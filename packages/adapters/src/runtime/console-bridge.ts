import { randomUUID, timingSafeEqual } from "node:crypto";
import net from "node:net";
import {
    type CommandCompletionRequest,
    type CommandSuggestion,
    type ConsoleCapabilities,
    CrafleetError,
    validCompletionRequest,
    validSuggestions,
} from "@crafleet/core";

const unavailable = () =>
    new CrafleetError(
        "COMPLETION_UNAVAILABLE",
        "Console addon is not connected or did not respond.",
        3,
    );
export class ConsoleBridge {
    private readonly token = randomUUID();
    private readonly server = net.createServer((socket) => this.accept(socket));
    private readonly sockets = new Set<net.Socket>();
    private addon: net.Socket | undefined;
    private version: string | undefined;
    private readonly pending = new Map<
        string,
        {
            request: CommandCompletionRequest;
            resolve(value: CommandSuggestion[]): void;
            reject(error: Error): void;
            cleanup(): void;
        }
    >();
    constructor(private readonly kind: "paper" | "velocity") {
        this.server.maxConnections = 8;
        this.server.on("error", () => this.close());
    }
    async listen(): Promise<Record<string, string>> {
        await new Promise<void>((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(0, "127.0.0.1", () => {
                this.server.off("error", reject);
                resolve();
            });
        });
        const address = this.server.address();
        if (!address || typeof address === "string") throw unavailable();
        return {
            CRAFLEET_CONSOLE_PORT: String(address.port),
            CRAFLEET_CONSOLE_TOKEN: this.token,
        };
    }
    capabilities(): ConsoleCapabilities {
        return this.addon && this.version
            ? { completion: true, addonVersion: this.version }
            : { completion: false };
    }
    complete(
        request: CommandCompletionRequest,
        signal?: AbortSignal,
    ): Promise<CommandSuggestion[]> {
        signal?.throwIfAborted();
        if (
            !this.addon ||
            !validCompletionRequest(request) ||
            this.pending.size >= 32
        )
            return Promise.reject(unavailable());
        const socket = this.addon;
        return new Promise((resolve, reject) => {
            const id = randomUUID();
            const cancel = () => {
                this.finish(id, unavailable());
                if (!socket.destroyed) socket.write(`CANCEL\t${id}\n`);
            };
            const timer = setTimeout(cancel, 1500);
            const cleanup = () => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", cancel);
            };
            this.pending.set(id, { request, resolve, reject, cleanup });
            signal?.addEventListener("abort", cancel, { once: true });
            socket.write(
                `COMPLETE\t${id}\t${request.cursor}\t${Buffer.from(request.line).toString("base64")}\n`,
            );
        });
    }
    close(): void {
        for (const socket of this.sockets) socket.destroy();
        if (this.server.listening) this.server.close();
        this.disconnected();
    }
    private disconnected(): void {
        this.addon = undefined;
        this.version = undefined;
        for (const id of this.pending.keys()) this.finish(id, unavailable());
    }
    private finish(id: string, result: Error | CommandSuggestion[]): void {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.cleanup();
        if (result instanceof Error) pending.reject(result);
        else pending.resolve(result);
    }
    private accept(socket: net.Socket): void {
        this.sockets.add(socket);
        let buffer: Buffer = Buffer.alloc(0);
        let authenticated = false;
        socket.setTimeout(3000, () => socket.destroy());
        socket.on("error", () => socket.destroy());
        socket.once("close", () => {
            this.sockets.delete(socket);
            if (socket === this.addon) this.disconnected();
        });
        socket.on("data", (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            for (;;) {
                const end = buffer.indexOf(10);
                if (end > 65536 || (end < 0 && buffer.length > 65536)) {
                    socket.destroy();
                    return;
                }
                if (end < 0) break;
                const parts = buffer
                    .subarray(0, end)
                    .toString("utf8")
                    .split("\t");
                buffer = buffer.subarray(end + 1);
                if (!authenticated) {
                    const supplied = Buffer.from(parts[2] ?? "");
                    const expected = Buffer.from(this.token);
                    if (
                        parts.length !== 5 ||
                        parts[0] !== "HELLO" ||
                        parts[1] !== "1" ||
                        supplied.length !== expected.length ||
                        !timingSafeEqual(supplied, expected) ||
                        parts[4] !== this.kind ||
                        !/^[0-9A-Za-z.+-]{1,80}$/.test(parts[3] ?? "") ||
                        this.addon
                    ) {
                        socket.destroy();
                        return;
                    }
                    authenticated = true;
                    this.addon = socket;
                    this.version = parts[3];
                    socket.setTimeout(0);
                    socket.write("READY\t1\n");
                    continue;
                }
                const id = parts[1] ?? "";
                const pending = this.pending.get(id);
                if (!pending) continue;
                if (parts[0] !== "RESULT") {
                    this.finish(id, unavailable());
                    continue;
                }
                if (
                    parts
                        .slice(2)
                        .some(
                            (field) =>
                                !/^\d{1,4}:\d{1,4}:(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
                                    field,
                                ),
                        )
                ) {
                    this.finish(id, unavailable());
                    continue;
                }
                const suggestions = parts.slice(2).map((field) => {
                    const [start, end, encoded] = field.split(":");
                    return {
                        start: Number(start),
                        end: Number(end),
                        text: Buffer.from(encoded ?? "", "base64").toString(
                            "utf8",
                        ),
                    };
                });
                this.finish(
                    id,
                    validSuggestions(suggestions, pending.request)
                        ? suggestions
                        : unavailable(),
                );
            }
        });
    }
}
