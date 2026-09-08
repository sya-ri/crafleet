import { CrafleetError } from "./errors.js";

export interface RuntimeIntent {
    schemaVersion: 1;
    desired: "running" | "stopped";
    attempts: number[];
}

export const SUPERVISION_POLL_MS = 1000;
export const SUPERVISION_RESTART_DELAY_MS = 10_000;
export const SUPERVISION_WINDOW_MS = 300_000;
export const SUPERVISION_MAX_ATTEMPTS = 5;

/** Reserve before launching so restarting the supervisor cannot reset the budget. */
export function reserveAutomaticStart(
    intent: RuntimeIntent,
    now: number,
): RuntimeIntent {
    const attempts = intent.attempts.filter(
        (time) => time > now - SUPERVISION_WINDOW_MS,
    );
    if (attempts.length >= SUPERVISION_MAX_ATTEMPTS)
        throw new CrafleetError(
            "SUPERVISION_LIMIT",
            "Automatic restart limit reached; inspect logs and explicitly start the server to resume.",
            3,
        );
    return {
        schemaVersion: 1,
        desired: "stopped",
        attempts: [...attempts, now],
    };
}
