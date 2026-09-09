import path from "node:path";
import { fileURLToPath } from "node:url";
import { confirm, isCancel, text } from "@clack/prompts";
import {
    type BackupBatch,
    backupService,
    crafleetHome,
    NodeArtifactStore,
    NodeDeploymentManager,
    NodePluginCatalog,
    NodeRecoveryGroup,
    NodeServerController,
    nearestFile,
    type ProjectContext,
    resolveBackupBatches,
    selectProjects,
} from "@crafleet/adapters";
import { type BackupService, CrafleetError } from "@crafleet/core";
import type { Command } from "commander";
import { confirmEula } from "../presentation/eula.js";
import { printError, printResult } from "../presentation/output.js";
import { chooseWorkspaceProjects } from "../presentation/project-picker.js";
import {
    commandPath,
    commandPolicy,
    describeCommand,
    isStreamingCommand,
} from "./metadata.js";

export interface Globals {
    cwd?: string;
    recursive?: boolean;
    filter?: string[];
    json?: boolean;
    yes?: boolean;
    offline?: boolean;
    dryRun?: boolean;
}

function isCiEnvironment(value: string | undefined): boolean {
    if (value === undefined) return false;
    const normalized = value.trim().toLowerCase();
    return !["", "0", "false", "no", "off"].includes(normalized);
}

export class CommandContext {
    parsingCommand?: Command;
    readonly home = crafleetHome();
    readonly store = new NodeArtifactStore(this.home);
    readonly pluginCatalog = new NodePluginCatalog();
    readonly abort = new AbortController();
    readonly runnerEntry: string;
    private activeGlobals: Globals = {};
    private selection: Promise<ProjectContext[]> | undefined;
    readonly requestEulaConsent = async (document: {
        path: string;
        text: string;
        url: string;
    }): Promise<void> => {
        try {
            await confirmEula(document, {
                yes: this.activeGlobals.yes ?? false,
                json: this.activeGlobals.json ?? false,
                signal: this.abort.signal,
            });
        } catch (error) {
            if (error instanceof CrafleetError && error.code === "CANCELLED")
                this.abort.abort();
            throw error;
        }
    };
    constructor(entryUrl: string) {
        this.runnerEntry = fileURLToPath(new URL("./runner.mjs", entryUrl));
    }
    globals(command: Command): Globals {
        const chain: Command[] = [];
        for (
            let current: Command | null = command;
            current;
            current = current.parent
        )
            chain.unshift(current);
        const result: Record<string, unknown> = {};
        for (const current of chain)
            for (const key of [
                "cwd",
                "recursive",
                "filter",
                "json",
                "yes",
                "offline",
                "dryRun",
            ] as const) {
                const value: unknown = current.opts()[key];
                if (
                    value === undefined ||
                    current.getOptionValueSource(key) === "default"
                )
                    continue;
                result[key] =
                    key === "filter"
                        ? [
                              ...((result[key] as string[]) ?? []),
                              ...(value as string[]),
                          ]
                        : value;
            }
        return result as Globals;
    }
    cwd(command: Command): string {
        return path.resolve(this.globals(command).cwd ?? process.cwd());
    }
    projects(command: Command): Promise<ProjectContext[]> {
        const options = this.globals(command);
        this.selection ??= selectProjects(this.cwd(command), this.home, {
            recursive: options.recursive ?? false,
            filters: options.filter ?? [],
        });
        return this.selection;
    }
    private async selectWorkspace(command: Command): Promise<void> {
        const options = this.globals(command);
        const policy = commandPolicy(command);
        if (
            !policy ||
            policy.target === "none" ||
            options.recursive ||
            options.filter?.length
        )
            return;
        const cwd = this.cwd(command);
        // Direct runtime operations must still work when the manifest is broken.
        if (await nearestFile(cwd, "crafleet.yaml")) return;
        if (!(await nearestFile(cwd, "crafleet-workspace.yaml"))) return;
        if (policy.effect === "read" && policy.target === "multiple") {
            command.setOptionValue("recursive", true);
            return;
        }
        this.requireInteractiveInput(
            command,
            "Select an explicit workspace target with --filter <name-or-path>, -r, or -C <project>. Interactive project selection is unavailable in this mode.",
        );
        const projects = await selectProjects(cwd, this.home, {
            recursive: true,
        });
        const selected = await chooseWorkspaceProjects(
            projects,
            policy,
            commandPath(command),
            this.abort.signal,
        );
        this.selection = Promise.resolve(selected);
        command.setOptionValue("recursive", true);
    }
    async one(command: Command): Promise<ProjectContext> {
        const projects = await this.projects(command);
        if (projects.length !== 1 || !projects[0])
            throw new CrafleetError(
                "SINGLE_PROJECT",
                "This operation requires exactly one project.",
                2,
            );
        return projects[0];
    }
    async runtimeDir(command: Command): Promise<string> {
        const options = this.globals(command);
        if (options.recursive || options.filter?.length)
            return (await this.one(command)).dir;
        const file = await nearestFile(this.cwd(command), "crafleet.yaml");
        if (!file)
            throw new CrafleetError(
                "NO_PROJECT",
                "No crafleet.yaml was found.",
                2,
            );
        return path.dirname(file);
    }
    async deployment(
        project: ProjectContext,
        backup?: BackupService,
        launch = false,
    ): Promise<NodeDeploymentManager> {
        return new NodeDeploymentManager(
            project,
            this.store,
            backup ?? (await backupService(project)),
            this.runnerEntry,
            undefined,
            {
                offline: this.activeGlobals.offline ?? false,
                signal: this.abort.signal,
                ...(launch
                    ? { requestEulaConsent: this.requestEulaConsent }
                    : {}),
            },
        );
    }
    async batches(command: Command, complete = false): Promise<BackupBatch[]> {
        const repository = command.optsWithGlobals<{ repository?: string }>()
            .repository;
        return resolveBackupBatches(await this.projects(command), {
            complete,
            ...(repository ? { repository } : {}),
        });
    }
    group(batch: BackupBatch, launch = false): NodeRecoveryGroup {
        return new NodeRecoveryGroup(batch, this.store, this.runnerEntry, {
            offline: this.activeGlobals.offline ?? false,
            signal: this.abort.signal,
            ...(launch ? { requestEulaConsent: this.requestEulaConsent } : {}),
        });
    }
    async controller(command: Command): Promise<NodeServerController> {
        return new NodeServerController(
            await this.runtimeDir(command),
            this.home,
            this.runnerEntry,
            this.abort.signal,
        );
    }
    installOptions(command: Command) {
        const options = this.globals(command);
        return {
            offline: options.offline ?? false,
            dryRun: options.dryRun ?? false,
            signal: this.abort.signal,
        };
    }
    requireInteractiveInput(command: Command, message: string): void {
        const options = this.globals(command);
        if (
            options.json ||
            options.yes ||
            isCiEnvironment(process.env.CI) ||
            !process.stdin.isTTY ||
            !process.stderr.isTTY
        )
            throw new CrafleetError("INPUT_REQUIRED", message, 2);
    }
    async ask(command: Command, message: string): Promise<void> {
        const options = this.globals(command);
        if (options.yes) return;
        if (options.json || !process.stdin.isTTY)
            throw new CrafleetError(
                "CONFIRMATION_REQUIRED",
                `${message} Supply --yes to confirm this explicitly requested operation.`,
                3,
            );
        const answer = await confirm({ message, output: process.stderr });
        if (isCancel(answer) || !answer) {
            this.abort.abort();
            throw new CrafleetError("CANCELLED", "Operation cancelled.", 130);
        }
    }
    async input(
        command: Command,
        value: string | undefined,
        message: string,
    ): Promise<string> {
        if (value) return value;
        const options = this.globals(command);
        if (options.json || !process.stdin.isTTY || options.yes)
            throw new CrafleetError("INPUT_REQUIRED", message, 2);
        const answer = await text({ message, output: process.stderr });
        if (isCancel(answer)) {
            this.abort.abort();
            throw new CrafleetError("CANCELLED", "Operation cancelled.", 130);
        }
        if (!answer.trim())
            throw new CrafleetError("INPUT_REQUIRED", message, 2);
        return answer;
    }
    action(
        command: Command,
        handler: (args: unknown[], command: Command) => Promise<unknown>,
    ): void {
        if (!commandPolicy(command))
            throw new Error(
                `Missing CLI operation policy: ${commandPath(command)}`,
            );
        command.action(async (...args: unknown[]) => {
            const current = args.at(-1) as Command;
            const globals = this.globals(current);
            this.activeGlobals = globals;
            this.selection = undefined;
            const positional = args.slice(0, -2);
            const path = commandPath(current);
            const presentation = {
                command: path,
                dryRun: globals.dryRun ?? false,
                ...(isStreamingCommand(current) && !globals.dryRun
                    ? { stream: true }
                    : {}),
            };
            try {
                await this.selectWorkspace(current);
                printResult(
                    await handler(positional, current),
                    globals.json ?? false,
                    presentation,
                    Number(process.exitCode ?? 0),
                );
            } catch (error) {
                printError(
                    error,
                    globals.json ?? false,
                    describeCommand(current),
                );
            }
        });
    }
}
