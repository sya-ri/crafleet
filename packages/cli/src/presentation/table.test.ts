import { CrafleetError } from "@crafleet/core";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHumanResult } from "./human.js";
import {
    outputWidth,
    printError,
    printOperation,
    printResult,
} from "./output.js";
import {
    cellText,
    renderTable,
    terminalWidth,
    wrapHumanText,
} from "./table.js";

const originalTty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (originalTty)
        Object.defineProperty(process.stderr, "isTTY", originalTty);
    else Reflect.deleteProperty(process.stderr, "isTTY");
    process.exitCode = 0;
});

describe("readable terminal tables", () => {
    it("aligns ASCII, Japanese, emoji and combining marks by display width", () => {
        const output = renderTable(
            ["NAME", "VERSION"],
            [
                ["桜ワールド", "one"],
                ["Cafe\u0301", "two"],
                ["🧑‍💻", "three"],
            ],
        );
        const lines = output.split("\n");
        const offsets = ["one", "two", "three"].map((value, index) => {
            const line = lines[index + 2] ?? "";
            expect(line).toContain(value);
            return visibleWidth(line.slice(0, line.indexOf(value)));
        });
        expect(new Set(offsets).size).toBe(1);
        expect(output).toContain("Cafe\u0301");
        expect(output).toContain("🧑‍💻");
    });

    it.each([2, 12, 30, 43, 44, 80, 120])(
        "keeps complete long values at width %s",
        (width) => {
            const name = "桜".repeat(150);
            const version = `release-${"1234567890".repeat(32)}`;
            const output = renderTable(
                ["NAME", "VERSION"],
                [[name, version]],
                width,
            );
            expect(
                output.split("\n").every((line) => visibleWidth(line) <= width),
            ).toBe(true);
            expect(output).not.toContain("...");
            // A single-column table can be rejoined without losing any byte of a value.
            const complete = renderTable(["VALUE"], [[version]], width).replace(
                /\s/g,
                "",
            );
            expect(complete).toContain(version);
            expect(output.match(/桜/gu)?.length).toBe(150);
        },
    );

    it("uses labeled items on narrow terminals and handles empty or missing cells", () => {
        expect(
            renderTable(["NAME", "ACTIVE"], [["Example", "1"], ["Second"]], 32),
        ).toBe("NAME: Example\nACTIVE: 1\n\nNAME: Second\nACTIVE: -");
        expect(renderTable([], [["value"]])).toBe("");
        expect(renderTable(["NAME"], [])).toBe("");
        expect(cellText({ password: "hidden" })).toBe("-");
        expect(cellText(false)).toBe("false");
        expect(terminalWidth(Number.NaN)).toBe(80);
        expect(terminalWidth(900)).toBe(500);
    });

    it("sanitizes terminal controls without truncating names or leaking source locations", () => {
        const name = "Name".repeat(100);
        const output = renderHumanResult(
            [
                {
                    project: "日本語",
                    plugins: [
                        {
                            name,
                            requested: "file:/private/plugin.jar",
                            requestedVersion: "3",
                            active: "3",
                            pending: null,
                            locked: "3",
                        },
                    ],
                },
            ],
            { command: "plugins", dryRun: false, width: 32 },
        );
        expect(output.replace(/\s/g, "")).toContain(name);
        expect(output).not.toContain("private");
        expect(output).not.toContain("LATEST");
        expect(cellText("bad\u001b[31m\n\t\u202e\u2028")).toBe("bad?[31m????");
        expect(wrapHumanText("long\n\nparagraph", 8)).toContain("\n\n");
    });

    it("shows declaration differences and all projects' runtime states", () => {
        const plugins = renderHumanResult(
            [
                {
                    project: "alpha",
                    plugins: [
                        {
                            name: "Example",
                            requested: "modrinth:example@new",
                            requestedVersion: null,
                            active: "1",
                            pending: null,
                            locked: "1",
                        },
                    ],
                },
            ],
            { command: "plugins", dryRun: false },
        );
        expect(plugins).toContain("declaration differs from the lock");
        const status = renderHumanResult(
            [
                {
                    project: "alpha",
                    status: "running",
                    intent: "running",
                    javaPid: 123,
                    pid: 456,
                    clean: true,
                    activeId: "active-1",
                },
                { project: "beta", status: "stopped", intent: "stopped" },
            ],
            { command: "status", dryRun: false },
        );
        expect(status).toContain("INTENT");
        expect(status).toContain("123");
        expect(status).toContain("active-1");
        expect(status).toContain("alpha: runner 456; last shutdown clean.");
        expect(status).toContain(
            "beta: runner unknown; last shutdown unknown.",
        );
    });

    it("keeps JSON unchanged and uses stable plain output with NO_COLOR and non-TTY streams", () => {
        vi.stubEnv("NO_COLOR", "1");
        vi.stubEnv("TERM", "dumb");
        const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
        const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
        const result = [{ name: "桜", directory: "/srv/alpha" }];
        printResult(result, true, {
            command: "workspace list",
            dryRun: false,
            width: 2,
        });
        expect(out.mock.calls[0]?.[0]).toBe(
            `${JSON.stringify({ ok: true, result })}\n`,
        );
        printResult(result, false, {
            command: "workspace list",
            dryRun: false,
            width: 30,
        });
        expect(out.mock.calls[1]?.[0]).not.toContain("\u001b");
        printOperation("install", true);
        expect(err).not.toHaveBeenCalled();
        expect(outputWidth({ isTTY: false, columns: 12 })).toBe(80);
        expect(outputWidth({ isTTY: true, columns: 32 })).toBe(32);
    });

    it("reports progress only when enabled on a capable terminal and labels error hints", () => {
        Object.defineProperty(process.stderr, "isTTY", {
            configurable: true,
            value: true,
        });
        vi.stubEnv("TERM", "xterm");
        const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
        printOperation("install", false);
        expect(err).not.toHaveBeenCalled();
        printOperation("install", true);
        expect(err.mock.calls[0]?.[0]).toBe("Running: crafleet install\n");
        printError(
            new CrafleetError(
                "INPUT_REQUIRED",
                "Choose a target.",
                2,
                "Use --filter.",
            ),
            false,
        );
        expect(err.mock.calls[1]?.[0]).toBe(
            "Error [INPUT_REQUIRED]: Choose a target.\nHint: Use --filter.\n",
        );
        expect(process.exitCode).toBe(2);
    });
});
