import { lstat } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import {
    type BackupSecretResolver,
    CrafleetError,
    type PostgresBackupConfig,
} from "@crafleet/core";
import {
    privateBackupDirectory,
    removePrivateBackupDirectory,
} from "../filesystem/backup-files.js";
import { assertNoSymlinks, atomicWrite } from "../filesystem/io.js";
import {
    type BackupProcessRunner,
    sanitizedBackupEnvironment,
} from "../restic/process.js";

export function pgIdentifier(value: string): string {
    if (!value || /[\0\r\n]/u.test(value) || Buffer.byteLength(value) > 63)
        throw new CrafleetError(
            "DATABASE_CONFIG",
            "PostgreSQL identifiers must be nonempty and at most 63 bytes, without NUL or line breaks.",
            2,
        );
    return `"${value.replaceAll('"', '""')}"`;
}
export function pgLiteral(value: string): string {
    if (value.includes("\0"))
        throw new CrafleetError(
            "DATABASE_CONFIG",
            "PostgreSQL values cannot contain NUL.",
            2,
        );
    return `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}
export class PostgresClient {
    constructor(
        readonly projectDir: string,
        readonly home: string,
        private readonly secrets: BackupSecretResolver,
        private readonly runner: BackupProcessRunner,
    ) {}

    private environment(config: PostgresBackupConfig): NodeJS.ProcessEnv {
        const env = sanitizedBackupEnvironment();
        for (const key of Object.keys(env))
            if (/^PG/iu.test(key)) delete env[key];
        for (const secret of [config.password, config.restore?.password])
            if (secret && "env" in secret) delete env[secret.env];
        return env;
    }

    executable(
        config: PostgresBackupConfig,
        tool: "pg_dump" | "pg_restore" | "psql",
    ): string {
        const configured =
            tool === "pg_dump"
                ? config.command
                : tool === "pg_restore"
                  ? config.restoreCommand
                  : config.queryCommand;
        return configured
            ? /[\\/]/u.test(configured)
                ? path.resolve(this.projectDir, configured)
                : configured
            : tool;
    }

    async execute(
        config: PostgresBackupConfig,
        tool: "pg_dump" | "pg_restore" | "psql",
        args: string[],
        options: {
            admin?: boolean;
            database?: string;
            input?: string;
            signal?: AbortSignal;
        } = {},
    ): Promise<string> {
        this.validate(config);
        const credentials = options.admin
            ? (config.restore ?? {
                  user: config.user,
                  password: config.password,
                  maintenanceDatabase: "postgres",
              })
            : config;
        const password = await this.secrets(credentials.password);
        if (!password || /[\0\r\n]/u.test(password) || password.length > 65536)
            throw new CrafleetError(
                "BACKUP_SECRET",
                "PostgreSQL requires a nonempty single-line password reference.",
                3,
            );
        const root = path.join(this.home, "tmp", "database");
        const temporary = await privateBackupDirectory(root, "postgres-");
        try {
            const passfile = path.join(temporary, "pgpass");
            const escapePasswordField = (value: string) =>
                value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
            await atomicWrite(
                passfile,
                `${[config.host, String(config.port ?? 5432), "*", credentials.user, password].map(escapePasswordField).join(":")}\n`,
            );
            const env = this.environment(config);
            Object.assign(env, {
                PGHOST: config.host,
                PGPORT: String(config.port ?? 5432),
                PGUSER: credentials.user,
                PGDATABASE: options.database ?? config.database,
                PGPASSFILE: passfile,
                PGSSLMODE: config.sslCa ? "verify-full" : "disable",
                PGCONNECT_TIMEOUT: "10",
                PGAPPNAME: "crafleet",
                PGOPTIONS:
                    "-c search_path=pg_catalog -c statement_timeout=0 -c lock_timeout=5000",
                LC_ALL: "C",
            });
            if (config.sslCa) {
                const ca = await assertNoSymlinks(
                    path.resolve(this.projectDir, config.sslCa),
                );
                if (!(await lstat(ca)).isFile())
                    throw new CrafleetError(
                        "DATABASE_TLS",
                        "sslCa must identify a regular certificate file.",
                        3,
                    );
                env.PGSSLROOTCERT = ca;
            }
            const result = await this.runner({
                executable: this.executable(config, tool),
                args,
                env,
                maxOutputBytes: 8 * 1024 * 1024,
                ...(options.input !== undefined
                    ? { input: Buffer.from(options.input) }
                    : {}),
                ...(options.signal ? { signal: options.signal } : {}),
            });
            if (
                result.exitCode !== 0 ||
                (tool === "pg_restore" && /\bwarning:/iu.test(result.stderr))
            )
                throw new CrafleetError(
                    "DATABASE_POSTGRES",
                    `PostgreSQL ${tool} failed; client output is withheld. Keep writers stopped when recovering.`,
                    3,
                );
            return result.stdout;
        } finally {
            await removePrivateBackupDirectory(root, temporary);
        }
    }

    async query(
        config: PostgresBackupConfig,
        sql: string,
        signal?: AbortSignal,
        database = config.restore?.maintenanceDatabase ?? "postgres",
    ): Promise<string> {
        return (
            await this.execute(
                config,
                "psql",
                [
                    "--no-psqlrc",
                    "--no-password",
                    "--quiet",
                    "--tuples-only",
                    "--no-align",
                    "--set=ON_ERROR_STOP=1",
                ],
                {
                    admin: true,
                    database,
                    input: `SET statement_timeout = '30s';\n${sql}\n`,
                    ...(signal ? { signal } : {}),
                },
            )
        ).trim();
    }

    async major(
        config: PostgresBackupConfig,
        admin: boolean,
        signal?: AbortSignal,
    ): Promise<17 | 18> {
        const value = await this.execute(
            config,
            "psql",
            [
                "--no-psqlrc",
                "--no-password",
                "--quiet",
                "--tuples-only",
                "--no-align",
                "--set=ON_ERROR_STOP=1",
                "--command=SHOW server_version_num",
            ],
            {
                admin,
                database: admin
                    ? (config.restore?.maintenanceDatabase ?? "postgres")
                    : config.database,
                ...(signal ? { signal } : {}),
            },
        );
        const major = Math.floor(Number(value.trim()) / 10000);
        if (major !== 17 && major !== 18)
            throw new CrafleetError(
                "DATABASE_VERSION",
                "PostgreSQL backups and recovery support server majors 17 and 18.",
                3,
            );
        for (const tool of ["pg_dump", "pg_restore", "psql"] as const) {
            const output = await this.runner({
                executable: this.executable(config, tool),
                args: ["--version"],
                env: this.environment(config),
                maxOutputBytes: 8192,
                timeoutMs: 10000,
                ...(signal ? { signal } : {}),
            });
            if (
                output.exitCode !== 0 ||
                !new RegExp(`^${tool} \\(PostgreSQL\\) ${major}\\.`).test(
                    output.stdout.trim(),
                )
            )
                throw new CrafleetError(
                    "DATABASE_CLIENT",
                    "Use matching-major official pg_dump, pg_restore and psql clients.",
                    3,
                );
        }
        return major;
    }

    validate(config: PostgresBackupConfig): void {
        pgIdentifier(config.database);
        pgIdentifier(config.user);
        if (
            !config.host ||
            (isIP(config.host) !== 6 && /[\0\r\n\\/:*]/u.test(config.host)) ||
            (config.port !== undefined &&
                (!Number.isInteger(config.port) ||
                    config.port < 1 ||
                    config.port > 65535))
        )
            throw new CrafleetError(
                "DATABASE_CONFIG",
                "Use a PostgreSQL TCP hostname and valid port, not a connection string or socket path.",
                2,
            );
        if (
            !["localhost", "127.0.0.1", "::1"].includes(config.host) &&
            !config.sslCa
        )
            throw new CrafleetError(
                "DATABASE_TLS",
                "Non-loopback PostgreSQL requires sslCa and verified TLS.",
                3,
            );
        if (config.restore) {
            pgIdentifier(config.restore.user);
            pgIdentifier(config.restore.maintenanceDatabase);
        }
        if (
            config.database ===
                (config.restore?.maintenanceDatabase ?? "postgres") ||
            ["template0", "template1"].includes(config.database)
        )
            throw new CrafleetError(
                "DATABASE_CONFIG",
                "The target must differ from maintenance and template databases.",
                2,
            );
    }
}
