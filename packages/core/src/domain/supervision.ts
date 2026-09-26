import { CrafleetError } from "./errors.js";
import {
    DEFAULT_SETTINGS,
    type RuntimeSettings,
    settingLimit,
} from "./settings.js";

export interface RuntimeIntent {
    schemaVersion: 1;
    desired: "running" | "stopped";
    attempts: number[];
}

export const SUPERVISION_POLL_MS = DEFAULT_SETTINGS["supervision.pollMs"];
export const SUPERVISION_RESTART_DELAY_MS =
    DEFAULT_SETTINGS["supervision.restartDelayMs"];
export const SUPERVISION_WINDOW_MS = DEFAULT_SETTINGS["supervision.windowMs"];
export const SUPERVISION_MAX_ATTEMPTS =
    DEFAULT_SETTINGS["supervision.maxAttempts"];

/** Reserve before launching so restarting the supervisor cannot reset the budget. */
export function reserveAutomaticStart(
    intent: RuntimeIntent,
    now: number,
    settings: RuntimeSettings = DEFAULT_SETTINGS,
): RuntimeIntent {
    const attempts = intent.attempts.filter(
        (time) => time > now - settings["supervision.windowMs"],
    );
    if (attempts.length >= settingLimit(settings, "supervision.maxAttempts"))
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
