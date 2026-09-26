import { randomUUID, timingSafeEqual } from "node:crypto";
import net from "node:net";
import {
    type CommandCompletionRequest,
    type CommandSuggestion,
    type ConsoleCapabilities,
    CrafleetError,
    DEFAULT_SETTINGS,
    type SettingKey,
    settingEnvironmentName,
} from "@crafleet/core";
import {
    bindRuntimeSettings,
    captureRuntimeSettings,
    runtimeLimit,
    runtimeSettings,
    runtimeTimeout,
    runtimeValue,
    withSettingsMethods,
} from "../settings.js";
import {
    validCompletionRequest,
    validSuggestions,
} from "../settings-validation.js";

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
    private settingsAware = false;
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
        withSettingsMethods(this, captureRuntimeSettings());
        this.server.maxConnections = runtimeLimit("addon.maxConnections");
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
            CRAFLEET_CONSOLE_SETTINGS_VERSION: "1",
            ...Object.fromEntries(
                Object.entries(runtimeSettings())
                    .filter(
                        ([key]) =>
                            key.startsWith("addon.") ||
                            key === "console.maxCommandChars",
                    )
                    .map(([key, value]) => [
                        settingEnvironmentName(key as SettingKey),
                        String(value),
                    ]),
            ),
        };
    }
    capabilities(): ConsoleCapabilities {
        if (this.addon && !this.settingsAware && this.needsSettings())
            return { completion: false, requiresAddonUpdate: true };
        return this.addon && this.version
            ? { completion: true, addonVersion: this.version }
            : { completion: false };
    }
    private needsSettings(): boolean {
        return Object.entries(runtimeSettings()).some(
            ([key, value]) =>
                (key.startsWith("addon.") ||
                    key === "console.maxCommandChars") &&
                value !== DEFAULT_SETTINGS[key as SettingKey],
        );
    }
    complete(
        request: CommandCompletionRequest,
        signal?: AbortSignal,
    ): Promise<CommandSuggestion[]> {
        signal?.throwIfAborted();
        if (
            !this.addon ||
            (!this.settingsAware && this.needsSettings()) ||
            !validCompletionRequest(request) ||
            this.pending.size >= runtimeLimit("addon.maxPending")
        )
            return Promise.reject(unavailable());
        const socket = this.addon;
        return new Promise((resolve, reject) => {
            const id = randomUUID();
            const cancel = () => {
                this.finish(id, unavailable());
                if (!socket.destroyed) socket.write(`CANCEL\t${id}\n`);
            };
            const timer =
                runtimeValue("addon.requestTimeoutMs") === -1
                    ? undefined
                    : setTimeout(
                          cancel,
                          runtimeValue("addon.requestTimeoutMs"),
                      );
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
        this.settingsAware = false;
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
        socket.setTimeout(runtimeTimeout("addon.handshakeTimeoutMs"), () =>
            socket.destroy(),
        );
        socket.on("error", () => socket.destroy());
        socket.once("close", () => {
            this.sockets.delete(socket);
            if (socket === this.addon) this.disconnected();
        });
        socket.on(
            "data",
            bindRuntimeSettings((chunk: Buffer) => {
                buffer = Buffer.concat([buffer, chunk]);
                const configuredMaxFrameBytes = runtimeLimit(
                    "addon.maxFrameBytes",
                );
                for (;;) {
                    const end = buffer.indexOf(10);
                    if (
                        end > configuredMaxFrameBytes ||
                        (end < 0 && buffer.length > configuredMaxFrameBytes)
                    ) {
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
                            (parts.length !== 5 &&
                                !(
                                    parts.length === 6 &&
                                    parts[5] === "settings-v1"
                                )) ||
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
                        this.settingsAware = parts.length === 6;
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
                                    !/^\d+:\d+:(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
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
            }),
        );
    }
}
