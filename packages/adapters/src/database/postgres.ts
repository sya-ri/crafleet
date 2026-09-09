import { randomUUID } from "node:crypto";
import { chmod, lstat } from "node:fs/promises";
import { devNull } from "node:os";
import path from "node:path";
import {
    type BackupSecretResolver,
    CrafleetError,
    type DatabaseBackupArtifact,
    type PostgresBackupConfig,
} from "@crafleet/core";
import { type } from "arktype";
import { hashBackupFile } from "../filesystem/backup-files.js";
import { assertNoSymlinks, exists } from "../filesystem/io.js";
import {
    type BackupProcessRunner,
    runBackupProcess,
} from "../restic/process.js";
import { backupSecretResolver } from "../restic/secrets.js";
import {
    pgIdentifier as ident,
    pgLiteral as literal,
    PostgresClient,
} from "./postgres-client.js";
import {
    createPostgresDatabase,
    type PostgresProperties,
    PostgresPropertiesSchema,
    postgresPropertyStatements,
    readPostgresProperties,
    samePostgresProperties,
} from "./postgres-properties.js";

export const PostgresRecoverySchema = type({
    "+": "reject",
    id: "string > 0",
    operation: "string.uuid",
    target: "string > 0",
    originalOid: "0 < number.integer <= 4294967295",
    staging: "string > 0",
    retained: "string > 0",
    "stagingOid?": "0 < number.integer <= 4294967295",
    sha256: /^[a-f0-9]{64}$/u,
    major: "17 | 18",
    properties: PostgresPropertiesSchema,
    phase: "'planned' | 'created' | 'restoring' | 'ready' | 'blocked' | 'switched' | 'complete'",
});
export type PostgresRecovery = typeof PostgresRecoverySchema.infer;
type Save = (state: PostgresRecovery) => Promise<void>;

export class NodePostgresBackup {
    readonly client: PostgresClient;
    async verifyRecovery(
        config: PostgresBackupConfig,
        state: PostgresRecovery,
        sha256: string,
        major: 17 | 18,
        signal?: AbortSignal,
    ): Promise<void> {
        this.validateState(config, state, sha256, major);
        if (["ready", "blocked", "switched", "complete"].includes(state.phase))
            await this.identify(config, state, signal);
    }
    constructor(
        projectDir: string,
        home: string,
        secrets: BackupSecretResolver = backupSecretResolver(projectDir),
        runner: BackupProcessRunner = runBackupProcess,
    ) {
        this.client = new PostgresClient(projectDir, home, secrets, runner);
    }

    async preflight(
        config: PostgresBackupConfig,
        restore = false,
        signal?: AbortSignal,
    ): Promise<17 | 18> {
        const major = await this.client.major(config, restore, signal);
        if (restore) {
            const result = await this.client.query(
                config,
                `SELECT (r.rolsuper OR (r.rolcreatedb AND pg_has_role(current_user, d.datdba, 'SET') AND has_tablespace_privilege(current_user, d.dattablespace, 'CREATE'))) AND NOT d.datistemplate AND NOT EXISTS (SELECT 1 FROM pg_shseclabel WHERE objoid=d.oid AND classoid='pg_database'::regclass) FROM pg_database d CROSS JOIN pg_roles r WHERE d.datname=${literal(config.database)} AND r.rolname=current_user;`,
                signal,
            );
            if (result !== "t")
                throw new CrafleetError(
                    "DATABASE_PERMISSIONS",
                    "Restoration requires an existing ordinary database, CREATEDB, CREATE on its tablespace, and permission to act as its owner. Database security labels require a separate recovery strategy; privileges are never granted automatically.",
                    3,
                );
        }
        return major;
    }

    async verifyArchive(
        config: PostgresBackupConfig,
        file: string,
        major: 17 | 18,
        signal?: AbortSignal,
    ): Promise<void> {
        await assertNoSymlinks(file);
        if (!(await lstat(file)).isFile())
            throw new CrafleetError(
                "DATABASE_DUMP",
                "PostgreSQL restore input must be a regular custom archive.",
                3,
            );
        const listing = await this.client.execute(
            config,
            "pg_restore",
            ["--format=custom", "--list", file],
            { ...(signal ? { signal } : {}) },
        );
        const sourceMajor = Number(
            /^;\s*Dumped from database version:\s*(\d+)\./mu.exec(listing)?.[1],
        );
        if (sourceMajor !== major)
            throw new CrafleetError(
                "DATABASE_VERSION",
                "Restore only within the PostgreSQL major recorded by the custom archive.",
                3,
            );
        await this.client.execute(
            config,
            "pg_restore",
            ["--format=custom", "--exit-on-error", `--file=${devNull}`, file],
            { ...(signal ? { signal } : {}) },
        );
    }

    async dump(
        config: PostgresBackupConfig,
        directory: string,
        signal?: AbortSignal,
    ): Promise<DatabaseBackupArtifact> {
        const major = await this.preflight(config, false, signal);
        const file = path.join(directory, `${config.id}.dump`);
        await assertNoSymlinks(file);
        if (await exists(file))
            throw new CrafleetError(
                "DATABASE_DESTINATION",
                "PostgreSQL dump destination already exists.",
                3,
            );
        await this.client.execute(
            config,
            "pg_dump",
            ["--no-password", "--format=custom", "--create", `--file=${file}`],
            { ...(signal ? { signal } : {}) },
        );
        await chmod(file, 0o600);
        await this.verifyArchive(config, file, major, signal);
        const hash = await hashBackupFile(file);
        if (!hash.bytes)
            throw new CrafleetError(
                "DATABASE_DUMP",
                "PostgreSQL produced an empty dump.",
                3,
            );
        return {
            id: config.id,
            kind: "postgres",
            file: `databases/${config.id}.dump`,
            sha256: hash.sha256,
            bytes: hash.bytes,
            postgresMajor: major,
        };
    }

    async prepare(
        config: PostgresBackupConfig,
        file: string,
        sha256: string,
        major: 17 | 18,
        previous: PostgresRecovery | undefined,
        save: Save,
        signal?: AbortSignal,
    ): Promise<PostgresRecovery> {
        const target = config.database;
        let state = previous;
        if (state) this.validateState(config, state, sha256, major);
        if (
            state &&
            ["ready", "blocked", "switched", "complete"].includes(state.phase)
        ) {
            await this.identify(config, state, signal);
            return state;
        }
        if ((await this.preflight(config, true, signal)) !== major)
            throw new CrafleetError(
                "DATABASE_VERSION",
                "PostgreSQL target and snapshot majors differ.",
                3,
            );
        if (
            (await hashBackupFile(await assertNoSymlinks(file))).sha256 !==
            sha256
        )
            throw new CrafleetError(
                "RESTORE_HASH",
                "PostgreSQL archive changed after verification.",
                3,
            );
        await this.verifyArchive(config, file, major, signal);
        if (!state) {
            const properties = await readPostgresProperties(
                this.client,
                config,
                target,
                signal,
            );
            if (!properties?.allowConnections)
                throw new CrafleetError(
                    "DATABASE_TARGET",
                    "The original database must exist and permit connections before recovery begins.",
                    3,
                );
            const operation = randomUUID();
            const suffix = operation.replaceAll("-", "");
            state = {
                id: config.id,
                operation,
                target,
                originalOid: properties.oid,
                staging: `crafleet_restore_${suffix}`,
                retained: `crafleet_retained_${suffix}`,
                sha256,
                major,
                properties,
                phase: "planned",
            };
            await save(state);
        }
        const marker = `crafleet recovery ${state.operation}`;
        let staging = await readPostgresProperties(
            this.client,
            config,
            state.staging,
            signal,
        );
        const original = await readPostgresProperties(
            this.client,
            config,
            state.target,
            signal,
        );
        if (
            !original ||
            original.oid !== state.originalOid ||
            !samePostgresProperties(original, state.properties)
        )
            throw new CrafleetError(
                "DATABASE_IDENTITY",
                "Original database identity or properties changed. Recovery is stopped.",
                4,
            );
        if (state.phase === "planned") {
            if (
                await readPostgresProperties(
                    this.client,
                    config,
                    state.retained,
                    signal,
                )
            )
                throw new CrafleetError(
                    "DATABASE_IDENTITY",
                    "The retained database name is already occupied.",
                    4,
                );
            if (!staging) {
                await this.client.query(
                    config,
                    createPostgresDatabase(state.staging, state.properties),
                    signal,
                );
                await this.client.query(
                    config,
                    `COMMENT ON DATABASE ${ident(state.staging)} IS ${literal(marker)};`,
                    signal,
                );
                staging = await readPostgresProperties(
                    this.client,
                    config,
                    state.staging,
                    signal,
                );
            }
            if (!staging || staging.comment !== marker)
                throw new CrafleetError(
                    "DATABASE_IDENTITY",
                    "An unrecorded staging database requires manual identity inspection. It was not reused or deleted.",
                    4,
                );
            state.stagingOid = staging.oid;
            state.phase = "created";
            await save(state);
        }
        if (!staging || staging.oid !== state.stagingOid)
            throw new CrafleetError(
                "DATABASE_IDENTITY",
                "Staging database identity changed.",
                4,
            );
        // A crash during pg_restore can leave a committed but unacknowledged transaction.
        // Drop/recreate is deliberately avoided: clean only this OID-pinned staging DB.
        state.phase = "restoring";
        await save(state);
        await this.client.query(
            config,
            `REVOKE ALL ON DATABASE ${ident(state.staging)} FROM PUBLIC; ALTER DATABASE ${ident(state.staging)} ALLOW_CONNECTIONS true;`,
            signal,
        );
        await this.client.execute(
            config,
            "pg_restore",
            [
                "--no-password",
                "--format=custom",
                "--exit-on-error",
                "--single-transaction",
                "--clean",
                "--if-exists",
                `--dbname=${state.staging}`,
                file,
            ],
            {
                admin: true,
                database: state.staging,
                ...(signal ? { signal } : {}),
            },
        );
        await this.client.query(
            config,
            `ALTER DATABASE ${ident(state.staging)} ALLOW_CONNECTIONS false;`,
            signal,
        );
        if (
            (await this.client.query(
                config,
                `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datid=${state.stagingOid});`,
                signal,
            )) !== "f"
        )
            throw new CrafleetError(
                "DATABASE_CONNECTIONS",
                "A staging database session remains. New connections are blocked and no session was terminated.",
                4,
            );
        await this.client.query(
            config,
            `BEGIN;\n${postgresPropertyStatements(state.staging, state.properties)}\nCOMMIT;`,
            signal,
        );
        staging = await readPostgresProperties(
            this.client,
            config,
            state.staging,
            signal,
        );
        if (
            !staging ||
            staging.oid !== state.stagingOid ||
            !samePostgresProperties(staging, state.properties)
        )
            throw new CrafleetError(
                "DATABASE_PROPERTIES",
                "Restored database ownership, ACL or defaults differ; the original database is unchanged.",
                4,
            );
        state.phase = "ready";
        await save(state);
        return state;
    }

    async switch(
        config: PostgresBackupConfig,
        state: PostgresRecovery,
        save: Save,
        signal?: AbortSignal,
    ): Promise<void> {
        this.validateState(config, state, state.sha256, state.major);
        const current = await this.identify(config, state, signal);
        if (current === "switched") {
            state.phase = "switched";
            await save(state);
            return;
        }
        if (!["ready", "blocked"].includes(state.phase))
            throw new CrafleetError(
                "DATABASE_RECOVERY",
                "PostgreSQL staging must be verified before switching.",
                4,
            );
        state.phase = "blocked";
        await save(state);
        await this.client.query(
            config,
            `ALTER DATABASE ${ident(state.target)} ALLOW_CONNECTIONS false; ALTER DATABASE ${ident(state.staging)} ALLOW_CONNECTIONS false;`,
            signal,
        );
        const busy = await this.client.query(
            config,
            `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datid IN (${state.originalOid}, ${state.stagingOid})) OR EXISTS (SELECT 1 FROM pg_prepared_xacts WHERE database IN (${literal(state.target)}, ${literal(state.staging)}));`,
            signal,
        );
        if (busy !== "f")
            throw new CrafleetError(
                "DATABASE_CONNECTIONS",
                "External sessions or prepared transactions remain. New connections are blocked; no sessions were terminated. Keep writers stopped and run recover after resolving them.",
                4,
            );
        await this.identify(config, state, signal);
        await this.client.query(
            config,
            `BEGIN; ALTER DATABASE ${ident(state.target)} RENAME TO ${ident(state.retained)}; ALTER DATABASE ${ident(state.staging)} RENAME TO ${ident(state.target)}; COMMIT;`,
            signal,
        );
        if ((await this.identify(config, state, signal)) !== "switched")
            throw new CrafleetError(
                "DATABASE_IDENTITY",
                "PostgreSQL switch identity could not be confirmed.",
                4,
            );
        state.phase = "switched";
        await save(state);
    }

    async complete(
        config: PostgresBackupConfig,
        state: PostgresRecovery,
        save: Save,
        signal?: AbortSignal,
    ): Promise<void> {
        if ((await this.identify(config, state, signal)) !== "switched")
            throw new CrafleetError(
                "DATABASE_RECOVERY",
                "PostgreSQL switch is incomplete.",
                4,
            );
        await this.client.query(
            config,
            `ALTER DATABASE ${ident(state.target)} ALLOW_CONNECTIONS ${state.properties.allowConnections ? "true" : "false"};`,
            signal,
        );
        state.phase = "complete";
        await save(state);
    }

    private validateState(
        config: PostgresBackupConfig,
        state: PostgresRecovery,
        sha256: string,
        major: 17 | 18,
    ): void {
        const parsed = PostgresRecoverySchema(state);
        if (parsed instanceof type.errors)
            throw new CrafleetError(
                "DATABASE_IDENTITY",
                "Invalid PostgreSQL recovery record.",
                4,
            );
        const suffix = state.operation.replaceAll("-", "");
        if (
            state.id !== config.id ||
            state.target !== config.database ||
            state.sha256 !== sha256 ||
            state.major !== major ||
            state.originalOid !== state.properties.oid ||
            state.target !== state.properties.name ||
            state.staging !== `crafleet_restore_${suffix}` ||
            state.retained !== `crafleet_retained_${suffix}` ||
            state.originalOid === state.stagingOid
        )
            throw new CrafleetError(
                "DATABASE_IDENTITY",
                "PostgreSQL recovery record does not match its target and archive.",
                4,
            );
    }

    private async identify(
        config: PostgresBackupConfig,
        state: PostgresRecovery,
        signal?: AbortSignal,
    ): Promise<"original" | "switched"> {
        const original = await readPostgresProperties(
            this.client,
            config,
            state.target,
            signal,
        );
        const staging = await readPostgresProperties(
            this.client,
            config,
            state.staging,
            signal,
        );
        const retained = await readPostgresProperties(
            this.client,
            config,
            state.retained,
            signal,
        );
        const match = (
            p: PostgresProperties | undefined,
            oid: number | undefined,
        ) => p && p.oid === oid && samePostgresProperties(p, state.properties);
        if (
            match(original, state.originalOid) &&
            match(staging, state.stagingOid) &&
            !retained
        )
            return "original";
        if (
            match(original, state.stagingOid) &&
            match(retained, state.originalOid) &&
            !staging &&
            retained &&
            !retained.allowConnections
        )
            return "switched";
        throw new CrafleetError(
            "DATABASE_IDENTITY",
            "Database names, OIDs or properties differ from the recovery record. No further changes were made.",
            4,
        );
    }
}
