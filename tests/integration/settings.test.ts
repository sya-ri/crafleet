import { createHash } from "node:crypto";
import {
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
    NodeArtifactStore,
    NodeConfigManager,
    readBoundedRegularFile,
    readRecentServerLogs,
    readRuntimeSettings,
    resolveEnvironmentSettings,
    runtimeValue,
    saveState,
    withRuntimeSettings,
} from "@crafleet/adapters";
import { resolveSettings, type SettingsOverrides } from "@crafleet/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderHttp } from "../../packages/adapters/src/providers/http.js";
import { runBackupProcess } from "../../packages/adapters/src/restic/process.js";
import { runCli } from "../../packages/cli/src/application.js";
import { artifactZip } from "./artifacts-fixture.js";

const roots: string[] = [];
const originalExitCode = process.exitCode;
const entry = pathToFileURL(path.resolve("packages/cli/dist/cli.mjs")).href;
async function root(): Promise<string> {
    const dir = await mkdtemp(
        path.join(await realpath(tmpdir()), "crafleet-settings-"),
    );
    roots.push(dir);
    return dir;
}
async function project(dir: string, extra = ""): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(
        path.join(dir, "crafleet.yaml"),
        `schemaVersion: 1\nname: example\nserver:\n  type: paper\n  version: '1.21.11'\nplugins: {}\n${extra}`,
    );
}
const scoped = <T>(values: SettingsOverrides, action: () => T) =>
    withRuntimeSettings(resolveSettings([{ source: "cli", values }]), action);
afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = originalExitCode;
    for (const dir of roots.splice(0))
        await rm(dir, { recursive: true, force: true });
});

describe("runtime settings propagation", () => {
    it.each([30, -1])(
        "reads complete log lines across small I/O pages with maxLineBytes=%s",
        async (maximum) => {
            const dir = await root();
            await mkdir(path.join(dir, ".crafleet"));
            const text = `older\n${"x".repeat(25)}\n`;
            await writeFile(path.join(dir, ".crafleet/server.log"), text);
            const logs = await scoped(
                { "logs.pageBytes": 8, "logs.maxLineBytes": maximum },
                () => readRecentServerLogs(dir, 1),
            );
            expect(logs.text).toBe(`${"x".repeat(25)}\n`);
        },
    );
    it("checks state capacity before replacing an existing state file", async () => {
        const dir = await root();
        await mkdir(path.join(dir, ".crafleet"));
        const file = path.join(dir, ".crafleet/state.json");
        await writeFile(file, '{"schemaVersion":1}');
        await expect(
            scoped({ "state.maxBytes": 1 }, () =>
                saveState(dir, { schemaVersion: 1 }),
            ),
        ).rejects.toThrow("state.maxBytes");
        expect(await readFile(file, "utf8")).toBe('{"schemaVersion":1}');
        await scoped({ "state.maxBytes": -1 }, () =>
            saveState(dir, { schemaVersion: 1 }),
        );
    });
    it("isolates shared artifact store operations and applies limits again to cache hits", async () => {
        const dir = await root();
        const bytes = artifactZip([
            {
                name: "META-INF/MANIFEST.MF",
                content: "Manifest-Version: 1.0\n",
            },
        ]);
        const source = path.join(dir, "server.jar");
        await writeFile(source, bytes);
        const artifact = {
            source: { provider: "file" as const, path: source },
            version: "local",
            sha256: createHash("sha256").update(bytes).digest("hex"),
            size: bytes.length,
        };
        const store = new NodeArtifactStore(path.join(dir, "home"));
        const context = (limit: number) => ({
            projectDir: dir,
            serverKind: "paper" as const,
            settings: resolveSettings([
                { source: "project", values: { "artifacts.maxBytes": limit } },
            ]).values,
        });
        const results = await Promise.allSettled([
            store.ensure(artifact, context(1)),
            store.ensure(artifact, context(-1)),
        ]);
        expect(results[0]?.status).toBe("rejected");
        expect(results[1]?.status).toBe("fulfilled");
        await expect(store.ensure(artifact, context(1))).rejects.toThrow();
        await expect(
            store.ensure(artifact, context(bytes.length)),
        ).resolves.toBeTypeOf("string");
    });
    it("resolves workspace, legacy project fields, new fields, environment and CLI", async () => {
        const dir = await root();
        await writeFile(
            path.join(dir, "crafleet-workspace.yaml"),
            "schemaVersion: 1\nprojects: ['server']\nsettings:\n  runtime:\n    startupTimeoutMs: 100\n  backup:\n    maxFiles: 20\n",
        );
        const server = path.join(dir, "server");
        await project(
            server,
            "java:\n  startupTimeout: 3\n  stopTimeout: 4\nsettings:\n  runtime:\n    startupTimeoutMs: 5000\n",
        );
        const inputs = resolveEnvironmentSettings(
            {
                PI_TUI_ESC_TIMEOUT: "20",
                CRAFLEET_SETTINGS_RUNTIME_STARTUP_TIMEOUT_MS: "6000",
                CRAFLEET_SETTINGS_CONSOLE_ESCAPE_TIMEOUT_MS: "30",
            },
            { "runtime.startupTimeoutMs": 7000 },
        );
        const result = await readRuntimeSettings(server, inputs);
        expect(result.resolved.values["runtime.startupTimeoutMs"]).toBe(7000);
        expect(result.resolved.values["runtime.stopTimeoutMs"]).toBe(4000);
        expect(result.resolved.values["console.escapeTimeoutMs"]).toBe(30);
        expect(result.resolved.values["backup.maxFiles"]).toBe(20);
        expect(result.resolved.deprecated).toEqual(
            expect.arrayContaining([
                "java.startupTimeout",
                "java.stopTimeout",
                "PI_TUI_ESC_TIMEOUT",
            ]),
        );
    });
    it("keeps concurrent project settings isolated through nested asynchronous calls", async () => {
        const results = await Promise.all(
            [11, 22].map((value) =>
                scoped({ "backup.maxFiles": value }, async () => {
                    await delay(5);
                    return runtimeValue("backup.maxFiles");
                }),
            ),
        );
        expect(results).toEqual([11, 22]);
        expect(runtimeValue("backup.maxFiles")).toBe(250000);
    });
    it("does not let a declaration override its own read limit", async () => {
        const dir = await root();
        await project(dir, "settings:\n  files:\n    maxYamlBytes: -1\n");
        const inputs = resolveEnvironmentSettings(
            {},
            { "files.maxYamlBytes": 8 },
        );
        await expect(readRuntimeSettings(dir, inputs)).rejects.toThrow(
            "files.maxYamlBytes",
        );
        expect(
            (await readRuntimeSettings(dir)).resolved.values[
                "files.maxYamlBytes"
            ],
        ).toBe(-1);
    });
    it("preserves broken-manifest runtime access while rejecting invalid setting values", async () => {
        const dir = await root();
        await writeFile(path.join(dir, "crafleet.yaml"), "broken: [");
        await expect(
            readRuntimeSettings(dir, undefined, true),
        ).resolves.toBeDefined();
        await project(dir, "settings:\n  files:\n    maxTextBytes: -2\n");
        await expect(readRuntimeSettings(dir, undefined, true)).rejects.toThrow(
            "files.maxTextBytes",
        );
    });
    it("reads unlimited files without allocating the maximum and retains limit failures", async () => {
        const dir = await root();
        const file = path.join(dir, "data");
        await writeFile(file, "abcdefgh");
        const failure = (reason: string): never => {
            throw new Error(reason);
        };
        await expect(
            readBoundedRegularFile(file, { maxBytes: 7, failure }),
        ).rejects.toThrow("too-large");
        expect(
            (
                await readBoundedRegularFile(file, { maxBytes: -1, failure })
            )?.bytes.toString(),
        ).toBe("abcdefgh");
        expect(
            (
                await readBoundedRegularFile(file, {
                    maxBytes: Number.MAX_SAFE_INTEGER,
                    failure,
                })
            )?.bytes.length,
        ).toBe(8);
    });
    it("captures and reloads text with raised limits and leaves state intact when lowered", async () => {
        const dir = await root();
        await project(dir);
        await mkdir(path.join(dir, "runtime"));
        await writeFile(
            path.join(dir, "runtime", "config.yml"),
            "message: abcdefghijklmnopqrstuvwxyz\n",
        );
        await scoped({ "files.maxTextBytes": -1 }, async () => {
            const manager = new NodeConfigManager(dir);
            await manager.capture({
                initial: true,
                kind: "paper",
                candidates: ["config.yml"],
            });
            expect((await manager.prepare()).files.length).toBeGreaterThan(0);
        });
        const state = path.join(dir, ".crafleet", "config-state.json");
        const before = await readFile(state);
        await expect(
            scoped({ "files.maxTextBytes": 3 }, () =>
                new NodeConfigManager(dir).prepare(),
            ),
        ).rejects.toThrow();
        expect(await readFile(state)).toEqual(before);
    });
    it("supports an unlimited HTTP deadline and output bound with explicit cancellation", async () => {
        const abort = new AbortController();
        const fetcher = vi.fn(
            async (_url: string | URL | Request, init?: RequestInit) => {
                expect(init?.signal).toBe(abort.signal);
                return new Response(JSON.stringify({ text: "x".repeat(100) }));
            },
        );
        const value = await scoped(
            { "http.timeoutMs": -1, "http.maxMetadataBytes": -1 },
            () =>
                new ProviderHttp({ fetch: fetcher }).json(
                    "https://example.com/test",
                    { signal: abort.signal },
                ),
        );
        expect(value).toEqual({ text: "x".repeat(100) });
        abort.abort();
        await expect(
            scoped({ "http.timeoutMs": -1 }, () =>
                new ProviderHttp({ fetch: fetcher }).json(
                    "https://example.com/test",
                    { signal: abort.signal },
                ),
            ),
        ).rejects.toThrow();
    });
    it("does not turn an unlimited subprocess timeout into immediate termination", async () => {
        const result = await scoped(
            { "backup.commandTimeoutMs": -1, "backup.maxOutputBytes": -1 },
            () =>
                runBackupProcess({
                    executable: process.execPath,
                    args: [
                        "-e",
                        "setTimeout(() => process.stdout.write('done'), 25)",
                    ],
                }),
        );
        expect(result.stdout).toBe("done");
    });
    it("reports aliases once on stderr and keeps settings JSON numeric", async () => {
        const dir = await root();
        await project(
            dir,
            "java:\n  startupTimeout: 3\n  stopTimeout: 4\nsettings:\n  runtime:\n    startupTimeoutMs: 5000\n",
        );
        vi.stubEnv("PI_TUI_ESC_TIMEOUT", "20");
        let stdout = "",
            stderr = "";
        vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
            stdout += String(chunk);
            return true;
        });
        vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
            stderr += String(chunk);
            return true;
        });
        process.exitCode = 0;
        await runCli(
            [
                "--set",
                "backup.maxFiles=1",
                "settings",
                "show",
                "-C",
                dir,
                "--json",
                "--set",
                "backup.maxFiles=-1",
            ],
            entry,
        );
        expect(process.exitCode).toBe(0);
        const result = JSON.parse(stdout).result;
        expect(
            result.settings.find(
                (item: { key: string }) => item.key === "backup.maxFiles",
            ).value,
        ).toBe(-1);
        for (const name of [
            "java.startupTimeout",
            "java.stopTimeout",
            "PI_TUI_ESC_TIMEOUT",
        ])
            expect(stderr.split(`${name} is deprecated`)).toHaveLength(2);
        expect(stderr).toContain("will be removed in a future release");
        expect(stderr).not.toContain("removed in 0.6.0");
    });
});
