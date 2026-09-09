import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    NodePostgresBackup,
    type PostgresRecovery,
} from "../../packages/adapters/src/database/postgres.js";
import * as properties from "../../packages/adapters/src/database/postgres-properties.js";
import { hashBackupFile } from "../../packages/adapters/src/filesystem/backup-files.js";
import type { PostgresBackupConfig } from "../../packages/core/src/domain/backup.js";
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
    user: "owner",
    password: { env: "FIXTURE_PASSWORD" },
};

afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupBackupTestDirectories();
});

async function fixture() {
    const root = await backupTestDirectory();
    const file = path.join(root, "archive.dump");
    await writeFile(
        file,
        "archive fixture: actual archive compatibility is covered by PG 17/18 service tests",
    );
    const { sha256 } = await hashBackupFile(file);
    const pg = new NodePostgresBackup(
        root,
        root,
        async () => "fixture",
        vi.fn(),
    );
    vi.spyOn(pg, "preflight").mockResolvedValue(17);
    vi.spyOn(pg, "verifyArchive").mockResolvedValue();
    const catalog = new Map<string, properties.PostgresProperties>([
        [config.database, postgresProperties()],
    ]);
    vi.spyOn(properties, "readPostgresProperties").mockImplementation(
        async (_client, _config, name) => {
            const value = catalog.get(name);
            return value ? structuredClone(value) : undefined;
        },
    );
    let saved: PostgresRecovery | undefined;
    let sessions = false;
    let lostAcknowledgement = false;
    const save = async (state: PostgresRecovery) => {
        saved = structuredClone(state);
    };
    const query = vi
        .spyOn(pg.client, "query")
        .mockImplementation(async (_config, sql) => {
            if (sql.includes("pg_stat_activity")) return sessions ? "t" : "f";
            for (const [, name, enabled] of sql.matchAll(
                /ALTER DATABASE "([^"]+)" ALLOW_CONNECTIONS (true|false)/gu,
            )) {
                const value = catalog.get(name as string);
                if (value) value.allowConnections = enabled === "true";
            }
            if (sql.startsWith("CREATE DATABASE")) {
                const name = /CREATE DATABASE "([^"]+)"/u.exec(sql)?.[1];
                if (!name) throw new Error("Missing staging name");
                catalog.set(
                    name,
                    postgresProperties({ name, oid: 20000, comment: null }),
                );
            }
            const marker =
                /COMMENT ON DATABASE "([^"]+)" IS E'(crafleet recovery [^']+)'/u.exec(
                    sql,
                );
            if (marker?.[1] && marker[2]) {
                const value = catalog.get(marker[1]);
                if (value) value.comment = marker[2];
            }
            if (sql.includes("OWNER TO") && saved) {
                const current = catalog.get(saved.staging);
                if (current)
                    catalog.set(saved.staging, {
                        ...saved.properties,
                        name: saved.staging,
                        oid: current.oid,
                        allowConnections: false,
                    });
            }
            if (sql.includes("RENAME TO") && saved) {
                const original = catalog.get(saved.target);
                const staging = catalog.get(saved.staging);
                if (!original || !staging)
                    throw new Error("Missing DB to rename");
                catalog.set(saved.retained, {
                    ...original,
                    name: saved.retained,
                });
                catalog.set(saved.target, { ...staging, name: saved.target });
                catalog.delete(saved.staging);
                if (lostAcknowledgement)
                    throw new Error("lost acknowledgement");
            }
            return "";
        });
    const restore = vi.spyOn(pg.client, "execute").mockResolvedValue("");
    return {
        pg,
        file,
        sha256,
        catalog,
        query,
        restore,
        save,
        saved: () => saved,
        busy: (value: boolean) => {
            sessions = value;
        },
        loseAck: () => {
            lostAcknowledgement = true;
        },
        prepare: () => pg.prepare(config, file, sha256, 17, saved, save),
    };
}

describe("PostgreSQL recovery boundaries", () => {
    it("recovers a committed rename without repeating the restore or losing the disabled original", async () => {
        const f = await fixture();
        const state = await f.prepare();
        f.busy(true);
        await expect(f.pg.switch(config, state, f.save)).rejects.toMatchObject({
            code: "DATABASE_CONNECTIONS",
        });
        expect(f.catalog.get(config.database)?.allowConnections).toBe(false);
        expect(
            f.query.mock.calls.some(([, sql]) =>
                /terminate_backend/u.test(sql),
            ),
        ).toBe(false);
        f.busy(false);
        f.loseAck();
        await expect(f.pg.switch(config, state, f.save)).rejects.toThrow(
            "lost acknowledgement",
        );
        const recovered = await f.prepare();
        await f.pg.switch(config, recovered, f.save);
        await f.pg.complete(config, recovered, f.save);
        await f.pg.verifyRecovery(config, recovered, f.sha256, 17);
        expect(f.restore).toHaveBeenCalledTimes(1);
        expect(f.catalog.get(config.database)?.oid).toBe(20000);
        expect(f.catalog.get(recovered.retained)).toMatchObject({
            oid: 16384,
            allowConnections: false,
        });
        expect(f.saved()?.phase).toBe("complete");
    });
    it("refuses changed names, OIDs, grants and archive identities before any additional mutation", async () => {
        const f = await fixture();
        const state = await f.prepare();
        const count = f.query.mock.calls.length;
        for (const patch of [
            { target: "other" },
            { staging: "other" },
            { originalOid: 9 },
            { stagingOid: state.originalOid },
            { stagingOid: 4294967296 },
            { sha256: "0".repeat(64) },
        ])
            await expect(
                f.pg.verifyRecovery(
                    config,
                    { ...state, ...patch },
                    f.sha256,
                    17,
                ),
            ).rejects.toMatchObject({ code: "DATABASE_IDENTITY" });
        f.catalog.set(state.target, postgresProperties({ oid: 999 }));
        await expect(f.prepare()).rejects.toMatchObject({
            code: "DATABASE_IDENTITY",
        });
        f.catalog.set(state.target, postgresProperties({ owner: "different" }));
        await expect(f.pg.switch(config, state, f.save)).rejects.toMatchObject({
            code: "DATABASE_IDENTITY",
        });
        expect(f.query.mock.calls.length).toBe(count);
    });
    it("holds preparation failures before any rename and resumes only the recorded staging database", async () => {
        const f = await fixture();
        f.restore.mockRejectedValueOnce(new Error("missing role or extension"));
        await expect(f.prepare()).rejects.toThrow("missing role or extension");
        expect(f.saved()?.phase).toBe("restoring");
        expect(f.catalog.get(config.database)?.allowConnections).toBe(true);
        expect(
            f.query.mock.calls.some(([, sql]) => sql.includes("RENAME TO")),
        ).toBe(false);
        const state = await f.prepare();
        expect(state.phase).toBe("ready");
        expect(f.restore).toHaveBeenCalledTimes(2);
        expect(f.catalog.size).toBe(2);
        await expect(
            f.pg.complete(config, state, f.save),
        ).rejects.toMatchObject({ code: "DATABASE_RECOVERY" });
        await expect(
            f.pg.switch(config, { ...state, phase: "restoring" }, f.save),
        ).rejects.toMatchObject({ code: "DATABASE_RECOVERY" });
    });
    it("does not reuse an unmarked staging database after an uncertain create acknowledgement", async () => {
        const f = await fixture();
        const implementation = f.query.getMockImplementation();
        f.query.mockImplementation(async (...args) => {
            if (args[1].startsWith("COMMENT ON"))
                throw new Error("lost before marker");
            return implementation ? implementation(...args) : "";
        });
        await expect(f.prepare()).rejects.toThrow("lost before marker");
        const state = f.saved();
        if (!state) throw new Error("Missing planned state");
        await expect(f.prepare()).rejects.toMatchObject({
            code: "DATABASE_IDENTITY",
        });
        expect(f.catalog.has(state.staging)).toBe(true);
        f.catalog.set(
            state.retained,
            postgresProperties({ name: state.retained, oid: 9 }),
        );
        await expect(f.prepare()).rejects.toMatchObject({
            code: "DATABASE_IDENTITY",
        });
        expect(f.restore).not.toHaveBeenCalled();
    });
    it("rejects disabled or missing originals and changed staging identities before restore", async () => {
        const f = await fixture();
        f.catalog.delete(config.database);
        await expect(f.prepare()).rejects.toMatchObject({
            code: "DATABASE_TARGET",
        });
        f.catalog.set(
            config.database,
            postgresProperties({ allowConnections: false }),
        );
        await expect(f.prepare()).rejects.toMatchObject({
            code: "DATABASE_TARGET",
        });
        f.catalog.set(config.database, postgresProperties());
        f.restore.mockRejectedValueOnce(new Error("interrupted"));
        await expect(f.prepare()).rejects.toThrow("interrupted");
        const state = f.saved();
        if (!state) throw new Error("Missing progress");
        const staged = f.catalog.get(state.staging);
        if (!staged) throw new Error("Missing staging");
        f.catalog.set(state.staging, { ...staged, oid: 90000 });
        await expect(f.prepare()).rejects.toMatchObject({
            code: "DATABASE_IDENTITY",
        });
        f.catalog.set(state.staging, staged);
        f.catalog.set(config.database, postgresProperties({ oid: 8 }));
        await expect(f.prepare()).rejects.toMatchObject({
            code: "DATABASE_IDENTITY",
        });
        expect(f.restore).toHaveBeenCalledTimes(1);
    });
    it("rejects a busy or incorrectly restored staging database before switching", async () => {
        const f = await fixture();
        f.busy(true);
        await expect(f.prepare()).rejects.toMatchObject({
            code: "DATABASE_CONNECTIONS",
        });
        f.busy(false);
        const implementation = f.query.getMockImplementation();
        f.query.mockImplementation(async (...args) =>
            args[1].includes("OWNER TO")
                ? ""
                : implementation
                  ? implementation(...args)
                  : "",
        );
        await expect(f.prepare()).rejects.toMatchObject({
            code: "DATABASE_PROPERTIES",
        });
        expect(f.catalog.get(config.database)?.oid).toBe(16384);
    });
});
