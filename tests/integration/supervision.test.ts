import {
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    rmdir,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
    initProject,
    installProjects,
    loadProject,
    NodeArtifactStore,
    NodeDeploymentManager,
    NodeServerController,
    NodeSupervisor,
    readRuntimeIntent,
    readState,
    saveState,
    stopWithIntent,
    superviseProject,
    withMutex,
    writeRuntimeIntent,
    writeYaml,
} from "@crafleet/adapters";
import {
    type BackupService,
    CrafleetError,
    type ServerStatus,
} from "@crafleet/core";
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    type MockInstance,
    vi,
} from "vitest";
import * as filesystem from "../../packages/adapters/src/filesystem/io.js";
import * as processState from "../../packages/adapters/src/runtime/process.js";
import { artifactZip } from "./artifacts-fixture.js";

let root: string;
let temporaryParent: string;
let project: Awaited<ReturnType<typeof loadProject>>;
let store: NodeArtifactStore;
let status: ServerStatus;
let now: number;
let supervisor: NodeSupervisor;
let start: MockInstance<NodeDeploymentManager["spawnActive"]>;
let preflight: MockInstance<NodeDeploymentManager["preflight"]>;

beforeEach(async () => {
    temporaryParent = await realpath(tmpdir());
    root = await mkdtemp(path.join(temporaryParent, "crafleet-supervision-"));
    const dir = path.join(root, "project");
    await initProject(dir, {
        name: "supervised",
        kind: "velocity",
        version: "3.4.0",
    });
    project = await loadProject(dir, path.join(root, "home"));
    store = new NodeArtifactStore(project.home);
    status = { status: "stopped", clean: true, exitCode: 0 };
    now = 1_000_000;
    vi.spyOn(NodeServerController.prototype, "status").mockImplementation(
        async () => status,
    );
    vi.spyOn(NodeServerController.prototype, "stop").mockImplementation(
        async () => {
            status = { status: "stopped", clean: true, exitCode: 0 };
            return status;
        },
    );
    preflight = vi
        .spyOn(NodeDeploymentManager.prototype, "preflight")
        .mockResolvedValue();
    start = vi
        .spyOn(NodeDeploymentManager.prototype, "spawnActive")
        .mockImplementation(async function (this: NodeDeploymentManager) {
            expect((await readRuntimeIntent(this.context.dir))?.desired).toBe(
                "stopped",
            );
            status = { status: "running", activeId: "same-active" };
            return status;
        });
    supervisor = new NodeSupervisor(
        project,
        store,
        "unused-runner",
        undefined,
        () => now,
    );
});

afterEach(async () => {
    vi.restoreAllMocks();
    if (
        path.dirname(root) !== temporaryParent ||
        !path.basename(root).startsWith("crafleet-supervision-")
    )
        throw new Error("Unsafe cleanup");
    await rm(root, { recursive: true, force: true });
});

async function due() {
    await supervisor.tick();
    now += 10_000;
    await supervisor.tick();
}

describe("native active-only supervision", () => {
    it("does not adopt missing intent or create it on an idle tick", async () => {
        await due();
        expect(start).not.toHaveBeenCalled();
        expect(await readRuntimeIntent(project.dir)).toBeUndefined();
    });
    it.each([0, 1, null])(
        "restarts a self-exit (%s) with offline active-only checks",
        async (exitCode) => {
            await writeRuntimeIntent(project.dir, "running");
            status = { status: "stopped", clean: exitCode === 0, exitCode };
            preflight.mockImplementation(async function (
                this: NodeDeploymentManager,
                pending,
            ) {
                expect(pending).toBe(false);
                expect(this.options.offline).toBe(true);
                expect(this.options.requestEulaConsent).toBeUndefined();
            });
            await due();
            expect(start).toHaveBeenCalledOnce();
            expect(await readRuntimeIntent(project.dir)).toMatchObject({
                desired: "running",
                attempts: [now],
            });
        },
    );
    it("explicit stop cancels a scheduled restart and persists across a new supervisor", async () => {
        await writeRuntimeIntent(project.dir, "running");
        await supervisor.tick();
        await stopWithIntent(
            new NodeServerController(project.dir, project.home),
        );
        supervisor = new NodeSupervisor(
            project,
            store,
            "unused-runner",
            undefined,
            () => now,
        );
        await due();
        expect(start).not.toHaveBeenCalled();
        expect((await readRuntimeIntent(project.dir))?.desired).toBe("stopped");
    });
    it("shares the workspace mutex with maintenance", async () => {
        await writeRuntimeIntent(project.dir, "running");
        await supervisor.tick();
        now += 10_000;
        await withMutex(
            path.join(project.lockRoot, ".crafleet/operation.lock"),
            async () => {
                await expect(supervisor.tick()).rejects.toMatchObject({
                    code: "BUSY",
                });
                expect(start).not.toHaveBeenCalled();
            },
        );
        await supervisor.tick();
        expect(start).toHaveBeenCalledOnce();
    });
    it.each(["unknown", "starting", "stopping"] as const)(
        "does not restart %s state",
        async (value) => {
            await writeRuntimeIntent(project.dir, "running");
            status = { status: value };
            if (value === "unknown")
                await expect(due()).rejects.toMatchObject({
                    code: "UNKNOWN_PROCESS",
                });
            else await due();
            expect(start).not.toHaveBeenCalled();
        },
    );
    it("blocks recovery journals instead of clearing them", async () => {
        await writeRuntimeIntent(project.dir, "running");
        const journal = path.join(project.dir, ".crafleet/deploy.json");
        await writeFile(journal, "{}");
        await expect(due()).rejects.toMatchObject({
            code: "RECOVERY_REQUIRED",
        });
        expect(await readFile(journal, "utf8")).toBe("{}");
        expect(start).not.toHaveBeenCalled();
    });
    it("retains stopped intent when readiness fails and stops a late-starting Java", async () => {
        await writeRuntimeIntent(project.dir, "running");
        start.mockImplementation(async () => {
            status = { status: "starting" };
            throw new Error("readiness failed");
        });
        await expect(due()).rejects.toThrow("readiness failed");
        expect((await readRuntimeIntent(project.dir))?.desired).toBe("stopped");
        expect(status.status).toBe("stopped");
    });
    it("persists a crash-loop stop and explicit start re-arms it", async () => {
        await writeRuntimeIntent(project.dir, "running", [
            now - 5,
            now - 4,
            now - 3,
            now - 2,
            now - 1,
        ]);
        await expect(due()).rejects.toMatchObject({
            code: "SUPERVISION_LIMIT",
        });
        expect((await readRuntimeIntent(project.dir))?.desired).toBe("stopped");
        const manager = new NodeDeploymentManager(project, store);
        await manager.start(true);
        expect(await readRuntimeIntent(project.dir)).toMatchObject({
            desired: "running",
            attempts: [],
        });
    });
    it("service shutdown stops Java but preserves boot intent", async () => {
        await writeRuntimeIntent(project.dir, "running");
        status = { status: "running" };
        await supervisor.shutdown();
        expect(status.status).toBe("stopped");
        expect((await readRuntimeIntent(project.dir))?.desired).toBe("running");
    });
    it("refuses duplicate supervisors", async () => {
        await mkdir(path.join(project.dir, ".crafleet"), { recursive: true });
        await withMutex(
            path.join(project.dir, ".crafleet/supervisor.lock"),
            async () => {
                await expect(
                    superviseProject(
                        project,
                        store,
                        "unused",
                        new AbortController().signal,
                    ),
                ).rejects.toMatchObject({ code: "BUSY" });
            },
        );
    });
    it("fails closed on malformed intent", async () => {
        await writeRuntimeIntent(project.dir, "running");
        await writeFile(
            path.join(project.dir, ".crafleet/runtime-intent.json"),
            "{invalid",
        );
        await expect(supervisor.tick()).rejects.toMatchObject({
            code: "RUNTIME_INTENT_INVALID",
        });
    });
    it("stop remains usable when project YAML is broken", async () => {
        await writeRuntimeIntent(project.dir, "running");
        await writeFile(path.join(project.dir, "crafleet.yaml"), "[");
        await stopWithIntent(
            new NodeServerController(project.dir, project.home),
        );
        expect((await readRuntimeIntent(project.dir))?.desired).toBe("stopped");
    });
    it("foreground supervisor handles service signals and releases its guard", async () => {
        await writeRuntimeIntent(project.dir, "running");
        status = { status: "running" };
        const abort = new AbortController();
        vi.spyOn(NodeSupervisor.prototype, "tick").mockImplementation(
            async () => {
                abort.abort();
            },
        );
        await superviseProject(project, store, "unused", abort.signal);
        expect((await readRuntimeIntent(project.dir))?.desired).toBe("running");
        expect(status.status).toBe("stopped");
        await expect(
            readFile(
                path.join(project.dir, ".crafleet/supervisor.lock/owner.json"),
            ),
        ).rejects.toMatchObject({ code: "ENOENT" });
    });
    it.each(["yaml", "intent"])(
        "fatal %s errors gracefully stop authenticated Java without changing intent",
        async (invalid) => {
            await writeRuntimeIntent(project.dir, "running");
            status = { status: "running" };
            const intentFile = path.join(
                project.dir,
                ".crafleet/runtime-intent.json",
            );
            await writeFile(
                invalid === "yaml"
                    ? path.join(project.dir, "crafleet.yaml")
                    : intentFile,
                "[",
            );
            const before = await readFile(intentFile, "utf8");
            await expect(
                superviseProject(
                    project,
                    store,
                    "unused",
                    new AbortController().signal,
                ),
            ).rejects.toMatchObject({
                code:
                    invalid === "yaml"
                        ? "YAML_SYNTAX"
                        : "RUNTIME_INTENT_INVALID",
            });
            expect(status.status).toBe("stopped");
            expect(await readFile(intentFile, "utf8")).toBe(before);
        },
    );
    it.each(["unknown", "recovery"])(
        "fatal %s ownership remains fail-closed during supervisor cleanup",
        async (unsafe) => {
            await writeRuntimeIntent(project.dir, "running");
            status = { status: unsafe === "unknown" ? "unknown" : "running" };
            if (unsafe === "recovery")
                await writeFile(
                    path.join(project.dir, ".crafleet/deploy.json"),
                    "{}",
                );
            await expect(
                superviseProject(
                    project,
                    store,
                    "unused",
                    new AbortController().signal,
                ),
            ).rejects.toMatchObject({
                code:
                    unsafe === "unknown"
                        ? "UNKNOWN_PROCESS"
                        : "RECOVERY_REQUIRED",
            });
            expect(NodeServerController.prototype.stop).not.toHaveBeenCalled();
        },
    );
    it("waits for live maintenance before acquiring supervisor ownership", async () => {
        const abort = new AbortController();
        const tick = vi
            .spyOn(NodeSupervisor.prototype, "tick")
            .mockImplementation(async () => {
                abort.abort();
            });
        let watching: Promise<void> | undefined;
        await withMutex(
            path.join(project.lockRoot, ".crafleet/operation.lock"),
            async () => {
                watching = superviseProject(
                    project,
                    store,
                    "unused",
                    abort.signal,
                );
                await delay(50);
                expect(tick).not.toHaveBeenCalled();
            },
        );
        await watching;
        expect(tick).toHaveBeenCalledOnce();
    });
    it.each(["tick", "shutdown"] as const)(
        "retries %s when the contending operation ends before owner inspection",
        async (operation) => {
            await writeRuntimeIntent(project.dir, "running");
            status = { status: "running" };
            const abort = new AbortController();
            const original = NodeSupervisor.prototype[operation];
            const spy = vi.spyOn(NodeSupervisor.prototype, operation);
            spy.mockImplementationOnce(async function (this: NodeSupervisor) {
                let contention: unknown;
                await withMutex(
                    path.join(project.lockRoot, ".crafleet/operation.lock"),
                    async () => {
                        try {
                            await original.call(this);
                        } catch (error) {
                            contention = error;
                        }
                    },
                );
                expect(contention).toMatchObject({ code: "BUSY" });
                throw contention;
            });
            const nextTick = async () => {
                expect(status.status).toBe("running");
                expect(
                    NodeServerController.prototype.stop,
                ).not.toHaveBeenCalled();
                abort.abort();
            };
            if (operation === "tick") spy.mockImplementationOnce(nextTick);
            else
                vi.spyOn(NodeSupervisor.prototype, "tick").mockImplementation(
                    nextTick,
                );
            await superviseProject(project, store, "unused", abort.signal);
            expect(spy).toHaveBeenCalledTimes(2);
            expect(NodeServerController.prototype.stop).toHaveBeenCalledOnce();
            expect((await readRuntimeIntent(project.dir))?.desired).toBe(
                "running",
            );
        },
    );
    it("retries supervisor election when the competing operation has already released", async () => {
        const abort = new AbortController();
        const original = filesystem.withMutex;
        vi.spyOn(filesystem, "withMutex").mockImplementationOnce(
            async (directory) => {
                let contention: unknown;
                await original(directory, async () => {
                    try {
                        await original(directory, async () => {});
                    } catch (error) {
                        contention = error;
                    }
                });
                expect(contention).toMatchObject({ code: "BUSY" });
                throw contention;
            },
        );
        const tick = vi
            .spyOn(NodeSupervisor.prototype, "tick")
            .mockImplementation(async () => {
                abort.abort();
            });
        await superviseProject(project, store, "unused", abort.signal);
        expect(tick).toHaveBeenCalledOnce();
    });
    it("waits for publication of an operation owner before retrying", async () => {
        const guard = path.join(project.lockRoot, ".crafleet/operation.lock");
        const ownerFile = path.join(guard, "owner.json");
        const abort = new AbortController();
        const original = NodeSupervisor.prototype.tick;
        let publication: Promise<void> | undefined;
        vi.spyOn(NodeSupervisor.prototype, "tick")
            .mockImplementationOnce(async function (this: NodeSupervisor) {
                await mkdir(guard);
                try {
                    await original.call(this);
                } finally {
                    publication = delay(50).then(() =>
                        writeFile(
                            ownerFile,
                            JSON.stringify({ pid: process.pid }),
                        ),
                    );
                }
            })
            .mockImplementationOnce(async () => {
                await publication;
                await rm(ownerFile);
                await rmdir(guard);
                expect(
                    NodeServerController.prototype.stop,
                ).not.toHaveBeenCalled();
                abort.abort();
            });
        status = { status: "running" };
        await superviseProject(project, store, "unused", abort.signal);
        expect(NodeServerController.prototype.stop).toHaveBeenCalledOnce();
    });
    it.each(["missing", "malformed"])(
        "keeps a persistently %s operation owner blocked",
        async (kind) => {
            const guard = path.join(
                project.lockRoot,
                ".crafleet/operation.lock",
            );
            await mkdir(guard, { recursive: true });
            if (kind === "malformed")
                await writeFile(path.join(guard, "owner.json"), "[");
            await expect(
                superviseProject(
                    project,
                    store,
                    "unused",
                    new AbortController().signal,
                ),
            ).rejects.toMatchObject({ code: "BUSY" });
            expect(await filesystem.exists(guard)).toBe(true);
            expect(start).not.toHaveBeenCalled();
            expect(NodeServerController.prototype.stop).not.toHaveBeenCalled();
        },
    );
    it("does not retry an unrelated BUSY thrown after acquiring the operation lock", async () => {
        const failure = new CrafleetError(
            "BUSY",
            "Nested operation is blocked",
            4,
        );
        const tick = vi
            .spyOn(NodeSupervisor.prototype, "tick")
            .mockRejectedValue(failure);
        await expect(
            superviseProject(
                project,
                store,
                "unused",
                new AbortController().signal,
            ),
        ).rejects.toBe(failure);
        expect(tick).toHaveBeenCalledOnce();
    });
    it("reclaims only a definitively ended supervisor guard", async () => {
        const guard = path.join(project.dir, ".crafleet/supervisor.lock");
        await mkdir(guard, { recursive: true });
        await writeFile(
            path.join(guard, "owner.json"),
            JSON.stringify({
                pid: 2147483647,
                started: new Date().toISOString(),
            }),
        );
        vi.spyOn(processState, "processDefinitelyExited").mockReturnValue(true);
        const abort = new AbortController();
        vi.spyOn(NodeSupervisor.prototype, "tick").mockImplementation(
            async () => {
                abort.abort();
            },
        );
        await superviseProject(project, store, "unused", abort.signal);
        await expect(
            readFile(path.join(guard, "owner.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
    });
    it("does not clear an ended operation lock", async () => {
        const guard = path.join(project.lockRoot, ".crafleet/operation.lock");
        await mkdir(guard, { recursive: true });
        await writeFile(
            path.join(guard, "owner.json"),
            JSON.stringify({ pid: 2147483647 }),
        );
        vi.spyOn(processState, "processDefinitelyExited").mockReturnValue(true);
        await expect(
            superviseProject(
                project,
                store,
                "unused",
                new AbortController().signal,
            ),
        ).rejects.toMatchObject({ code: "BUSY" });
        expect(
            await readFile(path.join(guard, "owner.json"), "utf8"),
        ).toContain("2147483647");
    });
    it("does not accept a missing runtime EULA during an automatic Paper launch", async () => {
        const jar = path.join(root, "server.jar");
        await writeFile(
            jar,
            artifactZip([
                {
                    name: "META-INF/MANIFEST.MF",
                    content: "Manifest-Version: 1.0\n",
                },
            ]),
        );
        await writeYaml(path.join(project.dir, "crafleet.yaml"), {
            ...project.manifest,
            server: { type: "paper", version: "26.2", source: `file:${jar}` },
        });
        const context = await loadProject(project.dir, project.home);
        await installProjects([context], store, { offline: true });
        const pending = (await readState(project.dir)).pending;
        if (!pending) throw new Error("Missing fixture installation");
        await saveState(project.dir, { schemaVersion: 1, active: pending });
        await writeRuntimeIntent(project.dir, "running");
        await expect(due()).rejects.toMatchObject({ code: "EULA_REQUIRED" });
        expect(start).not.toHaveBeenCalled();
        expect(preflight).not.toHaveBeenCalled();
        await expect(
            readFile(path.join(project.dir, "runtime/eula.txt")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
            readFile(path.join(project.home, "eula.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
    });
    it("service cancellation during automatic startup retains its boot intent", async () => {
        const abort = new AbortController();
        supervisor = new NodeSupervisor(
            project,
            store,
            "unused",
            abort.signal,
            () => now,
        );
        await writeRuntimeIntent(project.dir, "running");
        start.mockImplementation(async () => {
            status = { status: "starting" };
            abort.abort();
            throw new DOMException("Cancelled", "AbortError");
        });
        await expect(due()).rejects.toMatchObject({ name: "AbortError" });
        expect((await readRuntimeIntent(project.dir))?.desired).toBe("running");
        expect(status.status).toBe("stopped");
    });
});

describe("maintenance intent transitions", () => {
    const backup = () => ({
        prepare: vi.fn(async () => {}),
        preflight: vi.fn(async () => {}),
        create: vi.fn(async () => ({ snapshotId: "a".repeat(64) })),
    });
    it.each([false, true])(
        "backup leaveStopped=%s suppresses automatic restart until successful resume",
        async (leaveStopped) => {
            await writeRuntimeIntent(project.dir, "running");
            status = { status: "running" };
            const service = backup();
            service.create.mockImplementation(async () => {
                expect(status.status).toBe("stopped");
                expect((await readRuntimeIntent(project.dir))?.desired).toBe(
                    "stopped",
                );
                await expect(supervisor.tick()).rejects.toMatchObject({
                    code: "BUSY",
                });
                return { snapshotId: "a".repeat(64) };
            });
            await new NodeDeploymentManager(
                project,
                store,
                service as unknown as BackupService,
            ).createBackup(leaveStopped);
            expect((await readRuntimeIntent(project.dir))?.desired).toBe(
                leaveStopped ? "stopped" : "running",
            );
        },
    );
    it("backup failure after stop stays stopped", async () => {
        await writeRuntimeIntent(project.dir, "running");
        status = { status: "running" };
        const service = backup();
        service.create.mockRejectedValue(new Error("snapshot failed"));
        await expect(
            new NodeDeploymentManager(
                project,
                store,
                service as unknown as BackupService,
            ).createBackup(),
        ).rejects.toThrow("snapshot failed");
        await due();
        expect(start).not.toHaveBeenCalled();
        expect((await readRuntimeIntent(project.dir))?.desired).toBe("stopped");
    });
    it("preflight failure leaves the running process and intent alone", async () => {
        await writeRuntimeIntent(project.dir, "running");
        status = { status: "running" };
        preflight.mockRejectedValue(new Error("preflight failed"));
        await expect(
            new NodeDeploymentManager(project, store).restart(),
        ).rejects.toThrow("preflight failed");
        expect(status.status).toBe("running");
        expect((await readRuntimeIntent(project.dir))?.desired).toBe("running");
    });
});
