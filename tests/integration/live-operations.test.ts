import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
    newProject,
    type OperationWarning,
    type RuntimeStatus,
} from "@crafleet/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeDeploymentManager } from "../../packages/adapters/src/filesystem/deployment.js";
import { NodeFilesManager } from "../../packages/adapters/src/filesystem/files.js";
import { migrateFiles } from "../../packages/adapters/src/filesystem/files-migration.js";
import { NodeRecoveryGroup } from "../../packages/adapters/src/filesystem/groups.js";
import { installProjects } from "../../packages/adapters/src/filesystem/installations.js";
import {
    exists,
    readJson,
    writeJson,
} from "../../packages/adapters/src/filesystem/io.js";
import {
    loadProject,
    writeYaml,
} from "../../packages/adapters/src/filesystem/projects.js";
import {
    readState,
    saveState,
} from "../../packages/adapters/src/filesystem/state.js";
import { NodeServerController } from "../../packages/adapters/src/runtime/controller.js";
import { writeRuntimeIntent } from "../../packages/adapters/src/runtime/intent.js";
import {
    backupTestDirectory,
    cleanupBackupTestDirectories,
    writeBackupTestFile as put,
} from "./backup-fixtures.js";
import {
    backupGroupFixture,
    requireGroupFixture as required,
} from "./backup-group-fixtures.js";

afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await cleanupBackupTestDirectories();
});

const setting = "plugins/Game/config.yml";
const second = "extra.properties";
async function settingsFixture(secret = false) {
    const fixture = await backupGroupFixture(true);
    if (secret)
        vi.stubEnv("CRAFLEET_LIVE_TEST_SECRET", "private-live-test-password");
    for (const project of fixture.projects) {
        if (secret) {
            project.manifest.secrets = {
                PASSWORD: { env: "CRAFLEET_LIVE_TEST_SECRET" },
            };
            await writeYaml(
                path.join(project.dir, "crafleet.yaml"),
                project.manifest,
            );
            Object.assign(
                project,
                await loadProject(project.dir, project.home),
            );
        }
        await put(
            project.dir,
            `files/${setting}`,
            `value: old\n${secret ? `password: "\${secret:PASSWORD}"\n` : ""}`,
        );
        await put(project.dir, `files/${second}`, "value=old\n");
    }
    await installProjects(fixture.projects, fixture.store);
    for (const project of fixture.projects) {
        await new NodeDeploymentManager(project, fixture.store).applyPrepared();
        await writeRuntimeIntent(project.dir, "running");
        await put(
            project.dir,
            `files/${setting}`,
            `value: new\n${secret ? `password: "\${secret:PASSWORD}"\n` : ""}`,
        );
        await put(project.dir, `files/${second}`, "value=new\n");
    }
    await installProjects(fixture.projects, fixture.store);
    return fixture;
}

describe("file operations while running", () => {
    it.each(["files", "config"] as const)(
        "requires force for %s capture and preserves runtime",
        async (mode) => {
            const root = await backupTestDirectory();
            await put(root, `runtime/${setting}`, "value: live\n");
            vi.spyOn(
                NodeServerController.prototype,
                "status",
            ).mockResolvedValue({ status: "running" });
            const warnings: OperationWarning[] = [];
            const manager = new NodeFilesManager(
                root,
                {},
                { mode, onWarning: (warning) => warnings.push(warning) },
            );
            await expect(
                manager.capture({ paths: [setting] }),
            ).rejects.toMatchObject({
                code: "NOT_STOPPED",
                hint: expect.stringContaining("--force"),
            });
            await manager.capture({ paths: [setting], force: true });
            expect(await readFile(path.join(root, mode, setting), "utf8")).toBe(
                "value: live\n",
            );
            expect(
                await readFile(path.join(root, "runtime", setting), "utf8"),
            ).toBe("value: live\n");
            expect(warnings).toContainEqual(
                expect.objectContaining({ code: "LIVE_CAPTURE" }),
            );
            await manager.untrack(setting);
            expect(await exists(path.join(root, mode, setting))).toBe(false);
            expect(await exists(path.join(root, "runtime", setting))).toBe(
                true,
            );
        },
    );

    it.each(["stopped", "starting", "stopping", "unknown"] as const)(
        "does not bypass %s state with force",
        async (status) => {
            const root = await backupTestDirectory();
            await put(root, "runtime/a.yml", "value: live\n");
            vi.spyOn(
                NodeServerController.prototype,
                "status",
            ).mockResolvedValue({ status });
            const manager = new NodeFilesManager(root, {}, { force: true });
            if (status === "stopped") await manager.track("a.yml");
            else {
                await expect(manager.track("a.yml")).rejects.toMatchObject({
                    code: "NOT_STOPPED",
                });
                await expect(manager.untrack("a.yml")).rejects.toMatchObject({
                    code: "NOT_STOPPED",
                });
                await expect(
                    manager.resolve("a.yml", "base"),
                ).rejects.toMatchObject({ code: "NOT_STOPPED" });
                expect(await exists(path.join(root, "files/a.yml"))).toBe(
                    false,
                );
            }
        },
    );

    it.each(["base", "runtime"] as const)(
        "resolves %s into saved files only and rejects concurrent capture edits",
        async (side) => {
            const root = await backupTestDirectory();
            await put(root, "runtime/a.yml", "value: original\n");
            const status = vi
                .spyOn(NodeServerController.prototype, "status")
                .mockResolvedValue({ status: "stopped" });
            const manager = new NodeFilesManager(root, {}, { force: true });
            await manager.track("a.yml");
            await put(root, "files/a.yml", "value: base\n");
            await put(root, "runtime/a.yml", "value: runtime\n");
            status.mockResolvedValue({ status: "running" });
            await manager.resolve("a.yml", side);
            expect(await readFile(path.join(root, "files/a.yml"), "utf8")).toBe(
                `value: ${side}\n`,
            );
            expect(
                await readFile(path.join(root, "runtime/a.yml"), "utf8"),
            ).toBe("value: runtime\n");
            const changing = new NodeFilesManager(
                root,
                {},
                {
                    force: true,
                    checkpoint: async (stage) => {
                        if (stage === "capture:journal")
                            await put(
                                root,
                                "runtime/a.yml",
                                "value: concurrent\n",
                            );
                    },
                },
            );
            await expect(changing.capture()).rejects.toMatchObject({
                code: "CONFIG_CAPTURE_FAILED",
            });
            expect(await readFile(path.join(root, "files/a.yml"), "utf8")).toBe(
                `value: ${side}\n`,
            );
        },
    );

    it("previews capture without force or saved state, and migrates with force without changing runtime", async () => {
        const root = await backupTestDirectory();
        const manifest = newProject("legacy", "velocity", "3.4.0");
        delete manifest.files;
        manifest.config = { files: ["*.properties"] };
        await writeYaml(path.join(root, "crafleet.yaml"), manifest);
        await put(root, "config/server.properties", "value=saved\n");
        await put(root, "runtime/server.properties", "value=live\n");
        vi.spyOn(NodeServerController.prototype, "status").mockResolvedValue({
            status: "running",
        });
        const manager = new NodeFilesManager(root, {}, { mode: "config" });
        await manager.capture({ paths: ["server.properties"], dryRun: true });
        expect(
            await exists(path.join(root, ".crafleet/config-state.json")),
        ).toBe(false);
        const project = await loadProject(root, root);
        await expect(migrateFiles(project)).rejects.toMatchObject({
            code: "NOT_STOPPED",
        });
        await migrateFiles(project, { dryRun: true });
        expect(await exists(path.join(root, "files"))).toBe(false);
        await migrateFiles(project, { force: true });
        expect(
            await readFile(path.join(root, "files/server.properties"), "utf8"),
        ).toBe("value=saved\n");
        expect(
            await readFile(
                path.join(root, "runtime/server.properties"),
                "utf8",
            ),
        ).toBe("value=live\n");
    });
});

describe("settings-only live deployment", () => {
    it("supports structured setting creation and deletion", async () => {
        const fixture = await settingsFixture();
        const project = fixture.projects[0];
        const additions = {
            "new.json": '{"value":true}\n',
            "new.toml": "value = true\n",
            "new.properties": "value=true\n",
            "new.yaml": "value: true\n",
        };
        for (const [relative, content] of Object.entries(additions))
            await put(project.dir, `files/${relative}`, content);
        await rm(path.join(project.dir, "files", second));
        await installProjects(fixture.projects, fixture.store);
        const manager = new NodeDeploymentManager(project, fixture.store);
        vi.spyOn(manager.controller, "status").mockResolvedValue({
            status: "running",
        });
        await manager.apply(false, true);
        for (const [relative, content] of Object.entries(additions))
            expect(
                await readFile(
                    path.join(project.dir, "runtime", relative),
                    "utf8",
                ),
            ).toBe(content);
        expect(await exists(path.join(project.dir, "runtime", second))).toBe(
            false,
        );
    });

    it.each(["saved", "metadata"])(
        "preserves external %s edits made during a live deployment",
        async (changed) => {
            const fixture = await settingsFixture();
            const project = fixture.projects[0];
            const manager = new NodeDeploymentManager(
                project,
                fixture.store,
                undefined,
                undefined,
                async (stage) => {
                    if (stage !== "live:file:extra.properties") return;
                    if (changed === "saved")
                        await put(
                            project.dir,
                            `files/${setting}`,
                            "value: external\n",
                        );
                    else {
                        const state = await readState(project.dir);
                        required(state.active).createdAt = "external-change";
                        await saveState(project.dir, state);
                    }
                },
            );
            const status = vi
                .spyOn(manager.controller, "status")
                .mockResolvedValue({ status: "running" });
            await expect(manager.apply(false, true)).rejects.toMatchObject({
                code: "DEPLOY_INTERRUPTED",
            });
            status.mockResolvedValue({ status: "stopped" });
            if (changed === "saved") {
                await manager.recover();
                expect(
                    await readFile(
                        path.join(project.dir, "files", setting),
                        "utf8",
                    ),
                ).toBe("value: external\n");
            } else {
                await expect(manager.recover()).rejects.toMatchObject({
                    code: "CONFIG_RECOVERY_REQUIRED",
                });
                expect((await readState(project.dir)).active?.createdAt).toBe(
                    "external-change",
                );
            }
        },
    );

    it("rejects malformed live journal selections before recovery", async () => {
        const fixture = await settingsFixture();
        const project = fixture.projects[0];
        const manager = new NodeDeploymentManager(
            project,
            fixture.store,
            undefined,
            undefined,
            async (stage) => {
                if (stage === "live:prepared") throw new Error("interrupted");
            },
        );
        const status = vi
            .spyOn(manager.controller, "status")
            .mockResolvedValue({ status: "running" });
        await expect(manager.apply(false, true)).rejects.toThrow("interrupted");
        status.mockResolvedValue({ status: "stopped" });
        const file = path.join(project.dir, ".crafleet/deploy.json");
        const journal = required(await readJson<Record<string, unknown>>(file));
        for (const live of [
            null,
            { paths: ["world/shared.bin"], operationId: "invalid" },
        ]) {
            await writeJson(file, { ...journal, live });
            await expect(manager.recover()).rejects.toMatchObject({
                code: "JOURNAL_INVALID",
            });
        }
        await writeJson(file, journal);
        await manager.recover();
        expect(
            await readFile(path.join(project.dir, "runtime", setting), "utf8"),
        ).toBe("value: old\n");
    });

    it("keeps Java, intent, secrets and unrelated changing world data safe without a cold backup", async () => {
        const fixture = await settingsFixture(true);
        const project = fixture.projects[0];
        const before = await readState(project.dir);
        const warnings: OperationWarning[] = [];
        const manager = new NodeDeploymentManager(
            project,
            fixture.store,
            fixture.backup,
            undefined,
            undefined,
            { onWarning: (warning) => warnings.push(warning) },
        );
        vi.spyOn(manager.controller, "status").mockResolvedValue({
            status: "running",
            activeId: required(before.active).id,
        });
        const stop = vi.spyOn(manager.controller, "stop");
        const backup = vi.spyOn(fixture.backup, "create");
        const intent = await readFile(
            path.join(project.dir, ".crafleet/runtime-intent.json"),
        );
        await put(
            project.dir,
            "runtime/world/shared.bin",
            Buffer.alloc(258, 0x83),
        );
        await expect(manager.apply()).rejects.toMatchObject({
            code: "NOT_STOPPED",
        });
        await manager.apply(true, true);
        expect(
            await exists(path.join(project.dir, ".crafleet/live-deploy")),
        ).toBe(false);
        expect(await readState(project.dir)).toEqual(before);
        const result = (await manager.apply(false, true)) as {
            activation: string;
            live: { backupPath: string };
        };
        expect(result.activation).toBe("unconfirmed");
        const archive = await readFile(result.live.backupPath, "utf8");
        expect(archive).not.toContain("private-live-test-password");
        expect(archive).toContain(`\${secret:PASSWORD}`);
        expect(archive).toContain("value: old");
        expect(
            (
                await readJson<{ config: { files: { relative: string }[] } }>(
                    result.live.backupPath,
                )
            )?.config.files
                .map((file) => file.relative)
                .sort(),
        ).toEqual([second, setting].sort());
        expect(
            await readFile(path.join(project.dir, "runtime/world/shared.bin")),
        ).toEqual(Buffer.alloc(258, 0x83));
        expect(
            await readFile(
                path.join(project.dir, ".crafleet/runtime-intent.json"),
            ),
        ).toEqual(intent);
        expect((await readState(project.dir)).active?.id).toBe(
            before.pending?.id,
        );
        expect((await manager.plan()).status.activeId).toBe(before.active?.id);
        expect(
            await readFile(path.join(project.dir, "runtime", setting), "utf8"),
        ).toContain("value: new");
        expect(stop).not.toHaveBeenCalled();
        expect(backup).not.toHaveBeenCalled();
        expect(warnings).toContainEqual(
            expect.objectContaining({ code: "LIVE_DEPLOY" }),
        );
    });

    it.each(["jar", "binary", "text", "launch", "missing-active"])(
        "rejects %s changes before any live writes",
        async (change) => {
            const fixture = await settingsFixture();
            const project = fixture.projects[0];
            if (change === "jar") await fixture.stageNext();
            else if (change === "binary" || change === "text") {
                await put(
                    project.dir,
                    change === "binary"
                        ? "files/world/shared.bin"
                        : "files/notes.txt",
                    change === "binary"
                        ? Buffer.alloc(12, 0x82)
                        : "not a structured setting",
                );
                await installProjects(fixture.projects, fixture.store);
            } else {
                const state = await readState(project.dir);
                if (change === "launch")
                    required(state.pending).manifest.java = {
                        args: ["-Xmx2G"],
                    };
                else delete state.active;
                await saveState(project.dir, state);
            }
            const manager = new NodeDeploymentManager(project, fixture.store);
            vi.spyOn(manager.controller, "status").mockResolvedValue({
                status: "running",
            });
            const state = await readState(project.dir);
            await expect(manager.apply(true)).resolves.toMatchObject({
                pending: state.pending?.id,
            });
            await expect(manager.apply(false, true)).rejects.toMatchObject({
                code: "LIVE_DEPLOY_UNSUPPORTED",
            });
            expect(await readState(project.dir)).toEqual(state);
            expect(
                await exists(path.join(project.dir, ".crafleet/deploy.json")),
            ).toBe(false);
            expect(
                await readFile(
                    path.join(project.dir, "runtime", setting),
                    "utf8",
                ),
            ).toBe("value: old\n");
        },
    );

    it.each([
        "live:file:extra.properties",
        "live:configuration",
        "live:applied",
    ])(
        "recovers %s after stopping without restoring unrelated world data",
        async (checkpoint) => {
            const fixture = await settingsFixture();
            const project = fixture.projects[0];
            const before = await readState(project.dir);
            let status: RuntimeStatus = "running";
            const manager = new NodeDeploymentManager(
                project,
                fixture.store,
                undefined,
                undefined,
                async (stage) => {
                    if (stage === checkpoint) throw new Error("interrupted");
                },
            );
            vi.spyOn(manager.controller, "status").mockImplementation(
                async () => ({ status }),
            );
            const stop = vi.spyOn(manager.controller, "stop");
            await expect(manager.apply(false, true)).rejects.toMatchObject({
                code: "DEPLOY_INTERRUPTED",
            });
            await put(
                project.dir,
                "runtime/world/shared.bin",
                Buffer.alloc(111, 0x84),
            );
            await expect(manager.recover()).rejects.toMatchObject({
                code: "NOT_STOPPED",
            });
            status = "stopped";
            await manager.recover();
            expect((await readState(project.dir)).active?.id).toBe(
                checkpoint === "live:applied"
                    ? before.pending?.id
                    : before.active?.id,
            );
            expect(
                await readFile(
                    path.join(project.dir, "runtime", setting),
                    "utf8",
                ),
            ).toBe(
                checkpoint === "live:applied" ? "value: new\n" : "value: old\n",
            );
            expect(
                await readFile(
                    path.join(project.dir, "runtime/world/shared.bin"),
                ),
            ).toEqual(Buffer.alloc(111, 0x84));
            expect(stop).not.toHaveBeenCalled();
        },
    );

    it("aborts when a selected file changes after preflight and refuses recovery over an external edit", async () => {
        const fixture = await settingsFixture();
        const project = fixture.projects[0];
        const manager = new NodeDeploymentManager(
            project,
            fixture.store,
            undefined,
            undefined,
            async (stage) => {
                if (stage === "live:file:extra.properties")
                    await put(
                        project.dir,
                        `runtime/${setting}`,
                        "value: external\n",
                    );
            },
        );
        const status = vi
            .spyOn(manager.controller, "status")
            .mockResolvedValue({ status: "running" });
        await expect(manager.apply(false, true)).rejects.toMatchObject({
            code: "DEPLOY_INTERRUPTED",
        });
        status.mockResolvedValue({ status: "stopped" });
        await expect(manager.recover()).rejects.toMatchObject({
            code: "CONFIG_RECOVERY_REQUIRED",
        });
        expect(
            await readFile(path.join(project.dir, "runtime", setting), "utf8"),
        ).toBe("value: external\n");
    });

    it("preflights all group members and rolls back an interrupted live group after manual shutdown", async () => {
        const fixture = await settingsFixture();
        const group = new NodeRecoveryGroup(fixture.batch, fixture.store);
        let status: RuntimeStatus = "running";
        const before = await Promise.all(
            fixture.projects.map((project) => readState(project.dir)),
        );
        const intents = await Promise.all(
            fixture.projects.map((project) =>
                readFile(
                    path.join(project.dir, ".crafleet/runtime-intent.json"),
                ),
            ),
        );
        for (const manager of group.managers)
            vi.spyOn(manager.controller, "status").mockImplementation(
                async () => ({ status }),
            );
        const stops = group.managers.map((manager) =>
            vi.spyOn(manager.controller, "stop"),
        );
        const backup = vi.spyOn(fixture.backup, "create");
        const secondManager = required(group.managers[1]);
        vi.spyOn(secondManager, "commitLiveDeployment").mockRejectedValueOnce(
            new Error("interrupted"),
        );
        await expect(
            group.operate("apply", false, false, true),
        ).rejects.toThrow("interrupted");
        expect((await readState(fixture.projects[0].dir)).active?.id).toBe(
            before[0]?.pending?.id,
        );
        expect(
            await exists(
                path.join(fixture.projects[0].dir, ".crafleet/deploy.json"),
            ),
        ).toBe(true);
        await expect(group.recover()).rejects.toMatchObject({
            code: "NOT_STOPPED",
        });
        for (const project of fixture.projects)
            await put(
                project.dir,
                "runtime/world/shared.bin",
                Buffer.alloc(99, 0x85),
            );
        status = "stopped";
        await group.recover();
        for (const [index, project] of fixture.projects.entries()) {
            expect((await readState(project.dir)).active?.id).toBe(
                before[index]?.active?.id,
            );
            expect(
                await readFile(
                    path.join(project.dir, "runtime", setting),
                    "utf8",
                ),
            ).toBe("value: old\n");
            expect(
                await readFile(
                    path.join(project.dir, "runtime/world/shared.bin"),
                ),
            ).toEqual(Buffer.alloc(99, 0x85));
            expect(
                await readFile(
                    path.join(project.dir, ".crafleet/runtime-intent.json"),
                ),
            ).toEqual(intents[index]);
        }
        expect(stops.every((stop) => stop.mock.calls.length === 0)).toBe(true);
        expect(backup).not.toHaveBeenCalled();
    });

    it("applies a mixed running/stopped group without changing intent and rejects the whole group if one pending is unsafe", async () => {
        const fixture = await settingsFixture();
        const group = new NodeRecoveryGroup(fixture.batch, fixture.store);
        for (const [index, manager] of group.managers.entries())
            vi.spyOn(manager.controller, "status").mockResolvedValue({
                status: index === 0 ? "running" : "stopped",
            });
        const unsafe = await readState(fixture.projects[1].dir);
        const pending = required(unsafe.pending);
        const originalJava = pending.manifest.java;
        pending.manifest.java = { args: ["-Xmx2G"] };
        await saveState(fixture.projects[1].dir, unsafe);
        await expect(
            group.operate("apply", false, false, true),
        ).rejects.toMatchObject({ code: "LIVE_DEPLOY_UNSUPPORTED" });
        expect(
            await exists(
                path.join(fixture.workspace, ".crafleet/group-operation.json"),
            ),
        ).toBe(false);
        if (originalJava) pending.manifest.java = originalJava;
        else delete pending.manifest.java;
        await saveState(fixture.projects[1].dir, unsafe);
        const stop = vi.spyOn(required(group.managers[1]).controller, "stop");
        await group.operate("apply", false, false, true);
        for (const project of fixture.projects) {
            expect(
                await readFile(
                    path.join(project.dir, "runtime", setting),
                    "utf8",
                ),
            ).toBe("value: new\n");
            expect((await readState(project.dir)).pending).toBeUndefined();
        }
        expect(stop).not.toHaveBeenCalled();
    });
});
