import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { BackupProcessRunner } from "../../packages/adapters/src/restic/process.js";

const images = {
    17: "postgres@sha256:29e0bb09c8e7e7fc265ea9f4367de9622e55bae6b0b97e7cce740c2d63c2ebc0",
    18: "postgres@sha256:7157393f508fd8eb46119937fab39813783fe3e7d4c6316c45c12ce2ea25e61d",
} as const;

/** Test transport only: official clients run against an unexposed disposable DB. */
export async function postgresService(
    major: 17 | 18,
    execute: BackupProcessRunner,
) {
    const parent = path.resolve(".test-tmp");
    await mkdir(parent, { recursive: true });
    const root = await realpath(
        await mkdtemp(path.join(parent, "postgres-service-")),
    );
    const name = `crafleet-test-postgres-${major}-${randomUUID()}`;
    await writeFile(
        path.join(root, "pg_hba.conf"),
        "local all all trust\nhost all all 127.0.0.1/32 scram-sha-256\nhost all all ::1/128 scram-sha-256\n",
    );
    const launched = await execute({
        executable: "docker",
        args: [
            "run",
            "--rm",
            "--detach",
            "--network",
            "none",
            "--name",
            name,
            "--label",
            "org.crafleet.fixture=postgres",
            "--mount",
            `type=bind,source=${root},target=/crafleet-tests`,
            "--env",
            "POSTGRES_PASSWORD=disposable-crafleet-password",
            "--env",
            "PGDATA=/var/lib/postgresql/crafleet-test",
            images[major],
            "postgres",
            "-c",
            "hba_file=/crafleet-tests/pg_hba.conf",
        ],
        timeoutMs: 120000,
    });
    const id = launched.stdout.trim();
    if (launched.exitCode || !/^[a-f0-9]{64}$/u.test(id))
        throw new Error(
            "Could not launch the explicit disposable PostgreSQL fixture",
        );
    const mapPath = (value: string) =>
        value === "\\\\.\\nul" || value === "/dev/null"
            ? "/dev/null"
            : value.replaceAll(root, "/crafleet-tests").replaceAll("\\", "/");
    const diagnostics: string[] = [];
    const runner: BackupProcessRunner = async (request) => {
        const tool = path.basename(request.executable);
        if (!["psql", "pg_dump", "pg_restore"].includes(tool))
            return execute(request);
        const containerPasswordFile = request.env?.PGPASSFILE
            ? `/tmp/crafleet-pass-${randomUUID()}`
            : undefined;
        if (containerPasswordFile) {
            const copy = await execute({
                executable: "docker",
                args: [
                    "exec",
                    id,
                    "install",
                    "-m",
                    "600",
                    mapPath(request.env?.PGPASSFILE as string),
                    containerPasswordFile,
                ],
            });
            if (copy.exitCode)
                throw new Error(
                    "Could not create private test-container password file",
                );
        }
        const envArgs = Object.entries(request.env ?? {})
            .filter(
                ([key, value]) =>
                    /^PG|^LC_ALL$/u.test(key) && value !== undefined,
            )
            .flatMap(([key, value]) => [
                "--env",
                `${key}=${key === "PGPASSFILE" ? containerPasswordFile : mapPath(value as string)}`,
            ]);
        try {
            const result = await execute({
                ...request,
                executable: "docker",
                args: [
                    "exec",
                    "-i",
                    ...envArgs,
                    id,
                    tool,
                    ...request.args.map((arg) =>
                        arg.startsWith("--file=") && /nul$/iu.test(arg)
                            ? "--file=/dev/null"
                            : mapPath(arg),
                    ),
                ],
                env: process.env,
            });
            diagnostics.push(
                `${tool}: ${result.exitCode}\n${result.stderr}\n${result.stdout.slice(0, 8192)}`,
            );
            if (diagnostics.length > 4) diagnostics.shift();
            return result;
        } finally {
            if (containerPasswordFile)
                await execute({
                    executable: "docker",
                    args: ["exec", id, "rm", "--", containerPasswordFile],
                });
        }
    };
    const cleanup = async () => {
        const check = await execute({
            executable: "docker",
            args: [
                "inspect",
                id,
                "--format",
                '{{.Name}} {{index .Config.Labels "org.crafleet.fixture"}}',
            ],
        });
        if (check.exitCode || check.stdout.trim() !== `/${name} postgres`)
            throw new Error(
                "Refusing to stop a container without the fixture identity",
            );
        await execute({
            executable: "docker",
            args: ["stop", "--time", "10", id],
            timeoutMs: 20000,
        });
        if (
            path.dirname(root) !== (await realpath(parent)) ||
            !path.basename(root).startsWith("postgres-service-")
        )
            throw new Error("Unsafe fixture cleanup");
        await rm(root, { recursive: true, force: true });
    };
    try {
        for (let attempt = 0; attempt < 60; attempt++) {
            const probe = await execute({
                executable: "docker",
                args: [
                    "exec",
                    id,
                    "pg_isready",
                    "-h",
                    "127.0.0.1",
                    "-U",
                    "postgres",
                ],
                timeoutMs: 10000,
            });
            if (probe.exitCode === 0)
                return { root, runner, cleanup, id, diagnostics };
            await delay(250);
        }
        throw new Error("Disposable PostgreSQL did not become ready");
    } catch (error) {
        await cleanup();
        throw error;
    }
}
