import type { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { createCli } from "../application.js";

function commandTree(command: Command): Command[] {
    return [command, ...command.commands.flatMap(commandTree)];
}

describe("CLI help", () => {
    it("lists every root command exactly once in useful groups before flags and examples", () => {
        const { program } = createCli(import.meta.url);
        const help = program.helpInformation();
        const headings = [
            "USAGE",
            "GETTING STARTED",
            "SERVER COMMANDS",
            "PROJECT COMMANDS",
            "MAINTENANCE COMMANDS",
            "FLAGS",
            "GLOBAL FLAGS",
            "EXAMPLES",
            "LEARN MORE",
        ];
        const positions = headings.map((heading) =>
            help.indexOf(`\n${heading}\n`),
        );
        expect(positions.every((position) => position >= 0)).toBe(true);
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
        const names = [...help.matchAll(/^ {2}([a-z]+): /gm)].map(
            (match) => match[1],
        );
        expect(names.slice(0, 3)).toEqual(["init", "import", "install"]);
        expect(names.at(-1)).toBe("help");
        expect(names.toSorted()).toEqual(
            [
                ...program
                    .createHelp()
                    .visibleCommands(program)
                    .map((command) => command.name()),
            ].sort(),
        );
        expect(help).not.toContain("__complete");
        expect(help).not.toContain(
            program.commands
                .find((command) => command.name() === "init")
                ?.description(),
        );
        expect(help).toContain(
            "crafleet init my-server\n  $ crafleet -C my-server install\n  $ crafleet -C my-server start",
        );
    });

    it("preserves detailed descriptions, syntax, defaults, and choices in command help", () => {
        const { program } = createCli(import.meta.url);
        const init = program.commands.find(
            (command) => command.name() === "init",
        );
        expect(init).toBeDefined();
        const help = init?.helpInformation() ?? "";
        expect(help.replaceAll(/\s+/g, " ")).toContain(init?.description());
        expect(help).toContain("crafleet init [options] [directory]");
        const flags = help.split("\nFLAGS\n")[1]?.split("\nGLOBAL FLAGS\n")[0];
        expect(flags).toContain("--version <version>");
        expect(flags).toContain('choices: "paper", "velocity"');
        expect(flags).toContain('default: "paper"');
        expect(flags).not.toContain("--cwd");
        expect(help).toContain("Use 'crafleet --help'");
    });

    it.each([60, 80, 100])(
        "wraps descriptions at %s columns and keeps redirected help plain",
        (width) => {
            const { program } = createCli(import.meta.url);
            for (const command of commandTree(program)) {
                command.configureOutput({ getOutHelpWidth: () => width });
                const help = command.helpInformation();
                expect(help).not.toContain("\u001b");
                for (const line of help.split("\n")) {
                    // Example commands stay intact so they can be copied into a shell.
                    if (!line.startsWith("  $ "))
                        expect(line.length, line).toBeLessThanOrEqual(width);
                }
                const examples =
                    help.split("\nEXAMPLES\n")[1]?.split("\nLEARN MORE\n")[0] ??
                    "";
                for (const line of examples.split("\n").filter(Boolean))
                    expect(line).toMatch(/^ {2}(?:# |\$ )/u);
            }
        },
    );

    it("keeps every documented example valid against the real command parser", async () => {
        const { program } = createCli(import.meta.url);
        const examples = new Set(
            commandTree(program).flatMap((command) =>
                [...command.helpInformation().matchAll(/^ {2}\$ (.+)$/gm)].map(
                    (match) => match[1] as string,
                ),
            ),
        );
        expect(examples.size).toBeGreaterThan(20);
        for (const example of examples) {
            const { program: parser } = createCli(import.meta.url);
            const action = vi.fn();
            // Exercise parsing and validation hooks without performing operations.
            for (const command of commandTree(parser)) command.action(action);
            const tokens = (example.match(/"[^"]*"|\S+/g) ?? []).map((token) =>
                token.replaceAll('"', ""),
            );
            expect(tokens.shift()).toBe("crafleet");
            await expect(
                parser.parseAsync(tokens, { from: "user" }),
                example,
            ).resolves.toBe(parser);
            expect(action, example).toHaveBeenCalledOnce();
        }
    });
});
