import { PassThrough, Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { type JsonConsoleOptions, openJsonConsole } from "./json-console.js";

function fixture(patch: Partial<JsonConsoleOptions<number>> = {}) {
    const events: Array<Record<string, unknown>> = [];
    const input = new PassThrough();
    const output = new Writable({
        write(chunk, _encoding, done) {
            events.push(JSON.parse(String(chunk)));
            done();
        },
    });
    const sendCommand = vi.fn(
        async (_text: string, _signal: AbortSignal) => {},
    );
    const options: JsonConsoleOptions<number> = {
        input,
        output,
        identity: { pid: 12, javaPid: 13, activeId: "installation" },
        loadRecent: async () => ({ text: "previous 日本語\n", follow: 1 }),
        async *follow(_checkpoint, signal) {
            yield { kind: "append", text: "live log\n" };
            await delay(60000, undefined, { signal });
        },
        sendCommand,
        isConnected: async () => true,
        ...patch,
    };
    return { input, output, options, events, sendCommand };
}

describe("bounded NDJSON console sessions", () => {
    it("correlates sequential acknowledgements among logs and detaches on EOF", async () => {
        const f = fixture();
        f.input.end(
            '{"id":"1","command":"list"}\n{"id":"日本語","command":"help"}',
        );
        expect(await openJsonConsole(f.options)).toMatchObject({
            reason: "eof",
            sent: 2,
            failed: 0,
            serverStopped: false,
        });
        expect(f.events[0]).toMatchObject({
            event: "connected",
            result: { maxInputBytes: 16384 },
        });
        expect(f.events.filter((e) => e.event === "command")).toEqual([
            {
                event: "command",
                id: "1",
                ok: true,
                result: { sent: true, execution: "unconfirmed" },
            },
            {
                event: "command",
                id: "日本語",
                ok: true,
                result: { sent: true, execution: "unconfirmed" },
            },
        ]);
        expect(f.events.some((e) => e.event === "log")).toBe(true);
        expect(f.events.at(-1)).toMatchObject({
            event: "disconnected",
            result: { reason: "eof", serverStopped: false },
        });
    });
    it("rejects malformed requests without echoing their contents and continues", async () => {
        const f = fixture();
        const lines = [
            "secret invalid",
            "null",
            "[]",
            "{}",
            '{"id":1}',
            '{"id":""}',
            JSON.stringify({ id: "x".repeat(129) }),
            '{"id":"1"}',
            '{"id":"1","command":"list","extra":true}',
            '{"id":"1","command":" "}',
            '{"id":"1","command":"a\\nb"}',
            JSON.stringify({ id: "1", command: "日".repeat(3000) }),
        ];
        f.input.end(`${lines.join("\n")}\n{"id":"ok","command":"list"}\n`);
        const result = await openJsonConsole(f.options);
        expect(result).toMatchObject({
            failed: lines.length,
            sent: 1,
            exitCode: 2,
        });
        expect(JSON.stringify(f.events)).not.toContain("secret invalid");
        expect(f.sendCommand).toHaveBeenCalledTimes(1);
    });
    it("bounds unterminated lines, recovers after newline, and decodes split UTF-8", async () => {
        const f = fixture();
        const text = Buffer.from('{"id":"ok","command":"say 日本語"}\n');
        const cut = text.indexOf(Buffer.from("日")) + 1;
        f.options.input = Readable.from([
            Buffer.alloc(9000, 120),
            Buffer.alloc(9000, 120),
            Buffer.from("\n"),
            Buffer.from([0xff, 10]),
            text.subarray(0, cut),
            text.subarray(cut),
            Buffer.alloc(20000, 120),
        ]);
        expect(await openJsonConsole(f.options)).toMatchObject({
            sent: 1,
            failed: 3,
        });
        expect(f.sendCommand.mock.calls[0]?.[0]).toBe("say 日本語");
        expect(
            f.events.filter(
                (e) =>
                    (e.error as { code: string } | undefined)?.code ===
                    "CONSOLE_INPUT_SIZE",
            ),
        ).toHaveLength(2);
    });
    it("pauses request processing while a slow reader drains stdout", async () => {
        let release: (() => void) | undefined;
        let hold = true;
        let writes = 0;
        const f = fixture({
            output: new Writable({
                highWaterMark: 1,
                write(_chunk, _encoding, done) {
                    writes++;
                    if (hold) release = done;
                    else done();
                },
            }),
        });
        f.input.end(
            Array.from({ length: 200 }, (_, i) =>
                JSON.stringify({ id: String(i), command: "list" }),
            ).join("\n"),
        );
        const task = openJsonConsole(f.options);
        await delay(30);
        expect(writes).toBe(1);
        expect(f.sendCommand).not.toHaveBeenCalled();
        hold = false;
        release?.();
        expect(await task).toMatchObject({ sent: 200, failed: 0 });
    });
    it("never overlaps command sends or retries an unacknowledged command", async () => {
        const f = fixture();
        let active = 0;
        let maximum = 0;
        f.sendCommand.mockImplementation(async () => {
            active++;
            maximum = Math.max(maximum, active);
            await delay(5);
            active--;
            throw new Error("private details");
        });
        f.input.end(
            '{"id":"1","command":"list"}\n{"id":"2","command":"help"}\n',
        );
        expect(await openJsonConsole(f.options)).toMatchObject({
            sent: 0,
            failed: 1,
            reason: "server-ended",
        });
        expect(maximum).toBe(1);
        expect(f.sendCommand).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(f.events)).not.toContain("private details");
    });
    it.each([false, true])(
        "detaches on Ctrl-C, including pre-aborted signals (%s)",
        async (preAborted) => {
            const abort = new AbortController();
            const f = fixture({ signal: abort.signal });
            if (preAborted) abort.abort();
            const task = openJsonConsole(f.options);
            if (!preAborted) {
                await delay(20);
                abort.abort();
            }
            expect(await task).toMatchObject({
                reason: "signal",
                sent: 0,
                exitCode: 0,
            });
            expect(f.input.destroyed).toBe(true);
        },
    );
    it("detaches when the original server ends and reports log rotation", async () => {
        const f = fixture({
            isConnected: vi
                .fn()
                .mockResolvedValueOnce(true)
                .mockResolvedValue(false),
            async *follow(_checkpoint, signal) {
                yield { kind: "reset" };
                await delay(60000, undefined, { signal });
            },
        });
        expect(await openJsonConsole(f.options)).toMatchObject({
            reason: "server-ended",
            exitCode: 3,
        });
        expect(f.events.some((e) => e.event === "log-reset")).toBe(true);
    });
    it("bounds detachment when stdout never drains", async () => {
        const abort = new AbortController();
        const f = fixture({
            signal: abort.signal,
            output: new Writable({ write() {} }),
        });
        const task = openJsonConsole(f.options);
        await delay(20);
        abort.abort();
        await expect(task).rejects.toThrow("Output closed");
        expect(f.options.output.destroyed).toBe(true);
    });
    it("handles input and output errors without sending a stop command", async () => {
        const f = fixture();
        const task = openJsonConsole(f.options);
        await delay(20);
        f.input.destroy(new Error("input failed"));
        expect(await task).toMatchObject({
            reason: "input-error",
            exitCode: 3,
        });
        expect(f.sendCommand).not.toHaveBeenCalled();
        const second = fixture();
        const other = openJsonConsole(second.options);
        await delay(20);
        second.output.destroy(new Error("broken pipe"));
        expect(await other).toMatchObject({
            reason: "output-closed",
            exitCode: 3,
        });
    });
});
