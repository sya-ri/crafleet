import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeDatabaseBackupAdapter } from "../../packages/adapters/src/database/backup.js";
import {
    NodePostgresBackup,
    type PostgresRecovery,
} from "../../packages/adapters/src/database/postgres.js";
import {
    PostgresClient,
    pgIdentifier,
    pgLiteral,
} from "../../packages/adapters/src/database/postgres-client.js";
import {
    createPostgresDatabase,
    postgresPropertyStatements,
    readPostgresProperties,
    samePostgresProperties,
} from "../../packages/adapters/src/database/postgres-properties.js";
import { hashBackupFile } from "../../packages/adapters/src/filesystem/backup-files.js";
import { validateBackupMetadata } from "../../packages/adapters/src/restic/metadata.js";
import type {
    BackupProcessRequest,
    BackupProcessRunner,
} from "../../packages/adapters/src/restic/process.js";
import type { PostgresBackupConfig } from "../../packages/core/src/domain/backup.js";
import { validateProject } from "../../packages/core/src/domain/project.js";
import { postgresProperties } from "../support/postgres-fixtures.js";
import {
    backupTestDirectory,
    cleanupBackupTestDirectories,
} from "./backup-fixtures.js";

const config: PostgresBackupConfig = {
    id: "db",
    kind: "postgres",
    host: "localhost",
    database: "application",
    user: "backup",
    password: { env: "PG_TEST_SECRET" },
    restore: {
        user: "owner",
        password: { env: "PG_RESTORE_SECRET" },
        maintenanceDatabase: "postgres",
    },
};
afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await cleanupBackupTestDirectories();
});

describe("PostgreSQL configuration and private official-client invocation", () => {
    it("validates the declarative adapter and quotes identifiers and literals", () => {
        expect(
            validateProject({
                schemaVersion: 1,
                name: "lobby",
                server: { type: "velocity", version: "4.1.1" },
                plugins: {},
                backup: { files: ["runtime/**"], databases: [config] },
            }).backup?.databases?.[0],
        ).toEqual(config);
        expect(pgIdentifier('a"b')).toBe('"a""b"');
        expect(pgLiteral("a'\\b")).toBe("E'a''\\\\b'");
        for (const value of ["", "x\0y", "a\nb", "日".repeat(22)])
            expect(() => pgIdentifier(value)).toThrow();
        expect(() => pgLiteral("a\0b")).toThrow();
    });
    it("uses private password files, separate restore credentials, verified TLS, and a clean PG environment", async () => {
        const root = await backupTestDirectory();
        const requests: BackupProcessRequest[] = [];
        const files: string[] = [];
        vi.stubEnv("PGPASSWORD", "ambient-password");
        vi.stubEnv("PGSERVICE", "ambient-service");
        vi.stubEnv("PG_TEST_SECRET", "backup-secret");
        vi.stubEnv("PG_RESTORE_SECRET", "admin-secret");
        const runner: BackupProcessRunner = async (request) => {
            requests.push(request);
            expect(request.env?.PGPASSWORD).toBeUndefined();
            expect(request.env?.PGSERVICE).toBeUndefined();
            expect(request.env?.PG_TEST_SECRET).toBeUndefined();
            expect(request.env?.PG_RESTORE_SECRET).toBeUndefined();
            expect(JSON.stringify(request.args)).not.toContain("secret");
            const file = request.env?.PGPASSFILE;
            if (!file) throw new Error("Missing password file");
            files.push(file);
            expect(await readFile(file, "utf8")).toContain(
                request.env?.PGUSER === "owner"
                    ? "admin\\:secret\\\\value"
                    : "backup\\:secret\\\\value",
            );
            return { exitCode: 0, stdout: " result \n", stderr: "" };
        };
        const client = new PostgresClient(
            root,
            root,
            async (ref) =>
                "env" in ref && ref.env === "PG_RESTORE_SECRET"
                    ? "admin:secret\\value"
                    : "backup:secret\\value",
            runner,
        );
        const ca = path.join(root, "ca.pem");
        await writeFile(ca, "fixture certificate");
        const remote = {
            ...config,
            host: "database.example",
            sslCa: "ca.pem",
            queryCommand: "bin/psql",
            command: "custom-pg-dump",
            restoreCommand: "bin/pg_restore",
        };
        await client.execute(remote, "pg_dump", ["--format=custom"]);
        expect(await client.query(remote, "SELECT 1")).toBe("result");
        expect(requests[0]?.env?.PGSSLMODE).toBe("verify-full");
        expect(requests[0]?.env?.PGSSLROOTCERT).toBe(ca);
        expect(requests[1]?.env?.PGDATABASE).toBe("postgres");
        expect(client.executable(remote, "pg_restore")).toBe(
            path.join(root, "bin/pg_restore"),
        );
        for (const file of files)
            await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    });
    it.each(["", "bad\nsecret", "x".repeat(65537)])(
        "rejects unsupported password values",
        async (password) => {
            const root = await backupTestDirectory();
            const runner = vi.fn();
            const client = new PostgresClient(
                root,
                root,
                async () => password,
                runner,
            );
            await expect(
                client.execute(config, "psql", []),
            ).rejects.toMatchObject({ code: "BACKUP_SECRET" });
            expect(runner).not.toHaveBeenCalled();
        },
    );
    it("validates TCP/TLS targets and client versions before mutation", async () => {
        const root = await backupTestDirectory();
        const runner = vi.fn<BackupProcessRunner>(async (request) => ({
            exitCode: 0,
            stdout:
                request.args[0] === "--version"
                    ? `${request.executable} (PostgreSQL) 17.6\n`
                    : "170006\n",
            stderr: "",
        }));
        const client = new PostgresClient(
            root,
            root,
            async () => "secret",
            runner,
        );
        for (const patch of [
            { host: "remote" },
            { host: "/socket" },
            { port: 0 },
            { port: 65536 },
            { database: "postgres" },
            { database: "template0" },
        ])
            expect(() => client.validate({ ...config, ...patch })).toThrow();
        const direct = { ...config, host: "::1" };
        delete direct.restore;
        client.validate(direct);
        client.validate({ ...config, host: "2001:db8::1", sslCa: "ca.pem" });
        vi.stubEnv("PGPASSWORD", "ambient");
        vi.stubEnv("PG_TEST_SECRET", "backup");
        vi.stubEnv("PG_RESTORE_SECRET", "restore");
        expect(await client.major(config, true)).toBe(17);
        for (const [request] of runner.mock.calls) {
            expect(request.env?.PGPASSWORD).toBeUndefined();
            expect(request.env?.PG_TEST_SECRET).toBeUndefined();
            expect(request.env?.PG_RESTORE_SECRET).toBeUndefined();
        }
        runner.mockImplementation(async () => ({
            exitCode: 0,
            stdout: "180006",
            stderr: "",
        }));
        await expect(client.major(config, false)).rejects.toMatchObject({
            code: "DATABASE_CLIENT",
        });
        runner.mockImplementation(async () => ({
            exitCode: 0,
            stdout: "160000",
            stderr: "",
        }));
        await expect(client.major(config, false)).rejects.toMatchObject({
            code: "DATABASE_VERSION",
        });
        runner.mockResolvedValue({
            exitCode: 1,
            stdout: "",
            stderr: "sensitive server output",
        });
        await expect(client.execute(config, "psql", [])).rejects.not.toThrow(
            "sensitive",
        );
        await expect(
            client.execute({ ...config, sslCa: root }, "psql", []),
        ).rejects.toMatchObject({ code: "DATABASE_TLS" });
    });
});

describe("PostgreSQL catalog preservation", () => {
    it.each(["b", "c", "i"] as const)(
        "retains %s locale and safe database settings",
        (provider) => {
            const properties = postgresProperties({
                provider,
                locale: provider === "c" ? null : "C.UTF-8",
                icuRules: provider === "i" ? "&a < b" : null,
                collationVersion: "1",
                comment: "quote ' 日本語",
                settings: [
                    { role: null, values: ["work_mem=12MB"] },
                    {
                        role: "reader",
                        values: ["search_path=public, pg_catalog"],
                    },
                ],
            });
            const create = createPostgresDatabase("staged", properties);
            expect(create).toContain("TEMPLATE template0");
            expect(create).toContain("COLLATION_VERSION");
            const apply = postgresPropertyStatements("staged", properties);
            expect(apply).toContain('ALTER DATABASE "staged" OWNER TO "owner"');
            expect(apply).toContain(
                'ALTER ROLE "reader" IN DATABASE "staged" SET search_path',
            );
            expect(apply).toContain("quote '' 日本語");
            expect(
                samePostgresProperties(
                    {
                        ...properties,
                        oid: 999,
                        name: "different",
                        allowConnections: false,
                        acl: [...properties.acl].reverse(),
                    },
                    properties,
                ),
            ).toBe(true);
            expect(
                samePostgresProperties(
                    { ...properties, owner: "changed" },
                    properties,
                ),
            ).toBe(false);
        },
    );
    it("preserves delegated grantors and rejects impossible grant chains and malformed settings", () => {
        const properties = postgresProperties({
            acl: [
                {
                    grantee: "reader",
                    grantor: "delegate",
                    privilege: "CONNECT",
                    grantable: false,
                },
                {
                    grantee: "delegate",
                    grantor: "owner",
                    privilege: "CONNECT",
                    grantable: true,
                },
            ],
        });
        const sql = postgresPropertyStatements("staged", properties);
        expect(sql.indexOf('SET ROLE "owner"')).toBeLessThan(
            sql.indexOf('SET ROLE "delegate"'),
        );
        expect(sql).toContain("WITH GRANT OPTION");
        expect(() =>
            postgresPropertyStatements("staged", {
                ...properties,
                acl: properties.acl.slice(0, 1),
            }),
        ).toThrow();
        for (const setting of ["missing", "invalid;key=x"])
            expect(() =>
                postgresPropertyStatements(
                    "staged",
                    postgresProperties({
                        settings: [{ role: null, values: [setting] }],
                    }),
                ),
            ).toThrow();
    });
    it("validates catalog records without exposing malformed input", async () => {
        const root = await backupTestDirectory();
        const client = new PostgresClient(
            root,
            root,
            async () => "secret",
            vi.fn(),
        );
        const query = vi.spyOn(client, "query");
        query.mockResolvedValue("");
        expect(
            await readPostgresProperties(client, config, "missing"),
        ).toBeUndefined();
        for (const value of ["bad json", "null", '{"oid":"password"}']) {
            query.mockResolvedValue(value);
            await expect(
                readPostgresProperties(client, config, "application"),
            ).rejects.toMatchObject({ code: "DATABASE_METADATA" });
        }
        query.mockResolvedValue(JSON.stringify(postgresProperties()));
        expect(
            await readPostgresProperties(client, config, "application"),
        ).toEqual(postgresProperties());
    });
});

describe("PostgreSQL archives and coordinator boundary", () => {
    it("verifies full archive reads and refuses different majors, hashes and standalone replacement", async () => {
        const root = await backupTestDirectory();
        const directory = path.join(root, "dumps");
        await mkdir(directory);
        const runner = vi.fn<BackupProcessRunner>(async (request) => {
            if (request.args[0] === "--version")
                return {
                    exitCode: 0,
                    stdout: `${request.executable} (PostgreSQL) 17.6`,
                    stderr: "",
                };
            if (request.executable === "pg_dump") {
                const file = request.args
                    .find((arg) => arg.startsWith("--file="))
                    ?.slice(7);
                if (file) await writeFile(file, "PGDMP fixture");
            }
            return {
                exitCode: 0,
                stdout: request.args.includes("--list")
                    ? ";     Dumped from database version: 17.6\n"
                    : request.executable === "psql"
                      ? "170006"
                      : "",
                stderr: "",
            };
        });
        const adapter = new NodeDatabaseBackupAdapter(
            root,
            root,
            async () => "secret",
            runner,
        );
        const artifact = await adapter.dump(config, directory);
        expect(artifact).toMatchObject({
            kind: "postgres",
            file: "databases/db.dump",
            postgresMajor: 17,
        });
        const pg = new NodePostgresBackup(
            root,
            root,
            async () => "secret",
            runner,
        );
        await expect(
            pg.verifyArchive(config, path.join(directory, "db.dump"), 18),
        ).rejects.toMatchObject({ code: "DATABASE_VERSION" });
        await expect(
            pg.verifyArchive(config, directory, 17),
        ).rejects.toMatchObject({ code: "DATABASE_DUMP" });
        await expect(pg.dump(config, directory)).rejects.toMatchObject({
            code: "DATABASE_DESTINATION",
        });
        await expect(
            adapter.restore(config, path.join(directory, "db.dump"), {
                confirm: true,
            }),
        ).rejects.toMatchObject({ code: "DATABASE_RESTORE_COORDINATOR" });
        const metadata = {
            format: 1,
            projectId: "fixture",
            createdAt: new Date().toISOString(),
            active: {},
            roots: [
                {
                    id: "runtime",
                    path: root,
                    external: false,
                    kind: "directory",
                },
            ],
            files: [],
            databases: [artifact],
        };
        expect(
            validateBackupMetadata(metadata, "fixture").databases[0],
        ).toEqual(artifact);
        expect(() =>
            validateBackupMetadata(
                {
                    ...metadata,
                    databases: [{ ...artifact, postgresMajor: 16 }],
                },
                "fixture",
            ),
        ).toThrow();
        vi.spyOn(pg, "preflight").mockResolvedValue(17);
        await expect(
            pg.prepare(
                config,
                path.join(directory, "db.dump"),
                "f".repeat(64),
                17,
                undefined,
                async () => {},
            ),
        ).rejects.toMatchObject({ code: "RESTORE_HASH" });
        await expect(
            pg.prepare(
                config,
                path.join(directory, "db.dump"),
                artifact.sha256,
                18,
                undefined,
                async () => {},
            ),
        ).rejects.toMatchObject({ code: "DATABASE_VERSION" });
        await expect(
            pg.verifyRecovery(
                config,
                {} as PostgresRecovery,
                artifact.sha256,
                17,
            ),
        ).rejects.toMatchObject({ code: "DATABASE_IDENTITY" });
        expect(
            (await hashBackupFile(path.join(directory, "db.dump"))).sha256,
        ).toBe(artifact.sha256);
    });
});
