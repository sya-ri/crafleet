import { confirm, isCancel, select } from "@clack/prompts";
import {
    applyCompletionSetup,
    type CompletionSetupPlan,
    detectCompletionShell,
    planCompletionSetup,
    resolveCompletionTarget,
} from "@crafleet/adapters";
import {
    COMPLETION_SHELLS,
    type CompletionShell,
    CrafleetError,
    type Diagnostic,
} from "@crafleet/core";
import type { Command } from "commander";
import { COMPLETION_SCRIPTS } from "../presentation/completion.js";
import { renderCompletionSetup } from "../presentation/completion-setup.js";
import { sanitizeTerminalOutput } from "../presentation/terminal.js";
import type { CommandContext } from "./context.js";

function interactive(context: CommandContext, command: Command): boolean {
    if (context.globals(command).dryRun) return false;
    try {
        context.requireInteractiveInput(
            command,
            "Specify the shell explicitly.",
        );
        return true;
    } catch {
        return false;
    }
}

async function setupPlan(
    context: CommandContext,
    command: Command,
    explicit?: CompletionShell,
): Promise<CompletionSetupPlan | undefined> {
    const detected = await detectCompletionShell();
    let shell = explicit ?? detected?.shell;
    if (!shell && interactive(context, command)) {
        const answer = await select({
            message: "Which shell should use Crafleet completion?",
            options: COMPLETION_SHELLS.map((value) => ({
                value,
                label: value,
            })),
            output: process.stderr,
            signal: context.abort.signal,
        });
        if (isCancel(answer))
            throw new CrafleetError(
                "CANCELLED",
                "Completion shell selection cancelled.",
                130,
            );
        shell = answer;
    }
    if (!shell) return undefined;
    const target = await resolveCompletionTarget(shell, context.home, detected);
    return planCompletionSetup(target, COMPLETION_SCRIPTS[shell]);
}

function preview(plan: CompletionSetupPlan): void {
    process.stderr.write(
        `${sanitizeTerminalOutput(renderCompletionSetup(plan, true))}\n`,
    );
}

async function approve(
    plan: CompletionSetupPlan,
    context: CommandContext,
): Promise<boolean> {
    preview(plan);
    const answer = await confirm({
        message: "Apply these completion settings for your user?",
        initialValue: false,
        output: process.stderr,
        signal: context.abort.signal,
    });
    if (isCancel(answer))
        throw new CrafleetError(
            "CANCELLED",
            "Completion setup cancelled.",
            130,
        );
    return answer;
}

async function apply(
    plan: CompletionSetupPlan,
    context: CommandContext,
): Promise<CompletionSetupPlan> {
    await applyCompletionSetup(plan, context.abort.signal);
    const target = {
        shell: plan.shell,
        scriptPath: plan.files[0]?.path ?? "",
        profiles: plan.files.slice(1).map((file) => file.path),
    };
    const checked = await planCompletionSetup(
        target,
        COMPLETION_SCRIPTS[plan.shell],
    );
    if (checked.diagnostic.status !== "pass")
        throw new CrafleetError(
            "COMPLETION_VERIFY",
            "Completion settings could not be verified after writing.",
            3,
            "Run crafleet doctor to inspect the settings before retrying.",
        );
    return { ...plan, diagnostic: checked.diagnostic };
}

export async function installCompletion(
    context: CommandContext,
    command: Command,
    shell?: CompletionShell,
): Promise<CompletionSetupPlan> {
    const plan = await setupPlan(context, command, shell);
    if (!plan)
        throw new CrafleetError(
            "INPUT_REQUIRED",
            "The shell could not be detected. Specify bash, zsh, fish, or powershell.",
            2,
            "Run crafleet completion install <shell>.",
        );
    const options = context.globals(command);
    if (options.dryRun) return plan;
    if (!plan.canApply)
        throw new CrafleetError(
            "COMPLETION_CONFIG",
            plan.diagnostic.message,
            3,
            plan.diagnostic.hint,
        );
    if (plan.diagnostic.status === "pass") return plan;
    if (!options.yes) {
        if (!interactive(context, command))
            throw new CrafleetError(
                "CONFIRMATION_REQUIRED",
                "Completion setup requires confirmation before changing user settings.",
                3,
                "Preview with --dry-run, then use --yes to apply in this mode.",
            );
        if (!(await approve(plan, context)))
            throw new CrafleetError(
                "CANCELLED",
                "Completion setup cancelled.",
                130,
            );
    }
    return apply(plan, context);
}

export async function diagnoseCompletion(
    context: CommandContext,
    command: Command,
): Promise<Diagnostic[]> {
    let plan: CompletionSetupPlan | undefined;
    try {
        plan = await setupPlan(
            context,
            command,
            command.opts<{ shell?: CompletionShell }>().shell,
        );
    } catch (error) {
        if (error instanceof CrafleetError && error.code === "CANCELLED")
            throw error;
        return [
            {
                id: "completion.settings",
                status: "unknown",
                message: "Completion settings could not be inspected.",
                hint:
                    error instanceof CrafleetError
                        ? (error.hint ?? error.message)
                        : "Run crafleet completion install <shell> --dry-run to inspect the setup.",
            },
        ];
    }
    if (!plan)
        return [
            {
                id: "completion.shell",
                status: "unknown",
                message: "The current shell could not be detected.",
                hint: "Specify crafleet doctor --shell bash|zsh|fish|powershell.",
            },
        ];
    if (
        plan.canApply &&
        plan.diagnostic.status === "warn" &&
        interactive(context, command) &&
        (await approve(plan, context))
    ) {
        try {
            plan = await apply(plan, context);
        } catch (error) {
            if (
                error instanceof Error &&
                (error.name === "AbortError" ||
                    (error instanceof CrafleetError &&
                        error.code === "CANCELLED"))
            )
                throw error;
            return [
                {
                    id: `completion.${plan.shell}`,
                    status: "fail",
                    message:
                        error instanceof CrafleetError
                            ? error.message
                            : "Completion setup failed.",
                    hint: "Run crafleet completion install again to inspect the remaining changes.",
                },
            ];
        }
    }
    return [plan.diagnostic];
}
