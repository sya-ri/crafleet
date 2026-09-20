import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { ConsoleTranscript } from "./console-transcript.js";
import { LOG_STYLE_RESET as RESET } from "./log-format.js";

const red = "\u001b[31m";
const green = "\u001b[38;2;85;255;85m";
const plain = (rows: string[]) => rows.map(stripVTControlCharacters);

describe("colored console transcript", () => {
    it("preserves colors on wrapped rows, subsequent lines, and resize without leaking styles", () => {
        const transcript = new ConsoleTranscript(
            `${red}abcdefghij\nsecond${RESET}\nplain`,
            true,
        );
        expect(plain(transcript.render(5))).toEqual([
            "abcde",
            "fghij",
            "secon",
            "d",
            "plain",
        ]);
        for (const row of transcript.render(5).slice(0, 4)) {
            expect(row).toContain(red);
            expect(row.endsWith(RESET)).toBe(true);
            expect(visibleWidth(row)).toBeLessThanOrEqual(5);
        }
        expect(transcript.render(5).at(-1)).toBe("plain");
        expect(plain(transcript.render(80))).toEqual([
            "abcdefghij",
            "second",
            "plain",
        ]);
        expect(transcript.render(80)[1]).toContain(red);
    });

    it("joins fragmented ANSI and Minecraft codes before rendering the trailing line", () => {
        const transcript = new ConsoleTranscript("old\n\u001b[3", true);
        expect(transcript.render(80)).toEqual(["old", ""]);
        transcript.append("1mred\n§x§5§5§f");
        expect(plain(transcript.render(80))).toEqual(["old", "red", ""]);
        transcript.append("§f§5§5green§r plain");
        expect(transcript.render(80)[1]).toContain(red);
        expect(transcript.render(80)[2]).toContain(
            `${green}green${RESET} plain`,
        );
        expect(plain(transcript.render(80))).toEqual([
            "old",
            "red",
            "green plain",
        ]);
    });

    it("restores styles from older history while preserving the scroll anchor row count", () => {
        const transcript = new ConsoleTranscript("tail\nnext\nplain", true);
        transcript.render(80);
        expect(transcript.prepend(`${red}older\nhead `, 80)).toBe(1);
        expect(plain(transcript.render(80))).toEqual([
            "older",
            "head tail",
            "next",
            "plain",
        ]);
        for (const row of transcript.render(80)) expect(row).toContain(red);
        transcript.append(`${RESET}\nnew`);
        expect(transcript.render(80).at(-1)).toBe("new");
        transcript.replace("rotated");
        expect(transcript.render(80)).toEqual(["rotated"]);
    });

    it("keeps plain mode free of styling and sanitizes controls before width measurement", () => {
        const transcript = new ConsoleTranscript(
            `${red}赤${RESET}§a緑§r\ttext\n\u001b[2J\u202e`,
            false,
        );
        expect(transcript.render(80)).toEqual(["赤緑    text", "?[2J?"]);
        for (const row of transcript.render(4))
            expect(visibleWidth(row)).toBeLessThanOrEqual(4);
    });
});
