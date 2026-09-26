import { opendir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CrafleetError } from "@crafleet/core";
import { runtimeLimit } from "../settings.js";

function hasControlCharacters(value: string): boolean {
    return [...value].some((character) => {
        const point = character.codePointAt(0) ?? 0;
        return point < 32 || point === 127;
    });
}

/** Read one explicitly requested directory, never scan a tree or create a cache. */
export async function completePaths(
    cwd: string,
    input: string,
    kind: "directory" | "file" | "jar",
): Promise<string[]> {
    if (
        hasControlCharacters(input) ||
        input.length > runtimeLimit("completion.maxInputChars")
    )
        return [];
    const separator = Math.max(
        input.lastIndexOf("/"),
        process.platform === "win32" ? input.lastIndexOf("\\") : -1,
    );
    const prefix = input.slice(0, separator + 1);
    const partial = input.slice(separator + 1);
    const directory = path.resolve(
        cwd,
        prefix.startsWith("~/")
            ? path.join(os.homedir(), prefix.slice(2))
            : prefix || ".",
    );
    const candidates: string[] = [];
    try {
        const entries = await opendir(directory);
        let scanned = 0;
        const configuredMaxScanEntries = runtimeLimit(
            "completion.maxScanEntries",
        );
        const configuredMaxCandidates = runtimeLimit(
            "completion.maxCandidates",
        );
        for await (const entry of entries) {
            if (
                ++scanned > configuredMaxScanEntries ||
                candidates.length >= configuredMaxCandidates
            )
                break;
            if (
                !entry.name.startsWith(partial) ||
                hasControlCharacters(entry.name)
            )
                continue;
            if (entry.name.startsWith(".") && !partial.startsWith("."))
                continue;
            if (entry.isDirectory()) candidates.push(`${prefix}${entry.name}/`);
            else if (
                entry.isFile() &&
                kind !== "directory" &&
                (kind !== "jar" || entry.name.toLowerCase().endsWith(".jar"))
            )
                candidates.push(`${prefix}${entry.name}`);
        }
    } catch (error) {
        if (
            error instanceof Error &&
            "code" in error &&
            ["ENOENT", "ENOTDIR"].includes(String(error.code))
        )
            return [];
        throw new CrafleetError(
            "COMPLETION_ACCESS",
            "Cannot read the requested completion directory.",
            2,
        );
    }
    return candidates.sort();
}
