import { runtimeLimit } from "@crafleet/adapters";
import { sanitizeTerminalOutput } from "./terminal.js";

export const LOG_STYLE_RESET = "\u001b[0m";
const ESC = "\u001b";
const LEGACY_COLORS = [
    0x000000, 0x0000aa, 0x00aa00, 0x00aaaa, 0xaa0000, 0xaa00aa, 0xffaa00,
    0xaaaaaa, 0x555555, 0x5555ff, 0x55ff55, 0x55ffff, 0xff5555, 0xff55ff,
    0xffff55, 0xffffff,
];
const LEGACY_DECORATIONS: Record<string, number> = { l: 1, m: 9, n: 4, o: 3 };

type StyleChange = readonly [attribute: number, code: string | null];
interface LogCode {
    length: number;
    changes?: StyleChange[];
    pending?: boolean;
}

export function runtimeLogColorsEnabled(
    output: Pick<NodeJS.WriteStream, "isTTY"> = process.stdout,
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    return Boolean(output.isTTY && env.TERM !== "dumb" && !env.NO_COLOR);
}

function rgb(value: number): string {
    return `38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`;
}

/** Accept only colors and readable text decorations, never terminal operations. */
function sgrChanges(parameters: string): StyleChange[] | undefined {
    // Normalize the colon form of indexed/RGB colors to the semicolon form
    // understood by the terminal layout library, including an empty color space.
    const normalized = parameters.replace(
        /(?:38|48):(?:5:\d+|2:(?::|0:)?\d+:\d+:\d+)/g,
        (value) => value.replace(/:2:(?::|0:)/, ":2:").replaceAll(":", ";"),
    );
    if (!/^[\d;]*$/.test(normalized)) return undefined;
    const numbers = normalized.split(";").map(Number);
    const changes: StyleChange[] = [];
    for (let index = 0; index < numbers.length; index++) {
        const code = numbers[index] ?? 0;
        if (code === 0) changes.push([0, null]);
        else if ([1, 2, 3, 4, 7, 9].includes(code))
            changes.push([code, String(code)]);
        else if (code === 22) changes.push([1, null], [2, null]);
        else if ([23, 24, 27, 29].includes(code))
            changes.push([code - 20, null]);
        else if (code === 39 || code === 49) changes.push([code - 9, null]);
        else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97))
            changes.push([30, String(code)]);
        else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107))
            changes.push([40, String(code)]);
        else if (code === 38 || code === 48) {
            const mode = numbers[++index];
            const count = mode === 5 ? 1 : mode === 2 ? 3 : 0;
            const values = numbers.slice(index + 1, index + 1 + count);
            if (
                !count ||
                values.length !== count ||
                values.some(
                    (value) =>
                        !Number.isInteger(value) || value < 0 || value > 255,
                )
            )
                return undefined;
            changes.push([code - 8, `${code};${mode};${values.join(";")}`]);
            index += count;
        } else return undefined;
    }
    return changes;
}

function ansiCode(value: string, final: boolean): LogCode | undefined {
    const suffix = value.slice(1); // The caller has already matched ESC.
    const match = /^\[([\d;:]*)m/.exec(suffix);
    if (match) {
        const changes = sgrChanges(match[1] ?? "");
        return { length: match[0].length + 1, ...(changes ? { changes } : {}) };
    }
    if (
        !final &&
        value.length <= runtimeLimit("logs.maxStyleChars") &&
        /^(?:\[[\d;:]*)?$/.test(suffix)
    )
        return { length: value.length, pending: true };
    return undefined;
}

function legacyCode(value: string, final: boolean): LogCode | undefined {
    const next = value[1]?.toLowerCase();
    if (!next) return final ? undefined : { length: 1, pending: true };
    if (next === "#" || next === "x") {
        const pattern =
            next === "#" ? /^§#([\da-f]{6})/i : /^§x((?:§[\da-f]){6})/i;
        const match = pattern.exec(value);
        if (match)
            return {
                length: match[0].length,
                changes: [
                    [0, null],
                    [
                        30,
                        rgb(
                            Number.parseInt(
                                (match[1] ?? "").replaceAll("§", ""),
                                16,
                            ),
                        ),
                    ],
                ],
            };
        const prefix =
            (next === "#"
                ? /^§#[\da-f]{0,5}/i
                : /^§x(?:§[\da-f]){0,5}§?/i
            ).exec(value)?.[0] ?? "§";
        // Keep malformed RGB literals intact instead of interpreting their
        // individual BungeeCord digits as unrelated legacy colors.
        return {
            length: prefix.length,
            ...(!final && prefix === value ? { pending: true } : {}),
        };
    }
    if (/^[\da-f]$/.test(next))
        return {
            length: 2,
            changes: [
                [0, null],
                [30, rgb(LEGACY_COLORS[Number.parseInt(next, 16)] ?? 0)],
            ],
        };
    const decoration = LEGACY_DECORATIONS[next];
    if (decoration)
        return { length: 2, changes: [[decoration, String(decoration)]] };
    if (next === "r") return { length: 2, changes: [[0, null]] };
    if (next === "k") return { length: 2, changes: [] };
    return undefined;
}

/** Stateful log decoder. Each write is independently safe to print or wrap. */
export class RuntimeLogFormatter {
    private readonly active = new Map<number, string>();
    private pending = "";

    constructor(private readonly color = runtimeLogColorsEnabled()) {}

    clone(): RuntimeLogFormatter {
        const copy = new RuntimeLogFormatter(this.color);
        for (const [attribute, code] of this.active)
            copy.active.set(attribute, code);
        copy.pending = this.pending;
        return copy;
    }

    reset(): void {
        this.active.clear();
        this.pending = "";
    }

    write(value: string, final = false): string {
        const input = this.pending + value;
        this.pending = "";
        const result: string[] = [];
        let displayed = "";
        const emit = (text: string) => {
            const lines = sanitizeTerminalOutput(text).split("\n");
            for (let index = 0; index < lines.length; index++) {
                if (index > 0) {
                    if (displayed) result.push(LOG_STYLE_RESET);
                    result.push("\n");
                    displayed = "";
                }
                const line = lines[index];
                if (!line) continue;
                const style = this.color
                    ? [...this.active.values()]
                          .map((code) => `${ESC}[${code}m`)
                          .join("")
                    : "";
                if (style !== displayed) {
                    if (displayed) result.push(LOG_STYLE_RESET);
                    if (style) result.push(style);
                    displayed = style;
                }
                result.push(line);
            }
        };
        let start = 0;
        let index = 0;
        const configuredMaxStyleChars = runtimeLimit("logs.maxStyleChars");
        while (index < input.length) {
            const character = input[index];
            const code =
                character === ESC
                    ? ansiCode(
                          input.slice(
                              index,
                              index + configuredMaxStyleChars + 1,
                          ),
                          final,
                      )
                    : character === "§"
                      ? legacyCode(input.slice(index, index + 14), final)
                      : undefined;
            if (!code) {
                index++;
                continue;
            }
            emit(input.slice(start, index));
            if (code.pending) {
                this.pending = input.slice(index);
                start = input.length;
                break;
            }
            if (code.changes) {
                for (const [attribute, style] of code.changes) {
                    if (attribute === 0) this.active.clear();
                    else if (style === null) this.active.delete(attribute);
                    else this.active.set(attribute, style);
                }
            } else emit(input.slice(index, index + code.length));
            index += code.length;
            start = index;
        }
        emit(input.slice(start));
        if (displayed) result.push(LOG_STYLE_RESET);
        return result.join("");
    }
}

export function formatRuntimeLogChunk(
    value: string,
    json: boolean,
    formatter = new RuntimeLogFormatter(),
): string {
    if (json) return `${JSON.stringify({ event: "log", text: value })}\n`;
    return formatter.write(value.endsWith("\n") ? value : `${value}\n`);
}
