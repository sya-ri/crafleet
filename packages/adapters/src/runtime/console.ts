import { CrafleetError } from "@crafleet/core";
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
        5000,
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
                    5000,
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
                Buffer.byteLength(JSON.stringify(text)) > 8192
            )
                throw new CrafleetError(
                    "CONSOLE_COMMAND",
                    "Command must be nonempty, single-line, and at most 8192 encoded bytes.",
                    2,
                );
            const result = await runnerRequest(
                connected,
                "command",
                text,
                5000,
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
