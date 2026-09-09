import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sanitizeTerminalOutput } from "./terminal.js";

/** A display value, never an object dump or a truncated diagnostic field. */
export function cellText(value: unknown, fallback = "-"): string {
    if (!["string", "number", "boolean"].includes(typeof value))
        return fallback;
    return sanitizeTerminalOutput(String(value)).replace(
        /[\n\t\u2028\u2029]/gu,
        "?",
    );
}

export function terminalWidth(width?: number): number {
    return Number.isFinite(width)
        ? Math.max(2, Math.min(500, Math.floor(width ?? 80)))
        : 80;
}

/** Wrap complete values. Wide graphemes and combining marks remain intact. */
export function wrapHumanText(value: string, width?: number): string {
    return value
        .split("\n")
        .flatMap((line) =>
            wrapTextWithAnsi(
                sanitizeTerminalOutput(line),
                terminalWidth(width),
            ),
        )
        .join("\n");
}

export function renderTable(
    headers: readonly string[],
    rows: readonly (readonly unknown[])[],
    width?: number,
): string {
    if (!headers.length || !rows.length) return "";
    const columns = headers.map((header) => cellText(header));
    const values = rows.map((row) =>
        columns.map((_, index) => cellText(row[index])),
    );
    const available = terminalWidth(width);
    const gaps = (columns.length - 1) * 2;
    const minimums = columns.map((header) => Math.max(8, visibleWidth(header)));
    if (
        available <
        Math.max(
            44,
            minimums.reduce((a, b) => a + b, gaps),
        )
    ) {
        return values
            .map((row) =>
                columns
                    .map((header, index) => {
                        const prefix = `${header}: `;
                        if (visibleWidth(prefix) >= available - 2)
                            return `${wrapHumanText(header, available)}\n${wrapHumanText(row[index] ?? "-", available)}`;
                        const lines = wrapTextWithAnsi(
                            row[index] ?? "-",
                            available - visibleWidth(prefix),
                        );
                        return lines
                            .map(
                                (line, index) =>
                                    `${index === 0 ? prefix : " ".repeat(visibleWidth(prefix))}${line}`,
                            )
                            .join("\n");
                    })
                    .join("\n"),
            )
            .join("\n\n");
    }
    const widths = columns.map((header, index) =>
        Math.min(
            available,
            Math.max(
                minimums[index] ?? 8,
                visibleWidth(header),
                ...values.map((row) => visibleWidth(row[index] ?? "-")),
            ),
        ),
    );
    // Shrink the widest column first, without ever omitting part of a value.
    while (widths.reduce((a, b) => a + b, gaps) > available) {
        let widest = -1;
        for (const [index, size] of widths.entries())
            if (
                size > (minimums[index] ?? 8) &&
                (widest < 0 || size > (widths[widest] ?? 0))
            )
                widest = index;
        if (widest < 0) break;
        widths[widest] = (widths[widest] ?? 8) - 1;
    }
    const physicalRows = (row: readonly string[]) => {
        const wrapped = columns.map((_, index) =>
            wrapTextWithAnsi(row[index] ?? "-", widths[index] ?? 8),
        );
        return Array.from(
            { length: Math.max(...wrapped.map((cell) => cell.length)) },
            (_, line) =>
                wrapped
                    .map((cell, index) => {
                        const value = cell[line] ?? "";
                        return (
                            value +
                            " ".repeat(
                                Math.max(
                                    0,
                                    (widths[index] ?? 8) - visibleWidth(value),
                                ),
                            )
                        );
                    })
                    .join("  ")
                    .trimEnd(),
        );
    };
    return [
        ...physicalRows(columns),
        widths.map((size) => "-".repeat(size)).join("  "),
        ...values.flatMap(physicalRows),
    ].join("\n");
}
