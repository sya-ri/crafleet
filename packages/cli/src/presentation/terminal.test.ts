import { describe, expect, it } from "vitest";
import { formatRuntimeLogChunk } from "./log-format.js";
import {
    isCiEnvironment,
    sanitizeInlineTerminalOutput,
    sanitizeTerminalOutput,
} from "./terminal.js";

describe("terminal output sanitization", () => {
    it.each([
        ["\u0000\u0008\t\n\u000b\u001f ", "??\t\n?? "],
        ["~\u007f\u009f\u00a0", "~??\u00a0"],
        ["\u061b\u061c\u061d", "\u061b?\u061d"],
        ["\u200d\u200e\u200f\u2010", "\u200d??\u2010"],
        ["\u2029\u202a\u202e\u202f", "\u2029??\u202f"],
        ["\u2065\u2066\u2069\u206a", "\u2065??\u206a"],
        ["日本語 😀 👩‍💻 \ud800x\udc00", "日本語 😀 👩‍💻 \ud800x\udc00"],
    ])(
        "preserves the exact control-character boundaries in %j",
        (input, expected) => {
            expect(sanitizeTerminalOutput(input)).toBe(expected);
        },
    );

    it("preserves readable layout while neutralizing terminal and bidi controls", () => {
        const value = [
            "first\tcolumn\n",
            "escape\u001b]52;c;payload\u0007",
            "\rbackspace\bnull\0delete\u007f",
            "c1\u0085",
            "bidi\u061c\u200e\u200f\u202a\u202e\u2066\u2069",
        ].join("");

        const output = sanitizeTerminalOutput(value);

        expect(output).toBe(
            "first\tcolumn\nescape?]52;c;payload??backspace?null?delete?c1?bidi???????",
        );
        expect(
            [...output].some((character) => {
                const point = character.codePointAt(0) ?? 0;
                return (
                    (point <= 0x1f && point !== 0x09 && point !== 0x0a) ||
                    (point >= 0x7f && point <= 0x9f)
                );
            }),
        ).toBe(false);
    });

    it("keeps JSON log framing exact and sanitizes only human log chunks", () => {
        const value = "line\tvalue\n\u001b]52;c;payload\u0007\r";

        expect(formatRuntimeLogChunk(value, true)).toBe(
            `${JSON.stringify({ event: "log", text: value })}\n`,
        );
        expect(formatRuntimeLogChunk(value, false)).toBe(
            "line\tvalue\n?]52;c;payload??\n",
        );
    });

    it("bounds untrusted inline fields without preserving layout controls", () => {
        expect(
            sanitizeInlineTerminalOutput(
                "name\tline\nparagraph\u2028separator\u2029value",
            ),
        ).toBe("name?line?paragraph?separator?value");
        expect(sanitizeInlineTerminalOutput("x".repeat(241))).toBe(
            `${"x".repeat(237)}...`,
        );
        expect(sanitizeInlineTerminalOutput(`${"x".repeat(239)}😀😀`)).toBe(
            `${"x".repeat(237)}...`,
        );
    });
});

describe("CI environment detection", () => {
    it.each([undefined, "", " \t", "0", " FALSE ", "No", "off"])(
        "allows local interaction for %j",
        (value) => expect(isCiEnvironment(value)).toBe(false),
    );
    it.each(["1", "true", " YES ", "on", "provider-name"])(
        "recognizes CI for %j",
        (value) => expect(isCiEnvironment(value)).toBe(true),
    );
});
