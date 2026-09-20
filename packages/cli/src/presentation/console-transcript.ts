import { type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { LOG_STYLE_RESET, RuntimeLogFormatter } from "./log-format.js";

export function normalizeLogText(value: string): string {
    return value
        .replace(/\r\n?/g, "\n")
        .replace(/[\u2028\u2029]/g, "\n")
        .replaceAll("\t", "    ");
}

export class ConsoleTranscript implements Component {
    private lines: string[];
    private wrapped: string[][] | undefined;
    private rows: string[] | undefined;
    private width: number | undefined;
    private lastStart: RuntimeLogFormatter | undefined;

    constructor(
        value: string,
        private readonly color: boolean,
    ) {
        this.lines = normalizeLogText(value).split("\n");
    }

    append(value: string): void {
        const added = normalizeLogText(value).split("\n");
        const last = this.lines.length - 1;
        this.lines[last] = (this.lines[last] ?? "") + (added.shift() ?? "");
        this.lines.push(...added);
        if (
            !this.wrapped ||
            !this.rows ||
            this.width === undefined ||
            !this.lastStart
        )
            return;

        // Re-decode the last raw line: an escape or § RGB code may have been
        // split between appends. Earlier rows and their styles stay cached.
        const formatter = this.lastStart.clone();
        this.rows.length -= this.wrapped[last]?.length ?? 0;
        for (let index = last; index < this.lines.length; index++) {
            if (index === this.lines.length - 1)
                this.lastStart = formatter.clone();
            const rows = this.wrap(index, this.width, formatter);
            this.wrapped[index] = rows;
            for (const row of rows) this.rows.push(row);
        }
    }

    prepend(value: string, width: number): number {
        this.render(width);
        const previousRows = this.wrapped?.[0]?.length ?? 0;
        const added = normalizeLogText(value).split("\n");
        added[added.length - 1] = (added.at(-1) ?? "") + (this.lines[0] ?? "");
        this.lines = [...added, ...this.lines.slice(1)];
        // Older lines can introduce a style inherited by any later line.
        this.invalidate();
        this.render(width);
        return (
            (this.wrapped
                ?.slice(0, added.length)
                .reduce((sum, rows) => sum + rows.length, 0) ?? 0) -
            previousRows
        );
    }

    replace(value: string): void {
        this.lines = normalizeLogText(value).split("\n");
        this.invalidate();
    }

    invalidate(): void {
        this.wrapped = undefined;
        this.rows = undefined;
        this.width = undefined;
        this.lastStart = undefined;
    }

    render(width: number): string[] {
        const safeWidth = Math.max(1, width);
        if (!this.wrapped || !this.rows || this.width !== safeWidth) {
            this.width = safeWidth;
            const formatter = new RuntimeLogFormatter(this.color);
            this.wrapped = this.lines.map((_, index) => {
                if (index === this.lines.length - 1)
                    this.lastStart = formatter.clone();
                return this.wrap(index, safeWidth, formatter);
            });
            this.rows = this.wrapped.flat();
        }
        return this.rows;
    }

    private wrap(
        index: number,
        width: number,
        formatter: RuntimeLogFormatter,
    ): string[] {
        const terminated = index < this.lines.length - 1;
        const text = formatter.write(
            `${this.lines[index] ?? ""}${terminated ? "\n" : ""}`,
        );
        const line = terminated ? text.slice(0, -1) : text;
        return wrapTextWithAnsi(line, width).map((row) =>
            row.includes("\u001b[") ? `${row}${LOG_STYLE_RESET}` : row,
        );
    }
}
