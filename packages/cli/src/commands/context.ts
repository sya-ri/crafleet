import path from "node:path";
import { fileURLToPath } from "node:url";
import { confirm, isCancel, text } from "@clack/prompts";
import {
    type BackupBatch,
    backupService,
    captureRuntimeSettings,
    crafleetHome,
    NodeArtifactStore,
    NodeDeploymentManager,
    NodePluginCatalog,
    NodeRecoveryGroup,
    NodeServerController,
    nearestFile,
    type ProjectContext,
    readRuntimeSettings,
    resolveBackupBatches,
    resolveEnvironmentSettings,
    resolveRuntimeSettings,
    selectProjects,
    withRuntimeSettings,
} from "@crafleet/adapters";
import {
    type BackupService,
    CrafleetError,
    type ProgressObserver,
    parseSettingAssignments,
    progressStep,
    type ResolvedSettings,
} from "@crafleet/core";
import type { Command } from "commander";
import { confirmEula } from "../presentation/eula.js";
import type { HumanResultContext } from "../presentation/human.js";
import { printError, printResult } from "../presentation/output.js";
import { CommandProgress } from "../presentation/progress.js";
import { chooseWorkspaceProjects } from "../presentation/project-picker.js";
import { isCiEnvironment } from "../presentation/terminal.js";
import {
    isCancellation,
    type PartialFailureUnit,
    partialFailure,
} from "./failures.js";
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
    set?: string[];
}

const GROUPED_RESULTS = new Set([
    "validate",
    "workspace list",
    "status",
    "deploy plan",
    "plugins",
    "plugins check",
    "server",
    "server check",
    "files list",
    "files diff",
    "config list",
    "config diff",
]);

export class CommandContext {
    parsingCommand?: Command;
    readonly home = crafleetHome();
    readonly store = new NodeArtifactStore(this.home);
    readonly pluginCatalog = new NodePluginCatalog();
    readonly abort = new AbortController();
    readonly runnerEntry: string;
    private activeGlobals: Globals = {};
    private selection: Promise<ProjectContext[]> | undefined;
    private warnedLegacy = false;
    private progress: CommandProgress | undefined;
    private presentation: HumanResultContext = { command: "", dryRun: false };
    private readonly presented = new Set<unknown>();
    private readonly pendingResults = new Set<unknown>();
    private readonly resultSettings = new Map<unknown, ResolvedSettings>();
    private groupedResults = false;
    private sequence = 0;
    readonly onProgress: ProgressObserver = (event) =>
        this.progress?.report(event);

    get progressOptions() {
        return this.activeGlobals.json ? {} : { onProgress: this.onProgress };
    }

    step<T>(message: string, action: () => Promise<T>): Promise<T> {
        return progressStep(
            this.onProgress,
            `cli-${++this.sequence}`,
            message,
            action,
        );
    }

    pauseOutput(): () => void {
        this.progress?.pause();
        return () => this.progress?.resume();
    }

    async interaction<T>(action: () => Promise<T>): Promise<T> {
        const resume = this.pauseOutput();
        try {
            return await action();
        } finally {
            resume();
        }
    }

    publish<T>(result: T, array = true): T {
        if (!this.resultSettings.has(result))
            this.resultSettings.set(result, captureRuntimeSettings());
        if (this.activeGlobals.json || this.presented.has(result))
            return result;
        if (this.groupedResults && array) {
            this.pendingResults.add(result);
            return result;
        }
        this.printHumanResult(array ? [result] : result);
        this.presented.add(result);
        return result;
    }

    private printHumanResult(result: unknown, partial = false): void {
        this.progress?.pause();
        try {
            if (partial)
                printResult("Partial results:", false, this.presentation);
            printResult(result, false, this.presentation);
        } catch {
            this.onProgress({
                id: "result-display",
                message:
                    "A result could not be displayed. Inspect status before retrying the operation.",
                state: "failed",
            });
        } finally {
            this.progress?.resume();
        }
    }

    append<T>(results: T[], ...items: T[]): void {
        for (const item of items) results.push(this.publish(item));
    }

    retain<T>(result: T): T {
        if (!this.activeGlobals.json) this.presented.add(result);
        return result;
    }

    partialFailure(
        error: unknown,
        unitCount: number,
        unit: PartialFailureUnit,
        fallback: string,
    ) {
        if (isCancellation(error, this.abort.signal) || unitCount === 1)
            throw error;
        process.exitCode = 4;
        return partialFailure(error, unit, fallback);
    }

    collect<T, R>(
        items: readonly T[],
        action: (item: T) => Promise<R>,
    ): Promise<R[]> {
        return Promise.allSettled(
            items.map(async (item) => {
                const settings =
                    item && typeof item === "object" && "settings" in item
                        ? (item as unknown as ProjectContext).settings
                        : undefined;
                return withRuntimeSettings(
                    settings ?? captureRuntimeSettings(),
                    async () => {
                        const result = await action(item);
                        this.resultSettings.set(
                            result,
                            captureRuntimeSettings(),
                        );
                        return this.groupedResults
                            ? result
                            : this.publish(result);
                    },
                );
            }),
        ).then((results) => {
            if (this.groupedResults)
                for (const result of results)
                    if (result.status === "fulfilled")
                        this.publish(result.value);
            return results.map((result) => {
                if (result.status === "rejected") throw result.reason;
                return result.value;
            });
        });
    }
    readonly requestEulaConsent = async (document: {
        path: string;
        text: string;
        url: string;
    }): Promise<void> => {
        try {
            await this.interaction(() =>
                confirmEula(document, {
                    yes: this.activeGlobals.yes ?? false,
                    json: this.activeGlobals.json ?? false,
                    signal: this.abort.signal,
                }),
            );
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
                "set",
            ] as const) {
                const value: unknown = current.opts()[key];
                if (
                    value === undefined ||
                    current.getOptionValueSource(key) === "default"
                )
                    continue;
                result[key] =
                    key === "filter" || key === "set"
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
    async projects(command: Command): Promise<ProjectContext[]> {
        const options = this.globals(command);
        this.selection ??= this.step("Discovering projects", () =>
            selectProjects(this.cwd(command), this.home, {
                recursive: options.recursive ?? false,
                filters: options.filter ?? [],
            }),
        );
        const selected = await this.selection;
        if (
            !this.warnedLegacy &&
            selected.some((project) => project.manifest.files === undefined) &&
            commandPath(command) !== "files migrate"
        ) {
            this.warnedLegacy = true;
            const resume = this.pauseOutput();
            try {
                process.stderr.write(
                    "Warning: config is deprecated and will be removed in 0.6.0. Run crafleet files migrate --from config.\n",
                );
            } finally {
                resume();
            }
        }
        return selected;
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
        const selected = await this.interaction(() =>
            chooseWorkspaceProjects(
                projects,
                policy,
                commandPath(command),
                this.abort.signal,
            ),
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
                ...this.progressOptions,
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
            ...this.progressOptions,
            ...(launch ? { requestEulaConsent: this.requestEulaConsent } : {}),
        });
    }
    async controller(command: Command): Promise<NodeServerController> {
        return new NodeServerController(
            await this.runtimeDir(command),
            this.home,
            this.runnerEntry,
            this.abort.signal,
            this.onProgress,
        );
    }
    installOptions(command: Command) {
        const options = this.globals(command);
        return {
            offline: options.offline ?? false,
            dryRun: options.dryRun ?? false,
            signal: this.abort.signal,
            ...this.progressOptions,
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
        const answer = await this.interaction(() =>
            confirm({ message, output: process.stderr }),
        );
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
        const answer = await this.interaction(() =>
            text({ message, output: process.stderr }),
        );
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
            const inputs = resolveEnvironmentSettings(
                process.env,
                parseSettingAssignments(globals.set ?? []),
            );
            inputs.signal = this.abort.signal;
            const bootstrap = resolveRuntimeSettings({}, {}, [], inputs);
            return withRuntimeSettings(
                bootstrap,
                async () => {
                    const settings =
                        commandPath(current) === "settings list"
                            ? { resolved: bootstrap }
                            : await readRuntimeSettings(
                                  this.cwd(current),
                                  inputs,
                                  ["stop", "status", "settings show"].includes(
                                      commandPath(current),
                                  ),
                              );
                    return withRuntimeSettings(settings.resolved, async () => {
                        this.activeGlobals = globals;
                        this.selection = undefined;
                        const positional = args.slice(0, -2);
                        const path = commandPath(current);
                        const presentation = {
                            command: path,
                            dryRun: globals.dryRun ?? false,
                            resultSettings: this.resultSettings,
                            ...(isStreamingCommand(current) && !globals.dryRun
                                ? { stream: true }
                                : {}),
                        };
                        this.presentation = presentation;
                        this.presented.clear();
                        this.pendingResults.clear();
                        this.resultSettings.clear();
                        this.groupedResults = GROUPED_RESULTS.has(path);
                        this.progress = globals.json
                            ? undefined
                            : new CommandProgress(path);
                        let outcome: "complete" | "failed" | "cancelled" =
                            "complete";
                        try {
                            await this.selectWorkspace(current);
                            const result = await handler(positional, current);
                            if (process.exitCode) outcome = "failed";
                            else if (this.abort.signal.aborted)
                                outcome = "cancelled";
                            this.progress?.pause();
                            if (globals.json)
                                printResult(
                                    result,
                                    true,
                                    presentation,
                                    Number(process.exitCode ?? 0),
                                );
                            else if (this.groupedResults) {
                                const output =
                                    result === undefined &&
                                    this.pendingResults.size
                                        ? [...this.pendingResults]
                                        : result;
                                this.printHumanResult(
                                    output,
                                    outcome !== "complete" &&
                                        output !== undefined,
                                );
                            } else if (!this.presented.has(result)) {
                                const remaining = Array.isArray(result)
                                    ? result.filter(
                                          (item) => !this.presented.has(item),
                                      )
                                    : result;
                                if (
                                    !Array.isArray(result) ||
                                    result.length === 0 ||
                                    (remaining as unknown[]).length > 0
                                )
                                    this.printHumanResult(remaining);
                            }
                        } catch (error) {
                            outcome = isCancellation(error, this.abort.signal)
                                ? "cancelled"
                                : "failed";
                            this.progress?.pause();
                            if (this.pendingResults.size)
                                this.printHumanResult(
                                    [...this.pendingResults],
                                    true,
                                );
                            printError(
                                error,
                                globals.json ?? false,
                                describeCommand(current),
                            );
                        } finally {
                            this.progress?.finish(outcome);
                            this.progress = undefined;
                            this.presented.clear();
                            this.pendingResults.clear();
                            this.resultSettings.clear();
                            this.groupedResults = false;
                        }
                    });
                },
                inputs,
                (message) => {
                    process.stderr.write(message);
                },
            );
        });
    }
}
