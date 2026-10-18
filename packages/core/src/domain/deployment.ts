import { CrafleetError } from "./errors.js";

export type RuntimeStatus =
    | "stopped"
    | "starting"
    | "running"
    | "stopping"
    | "unknown";

export interface OperationWarning {
    code: string;
    message: string;
    target?: string;
}
export interface LiveOperationOptions {
    force?: boolean;
    onWarning?: (warning: OperationWarning) => void;
}
export function reportWarning(
    options: LiveOperationOptions,
    warning: OperationWarning,
): void {
    try {
        options.onWarning?.(warning);
    } catch {
        // Display failures must not affect an operation.
    }
}
export function assertRuntimeAccess(
    status: RuntimeStatus,
    options: LiveOperationOptions & { dryRun?: boolean },
    warning?: OperationWarning,
    allowRunning = false,
): boolean {
    if (status === "running") {
        if (!options.force && !options.dryRun && !allowRunning)
            throw new CrafleetError(
                "NOT_STOPPED",
                "Server is running; the operation was not performed.",
                3,
                `Stop the server first, or use --force. ${warning?.message ?? ""}`.trim(),
            );
        if (warning) reportWarning(options, warning);
        return true;
    }
    if (!options.dryRun) assertStopped(status);
    return false;
}

export const LIVE_CAPTURE_WARNING = {
    code: "LIVE_CAPTURE",
    message:
        "Reading running server files cannot include unsaved in-memory data or guarantee consistency across files. Detected changes still abort the operation; saved files do not change runtime.",
};
export const LIVE_MIGRATION_WARNING = {
    code: "LIVE_MIGRATION",
    message:
        "Migration changes the saved file layout and management metadata, not runtime. Upgrade all management tools first and restart long-running management tools if necessary.",
};
export const LIVE_DEPLOY_WARNING = {
    code: "LIVE_DEPLOY",
    message:
        "Settings are written to disk only; restart the server (recommended for Paper), or use a reload explicitly supported by the affected component. The server may overwrite these files, and text files may contain plugin save data. Only changed settings are retained for recovery; no world/database or full cold backup is created. Java is not stopped or reloaded automatically, including on failure.",
};
export function assertStopped(status: RuntimeStatus): void {
    if (status !== "stopped")
        throw new CrafleetError(
            "NOT_STOPPED",
            `Server is ${status}; no runtime files were changed.`,
            3,
            "Run crafleet stop and confirm termination first.",
        );
}

export function shouldResumeBackup(
    wasRunning: boolean,
    backupSucceeded: boolean,
    leaveStopped: boolean,
): boolean {
    return wasRunning && backupSucceeded && !leaveStopped;
}

export function mayRollback(
    phase: "prepared" | "applying" | "applied" | "spawned",
): boolean {
    return phase !== "spawned";
}
