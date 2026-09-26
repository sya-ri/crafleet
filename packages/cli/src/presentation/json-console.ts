import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { runtimeLimit, runtimeValue } from "@crafleet/adapters";
import { CrafleetError } from "@crafleet/core";

type Reason =
    | "eof"
    | "signal"
    | "server-ended"
    | "output-closed"
    | "input-error";
export interface JsonConsoleOptions<Checkpoint> {
    input: Readable;
    output: Writable;
    identity: { pid: number; javaPid: number; activeId: string };
    loadRecent(): Promise<{ text: string; follow: Checkpoint }>;
    follow(
        checkpoint: Checkpoint,
        signal: AbortSignal,
    ): AsyncIterable<{ kind: "append"; text: string } | { kind: "reset" }>;
    sendCommand(text: string, signal: AbortSignal): Promise<void>;
    isConnected(signal: AbortSignal): Promise<boolean>;
    signal?: AbortSignal;
}

/** At most one write per producer is queued; slow stdout also pauses stdin. */
export async function openJsonConsole<Checkpoint>(
    options: JsonConsoleOptions<Checkpoint>,
) {
    const flushTimeout = runtimeValue("console.flushTimeoutMs");
    const session = new AbortController();
    const writer = new AbortController();
    let reason: Reason | undefined;
    let failed = 0;
    let sent = 0;
    let tail = Promise.resolve();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: Reason) => {
        if (reason) return;
        reason = value;
        session.abort();
        options.input.destroy();
        // A pipe that never drains must not prevent detachment indefinitely.
        if (flushTimeout !== -1)
            flushTimer = setTimeout(() => {
                writer.abort();
                options.output.destroy();
            }, flushTimeout);
    };
    const outputClosed = () => {
        writer.abort();
        finish("output-closed");
    };
    const interrupted = () => {
        if (flushTimeout === -1) writer.abort();
        finish("signal");
    };
    options.output.on("error", outputClosed);
    options.output.on("close", outputClosed);
    options.signal?.addEventListener("abort", interrupted, { once: true });
    const write = (event: unknown): Promise<void> => {
        const next = tail.then(
            () =>
                new Promise<void>((resolve, reject) => {
                    if (writer.signal.aborted || options.output.destroyed)
                        return reject(new Error("Output closed"));
                    const cancel = () => reject(new Error("Output closed"));
                    writer.signal.addEventListener("abort", cancel, {
                        once: true,
                    });
                    options.output.write(
                        `${JSON.stringify(event)}\n`,
                        (error) => {
                            writer.signal.removeEventListener("abort", cancel);
                            if (error) reject(error);
                            else resolve();
                        },
                    );
                }),
        );
        tail = next.catch(() => {
            outputClosed();
        });
        return next;
    };
    const rejectInput = async (code: string, message: string, id?: string) => {
        failed++;
        await write({
            event: "command",
            ...(id === undefined ? {} : { id }),
            ok: false,
            error: { code, message },
        });
    };
    const request = async (line: Buffer) => {
        let value: unknown;
        try {
            value = JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(line),
            );
        } catch {
            return rejectInput(
                "CONSOLE_INPUT",
                "Expected one UTF-8 JSON object with id and command per line.",
            );
        }
        if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            !("id" in value) ||
            typeof value.id !== "string" ||
            value.id.length < 1 ||
            value.id.length > runtimeLimit("console.maxRequestIdChars")
        )
            return rejectInput(
                "CONSOLE_INPUT",
                `id must be a nonempty string within console.maxRequestIdChars (${runtimeValue("console.maxRequestIdChars")}).`,
            );
        const id = value.id;
        if (
            Object.keys(value).some(
                (key) => key !== "id" && key !== "command",
            ) ||
            !("command" in value) ||
            typeof value.command !== "string" ||
            !value.command.trim() ||
            /[\r\n\0]/.test(value.command) ||
            Buffer.byteLength(JSON.stringify(value.command)) >
                runtimeLimit("console.maxCommandBytes")
        )
            return rejectInput(
                "CONSOLE_COMMAND",
                `command must be nonempty, single-line, and within console.maxCommandBytes (${runtimeValue("console.maxCommandBytes")}); only id and command are accepted.`,
                id,
            );
        try {
            await options.sendCommand(value.command, session.signal);
            sent++;
            await write({
                event: "command",
                id,
                ok: true,
                result: { sent: true, execution: "unconfirmed" },
            });
        } catch (error) {
            failed++;
            await write({
                event: "command",
                id,
                ok: false,
                error: {
                    code:
                        error instanceof CrafleetError
                            ? error.code
                            : "CONSOLE_SEND",
                    message:
                        "Delivery is unconfirmed. No automatic retry was attempted.",
                },
            });
            finish(options.signal?.aborted ? "signal" : "server-ended");
        }
    };
    const input = async () => {
        let pending: Buffer = Buffer.alloc(0);
        let oversized = false;
        for await (const raw of options.input) {
            const chunk: Buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
            let start = 0;
            while (start < chunk.length && !session.signal.aborted) {
                const newline = chunk.indexOf(10, start);
                const end = newline < 0 ? chunk.length : newline;
                if (!oversized) {
                    if (
                        pending.length + end - start >
                        runtimeLimit("console.maxInputBytes")
                    ) {
                        oversized = true;
                        pending = Buffer.alloc(0);
                    } else
                        pending = Buffer.concat([
                            pending,
                            chunk.subarray(start, end),
                        ]);
                }
                if (newline >= 0) {
                    if (oversized)
                        await rejectInput(
                            "CONSOLE_INPUT_SIZE",
                            `Input line exceeds console.maxInputBytes (${runtimeLimit("console.maxInputBytes")} bytes).`,
                        );
                    else await request(pending);
                    pending = Buffer.alloc(0);
                    oversized = false;
                }
                start = end + 1;
            }
        }
        if (!session.signal.aborted) {
            if (oversized)
                await rejectInput(
                    "CONSOLE_INPUT_SIZE",
                    `Input line exceeds console.maxInputBytes (${runtimeLimit("console.maxInputBytes")} bytes).`,
                );
            else if (pending.length) await request(pending);
            finish("eof");
        }
    };
    const logs = async (checkpoint: Checkpoint) => {
        let position = checkpoint;
        while (!session.signal.aborted) {
            let reset = false;
            for await (const event of options.follow(
                position,
                session.signal,
            )) {
                if (session.signal.aborted) return;
                if (event.kind === "reset") {
                    reset = true;
                    break;
                }
                await write({ event: "log", text: event.text });
            }
            if (session.signal.aborted) return;
            if (!reset || !(await options.isConnected(session.signal))) {
                finish("server-ended");
                return;
            }
            await write({ event: "log-reset" });
            const recent = await options.loadRecent();
            position = recent.follow;
            if (recent.text) await write({ event: "log", text: recent.text });
            await delay(runtimeValue("logs.pollMs"), undefined, {
                signal: session.signal,
            });
        }
    };
    const monitor = async () => {
        while (!session.signal.aborted) {
            await delay(runtimeValue("runtime.statusPollMs"), undefined, {
                signal: session.signal,
            });
            if (!(await options.isConnected(session.signal))) {
                finish("server-ended");
                break;
            }
        }
    };
    try {
        if (options.signal?.aborted) finish("signal");
        if (!reason) {
            const recent = await options.loadRecent();
            await write({
                event: "connected",
                ok: true,
                result: {
                    ...options.identity,
                    maxInputBytes: runtimeValue("console.maxInputBytes"),
                    maxCommandBytes: runtimeValue("console.maxCommandBytes"),
                    execution: "unconfirmed",
                },
            });
            if (recent.text) await write({ event: "log", text: recent.text });
            const guard = (task: Promise<void>, failure: Reason) =>
                task.catch(() => {
                    if (!reason) finish(failure);
                });
            await Promise.all([
                guard(input(), "input-error"),
                guard(logs(recent.follow), "server-ended"),
                guard(monitor(), "server-ended"),
            ]);
        }
        if (!options.output.destroyed && !writer.signal.aborted)
            await write({
                event: "disconnected",
                ok: true,
                result: { reason, serverStopped: false },
            }).catch(() => {});
    } finally {
        session.abort();
        clearTimeout(flushTimer);
        options.signal?.removeEventListener("abort", interrupted);
        options.output.off("error", outputClosed);
        options.output.off("close", outputClosed);
    }
    return {
        detached: true,
        serverStopped: false,
        reason,
        sent,
        failed,
        exitCode: failed
            ? 2
            : reason === "server-ended" ||
                reason === "input-error" ||
                reason === "output-closed"
              ? 3
              : 0,
    };
}
