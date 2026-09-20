import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { validConsoleText } from "@crafleet/core";
import {
    assertNoSymlinks,
    canonicalPath,
    exists,
    withMutex,
    writeJson,
} from "./io.js";
import { MutexBusyError } from "./mutex-error.js";
import { ensurePrivateDirectory } from "./private.js";

export function appendHistory(
    history: readonly string[],
    command: string,
): string[] {
    if (
        !command.trim() ||
        !validConsoleText(command) ||
        history.at(-1) === command
    )
        return [...history];
    return [...history, command].slice(-1000);
}
export async function readConsoleHistory(
    projectDir: string,
): Promise<string[]> {
    const file = await assertNoSymlinks(
        projectDir,
        ".crafleet/console-history.json",
    );
    if (!(await exists(file))) return [];
    if ((await stat(file)).size > 40 * 1024 * 1024)
        throw new Error("Console history exceeds its size limit.");
    const record: unknown = JSON.parse(await readFile(file, "utf8"));
    if (
        !record ||
        typeof record !== "object" ||
        !("schemaVersion" in record) ||
        record.schemaVersion !== 1 ||
        !("commands" in record) ||
        !Array.isArray(record.commands) ||
        record.commands.length > 1000 ||
        !record.commands.every(validConsoleText)
    )
        throw new Error("Invalid console history.");
    return record.commands;
}
export async function saveConsoleCommand(
    projectDir: string,
    command: string,
): Promise<void> {
    await ensurePrivateDirectory(
        await assertNoSymlinks(projectDir, ".crafleet"),
    );
    const lock = await assertNoSymlinks(
        projectDir,
        ".crafleet/console-history.lock",
    );
    // Private-directory checks and concurrent disk writes can take seconds on Windows.
    // Bound contention by elapsed time without dropping submissions during normal bursts.
    const deadline = Date.now() + 10000;
    for (;;) {
        try {
            await withMutex(lock, async () => {
                const commands = appendHistory(
                    await readConsoleHistory(projectDir),
                    command,
                );
                await writeJson(
                    await assertNoSymlinks(
                        projectDir,
                        ".crafleet/console-history.json",
                    ),
                    { schemaVersion: 1, commands },
                );
            });
            return;
        } catch (error) {
            if (
                !(error instanceof MutexBusyError) ||
                error.directory !== lock ||
                Date.now() >= deadline
            )
                throw error;
            await delay(25);
        }
    }
}
async function preferenceFile(
    home: string,
    projectDir: string,
): Promise<string> {
    const real = await canonicalPath(projectDir);
    const key = createHash("sha256")
        .update(process.platform === "win32" ? real.toLowerCase() : real)
        .digest("hex");
    return assertNoSymlinks(home, path.join("console-prompts", `${key}.json`));
}
export async function consolePromptDismissed(
    home: string,
    projectDir: string,
): Promise<boolean> {
    const file = await preferenceFile(home, projectDir);
    if (!(await exists(file))) return false;
    if ((await stat(file)).size > 1024)
        throw new Error("Invalid console preference.");
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (
        !value ||
        typeof value !== "object" ||
        !("schemaVersion" in value) ||
        value.schemaVersion !== 1 ||
        !("dismissed" in value) ||
        value.dismissed !== true
    )
        throw new Error("Invalid console preference.");
    return true;
}
export async function dismissConsolePrompt(
    home: string,
    projectDir: string,
): Promise<void> {
    const file = await preferenceFile(home, projectDir);
    await ensurePrivateDirectory(path.dirname(file));
    await writeJson(file, { schemaVersion: 1, dismissed: true });
}
