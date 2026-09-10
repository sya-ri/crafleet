import type { CompletionSetupPlan } from "@crafleet/adapters";

export function renderCompletionSetup(
    plan: CompletionSetupPlan,
    dryRun: boolean,
): string {
    return [
        dryRun
            ? `Completion setup preview (${plan.shell}):`
            : plan.diagnostic.message,
        ...plan.files.flatMap((file) => [
            `${file.action}: ${file.path}`,
            ...(dryRun && file.content ? [file.content.trimEnd()] : []),
        ]),
        ...(!plan.canApply
            ? [plan.diagnostic.message, plan.diagnostic.hint ?? ""]
            : []),
        dryRun
            ? "No settings have been changed."
            : `Open a new shell, or load completion now:\n${plan.reload}`,
    ].join("\n");
}
