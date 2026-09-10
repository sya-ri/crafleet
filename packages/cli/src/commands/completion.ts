import path from "node:path";
import {
    completePaths,
    NodeConfigManager,
    nearestFile,
    readState,
    selectProjects,
} from "@crafleet/adapters";
import { CrafleetError, type SourceSpec } from "@crafleet/core";
import { Argument, type Command, Option } from "commander";
import {
    COMPLETION_SCRIPTS,
    COMPLETION_SHELLS,
    type CompletionShell,
} from "../presentation/completion.js";
import { sanitizeTerminalOutput } from "../presentation/terminal.js";
import { installCompletion } from "./completion-setup.js";
import type { CommandContext } from "./context.js";
import {
    type CompletionKind,
    commandPath,
    inputCompletion,
} from "./metadata.js";

interface CompletionContext {
    cwd: string;
    home: string;
    filters: string[];
    recursive: boolean;
}

const PLUGIN_PROVIDERS: Record<
    Exclude<SourceSpec["provider"], "paper">,
    true
> = {
    file: true,
    modrinth: true,
    github: true,
    hangar: true,
    spigotmc: true,
};

function safeCandidate(value: string): boolean {
    return (
        value.length <= 4096 &&
        sanitizeTerminalOutput(value) === value &&
        !/[\n\t\u2028\u2029]/u.test(value)
    );
}

async function localValues(
    kind: CompletionKind | undefined,
    prefix: string,
    context: CompletionContext,
): Promise<string[]> {
    if (!kind) return [];
    if (kind === "source") {
        if (prefix.startsWith("file:"))
            return (
                await completePaths(context.cwd, prefix.slice(5), "jar")
            ).map((candidate) => `file:${candidate}`);
        return [
            ...Object.keys(PLUGIN_PROVIDERS).map((provider) => `${provider}:`),
            ...(!prefix.includes(":")
                ? await completePaths(context.cwd, prefix, "jar")
                : []),
        ];
    }
    if (kind === "mapping") {
        const separator = prefix.indexOf("=");
        if (separator < 1) return [];
        return (
            await completePaths(
                context.cwd,
                prefix.slice(separator + 1),
                "file",
            )
        ).map((candidate) => `${prefix.slice(0, separator + 1)}${candidate}`);
    }
    if (kind === "directory" || kind === "file" || kind === "jar")
        return completePaths(context.cwd, prefix, kind);
    const workspace = await nearestFile(context.cwd, "crafleet-workspace.yaml");
    const project = await nearestFile(context.cwd, "crafleet.yaml");
    if (!workspace && !project) return [];
    const projects = await selectProjects(context.cwd, context.home, {
        recursive: Boolean(
            workspace && (kind === "project" || context.recursive || !project),
        ),
        filters: kind === "project" ? [] : context.filters,
    });
    if (kind === "project")
        return projects.flatMap((project) => [
            project.manifest.name,
            project.lockKey,
        ]);
    const names: string[] = [];
    for (const project of projects) {
        if (kind === "runtime-file") {
            names.push(
                ...(await completePaths(
                    path.join(project.dir, "runtime"),
                    prefix,
                    "file",
                )),
            );
            continue;
        }
        if (kind === "managed-file") {
            names.push(
                ...(await new NodeConfigManager(project.dir).list()).map(
                    (file) => file.relative,
                ),
            );
            continue;
        }
        const state = await readState(project.dir);
        names.push(
            ...Object.keys(project.manifest.plugins),
            ...Object.keys(state.active?.lock.plugins ?? {}),
            ...Object.keys(state.pending?.lock.plugins ?? {}),
        );
    }
    return names;
}

function visibleOptions(command: Command): Option[] {
    const options: Option[] = [];
    for (
        let current: Command | null = command;
        current;
        current = current.parent
    )
        options.push(...current.createHelp().visibleOptions(current));
    return options;
}

function optionFor(
    command: Command,
    token: string,
): { option: Option; value?: string; prefix?: string } | undefined {
    const equal = token.indexOf("=");
    const name = equal < 0 ? token : token.slice(0, equal);
    const options = visibleOptions(command);
    const exact = options.find(
        (option) => option.long === name || option.short === name,
    );
    if (exact)
        return {
            option: exact,
            ...(equal >= 0
                ? { value: token.slice(equal + 1), prefix: `${name}=` }
                : {}),
        };
    const attached = options.find(
        (option) =>
            option.short &&
            token.startsWith(option.short) &&
            token.length > option.short.length &&
            (option.required || option.optional),
    );
    if (attached?.short)
        return {
            option: attached,
            value: token.slice(attached.short.length),
            prefix: attached.short,
        };
    return undefined;
}

/** Inspect arguments only. Never parseAsync, invoke an action, or resolve a source. */
export async function completionCandidates(
    program: Command,
    words: readonly string[],
    cwd: string,
    home: string,
): Promise<string[]> {
    if (
        words.length > 128 ||
        words.reduce((bytes, word) => bytes + Buffer.byteLength(word), 0) >
            65536
    )
        throw new CrafleetError(
            "COMPLETION_INPUT",
            "The completion request exceeds the supported input limit.",
            2,
        );
    let command = program;
    const context: CompletionContext = {
        cwd,
        home,
        filters: [],
        recursive: false,
    };
    let pending: Option | undefined;
    let literal = false;
    const positionals: string[] = [];
    const applyOption = (option: Option, value: string) => {
        if (option.attributeName() === "cwd")
            context.cwd = path.resolve(cwd, value);
        if (option.attributeName() === "filter") context.filters.push(value);
    };
    for (const word of words.slice(0, -1)) {
        if (pending) {
            applyOption(pending, word);
            pending = undefined;
            continue;
        }
        if (!literal && word === "--") {
            literal = true;
            continue;
        }
        if (!literal && word.startsWith("-")) {
            const match = optionFor(command, word);
            if (!match) return [];
            if (match.option.attributeName() === "recursive")
                context.recursive = true;
            if (match.value !== undefined)
                applyOption(match.option, match.value);
            else if (match.option.required || match.option.optional)
                pending = match.option;
            continue;
        }
        const child =
            !literal && !positionals.length
                ? command
                      .createHelp()
                      .visibleCommands(command)
                      .find(
                          (child) =>
                              child.name() === word ||
                              child.aliases().includes(word),
                      )
                : undefined;
        if (child) command = child;
        else positionals.push(word);
    }
    const prefix = words.at(-1) ?? "";
    const completeOption = async (option: Option, value: string) =>
        option.argChoices ??
        localValues(
            inputCompletion(command, option.attributeName(), true),
            value,
            option.attributeName() === "serverJar" &&
                commandPath(command) === "import"
                ? {
                      ...context,
                      cwd: path.resolve(context.cwd, positionals[0] ?? "."),
                  }
                : context,
        );
    let candidates: string[];
    if (pending) candidates = await completeOption(pending, prefix);
    else if (!literal && prefix.startsWith("-")) {
        const attached = optionFor(command, prefix);
        if (attached?.value !== undefined && attached.prefix) {
            candidates = (
                await completeOption(attached.option, attached.value)
            ).map((value) => `${attached.prefix}${value}`);
        } else
            candidates = visibleOptions(command).flatMap((option) =>
                [option.short, option.long].filter((flag): flag is string =>
                    Boolean(flag),
                ),
            );
    } else {
        const arguments_ = command.registeredArguments;
        const argument =
            arguments_[positionals.length] ??
            (arguments_.at(-1)?.variadic ? arguments_.at(-1) : undefined);
        candidates = [
            ...(!literal && !positionals.length
                ? command
                      .createHelp()
                      .visibleCommands(command)
                      .map((child) => child.name())
                : []),
            ...(argument?.argChoices ??
                (await localValues(
                    argument
                        ? inputCompletion(command, argument.name())
                        : undefined,
                    prefix,
                    context,
                ))),
            ...(commandPath(command) === "tools prepare" && !positionals.length
                ? ["restic"]
                : []),
        ];
    }
    return [...new Set(candidates)]
        .filter((value) => safeCandidate(value) && value.startsWith(prefix))
        .sort()
        .slice(0, 200);
}

/** Bash splits '=' and ':' before calling a completion function. */
export function bashWords(input: readonly string[]): {
    words: string[];
    trim: number;
} {
    const words: string[] = [];
    let trim = 0;
    for (const [index, word] of input.entries()) {
        if ((word === "=" || word === ":") && words.length) {
            const before = words.pop() ?? "";
            words.push(before + word);
            if (index === input.length - 1) trim = before.length;
        } else if (
            index > 0 &&
            ["=", ":"].includes(input[index - 1] ?? "") &&
            words.length
        ) {
            const before = words.pop() ?? "";
            words.push(before + word);
            if (index === input.length - 1) trim = before.length;
        } else words.push(word);
    }
    return { words, trim };
}

export function registerCompletionCommands(
    program: Command,
    context: CommandContext,
): void {
    const completion = program.command("completion");
    context.action(
        completion
            .description(
                "Print an offline completion script for your shell. Source it to enable tab completion.",
            )
            .addArgument(
                new Argument("<shell>", "interactive shell").choices([
                    ...COMPLETION_SHELLS,
                ]),
            ),
        async ([shell]) => COMPLETION_SCRIPTS[shell as CompletionShell],
    );
    context.action(
        completion
            .command("install")
            .description(
                "Review and install persistent completion settings for your user.",
            )
            .addArgument(
                new Argument("[shell]", "interactive shell").choices([
                    ...COMPLETION_SHELLS,
                ]),
            ),
        async ([shell], command) =>
            installCompletion(
                context,
                command,
                shell as CompletionShell | undefined,
            ),
    );
    context.action(
        program
            .command("__complete [words...]", { hidden: true })
            .description(
                "Return local completion candidates; arguments include the current partial word.",
            )
            .addOption(
                new Option("--shell <shell>", "shell word splitting").choices([
                    ...COMPLETION_SHELLS,
                ]),
            ),
        async ([input], command) => {
            const original = Array.isArray(input) ? input.map(String) : [];
            const { words, trim } =
                command.opts().shell === "bash"
                    ? bashWords(original)
                    : { words: original, trim: 0 };
            const candidates = (
                await completionCandidates(
                    program,
                    words,
                    context.cwd(command),
                    context.home,
                )
            ).map((candidate) => candidate.slice(trim));
            return context.globals(command).json
                ? candidates
                : candidates.join("\n");
        },
    );
}
