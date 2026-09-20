import { configFormat } from "./config.js";
import { CrafleetError } from "./errors.js";

export interface FileDefaultEntry {
    relative: string;
    source: string;
}

function invalid(): never {
    throw new CrafleetError(
        "FILES_DEFAULTS",
        "File defaults must map distinct portable runtime-relative configuration paths to project-relative example files, without traversal, reserved roots or overlapping destinations.",
        2,
    );
}

function portable(value: string): boolean {
    return (
        value.length > 0 &&
        !/[\\:*?"<>|]/u.test(value) &&
        ![...value].some((character) => character.charCodeAt(0) < 32) &&
        value
            .split("/")
            .every(
                (part) =>
                    part.length > 0 &&
                    part !== "." &&
                    part !== ".." &&
                    !/[. ]$/.test(part) &&
                    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(
                        part,
                    ),
            )
    );
}

export function fileDefaultEntries(
    defaults: Readonly<Record<string, string>> = {},
): FileDefaultEntry[] {
    if (Array.isArray(defaults)) invalid();
    const entries = Object.entries(defaults).map(([relative, source]) => {
        if (
            !portable(relative) ||
            !portable(source) ||
            /^(?:runtime|\.crafleet|\.git)(?:\/|$)/i.test(source) ||
            configFormat(relative) === "text" ||
            configFormat(source) !== configFormat(relative)
        )
            invalid();
        return { relative, source };
    });
    const destinations = entries.map(({ relative }) =>
        `files/${relative}`.toLowerCase(),
    );
    for (const [index, destination] of destinations.entries()) {
        const overlaps = (candidate: string) =>
            candidate === destination ||
            candidate.startsWith(`${destination}/`) ||
            destination.startsWith(`${candidate}/`);
        if (
            destinations.slice(index + 1).some(overlaps) ||
            entries.some(({ source }) => overlaps(source.toLowerCase()))
        )
            invalid();
    }
    return entries.sort((left, right) =>
        left.relative.localeCompare(right.relative, "en"),
    );
}
