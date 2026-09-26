import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
    CrafleetError,
    resolveSettings,
    type SettingsOverrides,
} from "@crafleet/core";
import { type } from "arktype";
import { assertNoSymlinks, exists, writeJson } from "../filesystem/io.js";
import { ensurePrivateDirectory } from "../filesystem/private.js";
import { loadConfigSecrets } from "../filesystem/secrets.js";
import { readState } from "../filesystem/state.js";
import { parseConfigDocument } from "../formats/config.js";
import {
    bindRuntimeSettings,
    resolveEnvironmentSettings,
    runtimeLimit,
    runtimeSettings,
    runtimeTimeout,
    runtimeValue,
    withRuntimeSettings,
} from "../settings.js";
import { ConsoleBridge } from "./console-bridge.js";
import { javaExecutable } from "./java.js";
import { consumeLogLines } from "./output.js";
import {
    RunnerLaunchSchema,
    type RunnerRecord,
    RunnerRequestSchema,
} from "./protocol.js";
import { pingServer } from "./status-ping.js";

export async function runtimeEndpoint(
    projectDir: string,
    kind: "paper" | "velocity",
): Promise<{ host: string; port: number }> {
    const relative = kind === "paper" ? "server.properties" : "velocity.toml";
    const file = path.join(projectDir, "runtime", relative);
    await assertNoSymlinks(projectDir, `runtime/${relative}`);
    if (!(await exists(file))) return { host: "127.0.0.1", port: 25565 };
    const data = parseConfigDocument(relative, await readFile(file, "utf8"))
        .value as Record<string, unknown>;
    if (kind === "paper") {
        const host = String(data["server-ip"] || "127.0.0.1");
        const port = Number(data["server-port"] ?? 25565);
        if (!Number.isInteger(port) || port < 1 || port > 65535)
            throw new CrafleetError("SERVER_PORT", "Invalid server-port.", 2);
        return {
            host: ["0.0.0.0", "::"].includes(host) ? "127.0.0.1" : host,
            port,
        };
    }
    const bind = String(data.bind ?? "0.0.0.0:25565");
    const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(bind);
    if (!match)
        throw new CrafleetError(
            "SERVER_BIND",
            "Invalid Velocity bind address.",
            2,
        );
    const host = match[1] ?? match[2] ?? "127.0.0.1";
    const port = Number(match[3]);
    if (port < 1 || port > 65535)
        throw new CrafleetError("SERVER_PORT", "Invalid Velocity port.", 2);
    return {
        host: ["0.0.0.0", "::"].includes(host) ? "127.0.0.1" : host,
        port,
    };
}

async function runServerDaemonConfigured(projectDir: string): Promise<void> {
    const privateDir = await assertNoSymlinks(projectDir, ".crafleet");
    await ensurePrivateDirectory(privateDir);
    const launchFile = path.join(privateDir, "runner-launch.json");
    const launch = RunnerLaunchSchema(
        JSON.parse(await readFile(launchFile, "utf8")),
    );
    if (launch instanceof type.errors)
        throw new CrafleetError(
            "RUNNER_LAUNCH",
            "Invalid runner launch request.",
            4,
        );
    const launchToken = launch.token;
    const state = await readState(projectDir);
    if (!state.active || state.active.id !== launch.activeId)
        throw new CrafleetError(
            "RUNNER_ACTIVE",
            "Runner active installation mismatch.",
            4,
        );
    const active = state.active;
    const secrets = await loadConfigSecrets(
        projectDir,
        active.manifest.secrets,
    );
    const executable = await javaExecutable(active.manifest.java?.command);
    await assertNoSymlinks(projectDir, "runtime/server.jar");
    await assertNoSymlinks(projectDir, ".crafleet/server.log");
    const guard = path.join(privateDir, "process.lock");
    try {
        await mkdir(guard);
    } catch {
        throw new CrafleetError(
            "RUNNER_GUARD",
            "A server lifetime guard already exists. Inspect status before recovery.",
            4,
        );
    }
    await writeJson(path.join(guard, "owner.json"), {
        token: launch.token,
        pid: process.pid,
    });
    await rm(launchFile);
    const recordFile = path.join(privateDir, "runner.json");
    let record: RunnerRecord = {
        protocol: 1,
        settings: runtimeSettings(),
        projectDir: path.resolve(projectDir),
        token: launch.token,
        pid: process.pid,
        port: 0,
        activeId: active.id,
        phase: "starting",
        clean: true,
        startedAt: new Date().toISOString(),
    };
    // Snapshot and serialize writes so a late starting/running write cannot overwrite stopped.
    let recordWrites = Promise.resolve();
    const persistRecord = () => {
        const snapshot = { ...record };
        const writing = recordWrites.then(() =>
            writeJson(recordFile, snapshot),
        );
        recordWrites = writing.catch(() => {});
        return writing;
    };
    const output = createWriteStream(path.join(privateDir, "server.log"), {
        flags: "a",
        mode: 0o600,
    });
    let logFailed = false;
    output.on("error", () => {
        logFailed = true;
    });
    const log = (line: string) => {
        if (!logFailed)
            output.write(
                `${secrets.redact(line).slice(0, runtimeLimit("logs.maxOutputChars"))}\n`,
            );
    };
    let stopRequested = false;
    let forced = false;
    let exited = false;
    let announcedReady = false;
    let resolveExit: () => void = () => {};
    const lifecycle = new AbortController();
    const exitPromise = new Promise<void>((resolve) => {
        resolveExit = resolve;
    });
    const control = net.createServer();
    control.maxConnections = runtimeLimit("runtime.maxConnections");
    await new Promise<void>((resolve, reject) => {
        control.once("error", reject);
        control.listen(0, "127.0.0.1", () => {
            control.off("error", reject);
            resolve();
        });
    });
    const address = control.address();
    if (!address || typeof address === "string")
        throw new Error("Missing control address");
    record.port = address.port;
    try {
        await persistRecord();
    } catch {
        control.close();
        output.end();
        await assertNoSymlinks(projectDir, ".crafleet/process.lock");
        await rm(guard, { recursive: true });
        throw new CrafleetError(
            "RUNNER_STATE",
            "Runner state could not be persisted; Java was not started.",
            4,
        );
    }
    const javaArgs = active.manifest.java?.args ?? ["-Xms512M", "-Xmx2G"];
    const legacyPaper =
        active.manifest.server.type === "paper" &&
        /^1\.(?:8|9|10|11|12|13)(?:\.|$)/u.test(active.manifest.server.version);
    const terminalDefaults = [
        "-Dterminal.ansi=true",
        "-Dterminal.jline=false",
        ...(process.platform === "win32" && legacyPaper
            ? ["-Dlog4j.skipJansi=true"]
            : []),
    ].filter((argument) => {
        const property = argument.split("=")[0] ?? argument;
        return !javaArgs.some(
            (value) => value === property || value.startsWith(`${property}=`),
        );
    });
    const args = [
        ...terminalDefaults,
        ...javaArgs,
        "-jar",
        "server.jar",
        ...(active.manifest.server.type === "paper"
            ? [legacyPaper ? "nogui" : "--nogui"]
            : []),
    ];
    const consoleBridge = new ConsoleBridge(active.manifest.server.type);
    const consoleEnvironment = await consoleBridge.listen().catch(() => {
        log(
            "[crafleet] Tab completion is unavailable; normal console input remains available.",
        );
        return {};
    });
    const child = spawn(executable, args, {
        cwd: path.join(projectDir, "runtime"),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {
            ...process.env,
            CRAFLEET_CONSOLE_PORT: undefined,
            CRAFLEET_CONSOLE_TOKEN: undefined,
            ...consoleEnvironment,
        },
    });
    if (child.pid) record.javaPid = child.pid;
    for (const stream of [child.stdout, child.stderr]) {
        consumeLogLines(stream, (line) => {
            log(line);
            if (/\bDone \([\d.,]+s\)!/.test(line)) announcedReady = true;
        });
    }
    async function finalized(code: number | null) {
        if (exited) return;
        exited = true;
        lifecycle.abort();
        consoleBridge.close();
        record = {
            ...record,
            phase: "stopped",
            clean: !forced && code === 0,
            exitCode: code,
        };
        try {
            await persistRecord();
            await assertNoSymlinks(projectDir, ".crafleet/process.lock");
            const owner: unknown = JSON.parse(
                await readFile(path.join(guard, "owner.json"), "utf8"),
            );
            if (
                owner &&
                typeof owner === "object" &&
                "token" in owner &&
                owner.token === launchToken
            )
                await rm(guard, { recursive: true });
        } catch {
            log(
                "[crafleet] Process ended, but durable state or lifetime-guard cleanup failed; run doctor and recover.",
            );
        } finally {
            await new Promise<void>((resolve) => output.end(() => resolve()));
            resolveExit();
            control.close();
        }
    }
    child.once("error", () => {
        log("[crafleet] Java could not be spawned.");
        void finalized(1);
    });
    child.once("close", (code) => {
        void finalized(code);
    });
    child.stdin.on("error", () => {
        log("[crafleet] Server input is no longer writable.");
    });
    if (!exited)
        await persistRecord().catch(() =>
            log(
                "[crafleet] Runner process metadata could not be persisted; inspect doctor before any further operation.",
            ),
        );
    async function stop(force: boolean): Promise<void> {
        if (exited) return;
        stopRequested = true;
        forced ||= force;
        record.phase = "stopping";
        await persistRecord();
        if (exited) return;
        if (force) child.kill("SIGKILL");
        else
            child.stdin.write(
                active.manifest.server.type === "paper" ? "stop\n" : "end\n",
            );
        const timeout = runtimeValue("runtime.stopTimeoutMs");
        if (timeout === -1) {
            await exitPromise;
            return;
        }
        const timeoutAbort = new AbortController();
        try {
            await Promise.race([
                exitPromise,
                delay(timeout, undefined, { signal: timeoutAbort.signal }).then(
                    () => {
                        if (!exited)
                            throw new CrafleetError(
                                "STOP_TIMEOUT",
                                "The server did not stop; it was not killed.",
                                3,
                            );
                    },
                ),
            ]);
        } finally {
            timeoutAbort.abort();
        }
    }
    control.on(
        "connection",
        bindRuntimeSettings((socket: net.Socket) => {
            let body: Buffer = Buffer.alloc(0);
            let handled = false;
            socket.setTimeout(runtimeTimeout("runtime.requestTimeoutMs"), () =>
                socket.destroy(),
            );
            socket.on("error", () => socket.destroy());
            socket.on(
                "data",
                bindRuntimeSettings((data: Buffer) => {
                    if (handled) return;
                    body = Buffer.concat([body, data]);
                    if (body.length > runtimeLimit("runtime.maxFrameBytes")) {
                        socket.destroy();
                        return;
                    }
                    const newline = body.indexOf("\n");
                    if (newline < 0) return;
                    handled = true;
                    void (async () => {
                        try {
                            const request = RunnerRequestSchema(
                                JSON.parse(
                                    body.subarray(0, newline).toString("utf8"),
                                ),
                            );
                            if (
                                request instanceof type.errors ||
                                !timingSafeEqual(
                                    Buffer.from(request.token),
                                    Buffer.from(launch.token),
                                )
                            )
                                throw new Error("Unauthorized");
                            socket.setTimeout(
                                runtimeValue("runtime.stopTimeoutMs") === -1
                                    ? 0
                                    : Math.min(
                                          2147483647,
                                          runtimeValue(
                                              "runtime.stopTimeoutMs",
                                          ) +
                                              runtimeValue(
                                                  "runtime.stopGraceMs",
                                              ),
                                      ),
                            );
                            let consoleResult: unknown;
                            if (request.command === "capabilities")
                                consoleResult = consoleBridge.capabilities();
                            else if (request.command === "complete") {
                                const abort = new AbortController();
                                socket.once("close", () => abort.abort());
                                consoleResult = await consoleBridge.complete(
                                    {
                                        line: request.text ?? "",
                                        cursor: request.cursor ?? -1,
                                    },
                                    abort.signal,
                                );
                            } else if (
                                request.command === "stop" ||
                                request.command === "force-stop"
                            )
                                await stop(request.command === "force-stop");
                            else if (request.command === "command") {
                                if (
                                    !request.text ||
                                    /[\r\n\0]/.test(request.text) ||
                                    request.text.length >
                                        runtimeLimit(
                                            "console.maxCommandChars",
                                        ) ||
                                    exited ||
                                    stopRequested
                                )
                                    throw new Error("Invalid command");
                                await new Promise<void>((resolve, reject) => {
                                    child.stdin.write(
                                        `${request.text}\n`,
                                        (error) =>
                                            error ? reject(error) : resolve(),
                                    );
                                });
                            }
                            socket.end(
                                `${JSON.stringify({ ok: true, result: record, ...(consoleResult !== undefined ? { data: consoleResult } : {}) })}\n`,
                            );
                        } catch (error) {
                            const code =
                                error instanceof CrafleetError &&
                                error.code === "STOP_TIMEOUT"
                                    ? "STOP_TIMEOUT"
                                    : undefined;
                            socket.end(
                                `${JSON.stringify({ ok: false, ...(code ? { code } : {}) })}\n`,
                            );
                        }
                    })();
                }),
            );
        }),
    );
    const interrupt = () => {
        void stop(false).catch(() => {
            log("[crafleet] Graceful stop timed out; no automatic force kill.");
        });
    };
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    const configuredPollMs = runtimeValue("runtime.pollMs");
    while (!exited && !stopRequested) {
        if (announcedReady && record.phase === "starting") {
            try {
                const endpoint = await runtimeEndpoint(
                    projectDir,
                    active.manifest.server.type,
                );
                await pingServer(
                    endpoint.host,
                    endpoint.port,
                    undefined,
                    lifecycle.signal,
                );
                if (exited || stopRequested) break;
                record.phase = "running";
                await persistRecord();
            } catch {
                /* A ready log must be corroborated by a real server response. */
            }
        }
        await Promise.race([delay(configuredPollMs), exitPromise]);
    }
    await exitPromise;
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
}

export async function runServerDaemon(projectDir: string): Promise<void> {
    const file = await assertNoSymlinks(
        projectDir,
        ".crafleet/runner-launch.json",
    );
    const launch = RunnerLaunchSchema(JSON.parse(await readFile(file, "utf8")));
    if (launch instanceof type.errors)
        throw new CrafleetError(
            "RUNNER_LAUNCH",
            "Invalid runner launch request.",
            4,
        );
    const inputs = resolveEnvironmentSettings(process.env);
    const settings: SettingsOverrides = (launch.settings ??
        {}) as SettingsOverrides;
    if (!launch.settings) {
        const state = await readState(projectDir);
        const java = state.active?.manifest.java;
        if (java?.startupTimeout !== undefined)
            settings["runtime.startupTimeoutMs"] = java.startupTimeout * 1000;
        if (java?.stopTimeout !== undefined)
            settings["runtime.stopTimeoutMs"] = java.stopTimeout * 1000;
    }
    const resolved = resolveSettings([{ source: "project", values: settings }]);
    return withRuntimeSettings(
        resolved,
        () => runServerDaemonConfigured(projectDir),
        inputs,
    );
}
