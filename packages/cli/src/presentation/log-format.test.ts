import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import {
    formatRuntimeLogChunk,
    LOG_STYLE_RESET as RESET,
    RuntimeLogFormatter,
    runtimeLogColorsEnabled,
} from "./log-format.js";

const ESC = "\u001b";
const red = `${ESC}[31m`;

describe("runtime log colors", () => {
    it.each([
        [true, {}, true],
        [false, {}, false],
        [undefined, {}, false],
        [true, { TERM: "dumb" }, false],
        [true, { NO_COLOR: "1" }, false],
        [true, { NO_COLOR: "0" }, false],
        [true, { NO_COLOR: "" }, true],
        [false, { FORCE_COLOR: "1" }, false],
    ])("selects color for TTY=%s env=%j", (isTTY, env, expected) => {
        expect(
            runtimeLogColorsEnabled(
                { isTTY } as Pick<NodeJS.WriteStream, "isTTY">,
                env,
            ),
        ).toBe(expected);
    });

    it.each([
        ["31", "31"],
        ["94", "94"],
        ["43", "43"],
        ["104", "104"],
        ["38;5;202", "38;5;202"],
        ["48;5;255", "48;5;255"],
        ["38;2;10;20;30", "38;2;10;20;30"],
        ["48;2;255;0;85", "48;2;255;0;85"],
        ["38:2::10:20:30", "38;2;10;20;30"],
        ["48:2:0:10:20:30", "48;2;10;20;30"],
        ["38:5:202", "38;5;202"],
    ])("preserves and safely terminates ANSI %s", (code, normalized) => {
        expect(
            new RuntimeLogFormatter(true).write(`${ESC}[${code}mhello\n`),
        ).toBe(`${ESC}[${normalized}mhello${RESET}\n`);
        expect(
            new RuntimeLogFormatter(false).write(
                `${ESC}[${code}mhello${RESET}\n`,
            ),
        ).toBe("hello\n");
    });

    it.each([
        ["§0", "0;0;0"],
        ["§6", "255;170;0"],
        ["§a", "85;255;85"],
        ["§F", "255;255;255"],
        ["§#a25981", "162;89;129"],
        ["§x§A§2§5§9§8§1", "162;89;129"],
    ])(
        "converts Minecraft %s and removes it in plain output",
        (code, color) => {
            expect(new RuntimeLogFormatter(true).write(`${code}hello§r`)).toBe(
                `${ESC}[38;2;${color}mhello${RESET}`,
            );
            expect(new RuntimeLogFormatter(false).write(`${code}hello§r`)).toBe(
                "hello",
            );
        },
    );

    it("handles decorations, resets, mixed formats, and readable obfuscated text", () => {
        const formatter = new RuntimeLogFormatter(true);
        expect(formatter.write(`${red}§lbold§cred§rplain`)).toBe(
            `${red}${ESC}[1mbold${RESET}${ESC}[38;2;255;85;85mred${RESET}plain`,
        );
        expect(formatter.write("§o§n§mstyled§r§kreadable")).toBe(
            `${ESC}[3m${ESC}[4m${ESC}[9mstyled${RESET}readable`,
        );
        expect(
            formatter.write(
                `${ESC}[1;2;3;4;7;9;31;44mstyled${ESC}[22;23;24;27;29;39;49mplain`,
            ),
        ).toBe(
            `${ESC}[1m${ESC}[2m${ESC}[3m${ESC}[4m${ESC}[7m${ESC}[9m${red}${ESC}[44mstyled${RESET}plain`,
        );
    });

    it("retains logical style across lines and writes, but resets every printed fragment", () => {
        const formatter = new RuntimeLogFormatter(true);
        expect(formatter.write(`${red}one\ntwo\n`)).toBe(
            `${red}one${RESET}\n${red}two${RESET}\n`,
        );
        expect(formatter.write("three")).toBe(`${red}three${RESET}`);
        expect(formatter.write(`${RESET}plain`)).toBe("plain");
        formatter.write(red);
        formatter.reset();
        expect(formatter.write("rotated")).toBe("rotated");
    });

    it.each([`${ESC}[38;2;1;2;3m`, "§#123abc", "§x§1§2§3§a§b§c", "§a"])(
        "joins every split of %s before interpreting it",
        (code) => {
            for (let split = 1; split < code.length; split++) {
                const formatter = new RuntimeLogFormatter(true);
                expect(formatter.write(code.slice(0, split))).toBe("");
                const output = formatter.write(`${code.slice(split)}hello`);
                expect(output).toBe(
                    new RuntimeLogFormatter(true).write(`${code}hello`),
                );
            }
        },
    );

    it("preserves unknown and incomplete literal codes and flushes partial escapes on EOF", () => {
        const literal = "&a <red> §z §#123xxz §x§1§2";
        expect(new RuntimeLogFormatter(true).write(literal, true)).toBe(
            literal,
        );
        const formatter = new RuntimeLogFormatter(true);
        expect(formatter.write(`${ESC}[38;2`)).toBe("");
        expect(formatter.write("", true)).toBe("?[38;2");
        expect(new RuntimeLogFormatter(true).write("§", true)).toBe("§");
    });

    it.each([true, false])(
        "neutralizes unsafe, unsupported and malformed sequences (color=%s)",
        (color) => {
            const input = `${ESC}]52;c;payload\u0007${ESC}[2J${ESC}[H${ESC}[?25l\u009b31m\u202e${ESC}[8mhidden${ESC}[38;5;256mtoo-high${ESC}[38;2;1mshort`;
            const output = new RuntimeLogFormatter(color).write(input, true);
            expect(output).not.toContain(ESC);
            expect(output).not.toContain("\u009b");
            expect(output).not.toContain("\u202e");
            expect(output).toContain("hidden");
            expect(output).toContain("too-high");
            expect(output).toContain("short");
            const long = `${ESC}[${"1;".repeat(1000)}`;
            expect(new RuntimeLogFormatter(color).write(long)).toBe(
                `?${long.slice(1)}`,
            );
        },
    );

    it("keeps JSON exact, including color codes, while human chunks retain line endings", () => {
        const input = `${red}ANSI${RESET}\n§aMinecraft§r\n\n`;
        expect(formatRuntimeLogChunk(input, true)).toBe(
            `${JSON.stringify({ event: "log", text: input })}\n`,
        );
        expect(
            formatRuntimeLogChunk(input, false, new RuntimeLogFormatter(false)),
        ).toBe("ANSI\nMinecraft\n\n");
        expect(
            stripVTControlCharacters(
                formatRuntimeLogChunk(
                    input,
                    false,
                    new RuntimeLogFormatter(true),
                ),
            ),
        ).toBe("ANSI\nMinecraft\n\n");
    });
});
