import type { Command } from "commander";

export interface CommandPolicy {
    /** Optional, separately confirmed setup offered only in interactive mode. */
    interactiveSetup?: "completion install";
    effect: "read" | "change";
    target: "none" | "single" | "multiple" | "recovery-unit";
    completeGroup: boolean;
    json: "document" | "stream" | "follow" | "terminal-only";
    /** Explicit inputs that replace a prompt; alternatives share one array. */
    inputs: readonly (readonly string[])[];
}

function policy(
    effect: CommandPolicy["effect"],
    target: CommandPolicy["target"],
    options: Partial<Omit<CommandPolicy, "effect" | "target">> = {},
): CommandPolicy {
    return {
        effect,
        target,
        completeGroup: false,
        json: "document",
        inputs: [],
        ...options,
    };
}

/** Operation semantics supplement Commander's argument and option definitions. */
export const COMMAND_POLICIES: Readonly<Record<string, CommandPolicy>> = {
    completion: policy("read", "none"),
    "completion install": policy("change", "none", {
        inputs: [["shell"], ["--yes"]],
    }),
    __complete: policy("read", "none"),
    init: policy("change", "none", { inputs: [["--version"]] }),
    import: policy("change", "none", { inputs: [["--stopped"]] }),
    "workspace init": policy("change", "none"),
    "workspace list": policy("read", "none"),
    validate: policy("read", "multiple"),
    doctor: policy("read", "multiple", {
        interactiveSetup: "completion install",
    }),
    install: policy("change", "multiple"),
    plugins: policy("read", "multiple"),
    "plugins check": policy("read", "multiple"),
    "plugins inspect": policy("read", "none"),
    "plugins add": policy("change", "multiple", { inputs: [["sources"]] }),
    "plugins remove": policy("change", "multiple"),
    "plugins update": policy("change", "multiple"),
    server: policy("read", "multiple"),
    "server check": policy("read", "multiple"),
    "server update": policy("change", "multiple"),
    start: policy("change", "multiple", { completeGroup: true }),
    restart: policy("change", "multiple", { completeGroup: true }),
    stop: policy("change", "multiple"),
    status: policy("read", "multiple"),
    command: policy("change", "single"),
    logs: policy("read", "single", { json: "follow" }),
    run: policy("change", "single", { json: "stream", completeGroup: true }),
    supervise: policy("change", "single", { json: "stream" }),
    console: policy("change", "single", { json: "stream" }),
    "deploy plan": policy("read", "multiple"),
    "deploy apply": policy("change", "multiple", { completeGroup: true }),
    "deploy discard": policy("change", "multiple"),
    recover: policy("change", "multiple", { completeGroup: true }),
    "config list": policy("read", "single"),
    "config track": policy("change", "single"),
    "config untrack": policy("change", "single"),
    "config diff": policy("read", "single"),
    "config capture": policy("change", "single"),
    "config resolve": policy("change", "single"),
    "files list": policy("read", "single"),
    "files track": policy("change", "single"),
    "files untrack": policy("change", "single"),
    "files diff": policy("read", "single"),
    "files capture": policy("change", "single"),
    "files resolve": policy("change", "single"),
    "files migrate": policy("change", "single", { inputs: [["--from"]] }),
    "backup setup": policy("change", "single", {
        inputs: [["--path"], ["--password-env", "--password-file"]],
    }),
    "backup plan": policy("read", "recovery-unit"),
    "backup create": policy("change", "multiple", { completeGroup: true }),
    "backup list": policy("read", "recovery-unit"),
    "backup show": policy("read", "recovery-unit"),
    "backup diff": policy("read", "recovery-unit"),
    "backup check": policy("read", "recovery-unit"),
    "backup restore": policy("change", "recovery-unit"),
    "backup apply": policy("change", "recovery-unit", { completeGroup: true }),
    "backup prune": policy("change", "recovery-unit"),
    "cache info": policy("read", "none"),
    "cache verify": policy("read", "none"),
    "cache prune": policy("change", "none"),
    "tools prepare": policy("change", "none"),
};

export type CompletionKind =
    | "project"
    | "plugin"
    | "directory"
    | "file"
    | "jar"
    | "runtime-file"
    | "managed-file"
    | "source"
    | "mapping";

/** Shared by structured help and shell completion; values never invoke providers. */
export function inputCompletion(
    command: Command,
    input: string,
    option = false,
): CompletionKind | undefined {
    if (option) {
        if (
            input === "cwd" ||
            input === "path" ||
            (input === "to" && commandPath(command) === "backup restore")
        )
            return "directory";
        if (input === "filter") return "project";
        if (input === "source") return "source";
        if (input === "serverJar") return "jar";
        if (input === "passwordFile") return "file";
        if (input === "map") return "mapping";
        return undefined;
    }
    if (
        input === "directory" ||
        (input === "source" && commandPath(command) === "import")
    )
        return "directory";
    if (input === "path" || input === "paths") {
        if (["config track", "files track"].includes(commandPath(command)))
            return "runtime-file";
        if (/^(config|files) /.test(commandPath(command)))
            return "managed-file";
        return "file";
    }
    if (input === "jar") return "jar";
    if (input === "plugins") return "plugin";
    if (input === "sources") return "source";
    return undefined;
}

export function commandPath(command: Command): string {
    const names: string[] = [];
    for (
        let current: Command | null = command;
        current?.parent;
        current = current.parent
    )
        names.unshift(current.name());
    return names.join(" ");
}

export function commandPolicy(command: Command): CommandPolicy | undefined {
    return COMMAND_POLICIES[commandPath(command)];
}

export function isStreamingCommand(command: Command): boolean {
    const mode = commandPolicy(command)?.json;
    return (
        mode === "stream" ||
        (mode === "follow" && Boolean(command.opts().follow))
    );
}

export function describeCommand(command: Command) {
    const help = command.createHelp();
    return {
        command: commandPath(command) || command.name(),
        description: command.description(),
        usage: command.usage(),
        policy: commandPolicy(command) ?? null,
        arguments: command.registeredArguments.map((argument) => ({
            name: argument.name(),
            description: argument.description,
            required: argument.required,
            variadic: argument.variadic,
            ...(inputCompletion(command, argument.name())
                ? { completion: inputCompletion(command, argument.name()) }
                : {}),
            ...(argument.argChoices ? { choices: argument.argChoices } : {}),
        })),
        options: help.visibleOptions(command).map((option) => ({
            flags: option.flags,
            name: option.attributeName(),
            description: option.description,
            required: Boolean(option.mandatory),
            value: option.required
                ? "required"
                : option.optional
                  ? "optional"
                  : "none",
            variadic: Boolean(option.variadic),
            ...(inputCompletion(command, option.attributeName(), true)
                ? {
                      completion: inputCompletion(
                          command,
                          option.attributeName(),
                          true,
                      ),
                  }
                : {}),
            ...(option.argChoices ? { choices: option.argChoices } : {}),
            ...(option.defaultValue !== undefined
                ? { default: option.defaultValue }
                : {}),
        })),
        commands: help.visibleCommands(command).map((child) => ({
            name: child.name(),
            description: child.description(),
            policy: commandPolicy(child) ?? null,
        })),
    };
}
