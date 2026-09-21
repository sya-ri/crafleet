import type { BackupBatch } from "@crafleet/adapters";
import { CrafleetError } from "@crafleet/core";
import { sanitizeInlineTerminalOutput } from "../presentation/terminal.js";

export type PartialFailureUnit = { project: string } | { group: string };

export function batchFailureUnit(batch: BackupBatch): PartialFailureUnit {
    return batch.group
        ? { group: batch.group }
        : { project: batch.projects[0]?.manifest.name ?? "Selected project" };
}

export function isCancellation(error: unknown, signal: AbortSignal): boolean {
    return (
        signal.aborted ||
        (error instanceof CrafleetError && error.code === "CANCELLED") ||
        (error instanceof Error && error.name === "AbortError")
    );
}

export function partialFailure(
    error: unknown,
    unit: PartialFailureUnit,
    fallback: string,
) {
    const known = error instanceof CrafleetError;
    return {
        ...("project" in unit
            ? { project: sanitizeInlineTerminalOutput(unit.project) }
            : { group: sanitizeInlineTerminalOutput(unit.group) }),
        ok: false as const,
        code: sanitizeInlineTerminalOutput(
            known ? error.code : "OPERATION_FAILED",
        ),
        message: sanitizeInlineTerminalOutput(known ? error.message : fallback),
    };
}
