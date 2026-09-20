import type { Command, Help } from "commander";
import { commandPath } from "../commands/metadata.js";

const commandGroups = [
    [
        "GETTING STARTED",
        [
            ["init", "Create a server project."],
            ["import", "Import an existing stopped server."],
            ["install", "Download artifacts and prepare an installation."],
        ],
    ],
    [
        "SERVER COMMANDS",
        [
            ["start", "Start the server and apply prepared changes."],
            ["stop", "Stop the server gracefully."],
            ["restart", "Restart the server and apply prepared changes."],
            ["run", "Start the server and follow its logs."],
            ["status", "Show the managed server's status."],
            ["logs", "Read or follow server logs."],
            ["console", "Open an interactive server console."],
            ["command", "Send a server console command."],
            ["supervise", "Keep the intended server process running."],
        ],
    ],
    [
        "PROJECT COMMANDS",
        [
            ["plugins", "List, add, and update plugins."],
            ["server", "Inspect and update the server artifact."],
            ["files", "Review and capture managed server files."],
            ["config", "Manage legacy configuration (deprecated)."],
            ["deploy", "Inspect and apply prepared installations."],
            ["backup", "Set up backups and manage snapshots."],
            ["workspace", "Manage multiple server projects."],
        ],
    ],
    [
        "MAINTENANCE COMMANDS",
        [
            ["validate", "Validate project declarations and state."],
            ["doctor", "Check the host and server prerequisites."],
            ["recover", "Recover an interrupted operation."],
            ["cache", "Inspect and clean the artifact cache."],
            ["tools", "Prepare external tools."],
            ["completion", "Set up shell tab completion."],
            ["help", "Show help for a command."],
        ],
    ],
] as const;

interface Example {
    description: string;
    commands: readonly string[];
}

const examples: Readonly<Record<string, readonly Example[]>> = {
    "": [
        {
            description:
                "Create a Paper project (prompts for version and EULA consent), then install and start it",
            commands: [
                "crafleet init my-server",
                "crafleet -C my-server install",
                "crafleet -C my-server start",
            ],
        },
    ],
    init: [
        {
            description: "Create a Paper project with interactive setup",
            commands: ["crafleet init my-server"],
        },
        {
            description: "Choose the server version explicitly",
            commands: ["crafleet init my-server --type paper --version 26.2"],
        },
    ],
    import: [
        {
            description:
                "Stop the original server first, then copy it into a new project",
            commands: [
                "crafleet import ./old-server ./my-server --name survival --type paper --version 26.2 --stopped",
            ],
        },
    ],
    workspace: [
        {
            description: "Create a workspace and list its projects",
            commands: [
                'crafleet workspace init "servers/*"',
                "crafleet workspace list",
            ],
        },
        {
            description: "Check every project in the workspace",
            commands: ["crafleet --recursive status"],
        },
    ],
    plugins: [
        {
            description: "List plugins and check for updates",
            commands: ["crafleet plugins", "crafleet plugins check"],
        },
        {
            description: "Add a plugin to the pending installation",
            commands: ["crafleet plugins add modrinth:luckperms"],
        },
    ],
    "plugins add": [
        {
            description: "Add a plugin from Modrinth",
            commands: ["crafleet plugins add modrinth:luckperms"],
        },
        {
            description: "Add a local JAR, relative to the project directory",
            commands: ['crafleet plugins add "file:../build/MyPlugin.jar"'],
        },
    ],
    "plugins update": [
        {
            description:
                "Prepare an update for one plugin, then review pending changes",
            commands: [
                "crafleet plugins update LuckPerms",
                "crafleet deploy plan",
            ],
        },
        {
            description: "Prepare updates for all declared plugins",
            commands: ["crafleet plugins update"],
        },
    ],
    server: [
        {
            description: "Inspect the server artifact and check for updates",
            commands: ["crafleet server", "crafleet server check"],
        },
        {
            description:
                "Prepare a server update for the next start or restart",
            commands: ["crafleet server update"],
        },
    ],
    files: [
        {
            description: "Find configuration files and review changes",
            commands: [
                "crafleet files list --candidates",
                "crafleet files diff",
            ],
        },
        {
            description:
                "Capture tracked files with the server stopped and secrets registered",
            commands: ["crafleet files capture"],
        },
    ],
    "files capture": [
        {
            description:
                "Preview the initial capture with the server stopped and secrets registered",
            commands: ["crafleet files capture --initial --dry-run"],
        },
        {
            description: "Capture one tracked file",
            commands: ["crafleet files capture server.properties"],
        },
    ],
    "files resolve": [
        {
            description:
                "Resolve a reviewed conflict using the runtime version",
            commands: [
                "crafleet files resolve server.properties --use runtime",
            ],
        },
        {
            description: "Keep the base configuration instead",
            commands: ["crafleet files resolve server.properties --use base"],
        },
    ],
    config: [
        {
            description: "List configuration in an unmigrated legacy project",
            commands: ["crafleet config list"],
        },
        {
            description: "Preview migration to managed files",
            commands: ["crafleet files migrate --from config --dry-run"],
        },
    ],
    completion: [
        {
            description: "Review and install completion for your shell",
            commands: ["crafleet completion install"],
        },
        {
            description: "Print a completion script for PowerShell",
            commands: ["crafleet completion powershell"],
        },
    ],
    deploy: [
        {
            description: "Review the pending installation",
            commands: ["crafleet deploy plan"],
        },
        {
            description:
                "Apply pending changes to a stopped server; leave it stopped",
            commands: ["crafleet deploy apply"],
        },
        {
            description: "Discard the pending installation",
            commands: ["crafleet deploy discard"],
        },
    ],
    backup: [
        {
            description: "Configure a backup repository interactively",
            commands: ["crafleet backup setup local"],
        },
        {
            description:
                "Create a snapshot (stops running servers), then list snapshots",
            commands: ["crafleet backup create", "crafleet backup list"],
        },
    ],
    "backup setup": [
        {
            description: "Register an existing repository interactively",
            commands: ["crafleet backup setup local"],
        },
        {
            description:
                "Create a new encrypted repository at the path entered during setup",
            commands: ["crafleet backup setup local --init"],
        },
    ],
    "backup restore": [
        {
            description:
                "Use an ID from backup list and an empty destination directory",
            commands: [
                "crafleet backup restore abc12345 --to ./restore-preview",
            ],
        },
        {
            description: "Preview the restore without extracting files",
            commands: [
                "crafleet backup restore abc12345 --to ./restore-preview --dry-run",
            ],
        },
    ],
    cache: [
        {
            description: "Inspect cache usage and verify downloaded artifacts",
            commands: ["crafleet cache info", "crafleet cache verify"],
        },
        {
            description: "Preview unused entries without deleting them",
            commands: ["crafleet cache prune"],
        },
    ],
    tools: [
        {
            description: "Preview external tool setup",
            commands: ["crafleet tools prepare restic --dry-run"],
        },
        {
            description: "Download and verify restic before backup operations",
            commands: ["crafleet tools prepare restic"],
        },
    ],
};

function formatHelp(command: Command, helper: Help): string {
    const width = helper.helpWidth ?? 80;
    const sections: string[] = [];
    const section = (heading: string, lines: string[]) => {
        if (lines.length) sections.push(`${heading}\n${lines.join("\n")}`);
    };
    const indent = (text: string, spaces = 2) =>
        helper
            .boxWrap(text, width - spaces)
            .split("\n")
            .map((line) => `${" ".repeat(spaces)}${line}`)
            .join("\n");
    const rows = (items: [string, string][]) => {
        const termWidth = Math.max(
            0,
            ...items.map(([term]) => helper.displayWidth(term)),
        );
        return items.map(([term, description]) =>
            width - termWidth - 4 < helper.minWidthToWrap
                ? `  ${term}\n${indent(description, 4)}`
                : helper.formatItem(term, termWidth, description, helper),
        );
    };

    sections.push(helper.boxWrap(helper.commandDescription(command), width));
    section("USAGE", [indent(helper.commandUsage(command))]);

    const visibleCommands = helper.visibleCommands(command);
    const order: string[] = commandGroups.flatMap(([, commands]) =>
        commands.map(([name]) => name),
    );
    if (!command.parent)
        visibleCommands.sort(
            (left, right) =>
                order.indexOf(left.name()) - order.indexOf(right.name()),
        );
    const groups = helper.groupItems(
        visibleCommands,
        visibleCommands,
        (child) => child.helpGroup() || "COMMANDS",
    );
    for (const [heading, children] of groups)
        section(
            heading,
            rows(
                children.map((child) => [
                    `${child.name()}:`,
                    helper.subcommandDescription(child),
                ]),
            ),
        );

    section(
        "ARGUMENTS",
        rows(
            helper
                .visibleArguments(command)
                .map((argument) => [
                    helper.argumentTerm(argument),
                    helper.argumentDescription(argument),
                ]),
        ),
    );
    const options = helper.visibleOptions(command);
    for (const heading of ["FLAGS", "GLOBAL FLAGS"])
        section(
            heading,
            rows(
                options
                    .filter(
                        (option) =>
                            (option.helpGroupHeading ?? "FLAGS") === heading,
                    )
                    .map((option) => [
                        helper.optionTerm(option),
                        helper.optionDescription(option),
                    ]),
            ),
        );

    const path = commandPath(command);
    // Legacy leaf commands retain matching examples while the group guides
    // operators toward migration to files.
    const commandExamples =
        examples[path] ?? examples[path.replace(/^config /u, "files ")] ?? [];
    if (commandExamples.length)
        section("EXAMPLES", [
            commandExamples
                .map((example) =>
                    [
                        helper
                            .boxWrap(example.description, width - 4)
                            .split("\n")
                            .map((line) => `  # ${line}`)
                            .join("\n"),
                        ...example.commands.map(
                            (line) =>
                                `  $ ${path.startsWith("config ") ? line.replace("crafleet files ", "crafleet config ") : line}`,
                        ),
                    ].join("\n"),
                )
                .join("\n\n"),
        ]);
    section("LEARN MORE", [
        indent(
            command.commands.length
                ? `Use '${[programName(command), commandPath(command)].filter(Boolean).join(" ")} <command> --help' for more information about a command.`
                : "Use 'crafleet --help' to see all commands.",
        ),
        indent("Read the guide at https://github.com/sya-ri/crafleet#readme"),
    ]);
    return `${sections.join("\n\n")}\n`;
}

function programName(command: Command): string {
    return command.parent ? programName(command.parent) : command.name();
}

export function configureCliHelp(program: Command): void {
    // These commands have no operation of their own. Keep real default actions
    // such as the plugins/server inventories, and keep implicit help enabled.
    for (const command of [
        program,
        ...program.commands.filter((child) =>
            [
                "workspace",
                "config",
                "files",
                "deploy",
                "backup",
                "cache",
                "tools",
            ].includes(child.name()),
        ),
    ])
        command.action(() => command.outputHelp()).helpCommand(true);

    const configure = (command: Command) => {
        command.configureHelp({ formatHelp, minWidthToWrap: 20 });
        for (const child of command.commands) configure(child);
    };
    configure(program);
    for (const [heading, entries] of commandGroups)
        for (const [name, summary] of entries) {
            if (name === "help") {
                program
                    .commandsGroup(heading)
                    .helpCommand("help [command]", summary);
            } else {
                program.commands
                    .find((command) => command.name() === name)
                    ?.helpGroup(heading)
                    .summary(summary);
            }
        }
}
