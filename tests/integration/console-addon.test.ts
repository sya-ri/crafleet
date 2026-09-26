import {
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import {
    appendHistory,
    consolePromptDismissed,
    dismissConsolePrompt,
    readConsoleHistory,
    saveConsoleCommand,
    withRuntimeSettings,
} from "@crafleet/adapters";
import { resolveSettings } from "@crafleet/core";
import { afterEach, describe, expect, it } from "vitest";
import { ConsoleBridge } from "../../packages/adapters/src/runtime/console-bridge.js";

const roots: string[] = [];
const bridges: ConsoleBridge[] = [];
const sockets: net.Socket[] = [];
const parent = path.resolve(".test-tmp");
afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const bridge of bridges.splice(0)) bridge.close();
    for (const root of roots.splice(0)) {
        if (path.dirname(root) !== (await realpath(parent)))
            throw new Error("Unsafe cleanup");
        await rm(root, { recursive: true, force: true });
    }
});
async function directory() {
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(path.join(await realpath(parent), "console-"));
    roots.push(root);
    return root;
}
async function bridgeClient(aware = false) {
    const bridge = new ConsoleBridge("paper");
    bridges.push(bridge);
    const env = await bridge.listen();
    const socket = net.createConnection({
        host: "127.0.0.1",
        port: Number(env.CRAFLEET_CONSOLE_PORT),
    });
    sockets.push(socket);
    const reader = createInterface({ input: socket });
    const lines = reader[Symbol.asyncIterator]();
    socket.write(
        `HELLO\t1\t${env.CRAFLEET_CONSOLE_TOKEN}\t0.1.0\tpaper${aware ? "\tsettings-v1" : ""}\n`,
    );
    expect((await lines.next()).value).toBe("READY\t1");
    return { bridge, socket, lines, env };
}
describe("console persistence and transport", () => {
    it("preserves numeric -1 across addon launch and cancels unlimited requests outside their creation scope", async () => {
        const settings = resolveSettings([
            {
                source: "project",
                values: {
                    "addon.requestTimeoutMs": -1,
                    "console.maxCommandChars": -1,
                    "addon.maxPending": -1,
                },
            },
        ]);
        const { bridge, lines, env } = await withRuntimeSettings(settings, () =>
            bridgeClient(true),
        );
        expect(env.CRAFLEET_SETTINGS_ADDON_REQUEST_TIMEOUT_MS).toBe("-1");
        expect(env.CRAFLEET_SETTINGS_CONSOLE_MAX_COMMAND_CHARS).toBe("-1");
        expect(bridge.capabilities().completion).toBe(true);
        const abort = new AbortController();
        const pending = bridge.complete(
            { line: "x".repeat(9000), cursor: 9000 },
            abort.signal,
        );
        const rejected = expect(pending).rejects.toThrow();
        expect((await lines.next()).value).toMatch(/^COMPLETE\t/);
        abort.abort();
        await rejected;
        expect((await lines.next()).value).toMatch(/^CANCEL\t/);
    });
    it("requires an addon update when an old peer cannot accept changed settings", async () => {
        const settings = resolveSettings([
            { source: "project", values: { "addon.maxSuggestions": 500 } },
        ]);
        const { bridge } = await withRuntimeSettings(settings, () =>
            bridgeClient(),
        );
        expect(bridge.capabilities()).toEqual({
            completion: false,
            requiresAddonUpdate: true,
        });
    });
    it("merges concurrent writers, bounds history, and rejects damaged files", async () => {
        const root = await directory();
        const writers = await Promise.allSettled(
            Array.from({ length: 12 }, (_, index) =>
                saveConsoleCommand(root, `say ${index}`),
            ),
        );
        // Drain every writer before cleanup, even when one reports an error.
        for (const writer of writers) {
            if (writer.status === "rejected") throw writer.reason;
        }
        const history = await readConsoleHistory(root);
        expect(new Set(history).size).toBe(12);
        await saveConsoleCommand(root, history.at(-1) ?? "");
        expect(await readConsoleHistory(root)).toEqual(history);
        expect(
            appendHistory(
                Array.from({ length: 1000 }, (_, i) => String(i)),
                "last",
            ),
        ).toHaveLength(1000);
        await writeFile(
            path.join(root, ".crafleet/console-history.json"),
            "broken",
        );
        await expect(saveConsoleCommand(root, "list")).rejects.toThrow();
        expect(
            await readFile(
                path.join(root, ".crafleet/console-history.json"),
                "utf8",
            ),
        ).toBe("broken");
    });
    it("stores dismissal per user home and canonical project path", async () => {
        const root = await directory();
        const project = path.join(root, "server");
        const other = path.join(root, "other");
        await mkdir(project);
        await mkdir(other);
        const home = path.join(root, "home");
        expect(await consolePromptDismissed(home, project)).toBe(false);
        await dismissConsolePrompt(home, project);
        expect(
            await consolePromptDismissed(home, path.join(project, ".")),
        ).toBe(true);
        expect(await consolePromptDismissed(home, other)).toBe(false);
        expect(
            await consolePromptDismissed(
                path.join(root, "another-user"),
                project,
            ),
        ).toBe(false);
    });
    it("routes out-of-order completions independently without executing anything", async () => {
        const { bridge, socket, lines } = await bridgeClient();
        expect(bridge.capabilities()).toEqual({
            completion: true,
            addonVersion: "0.1.0",
        });
        const a = bridge.complete({ line: "he", cursor: 2 });
        const b = bridge.complete({ line: "li", cursor: 2 });
        const first = String((await lines.next()).value).split("\t");
        const second = String((await lines.next()).value).split("\t");
        expect(first[0]).toBe("COMPLETE");
        socket.write(
            `RESULT\t${second[1]}\t0:2:${Buffer.from("list").toString("base64")}\nRESULT\t${first[1]}\t0:2:${Buffer.from("help").toString("base64")}\n`,
        );
        expect(await b).toEqual([{ start: 0, end: 2, text: "list" }]);
        expect(await a).toEqual([{ start: 0, end: 2, text: "help" }]);
    });
    it("cancels requests and rejects malformed suggestions", async () => {
        const { bridge, socket, lines } = await bridgeClient();
        const abort = new AbortController();
        const request = bridge.complete(
            { line: "he", cursor: 2 },
            abort.signal,
        );
        const failure = expect(request).rejects.toThrow();
        await lines.next();
        abort.abort();
        await failure;
        expect((await lines.next()).value).toMatch(/^CANCEL\t/);
        const second = bridge.complete({ line: "he", cursor: 2 });
        const rejected = expect(second).rejects.toThrow();
        const id = String((await lines.next()).value).split("\t")[1];
        socket.write(`RESULT\t${id}\t0:99:aGVscA==\n`);
        await rejected;
        const third = bridge.complete({ line: "he", cursor: 2 });
        const disconnected = expect(third).rejects.toThrow();
        socket.destroy();
        await disconnected;
        expect(bridge.capabilities().completion).toBe(false);
    });
});
