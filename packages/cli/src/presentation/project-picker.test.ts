import type { ProjectContext } from "@crafleet/adapters";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMAND_POLICIES } from "../commands/metadata.js";
import { chooseWorkspaceProjects } from "./project-picker.js";

const prompts = vi.hoisted(() => ({ select: vi.fn(), multiselect: vi.fn() }));
vi.mock("@clack/prompts", () => ({
    ...prompts,
    isCancel: (value: unknown) => typeof value === "symbol",
}));
afterEach(() => vi.resetAllMocks());

function policy(name: string) {
    const value = COMMAND_POLICIES[name];
    if (!value) throw new Error("Missing fixture policy");
    return value;
}

function project(name: string, group?: string): ProjectContext {
    return {
        dir: `/workspace/${name}`,
        lockKey: `servers/${name}`,
        lockRoot: "/workspace",
        home: "/home",
        manifest: {
            schemaVersion: 1,
            name,
            server: { type: "velocity", version: "4.1.1" },
            plugins: {},
            ...(group ? { backup: { files: ["runtime/**"], group } } : {}),
        },
    };
}

describe("project picker recovery units", () => {
    it("offers complete groups for grouped lifecycle operations", async () => {
        const projects = [
            project("proxy", "network"),
            project("world", "network"),
            project("independent"),
        ];
        prompts.multiselect.mockResolvedValue(["group:network"]);
        const selected = await chooseWorkspaceProjects(
            projects,
            policy("start"),
            "start",
            new AbortController().signal,
        );
        expect(selected).toEqual(projects.slice(0, 2));
        expect(prompts.multiselect.mock.calls[0]?.[0].options).toEqual([
            {
                value: "group:network",
                label: "Group: network",
                hint: "servers/proxy, servers/world",
            },
            {
                value: "project:servers/independent",
                label: "independent",
                hint: "servers/independent",
            },
        ]);
    });

    it("selects one complete backup unit but one individual console target", async () => {
        const projects = [
            project("proxy", "network"),
            project("world", "network"),
        ];
        prompts.select.mockResolvedValue("group:network");
        expect(
            await chooseWorkspaceProjects(
                projects,
                policy("backup list"),
                "backup list",
                new AbortController().signal,
            ),
        ).toEqual(projects);
        prompts.select.mockResolvedValue("project:servers/world");
        expect(
            await chooseWorkspaceProjects(
                projects,
                policy("console"),
                "console",
                new AbortController().signal,
            ),
        ).toEqual([projects[1]]);
    });

    it("rejects empty choices, cancellation and a group for a single-project foreground run", async () => {
        const projects = [
            project("first", "network"),
            project("second", "network"),
        ];
        prompts.multiselect.mockResolvedValue([]);
        await expect(
            chooseWorkspaceProjects(
                projects,
                policy("stop"),
                "stop",
                new AbortController().signal,
            ),
        ).rejects.toMatchObject({ code: "SINGLE_PROJECT" });
        prompts.select.mockResolvedValue(Symbol("cancel"));
        await expect(
            chooseWorkspaceProjects(
                projects,
                policy("console"),
                "console",
                new AbortController().signal,
            ),
        ).rejects.toMatchObject({ code: "CANCELLED" });
        prompts.select.mockResolvedValue("group:network");
        await expect(
            chooseWorkspaceProjects(
                projects,
                policy("run"),
                "run",
                new AbortController().signal,
            ),
        ).rejects.toMatchObject({ code: "SINGLE_PROJECT" });
    });
});
