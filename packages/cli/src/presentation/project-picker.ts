import { isCancel, multiselect, select } from "@clack/prompts";
import type { ProjectContext } from "@crafleet/adapters";
import { CrafleetError } from "@crafleet/core";
import type { CommandPolicy } from "../commands/metadata.js";
import { sanitizeInlineTerminalOutput } from "./terminal.js";

export async function chooseWorkspaceProjects(
    projects: readonly ProjectContext[],
    policy: CommandPolicy,
    command: string,
    signal: AbortSignal,
): Promise<ProjectContext[]> {
    const groups = new Map<string, ProjectContext[]>();
    for (const project of projects) {
        const group =
            (policy.completeGroup || policy.target === "recovery-unit") &&
            project.manifest.backup?.group;
        const key = group ? `group:${group}` : `project:${project.lockKey}`;
        const members = groups.get(key) ?? [];
        members.push(project);
        groups.set(key, members);
    }
    const options = [...groups].map(([key, members]) => ({
        value: key,
        label: sanitizeInlineTerminalOutput(
            key.startsWith("group:")
                ? `Group: ${key.slice(6)}`
                : (members[0]?.manifest.name ?? key),
        ),
        hint: sanitizeInlineTerminalOutput(
            members.map((member) => member.lockKey).join(", "),
        ),
    }));
    const prompt = {
        message: `Select ${policy.target === "single" ? "a project" : "projects or a recovery group"} for ${command}`,
        options,
        output: process.stderr,
        signal,
    };
    const answer =
        policy.target === "multiple"
            ? await multiselect({
                  ...prompt,
                  required: true,
                  initialValues: [],
              })
            : await select(prompt);
    if (isCancel(answer))
        throw new CrafleetError(
            "CANCELLED",
            "Project selection cancelled.",
            130,
        );
    const keys = Array.isArray(answer) ? answer : [answer];
    const selected = keys.flatMap((key) => groups.get(key) ?? []);
    if (
        !selected.length ||
        (policy.target === "single" && selected.length !== 1)
    )
        throw new CrafleetError(
            "SINGLE_PROJECT",
            "Select the required project before running this operation.",
            2,
        );
    return projects.filter((project) => selected.includes(project));
}
