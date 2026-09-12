import { randomUUID } from "node:crypto";
import {
    lstat,
    mkdir,
    readdir,
    readFile,
    rename,
    rm,
    rmdir,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
    type ArtifactStore,
    CrafleetError,
    reserveAutomaticStart,
    SUPERVISION_POLL_MS,
    SUPERVISION_RESTART_DELAY_MS,
} from "@crafleet/core";
import { NodeDeploymentManager } from "../filesystem/deployment.js";
import { hasAcceptedEula, readEulaText } from "../filesystem/eula.js";
import {
    assertNoSymlinks,
    exists,
    readBoundedRegularFile,
    withMutex,
    writeJson,
} from "../filesystem/io.js";
import { MutexBusyError } from "../filesystem/mutex-error.js";
import {
    hasRecoveryJournal,
    loadProject,
    type ProjectContext,
} from "../filesystem/projects.js";
import { readState } from "../filesystem/state.js";
import { NodeServerController } from "./controller.js";
import {
    readRuntimeIntent,
    runtimeOperationRoot,
    writeRuntimeIntent,
} from "./intent.js";
import { processDefinitelyExited } from "./process.js";

/** One tick, including the final reread and launch, owns the normal operation mutex. */
export class NodeSupervisor {
    private stoppedSince: number | undefined;
    constructor(
        readonly project: ProjectContext,
        readonly store: ArtifactStore,
        readonly runnerEntry: string,
        readonly signal?: AbortSignal,
        readonly now: () => number = Date.now,
    ) {}

    async tick(): Promise<void> {
        const root = this.project.lockRoot;
        await withMutex(
            path.join(root, ".crafleet/operation.lock"),
            async () => {
                this.signal?.throwIfAborted();
                const project = await loadProject(
                    this.project.dir,
                    this.project.home,
                );
                if (project.lockRoot !== root)
                    throw new CrafleetError(
                        "SUPERVISION_CONTEXT",
                        "Workspace membership changed; restart supervision after review.",
                        4,
                    );
                if (await hasRecoveryJournal(project))
                    throw new CrafleetError(
                        "RECOVERY_REQUIRED",
                        "Supervision is blocked by an interrupted operation. Inspect doctor and recover deliberately.",
                        4,
                    );
                const intent = await readRuntimeIntent(project.dir);
                const manager = new NodeDeploymentManager(
                    project,
                    this.store,
                    undefined,
                    this.runnerEntry,
                    undefined,
                    {
                        offline: true,
                        ...(this.signal ? { signal: this.signal } : {}),
                    },
                );
                const status = await manager.controller.status();
                if (status.status === "unknown")
                    throw new CrafleetError(
                        "UNKNOWN_PROCESS",
                        "Supervision cannot identify the server; no restart or recovery was attempted.",
                        3,
                    );
                if (
                    intent?.desired !== "running" ||
                    status.status !== "stopped"
                ) {
                    this.stoppedSince = undefined;
                    return;
                }
                const now = this.now();
                this.stoppedSince ??= now;
                if (now - this.stoppedSince < SUPERVISION_RESTART_DELAY_MS)
                    return;
                let attempts = intent.attempts;
                try {
                    const reserved = reserveAutomaticStart(intent, now);
                    attempts = reserved.attempts;
                    await writeRuntimeIntent(project.dir, "stopped", attempts);
                    // A remembered host receipt must never turn a missing runtime EULA into fresh consent.
                    const active = (await readState(project.dir)).active;
                    if (
                        active?.manifest.server.type === "paper" &&
                        !hasAcceptedEula(
                            (await readEulaText(
                                path.join(project.dir, "runtime/eula.txt"),
                            )) ?? "",
                        )
                    )
                        throw new CrafleetError(
                            "EULA_REQUIRED",
                            "Explicitly start Paper after reviewing EULA consent; supervision never accepts it.",
                            3,
                        );
                    await manager.preflight(false);
                    await manager.spawnActive();
                    await writeRuntimeIntent(project.dir, "running", attempts);
                    this.stoppedSince = undefined;
                } catch (error) {
                    await writeRuntimeIntent(project.dir, "stopped", attempts);
                    const current = await manager.controller.status();
                    if (
                        ["starting", "running", "stopping"].includes(
                            current.status,
                        )
                    )
                        await manager.controller.stop();
                    if (this.signal?.aborted)
                        await writeRuntimeIntent(
                            project.dir,
                            "running",
                            attempts,
                        );
                    throw error;
                }
            },
        );
    }

    /** Host/service termination keeps intent, unlike an explicit server stop. */
    async shutdown(): Promise<void> {
        await withMutex(
            path.join(this.project.lockRoot, ".crafleet/operation.lock"),
            async () => {
                if (
                    (await runtimeOperationRoot(this.project.dir)) !==
                        this.project.lockRoot ||
                    (await hasRecoveryJournal(this.project))
                )
                    throw new CrafleetError(
                        "RECOVERY_REQUIRED",
                        "Supervisor shutdown is blocked by changed workspace ownership or an interrupted operation; inspect recovery state.",
                        4,
                    );
                const controller = new NodeServerController(
                    this.project.dir,
                    this.project.home,
                );
                const status = await controller.status();
                if (["running", "starting", "stopping"].includes(status.status))
                    await controller.stop();
                else if (status.status === "unknown")
                    throw new CrafleetError(
                        "UNKNOWN_PROCESS",
                        "Supervisor shutdown cannot identify the server; no force kill was attempted.",
                        3,
                    );
            },
        );
    }
}

async function retryOperationContention(
    error: unknown,
    root: string,
): Promise<boolean> {
    if (
        !(error instanceof MutexBusyError) ||
        error.directory !== path.join(root, ".crafleet/operation.lock")
    )
        return false;
    // Publication, retirement, and replacement can invalidate an owner read.
    // Allow one fresh inspection; persistently unsafe guards still block.
    const guard = path.join(root, ".crafleet/operation.lock");
    const identity = await operationGuardIdentity(guard);
    for (let inspection = 0; inspection < 2; inspection++) {
        const result = await inspectOperation(root);
        if (result !== "settling") return result === "retry";
        if (inspection === 0) await delay(SUPERVISION_POLL_MS);
    }
    // Two publishing observations may belong to different operations.
    return (await operationGuardIdentity(guard)) !== identity;
}

async function inspectOperation(
    root: string,
): Promise<"retry" | "blocked" | "settling"> {
    const guard = await assertNoSymlinks(root, ".crafleet/operation.lock");
    const file = await assertNoSymlinks(
        root,
        ".crafleet/operation.lock/owner.json",
    );
    const identity = await operationGuardIdentity(guard);
    if (identity === null) return "retry";
    try {
        const snapshot = await readBoundedRegularFile(file, {
            maxBytes: 4096,
            failure: () => {
                throw new Error("Unsafe operation owner");
            },
        });
        // The operation may have finished between mkdir's EEXIST and this read.
        if ((await operationGuardIdentity(guard)) !== identity) return "retry";
        if (!snapshot) return "settling";
        const owner: unknown = JSON.parse(snapshot.bytes.toString("utf8"));
        return owner &&
            typeof owner === "object" &&
            "pid" in owner &&
            typeof owner.pid === "number" &&
            Number.isSafeInteger(owner.pid) &&
            owner.pid > 0 &&
            !processDefinitelyExited(owner.pid)
            ? "retry"
            : "blocked";
    } catch {
        // A new owner may already occupy the path after the old read failed.
        // Presence alone cannot distinguish that handoff from an unsafe file.
        await assertNoSymlinks(root, ".crafleet/operation.lock");
        await assertNoSymlinks(root, ".crafleet/operation.lock/owner.json");
        if ((await operationGuardIdentity(guard)) !== identity) return "retry";
        return "settling";
    }
}

async function operationGuardIdentity(guard: string): Promise<string | null> {
    try {
        const info = await lstat(guard, { bigint: true });
        // Birth time distinguishes successive guards even when an inode is reused.
        return `${info.dev}:${info.ino}:${info.birthtimeNs}`;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

/** Reclaim only the supervisor's own guard, never runner or operation recovery state. */
async function retireEndedSupervisor(projectDir: string): Promise<void> {
    const guard = await assertNoSymlinks(
        projectDir,
        ".crafleet/supervisor.lock",
    );
    if (!(await exists(guard))) return;
    const ownerFile = await assertNoSymlinks(guard, "owner.json");
    let raw: string;
    let pid: number;
    try {
        const entries = await readdir(guard);
        if (entries.length !== 1 || entries[0] !== "owner.json")
            throw new Error("Unexpected supervisor files");
        const snapshot = await readBoundedRegularFile(ownerFile, {
            maxBytes: 4096,
            failure: () => {
                throw new Error("Unsafe owner");
            },
        });
        if (!snapshot) throw new Error("Missing owner");
        raw = snapshot.bytes.toString("utf8");
        const owner: unknown = JSON.parse(raw);
        if (
            !owner ||
            typeof owner !== "object" ||
            !("pid" in owner) ||
            typeof owner.pid !== "number" ||
            !Number.isSafeInteger(owner.pid) ||
            owner.pid <= 0
        )
            throw new Error("Invalid owner");
        pid = owner.pid;
    } catch {
        throw new CrafleetError(
            "SUPERVISOR_OWNER",
            "Supervisor ownership is unknown; inspect it before recovery.",
            4,
        );
    }
    if (!processDefinitelyExited(pid))
        throw new CrafleetError(
            "BUSY",
            "Another supervisor is alive or its PID is reused; no second supervisor was started.",
            4,
        );
    if (
        (await readFile(ownerFile, "utf8")) !== raw ||
        !processDefinitelyExited(pid)
    )
        throw new CrafleetError("BUSY", "Supervisor ownership changed.", 4);
    const retired = path.join(
        projectDir,
        ".crafleet",
        `.supervisor-${randomUUID()}.retired`,
    );
    await rename(guard, retired);
    // Remove only the recognized owner file and empty directory; unexpected contents stay visible.
    await rm(path.join(retired, "owner.json"));
    await rmdir(retired);
}

export async function superviseProject(
    project: ProjectContext,
    store: ArtifactStore,
    runnerEntry: string,
    signal: AbortSignal,
): Promise<void> {
    const guard = await assertNoSymlinks(
        project.dir,
        ".crafleet/supervisor.lock",
    );
    const ownerFile = path.join(guard, "owner.json");
    let ownership: string | undefined;
    while (!signal.aborted && ownership === undefined) {
        try {
            await withMutex(
                path.join(project.lockRoot, ".crafleet/operation.lock"),
                async () => {
                    // Serializing election and guard creation prevents two stale-owner reclaimers racing.
                    await retireEndedSupervisor(project.dir);
                    await mkdir(guard);
                    await writeJson(ownerFile, {
                        pid: process.pid,
                        started: new Date().toISOString(),
                    });
                    ownership = await readFile(ownerFile, "utf8");
                },
            );
        } catch (error) {
            if (!(await retryOperationContention(error, project.lockRoot)))
                throw error;
            await delay(SUPERVISION_POLL_MS, undefined, { signal }).catch(
                (error: unknown) => {
                    if (!signal.aborted) throw error;
                },
            );
        }
    }
    if (ownership === undefined) return;
    const operate = async () => {
        const supervisor = new NodeSupervisor(
            project,
            store,
            runnerEntry,
            signal,
        );
        try {
            while (!signal.aborted) {
                try {
                    await supervisor.tick();
                } catch (error) {
                    if (signal.aborted) break;
                    if (
                        !(await retryOperationContention(
                            error,
                            project.lockRoot,
                        ))
                    )
                        throw error;
                }
                await delay(SUPERVISION_POLL_MS, undefined, {
                    signal,
                }).catch((error: unknown) => {
                    if (!signal.aborted) throw error;
                });
            }
        } finally {
            await shutdownWhenIdle(supervisor);
        }
    };
    try {
        await operate();
    } finally {
        await releaseSupervisorGuard(guard, ownership);
    }
}

async function releaseSupervisorGuard(
    guard: string,
    ownership: string,
): Promise<void> {
    const file = await assertNoSymlinks(guard, "owner.json");
    if ((await readFile(file, "utf8")) !== ownership)
        throw new CrafleetError(
            "SUPERVISOR_OWNER",
            "Supervisor ownership changed; its guard was retained.",
            4,
        );
    await rm(file);
    await rmdir(guard);
}

async function shutdownWhenIdle(supervisor: NodeSupervisor): Promise<void> {
    // Finish maintenance before host shutdown; never race its resume.
    for (;;) {
        try {
            await supervisor.shutdown();
            return;
        } catch (error) {
            if (
                !(await retryOperationContention(
                    error,
                    supervisor.project.lockRoot,
                ))
            )
                throw error;
            await delay(SUPERVISION_POLL_MS);
        }
    }
}
