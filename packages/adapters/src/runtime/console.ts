import { CrafleetError } from "@crafleet/core";
import { runtimeLimit, runtimeTimeout } from "../settings.js";
import { type RunnerRecord, runnerRequest } from "./protocol.js";

/** Pin every request to the authenticated runner selected at attachment time. */
export async function connectServerConsole(
    record: RunnerRecord | undefined,
    signal?: AbortSignal,
) {
    if (!record)
        throw new CrafleetError(
            "SERVER_NOT_RUNNING",
            "Start the server before attaching its console.",
            3,
        );
    const connected = await runnerRequest(
        record,
        "status",
        undefined,
        runtimeTimeout("runtime.requestTimeoutMs"),
        signal,
    );
    if (connected.phase !== "running" || !connected.javaPid)
        throw new CrafleetError(
            "SERVER_NOT_RUNNING",
            "Start the server before attaching its console.",
            3,
        );
    const sameServer = (value: RunnerRecord) =>
        value.phase === "running" && value.javaPid === connected.javaPid;
    return {
        identity: {
            pid: connected.pid,
            javaPid: connected.javaPid,
            activeId: connected.activeId,
        },
        async isConnected(requestSignal: AbortSignal): Promise<boolean> {
            return sameServer(
                await runnerRequest(
                    connected,
                    "status",
                    undefined,
                    runtimeTimeout("runtime.requestTimeoutMs"),
                    requestSignal,
                ),
            );
        },
        async sendCommand(
            text: string,
            requestSignal: AbortSignal,
        ): Promise<void> {
            if (
                !text.trim() ||
                /[\r\n\0]/.test(text) ||
                Buffer.byteLength(JSON.stringify(text)) >
                    runtimeLimit("console.maxCommandBytes")
            )
                throw new CrafleetError(
                    "CONSOLE_COMMAND",
                    `Command must be nonempty, single-line, and within console.maxCommandBytes (${runtimeLimit("console.maxCommandBytes")} bytes).`,
                    2,
                );
            const result = await runnerRequest(
                connected,
                "command",
                text,
                runtimeTimeout("runtime.requestTimeoutMs"),
                requestSignal,
            );
            if (result.javaPid !== connected.javaPid)
                throw new CrafleetError(
                    "CONSOLE_DISCONNECTED",
                    "Server identity changed; delivery is unconfirmed. No retry was attempted.",
                    3,
                );
        },
    };
}
