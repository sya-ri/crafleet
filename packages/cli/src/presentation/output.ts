import { CrafleetError } from "@crafleet/core";
import type { describeCommand } from "../commands/metadata.js";
import { type HumanResultContext, renderHumanResult } from "./human.js";
import { sanitizeTerminalOutput } from "./terminal.js";

export function printResult(
    result: unknown,
    json: boolean,
    context: HumanResultContext,
    exitCode = 0,
): void {
    if (json && process.stdout.destroyed) return;
    if (json)
        process.stdout.write(
            `${JSON.stringify({
                ...(context.stream ? { event: "result" } : {}),
                ok: exitCode === 0,
                result: result ?? null,
                ...(exitCode !== 0
                    ? {
                          error: {
                              code:
                                  exitCode === 4
                                      ? "PARTIAL_FAILURE"
                                      : "CHECK_FAILED",
                              message:
                                  exitCode === 4
                                      ? "One or more selected recovery units failed. Inspect the per-target results before retrying."
                                      : "The command reported unsuccessful checks. Inspect the result for details.",
                          },
                      }
                    : {}),
            })}\n`,
        );
    else if (result === undefined) return;
    else if (typeof result === "string")
        process.stdout.write(`${sanitizeTerminalOutput(result)}\n`);
    else {
        try {
            process.stdout.write(`${renderHumanResult(result, context)}\n`);
        } catch {
            process.stdout.write(
                "The operation may have completed in whole or in part, but its result could not be displayed safely. Verify with a read-only command such as crafleet status, crafleet plugins, or crafleet deploy plan before retrying.\n",
            );
        }
    }
}
export function printError(
    error: unknown,
    json: boolean,
    command?: ReturnType<typeof describeCommand>,
): void {
    const normalized =
        error instanceof Error && error.name === "AbortError"
            ? new CrafleetError(
                  "CANCELLED",
                  "Operation cancelled at a safe boundary.",
                  130,
              )
            : error;
    const known = normalized instanceof CrafleetError;
    const code = known ? normalized.code : "UNEXPECTED";
    const message = known
        ? normalized.message
        : "An unexpected error occurred; no automatic retry or rollback was attempted.";
    const hint = known ? normalized.hint : undefined;
    process.exitCode = known ? normalized.exitCode : 1;
    if (json && process.stdout.destroyed) return;
    if (json)
        process.stdout.write(
            `${JSON.stringify({
                ok: false,
                error: {
                    code,
                    message,
                    ...(hint ? { hint } : {}),
                    ...(command &&
                    [
                        "CLI_USAGE",
                        "INPUT_REQUIRED",
                        "CONFIRMATION_REQUIRED",
                        "CONSOLE_TTY",
                        "SOURCE_STOPPED_REQUIRED",
                    ].includes(code)
                        ? { input: command }
                        : {}),
                },
            })}\n`,
        );
    else
        process.stderr.write(
            sanitizeTerminalOutput(
                `Error [${code}]: ${message}\n${hint ? `${hint}\n` : ""}`,
            ),
        );
}
