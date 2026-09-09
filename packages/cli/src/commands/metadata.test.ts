import { pathToFileURL } from "node:url";
import type { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCli, runCli } from "../application.js";
import { printResult } from "../presentation/output.js";
import {
    COMMAND_POLICIES,
    commandPath,
    describeCommand,
    isStreamingCommand,
} from "./metadata.js";

const entry = pathToFileURL(`${process.cwd()}/packages/cli/dist/cli.mjs`).href;
const originalExitCode = process.exitCode;
afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
});

function commands(root: Command): Command[] {
    return [root, ...root.commands.flatMap(commands)];
}

async function execute(args: string[]) {
    let output = "";
    let errors = "";
    process.exitCode = 0;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output += String(chunk);
        return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        errors += String(chunk);
        return true;
    });
    await runCli(args, entry);
    expect(errors).toBe("");
    expect(output.trim().split("\n")).toHaveLength(1);
    return { reply: JSON.parse(output), code: Number(process.exitCode) };
}

describe("machine-readable command contracts", () => {
    const tree = commands(createCli(entry).program);
    it("has no stale policies and refuses to register an unclassified operation", () => {
        const paths = tree.map(commandPath);
        expect(
            Object.keys(COMMAND_POLICIES).every((name) => paths.includes(name)),
        ).toBe(true);
        const { program, context } = createCli(entry);
        expect(() =>
            context.action(program.command("unclassified"), async () => null),
        ).toThrow("Missing CLI operation policy");
    });

    it.each(tree.map((command) => ({ path: commandPath(command), command })))(
        "prints one structured help document for '$path', with --json in either position",
        async ({ path, command }) => {
            const words = path ? path.split(" ") : [];
            for (const args of [
                ["--json", ...words, "--help"],
                [...words, "--help", "--json"],
            ]) {
                const { reply, code } = await execute(args);
                expect(code).toBe(0);
                expect(reply).toEqual({
                    ok: true,
                    help: command.helpInformation().trimEnd(),
                    result: describeCommand(command),
                });
                expect(
                    reply.result.options.some(
                        (option: { name: string }) => option.name === "json",
                    ),
                ).toBe(true);
            }
        },
    );

    it("reports version data without confusing a server version option", async () => {
        const { reply } = await execute(["--version", "--json"]);
        expect(reply.result.version).toBe(reply.help);
        expect(typeof reply.result.version).toBe("string");
        const init = tree.find((command) => commandPath(command) === "init");
        expect(
            describeCommand(init as Command).options.find(
                (option) => option.name === "version",
            )?.value,
        ).toBe("required");
    });

    it("returns missing argument definitions without echoing rejected values", async () => {
        const { reply, code } = await execute(["plugins", "remove", "--json"]);
        expect(code).toBe(2);
        expect(reply.error).toMatchObject({
            code: "CLI_USAGE",
            input: {
                command: "plugins remove",
                arguments: [
                    { name: "plugins", required: true, variadic: true },
                ],
            },
        });
        const rejected = await execute([
            "plugins",
            "update",
            "--to",
            "private-argument",
            "--json",
        ]);
        expect(JSON.stringify(rejected.reply)).not.toContain(
            "private-argument",
        );
    });

    it("explains explicit input alternatives without prompting", async () => {
        const { reply, code } = await execute(["init", "--json"]);
        expect(code).toBe(2);
        expect(reply.error).toMatchObject({
            code: "INPUT_REQUIRED",
            input: { command: "init", policy: { inputs: [["--version"]] } },
        });
    });

    it("distinguishes finite logs, followed logs and supervision", () => {
        const { program } = createCli(entry);
        const logs = program.commands.find(
            (command) => command.name() === "logs",
        ) as Command;
        expect(isStreamingCommand(logs)).toBe(false);
        logs.setOptionValue("follow", true);
        expect(isStreamingCommand(logs)).toBe(true);
        expect(
            isStreamingCommand(
                program.commands.find(
                    (command) => command.name() === "supervise",
                ) as Command,
            ),
        ).toBe(true);
        expect(isStreamingCommand(program)).toBe(false);
    });

    it.each([3, 4])(
        "preserves useful results and exposes unsuccessful exit code %s",
        (code) => {
            let output = "";
            vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
                output += String(chunk);
                return true;
            });
            const result = [
                { project: "first", ok: true },
                { project: "second", ok: false, code: "BUSY" },
            ];
            printResult(
                result,
                true,
                { command: "start", dryRun: false },
                code,
            );
            expect(JSON.parse(output)).toMatchObject({
                ok: false,
                result,
                error: {
                    code: code === 4 ? "PARTIAL_FAILURE" : "CHECK_FAILED",
                },
            });
            output = "";
            printResult(undefined, true, {
                command: "run",
                dryRun: false,
                stream: true,
            });
            expect(JSON.parse(output)).toEqual({
                event: "result",
                ok: true,
                result: null,
            });
        },
    );
});
