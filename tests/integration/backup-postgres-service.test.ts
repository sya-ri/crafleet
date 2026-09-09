import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
    applyBackupRestore,
    initProject,
    installProjects,
    loadProject,
    NodeArtifactStore,
    NodeBackupService,
    NodeDeploymentManager,
    NodeServerController,
    readRuntimeIntent,
    readState,
    recoverBackupRestore,
    writeYaml,
} from "@crafleet/adapters";
import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { NodeDatabaseBackupAdapter } from "../../packages/adapters/src/database/backup.js";
import {
    NodePostgresBackup,
    type PostgresRecovery,
} from "../../packages/adapters/src/database/postgres.js";
import { PostgresClient } from "../../packages/adapters/src/database/postgres-client.js";
import { readPostgresProperties } from "../../packages/adapters/src/database/postgres-properties.js";
import { runBackupProcess } from "../../packages/adapters/src/restic/process.js";
import type { PostgresBackupConfig } from "../../packages/core/src/domain/backup.js";
import { postgresService } from "../support/postgres-service.js";
import { artifactZip } from "./artifacts-fixture.js";
import { FixtureRestic, TEST_REPOSITORY_ID } from "./backup-fixtures.js";

describe.runIf(Boolean(process.env.CRAFLEET_TEST_POSTGRES_MAJOR))(
    "real PostgreSQL backup and OID-pinned replacement",
    () => {
        let service: Awaited<ReturnType<typeof postgresService>>;
        let pg: NodePostgresBackup;
        let config: PostgresBackupConfig;
        beforeAll(async () => {
            const major = Number(process.env.CRAFLEET_TEST_POSTGRES_MAJOR);
            if (major !== 17 && major !== 18)
                throw new Error("Select PostgreSQL 17 or 18 explicitly");
            service = await postgresService(major, runBackupProcess);
            pg = new NodePostgresBackup(
                service.root,
                path.join(service.root, "home"),
                async () => "disposable-crafleet-password",
                service.runner,
            );
            config = {
                id: "application",
                kind: "postgres",
                host: "127.0.0.1",
                database: "crafleet_test_application",
                user: "postgres",
                password: { env: "TEST_PASSWORD" },
                restore: {
                    user: "postgres",
                    password: { env: "RESTORE_PASSWORD" },
                    maintenanceDatabase: "postgres",
                },
            };
            expect(
                await pg.client.query(
                    config,
                    "SELECT bool_and(auth_method='scram-sha-256') FROM pg_hba_file_rules WHERE type='host'",
                ),
            ).toBe("t");
            await pg.client.query(
                config,
                "CREATE ROLE fixture_owner LOGIN PASSWORD 'disposable-crafleet-password'; CREATE ROLE fixture_reader LOGIN PASSWORD 'disposable-crafleet-password';",
            );
        }, 120000);
        afterAll(async () => {
            if (service) await service.cleanup();
        });

        afterEach((context) => {
            vi.restoreAllMocks();
            if (context.task.result?.state === "fail" && service)
                console.error(service.diagnostics.join("\n"));
        });

        it("preserves owner, database/object grants, settings and binary data while removing obsolete tables", async () => {
            await pg.client.query(
                config,
                "CREATE DATABASE crafleet_test_application OWNER fixture_owner;",
            );
            await pg.client.query(
                config,
                "REVOKE CONNECT ON DATABASE crafleet_test_application FROM PUBLIC; GRANT CONNECT ON DATABASE crafleet_test_application TO fixture_reader; ALTER DATABASE crafleet_test_application SET work_mem='12MB'; ALTER ROLE fixture_reader IN DATABASE crafleet_test_application SET statement_timeout='7s'; COMMENT ON DATABASE crafleet_test_application IS 'fixture 日本語';",
            );
            await pg.client.query(
                config,
                "SET ROLE fixture_owner; CREATE TABLE public.content(id integer PRIMARY KEY, payload bytea, note text); INSERT INTO public.content VALUES(1, decode('00ff0a01','hex'), '日本語'); GRANT SELECT ON public.content TO fixture_reader; RESET ROLE;",
                undefined,
                config.database,
            );
            const directory = path.join(service.root, "dump");
            await mkdir(directory);
            const adapter = new NodeDatabaseBackupAdapter(
                service.root,
                path.join(service.root, "home"),
                async () => "disposable-crafleet-password",
                service.runner,
            );
            const artifact = await adapter.dump(config, directory);
            expect(artifact.postgresMajor).toBe(
                Number(process.env.CRAFLEET_TEST_POSTGRES_MAJOR),
            );
            const file = path.join(directory, "application.dump");
            expect((await readFile(file)).subarray(0, 5).toString()).toBe(
                "PGDMP",
            );
            await pg.client.query(
                config,
                "UPDATE public.content SET note='changed'; CREATE TABLE public.obsolete(id integer);",
                undefined,
                config.database,
            );
            const before = await readPostgresProperties(
                pg.client,
                config,
                config.database,
            );
            const phases: string[] = [];
            let saved: PostgresRecovery | undefined;
            const save = async (state: PostgresRecovery) => {
                saved = structuredClone(state);
                phases.push(state.phase);
            };
            const state = await pg.prepare(
                config,
                file,
                artifact.sha256,
                artifact.postgresMajor as 17 | 18,
                undefined,
                save,
            );
            expect(
                await pg.client.query(
                    config,
                    "SELECT note FROM public.content",
                    undefined,
                    config.database,
                ),
            ).toBe("changed");
            await pg.switch(config, state, save);
            await pg.complete(config, state, save);
            expect(phases).toEqual([
                "planned",
                "created",
                "restoring",
                "ready",
                "blocked",
                "switched",
                "complete",
            ]);
            expect(saved?.phase).toBe("complete");
            if (!saved) throw new Error("Missing recovery state");
            expect(
                await pg.client.query(
                    config,
                    "SELECT encode(payload,'hex') || ':' || note FROM public.content",
                    undefined,
                    config.database,
                ),
            ).toBe("00ff0a01:日本語");
            expect(
                await pg.client.query(
                    config,
                    "SELECT to_regclass('public.obsolete') IS NULL",
                    undefined,
                    config.database,
                ),
            ).toBe("t");
            expect(
                await pg.client.query(
                    config,
                    "SELECT pg_get_userbyid(relowner) || ':' || has_table_privilege('fixture_reader','public.content','SELECT') FROM pg_class WHERE oid='public.content'::regclass",
                    undefined,
                    config.database,
                ),
            ).toBe("fixture_owner:true");
            const after = await readPostgresProperties(
                pg.client,
                config,
                config.database,
            );
            expect(after?.oid).not.toBe(before?.oid);
            expect(after?.owner).toBe("fixture_owner");
            expect(after?.settings).toEqual(before?.settings);
            expect(after?.acl).toEqual(before?.acl);
            expect(
                (
                    await readPostgresProperties(
                        pg.client,
                        config,
                        state.retained,
                    )
                )?.allowConnections,
            ).toBe(false);
            const corrupt = path.join(directory, "corrupt.dump");
            await writeFile(corrupt, (await readFile(file)).subarray(0, 400));
            await expect(
                pg.verifyArchive(
                    config,
                    corrupt,
                    artifact.postgresMajor as 17 | 18,
                ),
            ).rejects.toThrow();
            await expect(
                pg.prepare(
                    config,
                    file,
                    "f".repeat(64),
                    artifact.postgresMajor as 17 | 18,
                    saved,
                    save,
                ),
            ).rejects.toMatchObject({ code: "DATABASE_IDENTITY" });
        }, 120000);

        it("keeps the world and PostgreSQL consistent through backup apply and journal recovery after a lost switch acknowledgement", async () => {
            const root = path.join(service.root, "coordinator");
            const dir = path.join(root, "project");
            const home = path.join(root, "home");
            const repository = path.join(root, "repository");
            await mkdir(repository, { recursive: true });
            const selected: PostgresBackupConfig = {
                ...config,
                id: "coordinated",
                database: "crafleet_test_coordinated",
            };
            await pg.client.query(
                selected,
                "CREATE DATABASE crafleet_test_coordinated OWNER fixture_owner;",
            );
            await pg.client.query(
                selected,
                "SET ROLE fixture_owner; CREATE TABLE public.content(id integer PRIMARY KEY,note text); INSERT INTO public.content VALUES (1,'snapshot'); RESET ROLE;",
                undefined,
                selected.database,
            );
            const manifest = await initProject(dir, {
                name: "lobby",
                kind: "velocity",
                version: "4.1.1",
                source: "file:imports/server.jar",
            });
            manifest.backup = {
                files: ["runtime/**", "!**/*.jar"],
                databases: [selected],
            };
            await writeYaml(path.join(dir, "crafleet.yaml"), manifest);
            await mkdir(path.join(dir, "imports"), { recursive: true });
            await writeFile(
                path.join(dir, "imports/server.jar"),
                artifactZip([
                    {
                        name: "META-INF/MANIFEST.MF",
                        content: "Manifest-Version: 1.0\n",
                    },
                ]),
            );
            const project = await loadProject(dir, home);
            const store = new NodeArtifactStore(home);
            await installProjects([project], store, { offline: true });
            await new NodeDeploymentManager(project, store).applyPrepared();
            await mkdir(path.join(dir, "runtime/world"), { recursive: true });
            const world = path.join(dir, "runtime/world/level.dat");
            await writeFile(world, "snapshot-world");
            const originalExecute = PostgresClient.prototype.execute;
            const originalMajor = PostgresClient.prototype.major;
            // Replace only transport/credentials with the disposable service;
            // every PostgreSQL statement still reaches the actual database.
            vi.spyOn(PostgresClient.prototype, "execute").mockImplementation(
                (c, tool, args, options) =>
                    originalExecute.call(pg.client, c, tool, args, options),
            );
            vi.spyOn(PostgresClient.prototype, "major").mockImplementation(
                (c, admin, signal) =>
                    originalMajor.call(pg.client, c, admin, signal),
            );
            const engine = new FixtureRestic();
            const backup = new NodeBackupService(
                dir,
                home,
                {
                    ...manifest.backup,
                    projectId: manifest.id ?? "coordinated-fixture",
                    repository: "local",
                    repositories: {
                        local: {
                            path: repository,
                            password: { env: "TEST_RESTIC" },
                            id: TEST_REPOSITORY_ID,
                        },
                    },
                },
                async () => "fixture-repository-password",
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
            const active = (await readState(dir)).active;
            const snapshot = await backup.create({ installation: active });
            const extraction = path.join(root, "extraction");
            await backup.restore(snapshot.snapshotId, { target: extraction });
            await writeFile(world, "current-world");
            await pg.client.query(
                selected,
                "UPDATE public.content SET note='current'; CREATE TABLE public.obsolete(id integer);",
                undefined,
                selected.database,
            );
            const originalQuery = PostgresClient.prototype.query;
            let lost = false;
            vi.spyOn(PostgresClient.prototype, "query").mockImplementation(
                async function (
                    this: PostgresClient,
                    c,
                    sql,
                    signal,
                    database,
                ) {
                    const result = await originalQuery.call(
                        this,
                        c,
                        sql,
                        signal,
                        database,
                    );
                    if (!lost && sql.includes("RENAME TO")) {
                        lost = true;
                        throw new Error(
                            "Lost committed switch acknowledgement",
                        );
                    }
                    return result;
                },
            );
            await expect(
                applyBackupRestore(
                    project,
                    extraction,
                    { offline: true, databases: [selected.id] },
                    store,
                    backup,
                ),
            ).rejects.toMatchObject({ code: "RESTORE_INTERRUPTED" });
            expect(await readFile(world, "utf8")).toBe("snapshot-world");
            expect((await readRuntimeIntent(dir))?.desired).toBe("stopped");
            const journal = JSON.parse(
                await readFile(
                    path.join(dir, ".crafleet/restore.json"),
                    "utf8",
                ),
            );
            expect(journal.postgres.coordinated.phase).toBe("blocked");
            expect(engine.snapshots.size).toBe(2);
            expect(await recoverBackupRestore(project, store, backup)).toBe(
                true,
            );
            expect(
                await pg.client.query(
                    selected,
                    "SELECT note FROM public.content",
                    undefined,
                    selected.database,
                ),
            ).toBe("snapshot");
            expect(
                await pg.client.query(
                    selected,
                    "SELECT to_regclass('public.obsolete') IS NULL",
                    undefined,
                    selected.database,
                ),
            ).toBe("t");
            expect(
                (await new NodeServerController(dir, home).status()).status,
            ).toBe("stopped");
            const receipt = JSON.parse(
                await readFile(
                    path.join(
                        dir,
                        `.crafleet/restore-completed/${journal.nextInstallationId}.json`,
                    ),
                    "utf8",
                ),
            );
            expect(receipt.postgres.coordinated.phase).toBe("complete");
            expect(
                (
                    await readPostgresProperties(
                        pg.client,
                        selected,
                        receipt.postgres.coordinated.retained,
                    )
                )?.allowConnections,
            ).toBe(false);
        }, 180000);

        async function recoveryFixture(label: string) {
            const selected: PostgresBackupConfig = {
                ...config,
                id: label,
                database: `crafleet_test_${label}`,
            };
            await pg.client.query(
                selected,
                `CREATE DATABASE ${selected.database} OWNER fixture_owner;`,
            );
            await pg.client.query(
                selected,
                "SET ROLE fixture_owner; CREATE TABLE public.content(id integer PRIMARY KEY, note text); INSERT INTO public.content VALUES (1,'snapshot'); RESET ROLE;",
                undefined,
                selected.database,
            );
            const directory = path.join(service.root, label);
            await mkdir(directory);
            const artifact = await new NodeDatabaseBackupAdapter(
                service.root,
                path.join(service.root, "home"),
                async () => "disposable-crafleet-password",
                service.runner,
            ).dump(selected, directory);
            await pg.client.query(
                selected,
                "UPDATE public.content SET note='current';",
                undefined,
                selected.database,
            );
            return {
                selected,
                artifact,
                file: path.join(directory, `${label}.dump`),
            };
        }

        it.each([
            "created",
            "restoring",
            "ready",
            "blocked",
            "switched",
            "complete",
        ] as const)(
            "resumes after interruption at %s without losing the retained DB",
            async (phase) => {
                const f = await recoveryFixture(`phase_${phase}`);
                let saved: PostgresRecovery | undefined;
                let interrupted = false;
                const save = async (state: PostgresRecovery) => {
                    saved = structuredClone(state);
                    if (!interrupted && state.phase === phase) {
                        interrupted = true;
                        throw new Error("injected checkpoint");
                    }
                };
                const run = async () => {
                    const state = await pg.prepare(
                        f.selected,
                        f.file,
                        f.artifact.sha256,
                        f.artifact.postgresMajor as 17 | 18,
                        saved,
                        save,
                    );
                    await pg.switch(f.selected, state, save);
                    await pg.complete(f.selected, state, save);
                };
                await expect(run()).rejects.toThrow("injected checkpoint");
                await run();
                expect(saved?.phase).toBe("complete");
                if (!saved) throw new Error("Missing recovery state");
                expect(
                    await pg.client.query(
                        f.selected,
                        "SELECT note FROM public.content",
                        undefined,
                        f.selected.database,
                    ),
                ).toBe("snapshot");
                expect(
                    (
                        await readPostgresProperties(
                            pg.client,
                            f.selected,
                            saved.retained,
                        )
                    )?.allowConnections,
                ).toBe(false);
            },
            120000,
        );

        it("blocks new connections and waits for external sessions without terminating them", async () => {
            const f = await recoveryFixture("external");
            let saved: PostgresRecovery | undefined;
            const save = async (state: PostgresRecovery) => {
                saved = structuredClone(state);
            };
            const state = await pg.prepare(
                f.selected,
                f.file,
                f.artifact.sha256,
                f.artifact.postgresMajor as 17 | 18,
                undefined,
                save,
            );
            const external = pg.client.query(
                f.selected,
                "SELECT pg_sleep(15);",
                undefined,
                f.selected.database,
            );
            for (let i = 0; i < 20; i++) {
                if (
                    (await pg.client.query(
                        f.selected,
                        `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname='${f.selected.database}');`,
                    )) === "t"
                )
                    break;
            }
            await expect(
                pg.switch(f.selected, state, save),
            ).rejects.toMatchObject({ code: "DATABASE_CONNECTIONS" });
            expect(
                (
                    await readPostgresProperties(
                        pg.client,
                        f.selected,
                        f.selected.database,
                    )
                )?.allowConnections,
            ).toBe(false);
            await expect(external).resolves.toBe("");
            await pg.prepare(
                f.selected,
                f.file,
                f.artifact.sha256,
                f.artifact.postgresMajor as 17 | 18,
                saved,
                save,
            );
            if (!saved) throw new Error("Missing recovery state");
            await pg.switch(f.selected, saved, save);
            await pg.complete(f.selected, saved, save);
            expect(
                await pg.client.query(
                    f.selected,
                    "SELECT note FROM public.content",
                    undefined,
                    f.selected.database,
                ),
            ).toBe("snapshot");
        }, 120000);

        it("supports a database owner with CREATEDB and tablespace access without a superuser", async () => {
            const f = await recoveryFixture("owner_restore");
            await pg.client.query(
                config,
                "ALTER ROLE fixture_owner CREATEDB; GRANT CREATE ON TABLESPACE pg_default TO fixture_owner;",
            );
            try {
                const selected = {
                    ...f.selected,
                    restore: {
                        user: "fixture_owner",
                        password: { env: "TEST_PASSWORD" },
                        maintenanceDatabase: "postgres",
                    },
                };
                expect(await pg.preflight(selected, true)).toBe(
                    f.artifact.postgresMajor,
                );
                const state = await pg.prepare(
                    selected,
                    f.file,
                    f.artifact.sha256,
                    f.artifact.postgresMajor as 17 | 18,
                    undefined,
                    async () => {},
                );
                await pg.switch(selected, state, async () => {});
                await pg.complete(selected, state, async () => {});
                expect(
                    await pg.client.query(
                        selected,
                        "SELECT note FROM public.content",
                        undefined,
                        selected.database,
                    ),
                ).toBe("snapshot");
                expect(
                    await pg.client.query(
                        config,
                        "SELECT rolsuper FROM pg_roles WHERE rolname='fixture_owner'",
                    ),
                ).toBe("f");
            } finally {
                await pg.client.query(
                    config,
                    "ALTER ROLE fixture_owner NOCREATEDB; REVOKE CREATE ON TABLESPACE pg_default FROM fixture_owner;",
                );
            }
        }, 120000);

        it("rejects an unavailable extension before switching and can resume when it is installed", async () => {
            const f = await recoveryFixture("extension_restore");
            const shared = await runBackupProcess({
                executable: "docker",
                args: ["exec", service.id, "pg_config", "--sharedir"],
            });
            const directory = shared.stdout.trim();
            if (
                shared.exitCode ||
                !/^\/usr\/share\/postgresql\/\d+$/u.test(directory)
            )
                throw new Error("Unexpected fixture extension directory");
            await writeFile(
                path.join(service.root, "fixture.control"),
                "default_version = '1.0'\nrelocatable = true\n",
            );
            await writeFile(
                path.join(service.root, "fixture.sql"),
                "CREATE TABLE extension_content(id integer);\n",
            );
            const control = `${directory}/extension/crafleet_fixture.control`;
            const installControl = async () => {
                const installed = await runBackupProcess({
                    executable: "docker",
                    args: [
                        "exec",
                        service.id,
                        "install",
                        "-m",
                        "644",
                        "/crafleet-tests/fixture.control",
                        control,
                    ],
                });
                if (installed.exitCode)
                    throw new Error(
                        "Could not install fixture extension control",
                    );
            };
            await installControl();
            const installed = await runBackupProcess({
                executable: "docker",
                args: [
                    "exec",
                    service.id,
                    "install",
                    "-m",
                    "644",
                    "/crafleet-tests/fixture.sql",
                    `${directory}/extension/crafleet_fixture--1.0.sql`,
                ],
            });
            if (installed.exitCode)
                throw new Error("Could not install fixture extension SQL");
            await pg.client.query(
                f.selected,
                "CREATE EXTENSION crafleet_fixture WITH SCHEMA public;",
                undefined,
                f.selected.database,
            );
            const dumpDirectory = path.join(service.root, "extension-dump");
            await mkdir(dumpDirectory);
            const dump = await pg.dump(f.selected, dumpDirectory);
            const removed = await runBackupProcess({
                executable: "docker",
                args: ["exec", service.id, "rm", "--", control],
            });
            if (removed.exitCode)
                throw new Error("Could not remove test-only extension control");
            let saved: PostgresRecovery | undefined;
            const save = async (state: PostgresRecovery) => {
                saved = structuredClone(state);
            };
            const prepare = () =>
                pg.prepare(
                    f.selected,
                    path.join(dumpDirectory, `${f.selected.id}.dump`),
                    dump.sha256,
                    dump.postgresMajor as 17 | 18,
                    saved,
                    save,
                );
            await expect(prepare()).rejects.toMatchObject({
                code: "DATABASE_POSTGRES",
            });
            expect(saved?.phase).toBe("restoring");
            expect(
                await pg.client.query(
                    f.selected,
                    "SELECT note FROM public.content",
                    undefined,
                    f.selected.database,
                ),
            ).toBe("current");
            await installControl();
            expect((await prepare()).phase).toBe("ready");
        }, 120000);

        it("does not grant privileges and rejects a missing object owner before switching", async () => {
            const f = await recoveryFixture("permissions");
            await expect(
                pg.preflight(
                    {
                        ...f.selected,
                        restore: {
                            user: "fixture_owner",
                            password: { env: "TEST_PASSWORD" },
                            maintenanceDatabase: "postgres",
                        },
                    },
                    true,
                ),
            ).rejects.toMatchObject({ code: "DATABASE_PERMISSIONS" });
            expect(
                await pg.client.query(
                    f.selected,
                    "SELECT rolcreatedb FROM pg_roles WHERE rolname='fixture_owner'",
                ),
            ).toBe("f");
            await pg.client.query(f.selected, "CREATE ROLE fixture_missing;");
            await pg.client.query(
                f.selected,
                "ALTER TABLE public.content OWNER TO fixture_missing;",
                undefined,
                f.selected.database,
            );
            const directory = path.join(service.root, "missing");
            await mkdir(directory);
            const artifact = await new NodeDatabaseBackupAdapter(
                service.root,
                path.join(service.root, "home"),
                async () => "disposable-crafleet-password",
                service.runner,
            ).dump(f.selected, directory);
            await pg.client.query(
                f.selected,
                "ALTER TABLE public.content OWNER TO fixture_owner;",
                undefined,
                f.selected.database,
            );
            await pg.client.query(f.selected, "DROP ROLE fixture_missing;");
            let saved: PostgresRecovery | undefined;
            const save = async (state: PostgresRecovery) => {
                saved = structuredClone(state);
            };
            const file = path.join(directory, `${f.selected.id}.dump`);
            await expect(
                pg.prepare(
                    f.selected,
                    file,
                    artifact.sha256,
                    artifact.postgresMajor as 17 | 18,
                    undefined,
                    save,
                ),
            ).rejects.toMatchObject({ code: "DATABASE_POSTGRES" });
            expect(
                await pg.client.query(
                    f.selected,
                    "SELECT note FROM public.content",
                    undefined,
                    f.selected.database,
                ),
            ).toBe("current");
            expect(saved?.phase).toBe("restoring");
            await pg.client.query(f.selected, "CREATE ROLE fixture_missing;");
            const state = await pg.prepare(
                f.selected,
                file,
                artifact.sha256,
                artifact.postgresMajor as 17 | 18,
                saved,
                save,
            );
            expect(state.phase).toBe("ready");
            await expect(
                pg.prepare(
                    f.selected,
                    file,
                    artifact.sha256,
                    artifact.postgresMajor === 17 ? 18 : 17,
                    saved,
                    save,
                ),
            ).rejects.toMatchObject({ code: "DATABASE_IDENTITY" });
        }, 120000);
    },
);
