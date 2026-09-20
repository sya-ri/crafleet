import { isCancel, select } from "@clack/prompts";
import {
    consolePromptDismissed,
    dismissConsolePrompt,
    inspectAddon,
    manageAddons,
    NodeServerController,
    nearestFile,
    type ProjectContext,
} from "@crafleet/adapters";
import {
    CONSOLE_ADDON_DESCRIPTION,
    CONSOLE_ADDON_VERIFIED_CONFIGURATIONS,
    CRAFLEET_VERSION,
    CrafleetError,
    PAPER_ADDON_VERSIONS,
    VELOCITY_ADDON_VERSIONS,
    validateAddonNames,
} from "@crafleet/core";
import type { Command, CommanderError } from "commander";
import type { CommandContext } from "./context.js";
import { isCancellation } from "./failures.js";

function addonArgumentError(usage: string) {
    return (error: CommanderError): never => {
        if (error.code === "commander.missingArgument")
            throw new CrafleetError(
                "CLI_USAGE",
                "An addon name is required.",
                2,
                `Usage: crafleet addons ${usage}\nAvailable addons: console.`,
            );
        throw error;
    };
}

async function optionalProjects(
    context: CommandContext,
    command: Command,
): Promise<ProjectContext[]> {
    const cwd = context.cwd(command);
    if (
        (await nearestFile(cwd, "crafleet.yaml")) ||
        (await nearestFile(cwd, "crafleet-workspace.yaml")) ||
        context.globals(command).recursive ||
        context.globals(command).filter?.length
    )
        return context.projects(command);
    return [];
}
export function registerAddonCommands(
    program: Command,
    context: CommandContext,
): void {
    const addons = program
        .command("addons")
        .description("List and manage official Crafleet addons.");
    const inventory = async (command: Command) => ({
        name: "console",
        description: CONSOLE_ADDON_DESCRIPTION,
        available: CRAFLEET_VERSION,
        support: {
            paper: PAPER_ADDON_VERSIONS,
            velocity: VELOCITY_ADDON_VERSIONS,
            velocitySnapshotMinimumBuild: 507,
            verifiedConfigurations: CONSOLE_ADDON_VERIFIED_CONFIGURATIONS,
        },
        projects: await Promise.all(
            (await optionalProjects(context, command)).map(async (project) => ({
                ...(await inspectAddon(project)),
                ...(await new NodeServerController(
                    project.dir,
                    context.home,
                ).capabilities()),
            })),
        ),
    });
    context.action(addons, async (_, command) => inventory(command));
    context.action(
        addons
            .command("list")
            .description(
                "List official addons and their local installation state.",
            ),
        async (_, command) => inventory(command),
    );
    context.action(
        addons
            .command("info <name>")
            .exitOverride(addonArgumentError("info <name>"))
            .description(
                "Show addon support, installation eligibility, and usage.",
            ),
        async ([name], command) => {
            validateAddonNames([String(name)]);
            return inventory(command);
        },
    );
    for (const action of ["add", "update", "remove"] as const) {
        context.action(
            addons
                .command(
                    `${action} ${action === "update" ? "[names...]" : "<names...>"}`,
                )
                .exitOverride(addonArgumentError(`${action} <names...>`))
                .description(
                    `${action === "add" ? "Install" : action === "update" ? "Update" : "Remove"} official addons for the next start or restart.`,
                ),
            async ([names], command) => {
                validateAddonNames(names as string[]);
                const result = await manageAddons(
                    await context.projects(command),
                    context.store,
                    action,
                    names as string[],
                    context.installOptions(command),
                );
                if (result.noEligibleTargets) process.exitCode = 2;
                return result;
            },
        );
    }
}

export function mayOfferConsoleAddon(
    options: { yes?: boolean; dryRun?: boolean; json?: boolean },
    ci = process.env.CI,
): boolean {
    return (
        !options.yes &&
        !options.dryRun &&
        !options.json &&
        !(ci && !["0", "false", "no", "off"].includes(ci.trim().toLowerCase()))
    );
}
export async function offerConsoleAddon(
    project: ProjectContext,
    context: CommandContext,
    command: Command,
): Promise<string | undefined> {
    if (
        !mayOfferConsoleAddon(context.globals(command)) ||
        !process.stderr.isTTY
    )
        return;
    try {
        const inventory = await inspectAddon(project);
        if (
            inventory.declared ||
            inventory.active ||
            inventory.pending ||
            inventory.compatibility.status !== "supported"
        )
            return;
        if (
            !command.opts().askAddon &&
            (await consolePromptDismissed(context.home, project.dir))
        )
            return;
    } catch {
        return;
    }
    const choice = await context.interaction(() =>
        select({
            message:
                "Enable tab completion?\nThe console addon takes effect after the next server restart.",
            initialValue: "skip",
            options: [
                { value: "install", label: "Install addon" },
                { value: "skip", label: "Not now" },
                { value: "dismiss", label: "Don't ask again for this server" },
            ],
            output: process.stderr,
        }),
    );
    if (isCancel(choice))
        throw new CrafleetError(
            "CANCELLED",
            "Console attachment cancelled.",
            130,
        );
    if (choice === "dismiss") {
        try {
            await dismissConsolePrompt(context.home, project.dir);
        } catch {
            return "Could not save the preference; the addon question may appear next time.";
        }
    } else if (choice === "install") {
        try {
            const result = await manageAddons(
                [project],
                context.store,
                "add",
                ["console"],
                context.installOptions(command),
            );
            return result.noEligibleTargets
                ? "Console addon could not be installed for this server."
                : "Console addon prepared; restart the server to enable tab completion.";
        } catch (error) {
            if (isCancellation(error, context.abort.signal)) throw error;
            return `Addon installation failed: ${error instanceof Error ? error.message : "unknown error"}. Console input remains available.`;
        }
    }
    return undefined;
}
