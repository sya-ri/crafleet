import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { newProject, validateProject } from "@crafleet/core";
import { afterEach, describe, expect, it } from "vitest";
import { NodeConfigManager } from "../../packages/adapters/src/filesystem/config.js";
import { NodeFilesManager } from "../../packages/adapters/src/filesystem/files.js";
import { migrateFiles } from "../../packages/adapters/src/filesystem/files-migration.js";
import {
    loadProject,
    yamlText,
} from "../../packages/adapters/src/filesystem/projects.js";
import {
    type Installation,
    readState,
    saveState,
} from "../../packages/adapters/src/filesystem/state.js";
import {
    backupTestDirectory,
    cleanupBackupTestDirectories,
    writeBackupTestFile as put,
} from "./backup-fixtures.js";

afterEach(cleanupBackupTestDirectories);
const binary = (size: number, value = 0x81) => Buffer.alloc(size, value);

describe("managed files", () => {
    it("keeps declared discovery exclusions and an empty candidate list when --include is used", async () => {
        const root = await backupTestDirectory();
        await put(root, "runtime/plugins/Game/data.yml", "value: public\n");
        await put(
            root,
            "runtime/plugins/Game/private.yml",
            "value: excluded\n",
        );
        const manager = new NodeFilesManager(root);
        const options = {
            kind: "paper" as const,
            initial: true,
            include: ["plugins/Game/*.yml"],
        };
        expect(
            (await manager.capture({ ...options, candidates: [] })).captured,
        ).toEqual([]);
        expect(
            (
                await manager.capture({
                    ...options,
                    candidates: ["plugins/Game/*.yml", "!**/private.yml"],
                })
            ).captured,
        ).toEqual(["plugins/Game/data.yml"]);
        await expect(
            readFile(path.join(root, "files/plugins/Game/private.yml")),
        ).rejects.toMatchObject({ code: "ENOENT" });
    });
    it("keeps dry runs read-only and reports both size and hash changes", async () => {
        const root = await backupTestDirectory();
        await put(root, "files/a.dat", binary(123));
        const manager = new NodeFilesManager(root);
        await manager.prepare({ persist: false });
        await expect(
            readFile(path.join(root, ".crafleet/files-state.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
            readFile(path.join(root, ".crafleet/file-objects")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await manager.apply(await manager.prepare());
        await put(root, "runtime/a.dat", binary(125));
        expect((await manager.diff())[0]?.sizes).toEqual({
            base: 123,
            observed: 123,
            runtime: 125,
            delta: 2,
        });
        await manager.capture({ dryRun: true });
        expect(await readFile(path.join(root, "files/a.dat"))).toEqual(
            binary(123),
        );
    });
    it("recovers a journal-only interrupted capture and leaves runtime unchanged", async () => {
        const root = await backupTestDirectory();
        await put(root, "files/a.dat", binary(10));
        const manager = new NodeFilesManager(root);
        await manager.apply(await manager.prepare());
        await put(root, "runtime/a.dat", binary(11));
        const interrupted = new NodeFilesManager(
            root,
            {},
            {
                checkpoint: async (stage) => {
                    if (stage === "capture:journal")
                        throw new Error("interrupted");
                },
            },
        );
        await expect(interrupted.capture()).rejects.toThrow("interrupted");
        await expect(manager.capture()).rejects.toMatchObject({
            code: "RECOVERY_REQUIRED",
        });
        expect(await manager.recoverCapture(true)).toMatchObject({
            recovered: true,
            action: "rollback-capture",
        });
        expect(await manager.recoverCapture()).toMatchObject({
            recovered: true,
        });
        expect(await readFile(path.join(root, "files/a.dat"))).toEqual(
            binary(10),
        );
        expect(await readFile(path.join(root, "runtime/a.dat"))).toEqual(
            binary(11),
        );
        await manager.capture();
        expect(await manager.recoverCapture()).toEqual({ recovered: false });
    });
    it.each(["capture:journal", "capture:file:a.dat"])(
        "aborts the whole capture when runtime changes at %s",
        async (stage) => {
            const root = await backupTestDirectory();
            await put(root, "files/a.dat", binary(10));
            await put(root, "files/b.yml", "before: true\n");
            const manager = new NodeFilesManager(root);
            await manager.apply(await manager.prepare());
            await put(root, "runtime/a.dat", binary(11));
            await put(root, "runtime/b.yml", "after: true\n");
            const changing = new NodeFilesManager(
                root,
                {},
                {
                    checkpoint: async (point) => {
                        if (point === stage)
                            await put(root, "runtime/a.dat", binary(12));
                    },
                },
            );
            await expect(changing.capture()).rejects.toThrow();
            expect(await readFile(path.join(root, "files/a.dat"))).toEqual(
                binary(10),
            );
            expect(await readFile(path.join(root, "files/b.yml"), "utf8")).toBe(
                "before: true\n",
            );
        },
    );
    it("rolls back after observation commit failure and rejects hard links", async () => {
        const root = await backupTestDirectory();
        await put(root, "files/a.dat", binary(10));
        const manager = new NodeFilesManager(root);
        await manager.apply(await manager.prepare());
        const before = await readFile(
            path.join(root, ".crafleet/files-state.json"),
        );
        await put(root, "runtime/a.dat", binary(11));
        const failing = new NodeFilesManager(
            root,
            {},
            {
                checkpoint: async (stage) => {
                    if (stage === "capture:state")
                        throw new Error("disk failure");
                },
            },
        );
        await expect(failing.capture()).rejects.toThrow();
        expect(
            await readFile(path.join(root, ".crafleet/files-state.json")),
        ).toEqual(before);
        expect(await readFile(path.join(root, "files/a.dat"))).toEqual(
            binary(10),
        );
        await link(
            path.join(root, "runtime/a.dat"),
            path.join(root, "runtime/b.dat"),
        );
        await expect(manager.capture()).rejects.toThrow();
    });
    it("stages a large binary without embedding it in JSON and preserves uncaptured runtime edits", async () => {
        const root = await backupTestDirectory();
        const original = binary(5 * 1024 * 1024);
        await put(root, "files/world/r.0.0.mca", original);
        const manager = new NodeFilesManager(root);
        const pending = await manager.prepare();
        expect(pending.mode).toBe("files");
        expect(JSON.stringify(pending).length).toBeLessThan(2500);
        expect(pending.files[0]?.content).toEqual(
            expect.objectContaining({ kind: "binary", size: original.length }),
        );
        await manager.apply(pending);
        expect(
            await readFile(path.join(root, "runtime/world/r.0.0.mca")),
        ).toEqual(original);
        const changed = binary(12345, 0x82);
        await put(root, "runtime/world/r.0.0.mca", changed);
        expect((await manager.diff())[0]?.runtimeChanged).toBe(true);
        await manager.apply(await manager.prepare());
        expect(
            await readFile(path.join(root, "runtime/world/r.0.0.mca")),
        ).toEqual(changed);
        expect((await manager.capture()).captured).toEqual(["world/r.0.0.mca"]);
        expect(
            await readFile(path.join(root, "files/world/r.0.0.mca")),
        ).toEqual(changed);
    }, 60000); // Includes repeated streamed copies and fsync under CI coverage.
    it("detects same-size binary edits and refuses the entire mixed capture on conflict", async () => {
        const root = await backupTestDirectory();
        await put(root, "files/world/a.dat", binary(10));
        await put(root, "files/a.yml", "value: before\n");
        const manager = new NodeFilesManager(root);
        await manager.apply(await manager.prepare());
        await put(root, "files/world/a.dat", binary(10, 0x82));
        await put(root, "runtime/world/a.dat", binary(10, 0x83));
        await put(root, "runtime/a.yml", "value: after\n");
        const state = await readFile(
            path.join(root, ".crafleet/files-state.json"),
        );
        const result = await manager.capture();
        expect(result.captured).toEqual([]);
        expect(result.conflicts).toEqual([
            { relative: "world/a.dat", paths: ["/"] },
        ]);
        expect(await readFile(path.join(root, "files/a.yml"), "utf8")).toBe(
            "value: before\n",
        );
        expect(
            await readFile(path.join(root, ".crafleet/files-state.json")),
        ).toEqual(state);
        await manager.resolve("world/a.dat", "runtime");
        expect(await readFile(path.join(root, "files/world/a.dat"))).toEqual(
            binary(10, 0x83),
        );
    });
    it("limits initial capture and keeps missing saved YAML", async () => {
        const root = await backupTestDirectory();
        await put(root, "files/plugins/Game/data/old.yml", "saved: true\n");
        await put(root, "runtime/plugins/Game/data/new.yml", "new: true\n");
        await put(
            root,
            "runtime/plugins/Game/config.yml",
            "password: unrelated\n",
        );
        const manager = new NodeFilesManager(root);
        const result = await manager.capture({
            kind: "paper",
            initial: true,
            include: ["plugins/Game/data/**/*.yml"],
            keepMissing: true,
        });
        expect(result.captured).toEqual(["plugins/Game/data/new.yml"]);
        expect(
            await readFile(
                path.join(root, "files/plugins/Game/data/old.yml"),
                "utf8",
            ),
        ).toBe("saved: true\n");
        await expect(
            readFile(path.join(root, "files/plugins/Game/config.yml")),
        ).rejects.toMatchObject({ code: "ENOENT" });
    });
    it("rejects unknown process state, links, and stale pending content", async () => {
        const root = await backupTestDirectory();
        await put(root, "files/a.dat", binary(10));
        const manager = new NodeFilesManager(root);
        const pending = await manager.prepare();
        await put(root, ".crafleet/process.lock", "unknown");
        await expect(manager.capture()).rejects.toThrow();
        await rm(path.join(root, ".crafleet/process.lock"));
        await put(root, "files/a.dat", binary(11));
        await expect(manager.apply(pending)).rejects.toThrow();
        const outside = await backupTestDirectory();
        await put(outside, "a.yml", "value: secret\n");
        await mkdir(path.join(root, "runtime"), { recursive: true });
        await symlink(
            outside,
            path.join(root, "runtime/linked"),
            process.platform === "win32" ? "junction" : "dir",
        );
        await expect(
            manager.capture({
                initial: true,
                kind: "paper",
                include: ["linked/**/*.yml"],
            }),
        ).rejects.toThrow();
    });
    it("recovers a partially applied binary deployment and handles deletion", async () => {
        const root = await backupTestDirectory();
        await put(root, "files/a.dat", binary(10));
        const manager = new NodeFilesManager(root);
        await manager.apply(await manager.prepare());
        await put(root, "files/a.dat", binary(11));
        const pending = await manager.prepare();
        await manager.apply(pending);
        await manager.restore(pending);
        expect(await readFile(path.join(root, "runtime/a.dat"))).toEqual(
            binary(10),
        );
        await rm(path.join(root, "files/a.dat"));
        await manager.apply(await manager.prepare());
        await expect(
            readFile(path.join(root, "runtime/a.dat")),
        ).rejects.toMatchObject({ code: "ENOENT" });
    });
});

describe("config migration", () => {
    it.each([false, true])(
        "handles projects without saved files or installation state (rollback=%s)",
        async (rollback) => {
            const root = await backupTestDirectory();
            const manifest = newProject("empty", "velocity", "3.4.0");
            const original = await yamlText(
                path.join(root, "crafleet.yaml"),
                manifest,
                null,
            );
            await put(root, "crafleet.yaml", original);
            const project = await loadProject(root, root);
            await expect(
                migrateFiles(project, { rollback: true }),
            ).rejects.toMatchObject({ code: "FILES_MIGRATION_MISSING" });
            await expect(
                migrateFiles(project, {
                    checkpoint: async (stage) => {
                        if (stage === "tree") throw new Error("interrupted");
                    },
                }),
            ).rejects.toThrow("interrupted");
            const pending = await loadProject(root, root);
            expect(
                await migrateFiles(pending, { rollback, dryRun: true }),
            ).toMatchObject({ files: 0, rollback });
            await migrateFiles(pending, { rollback });
            expect((await loadProject(root, root)).manifest.files).toEqual(
                rollback ? undefined : {},
            );
            if (rollback) {
                expect(
                    await readFile(path.join(root, "crafleet.yaml"), "utf8"),
                ).toBe(original);
                await expect(
                    readFile(path.join(root, "config")),
                ).rejects.toMatchObject({ code: "ENOENT" });
            }
            await expect(
                readFile(path.join(root, ".crafleet/state.json")),
            ).rejects.toMatchObject({ code: "ENOENT" });
        },
    );
    async function fixture() {
        const root = await backupTestDirectory();
        const manifest = newProject("test", "velocity", "3.4.0");
        await put(
            root,
            "crafleet.yaml",
            await yamlText(path.join(root, "crafleet.yaml"), manifest, null),
        );
        await put(root, "config/a.yml", "# exact\r\nvalue: before\r\n");
        const config = new NodeConfigManager(root);
        const bundle = await config.prepare();
        const installation: Installation = {
            id: randomUUID(),
            createdAt: new Date().toISOString(),
            manifest,
            lock: {
                name: "test",
                requests: { server: "fixture", plugins: {} },
                server: {
                    source: {
                        provider: "paper",
                        project: "velocity",
                        version: "3.4.0",
                        build: "1",
                    },
                    version: "3.4.0",
                    upstreamId: "1",
                    url: "https://example.com/server.jar",
                    size: 1,
                    sha256: "a".repeat(64),
                },
                plugins: {},
            },
            config: bundle,
        };
        await saveState(root, {
            schemaVersion: 1,
            active: installation,
            pending: installation,
        });
        return { root, project: await loadProject(root, root), config };
    }
    it("preserves source bytes, pending/active identity and comparison results", async () => {
        const { root, project, config } = await fixture();
        const before = await config.diff();
        const bytes = await readFile(path.join(root, "config/a.yml"));
        const state = await readState(root);
        await migrateFiles(project, { dryRun: true });
        expect(await readFile(path.join(root, "config/a.yml"))).toEqual(bytes);
        await migrateFiles(project);
        expect(await readFile(path.join(root, "files/a.yml"))).toEqual(bytes);
        expect(
            (await new NodeFilesManager(root).diff()).map(
                ({ relative, content }) => ({ relative, content }),
            ),
        ).toEqual(
            before.map(({ relative, content }) => ({ relative, content })),
        );
        const after = await readState(root);
        expect(after.active?.id).toBe(state.active?.id);
        expect(after.pending?.id).toBe(state.pending?.id);
        expect(after.pending?.config.mode).toBe("files");
        expect(await migrateFiles(await loadProject(root, root))).toMatchObject(
            { alreadyMigrated: true },
        );
    });
    it("refuses a large migration before writing a journal that recovery could not read", async () => {
        const { root, project } = await fixture();
        const state = await readState(root);
        const installation = state.active;
        if (!installation) throw new Error("Missing fixture installation");
        const content = "x".repeat(2 * 1024 * 1024);
        installation.config.files = [];
        for (let index = 0; index < 7; index++) {
            const relative = `large-${index}.txt`;
            await put(root, `config/${relative}`, content);
            installation.config.files.push({
                relative,
                format: "text",
                base: content,
                observed: null,
                runtime: null,
                content,
            });
        }
        await saveState(root, {
            ...state,
            active: installation,
            pending: installation,
        });
        const declaration = await readFile(path.join(root, "crafleet.yaml"));
        await expect(migrateFiles(project)).rejects.toMatchObject({
            code: "FILES_JOURNAL_LIMIT",
        });
        expect(await readFile(path.join(root, "crafleet.yaml"))).toEqual(
            declaration,
        );
        expect(
            await readFile(path.join(root, "config/large-0.txt"), "utf8"),
        ).toBe(content);
        await expect(
            readFile(path.join(root, ".crafleet/files-migration.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(path.join(root, "files"))).rejects.toMatchObject({
            code: "ENOENT",
        });
    });
    it.each([
        "malformed",
        "foreign-project",
        "unsafe-path",
        "changed-manifest",
        "changed-state",
    ])(
        "refuses a %s recovery journal without changing saved data",
        async (fault) => {
            const { root, project } = await fixture();
            await expect(
                migrateFiles(project, {
                    checkpoint: async (stage) => {
                        if (stage === "journal") throw new Error("interrupted");
                    },
                }),
            ).rejects.toThrow("interrupted");
            const journalPath = ".crafleet/files-migration.json";
            const journal = JSON.parse(
                await readFile(path.join(root, journalPath), "utf8"),
            );
            if (fault === "foreign-project")
                journal.projectDir = path.join(root, "other");
            if (fault === "unsafe-path")
                journal.files[0].relative = "../outside.yml";
            if (fault === "changed-manifest")
                journal.manifest.after = journal.manifest.after.replace(
                    "name: test",
                    "name: changed",
                );
            if (fault === "changed-state") {
                const state = JSON.parse(journal.state.after);
                state.pending.id = randomUUID();
                journal.state.after = JSON.stringify(state);
            }
            await put(
                root,
                journalPath,
                fault === "malformed" ? "{" : JSON.stringify(journal),
            );
            const declaration = await readFile(
                path.join(root, "crafleet.yaml"),
            );
            const state = await readFile(
                path.join(root, ".crafleet/state.json"),
            );
            await expect(
                migrateFiles(await loadProject(root, root)),
            ).rejects.toThrow();
            expect(await readFile(path.join(root, "crafleet.yaml"))).toEqual(
                declaration,
            );
            expect(
                await readFile(path.join(root, ".crafleet/state.json")),
            ).toEqual(state);
            expect(
                await readFile(path.join(root, "config/a.yml"), "utf8"),
            ).toBe("# exact\r\nvalue: before\r\n");
        },
    );
    it("refuses unknown runtime state, foreign recovery and observation collisions before conversion", async () => {
        const { root, project } = await fixture();
        const manifest = await readFile(path.join(root, "crafleet.yaml"));
        await put(root, ".crafleet/process.lock", "unknown");
        await expect(migrateFiles(project)).rejects.toMatchObject({
            code: "NOT_STOPPED",
        });
        await rm(path.join(root, ".crafleet/process.lock"));
        await put(root, ".crafleet/files-capture.json", "{}");
        await expect(migrateFiles(project)).rejects.toMatchObject({
            code: "RECOVERY_REQUIRED",
        });
        await rm(path.join(root, ".crafleet/files-capture.json"));
        await put(root, ".crafleet/files-state.json", "{}");
        await expect(migrateFiles(project)).rejects.toMatchObject({
            code: "FILES_MIGRATION_COLLISION",
        });
        expect(await readFile(path.join(root, "crafleet.yaml"))).toEqual(
            manifest,
        );
    });
    it.each(["journal", "tree", "state", "manifest"])(
        "resumes after interruption at %s",
        async (stage) => {
            const { root, project } = await fixture();
            await expect(
                migrateFiles(project, {
                    checkpoint: async (point) => {
                        if (point === stage) throw new Error("interrupted");
                    },
                }),
            ).rejects.toThrow("interrupted");
            await migrateFiles(await loadProject(root, root));
            expect(
                await readFile(path.join(root, "files/a.yml"), "utf8"),
            ).toContain("# exact\r\n");
            expect((await readState(root)).pending?.config.mode).toBe("files");
        },
    );
    it("rejects destination collisions and mixed declarations", async () => {
        const { root, project } = await fixture();
        await put(root, "files/a.yml", "keep me\n");
        await expect(migrateFiles(project)).rejects.toMatchObject({
            code: "FILES_MIGRATION_COLLISION",
        });
        expect(await readFile(path.join(root, "files/a.yml"), "utf8")).toBe(
            "keep me\n",
        );
        expect(() =>
            validateProject({
                ...project.manifest,
                config: { files: [] },
                files: {},
            }),
        ).toThrow();
    });
    it.each(["journal", "tree", "state", "manifest"])(
        "rolls back interruption at %s byte-for-byte",
        async (stage) => {
            const { root, project } = await fixture();
            const declaration = await readFile(
                path.join(root, "crafleet.yaml"),
            );
            const state = await readFile(
                path.join(root, ".crafleet/state.json"),
            );
            await expect(
                migrateFiles(project, {
                    checkpoint: async (point) => {
                        if (stage === point) throw new Error("interrupted");
                    },
                }),
            ).rejects.toThrow();
            await migrateFiles(await loadProject(root, root), {
                rollback: true,
            });
            expect(await readFile(path.join(root, "crafleet.yaml"))).toEqual(
                declaration,
            );
            expect(
                await readFile(path.join(root, ".crafleet/state.json")),
            ).toEqual(state);
            expect(
                await readFile(path.join(root, "config/a.yml"), "utf8"),
            ).toBe("# exact\r\nvalue: before\r\n");
        },
    );
    it("rejects stale legacy writers and externally changed migration inputs", async () => {
        const { root, project, config } = await fixture();
        await expect(
            migrateFiles(project, {
                checkpoint: async (point) => {
                    if (point === "journal")
                        await put(root, "config/a.yml", "external: edit\n");
                },
            }),
        ).rejects.toThrow();
        await expect(config.capture()).rejects.toMatchObject({
            code: "RECOVERY_REQUIRED",
        });
        await expect(
            migrateFiles(await loadProject(root, root)),
        ).rejects.toThrow();
        expect(await readFile(path.join(root, "config/a.yml"), "utf8")).toBe(
            "external: edit\n",
        );
        await put(root, "config/a.yml", "# exact\r\nvalue: before\r\n");
        await migrateFiles(await loadProject(root, root));
        await expect(config.track("a.yml")).rejects.toMatchObject({
            code: "FILES_LAYOUT_CHANGED",
        });
    });
});
