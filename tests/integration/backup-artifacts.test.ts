import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
    applyBackupRestore,
    initProject,
    installProjects,
    loadProject,
    NodeArtifactStore,
    NodeBackupService,
    NodeDeploymentManager,
    readRuntimeIntent,
    readState,
    recoverBackupRestore,
    writeYaml,
} from "@crafleet/adapters";
import type { BackupConfig } from "@crafleet/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    selectedBackupArtifacts,
    stageInstallationArtifacts,
    validateBackupArtifacts,
} from "../../packages/adapters/src/filesystem/backup-artifacts.js";
import {
    applyGroupBackupRestore,
    recoverGroupBackupRestore,
} from "../../packages/adapters/src/filesystem/group-restore.js";
import { collectGroupBackupMetadata } from "../../packages/adapters/src/filesystem/groups.js";
import {
    executePreparedRestore,
    inspectBackupRestore,
    prepareRestoreApplication,
} from "../../packages/adapters/src/filesystem/restore.js";
import { saveState } from "../../packages/adapters/src/filesystem/state.js";
import { validateBackupMetadata } from "../../packages/adapters/src/restic/metadata.js";
import { validateProject } from "../../packages/core/src/domain/project.js";
import { artifactJar, artifactZip } from "./artifacts-fixture.js";
import {
    backupTestDirectory,
    cleanupBackupTestDirectories,
    FixtureRestic,
    writeBackupTestFile as put,
    TEST_REPOSITORY_ID,
} from "./backup-fixtures.js";
import { backupGroupFixture } from "./backup-group-fixtures.js";

afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupBackupTestDirectories();
});

async function fixture(policy: BackupConfig["artifacts"] = "all") {
    const root = await backupTestDirectory();
    const dir = path.join(root, "project");
    const home = path.join(root, "home");
    const repository = path.join(root, "repository");
    await mkdir(repository);
    const manifest = await initProject(dir, {
        name: "artifact-fixture",
        kind: "paper",
        version: "26.1",
        source: "file:imports/server.jar",
    });
    manifest.plugins.Example = "file:imports/example.jar";
    await writeYaml(path.join(dir, "crafleet.yaml"), manifest);
    await put(
        dir,
        "imports/server.jar",
        artifactZip([
            {
                name: "META-INF/MANIFEST.MF",
                content: "Manifest-Version: 1.0\n",
            },
        ]),
    );
    await put(dir, "imports/example.jar", artifactJar("Example", "1.0.0"));
    const project = await loadProject(dir, home);
    const store = new NodeArtifactStore(home);
    await installProjects([project], store, { offline: true });
    await new NodeDeploymentManager(project, store).applyPrepared();
    await put(dir, "runtime/world/level.dat", "snapshot-world");
    const active = (await readState(dir)).active;
    if (!active) throw new Error("Missing active fixture");
    // Model an already-installed provider server, without fetching a real game server.
    active.lock.server.source = {
        provider: "paper",
        project: "paper",
        version: "26.1",
        build: "1",
    };
    active.lock.server.url = "https://fixtures.invalid/server.jar";
    await saveState(dir, { schemaVersion: 1, active });
    const engine = new FixtureRestic();
    const backup = new NodeBackupService(
        dir,
        home,
        {
            ...(policy ? { artifacts: policy } : {}),
            projectId: manifest.id ?? "artifact-fixture",
            repository: "local",
            repositories: {
                local: {
                    path: repository,
                    password: { env: "FIXTURE" },
                    id: TEST_REPOSITORY_ID,
                },
            },
            files: ["runtime/**", "!**/*.[jJ][aA][rR]"],
        },
        async () => "fixture-password",
        {
            runner: engine.runner,
            bootstrap: {
                prepare: async () => ({
                    path: "fixture-restic",
                    version: "0.19.1",
                }),
            },
        },
    );
    const source = path.join(root, "extracted");
    const create = () => backup.create({ installation: active });
    const extract = async () => {
        const snapshot = await create();
        await backup.restore(snapshot.snapshotId, { target: source });
        return snapshot;
    };
    const removeOriginals = async () => {
        // All targets are fixed descendants of the temporary fixture returned above.
        for (const target of [
            path.join(dir, "imports"),
            path.join(home, "cache/artifacts"),
        ]) {
            if (!target.startsWith(`${root}${path.sep}`))
                throw new Error("Unsafe fixture path");
            await rm(target, { recursive: true, force: true });
        }
    };
    return {
        root,
        dir,
        home,
        project,
        store,
        backup,
        engine,
        active,
        source,
        create,
        extract,
        removeOriginals,
    };
}

describe("installation artifact snapshots", () => {
    it.runIf(process.env.CRAFLEET_TEST_RESTIC === "1")(
        "restores format 2 through the official restic binary with no artifact cache or network",
        async () => {
            const f = await fixture();
            const config = structuredClone(f.backup.config);
            const repository = config.repositories?.local;
            if (!repository) throw new Error("Missing fixture repository");
            delete repository.id;
            const backup = new NodeBackupService(
                f.dir,
                f.home,
                config,
                async () => "disposable-restic-artifacts-password",
            );
            await backup.prepare();
            repository.id = (
                await backup.setup("local", { initialize: true, confirm: true })
            ).id;
            const snapshot = await backup.create({ installation: f.active });
            await f.removeOriginals();
            vi.spyOn(globalThis, "fetch").mockRejectedValue(
                new Error("Network disabled after tool preparation"),
            );
            await backup.restore(snapshot.snapshotId, {
                target: f.source,
            });
            await put(f.dir, "runtime/world/level.dat", "current");
            await applyBackupRestore(
                f.project,
                f.source,
                { offline: true },
                f.store,
                backup,
            );
            expect(
                await readFile(
                    path.join(f.dir, "runtime/world/level.dat"),
                    "utf8",
                ),
            ).toBe("snapshot-world");
            expect(await backup.list()).toHaveLength(2);
            expect((await backup.show(snapshot.snapshotId)).format).toBe(2);
            await expect(backup.check({ readData: true })).resolves.toEqual({
                checked: true,
            });
        },
        180000,
    );

    it("validates artifact policies and verifies local seeds before adding them to an empty cache", async () => {
        const f = await fixture();
        for (const policy of ["none", "local", "all"])
            expect(
                validateProject({
                    ...f.active.manifest,
                    backup: { files: [], artifacts: policy },
                }).backup?.artifacts,
            ).toBe(policy);
        expect(() =>
            validateProject({
                ...f.active.manifest,
                backup: { files: [], artifacts: "pending" },
            }),
        ).toThrow();
        await f.removeOriginals();
        const context = {
            projectDir: f.dir,
            serverKind: "paper" as const,
            offline: true,
        };
        await expect(
            f.store.ensure(f.active.lock.server, context, f.root),
        ).rejects.toMatchObject({ code: "ARTIFACT_SOURCE" });
        const corrupt = path.join(f.root, "corrupt.jar");
        await writeFile(corrupt, Buffer.alloc(f.active.lock.server.size));
        await expect(
            f.store.ensure(f.active.lock.server, context, corrupt),
        ).rejects.toThrow();
        await expect(
            f.store.ensure(f.active.lock.server, context),
        ).rejects.toThrow();
    });
    it.each([undefined, "none", "local", "all"] as const)(
        "keeps %s policy scoped to exact active artifacts",
        async (policy) => {
            const f = await fixture(policy);
            if (policy === undefined) delete f.backup.config.artifacts;
            await put(f.dir, "runtime/plugins/unmanaged.jar", "not active");
            const plugin = f.active.lock.plugins.Example;
            if (!plugin) throw new Error("Missing fixture plugin");
            const pending = structuredClone(f.active);
            pending.lock.plugins.Example = {
                ...plugin,
                sha256: "0".repeat(64),
            };
            await saveState(f.dir, {
                schemaVersion: 1,
                active: f.active,
                pending,
            });
            const snapshot = await f.extract();
            const included = snapshot.metadata.artifacts?.files ?? [];
            expect(snapshot.metadata.format).toBe(
                policy === "all" || policy === "local" ? 2 : 1,
            );
            expect(included.map((file) => file.sha256).sort()).toEqual(
                (policy === "all"
                    ? [f.active.lock.server.sha256, plugin.sha256]
                    : policy === "local"
                      ? [plugin.sha256]
                      : []
                ).sort(),
            );
            expect(
                included.some((file) => file.sha256 === "0".repeat(64)),
            ).toBe(false);
            for (const file of included)
                expect(
                    createHash("sha256")
                        .update(await readFile(path.join(f.source, file.file)))
                        .digest("hex"),
                ).toBe(file.sha256);
        },
    );

    it("applies and recovers all artifacts without original files, cache, or provider calls", async () => {
        const f = await fixture();
        const snapshot = await f.extract();
        await f.removeOriginals();
        const originalEnsure = f.store.ensure.bind(f.store);
        const ensure = vi
            .spyOn(f.store, "ensure")
            .mockImplementation((artifact, context, seed) => {
                if (!seed)
                    throw new Error(
                        "No artifact source, cache, or network is available",
                    );
                return originalEnsure(artifact, context, seed);
            });
        await put(f.dir, "runtime/world/level.dat", "current-world");
        const result = await applyBackupRestore(
            f.project,
            f.source,
            { offline: true },
            f.store,
            f.backup,
        );
        expect(result).toBeDefined();
        expect(
            ensure.mock.calls.every(([, , seed]) => seed !== undefined),
        ).toBe(true);
        expect(
            await readFile(path.join(f.dir, "runtime/world/level.dat"), "utf8"),
        ).toBe("snapshot-world");
        expect((await readState(f.dir)).active?.lock).toEqual(f.active.lock);
        expect((await readState(f.dir)).pending).toBeUndefined();
        const prepared = await prepareRestoreApplication(
            f.project,
            f.source,
            { offline: true },
            f.store,
            f.backup,
        );
        await expect(
            executePreparedRestore(f.project, prepared, f.store, f.backup, {
                operationLockHeld: true,
                preRestoreSnapshot: snapshot.snapshotId,
                checkpoint: async (stage) => {
                    if (stage.startsWith("file:"))
                        throw new Error("interrupted");
                },
            }),
        ).rejects.toThrow("interrupted");
        await recoverBackupRestore(f.project, f.store, f.backup, false);
        expect(
            ensure.mock.calls.every(([, , seed]) => seed !== undefined),
        ).toBe(true);
        expect(await readRuntimeIntent(f.dir)).toMatchObject({
            desired: "stopped",
        });
        const restoredStore = new NodeArtifactStore(f.home);
        for (const artifact of [
            f.active.lock.server,
            ...Object.values(f.active.lock.plugins),
        ]) {
            const cached = await restoredStore.ensure(artifact, {
                projectDir: f.dir,
                serverKind: "paper",
                offline: true,
            });
            expect(
                createHash("sha256")
                    .update(await readFile(cached))
                    .digest("hex"),
            ).toBe(artifact.sha256);
        }
    });

    it("rejects missing and corrupted embedded JARs before touching the world, even with an available cache", async () => {
        const f = await fixture();
        const snapshot = await f.extract();
        const entry = snapshot.metadata.artifacts?.files[0];
        if (!entry) throw new Error("Missing embedded JAR");
        const file = path.join(f.source, entry.file);
        const bytes = await readFile(file);
        await writeFile(file, Buffer.alloc(bytes.length));
        await expect(
            applyBackupRestore(f.project, f.source, {}, f.store, f.backup),
        ).rejects.toMatchObject({ code: "RESTORE_HASH" });
        await rm(file);
        await expect(
            inspectBackupRestore(f.project, f.source, {}, f.backup),
        ).rejects.toMatchObject({ code: "RESTORE_CONTENTS" });
        expect(
            await readFile(path.join(f.dir, "runtime/world/level.dat"), "utf8"),
        ).toBe("snapshot-world");
        expect(f.engine.snapshots).toHaveLength(1);
    });

    it("requires exact active hashes and refuses damaged or missing installed files during capture", async () => {
        const f = await fixture();
        const jar = path.join(f.dir, "runtime/server.jar");
        const original = await readFile(jar);
        await writeFile(jar, Buffer.alloc(original.length));
        await expect(f.create()).rejects.toMatchObject({
            code: "BACKUP_ARTIFACT_HASH",
        });
        await writeFile(jar, "short");
        await expect(f.create()).rejects.toMatchObject({
            code: "BACKUP_ARTIFACT_HASH",
        });
        await rm(jar);
        await expect(f.create()).rejects.toMatchObject({
            code: "BACKUP_ARTIFACT_MISSING",
        });
        expect(f.engine.snapshots).toHaveLength(0);
    });

    it("rejects substituted, incomplete, duplicate and legacy-format artifact manifests", async () => {
        const f = await fixture();
        const snapshot = await f.create();
        const metadata = snapshot.metadata;
        const embedded = metadata.artifacts;
        if (!embedded) throw new Error("Missing artifact manifest");
        for (const patch of [
            { files: [] },
            { files: [embedded.files[0], embedded.files[0]] },
            {
                files: embedded.files.map((file) => ({
                    ...file,
                    size: file.size + 1,
                })),
            },
            {
                files: embedded.files.map((file) => ({
                    ...file,
                    file: "../wrong.jar",
                })),
            },
            { policy: "none" },
            { extra: true },
        ])
            expect(() =>
                validateBackupArtifacts(
                    { ...embedded, ...patch },
                    metadata.active,
                ),
            ).toThrow();
        expect(() =>
            validateBackupMetadata(
                { ...metadata, format: 1 },
                metadata.projectId,
            ),
        ).toThrow();
        expect(() =>
            validateBackupMetadata(
                { ...metadata, artifacts: undefined },
                metadata.projectId,
            ),
        ).toThrow();
        const empty = {
            ...metadata,
            active: { installation: null },
            artifacts: { policy: "all", files: [] },
        };
        expect(
            validateBackupMetadata(empty, metadata.projectId).artifacts?.files,
        ).toEqual([]);
        expect(() => selectedBackupArtifacts({ group: {} }, "all")).toThrow();
        await expect(
            stageInstallationArtifacts(
                metadata.active,
                [],
                "all",
                path.join(f.root, "stage"),
            ),
        ).rejects.toMatchObject({ code: "BACKUP_ARTIFACTS" });
    });

    it("keeps legacy snapshots dependent on their exact original artifacts", async () => {
        const f = await fixture("none");
        await f.extract();
        await f.removeOriginals();
        await expect(
            applyBackupRestore(
                f.project,
                f.source,
                { offline: true },
                f.store,
                f.backup,
            ),
        ).rejects.toThrow();
        expect((await readState(f.dir)).active?.id).toBe(f.active.id);
    });

    it("deduplicates group JARs and recovers every member using only embedded artifacts", async () => {
        const f = await backupGroupFixture();
        f.projects[0].manifest.backup.artifacts = "all";
        await expect(f.makeBackup()).rejects.toMatchObject({
            code: "BACKUP_GROUP_ARTIFACTS",
        });
        f.projects[1].manifest.backup.artifacts = "all";
        const backup = await f.makeBackup();
        const batch = { ...f.batch, backup };
        const snapshot = await backup.create(
            await collectGroupBackupMetadata("network", f.projects),
        );
        expect(snapshot.metadata.artifacts?.files).toHaveLength(1);
        const source = path.join(f.root, "extracted");
        await backup.restore(snapshot.snapshotId, { target: source });
        const shared = snapshot.metadata.roots.find(
            (root) => !root.id.startsWith("server-"),
        );
        if (!shared) throw new Error("Missing shared fixture root");
        const mappings = { [shared.id]: path.join(f.workspace, "shared") };
        const ensure = vi
            .spyOn(f.store, "ensure")
            .mockImplementation(async (_artifact, _context, seed) => {
                if (!seed) throw new Error("No cache or provider");
                return seed;
            });
        const artifactRoot = path.join(f.root, "artifacts");
        if (path.dirname(artifactRoot) !== f.root)
            throw new Error("Unsafe fixture cleanup");
        await rm(artifactRoot, { recursive: true });
        for (const project of f.projects)
            await put(project.dir, "runtime/world/players.dat", "changed");
        await expect(
            applyGroupBackupRestore(
                batch,
                source,
                {
                    offline: true,
                    mappings,
                    checkpoint: async (stage) => {
                        if (stage.endsWith(":complete"))
                            throw new Error("interrupted group");
                    },
                },
                f.store,
            ),
        ).rejects.toThrow();
        await recoverGroupBackupRestore(batch, f.store);
        expect(
            ensure.mock.calls.every(([, , seed]) => seed !== undefined),
        ).toBe(true);
        for (const project of f.projects)
            expect(
                await readFile(
                    path.join(project.dir, "runtime/world/players.dat"),
                    "utf8",
                ),
            ).toBe(`${project.manifest.name} original`);
    });
});
