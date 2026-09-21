import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
    initProject,
    initWorkspace,
    loadProject,
    NodeArtifactStore,
    readRuntimeIntent,
    workspaceProjects,
    writeYaml,
} from "@crafleet/adapters";
import { CrafleetError, parseSource } from "@crafleet/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../packages/cli/src/application.js";

const prompts = vi.hoisted(() => ({ choose: vi.fn() }));
const access = vi.hoisted(() => ({ denied: "" }));
vi.mock("node:fs/promises", async (original) => {
    const actual = await original<typeof import("node:fs/promises")>();
    return {
        ...actual,
        readdir: (...args: Parameters<typeof actual.readdir>) => {
            if (String(args[0]) === access.denied)
                return Promise.reject(
                    Object.assign(new Error("Fixture access denied"), {
                        code: "EACCES",
                    }),
                );
            return actual.readdir(...args);
        },
    };
});
vi.mock("../../packages/cli/src/presentation/project-picker.js", () => ({
    chooseWorkspaceProjects: prompts.choose,
}));
const entry = pathToFileURL(path.resolve("packages/cli/dist/cli.mjs")).href;
const parent = await fs.realpath(tmpdir());
const originalExit = process.exitCode;
const inputTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const errorTty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
let root: string;
let stdout: string;
let stderr: string;

beforeEach(async () => {
    access.denied = "";
    root = await fs.mkdtemp(path.join(parent, "crafleet-selection-"));
    await initWorkspace(root, ["servers/*"]);
    for (const name of ["alpha", "beta"])
        await initProject(path.join(root, "servers", name), {
            name,
            kind: "velocity",
            version: "4.1.1",
        });
    vi.stubEnv("CRAFLEET_HOME", path.join(root, ".home"));
    vi.stubEnv("CI", "false");
    prompts.choose.mockReset();
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        stdout += String(chunk);
        return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        stderr += String(chunk);
        return true;
    });
});
afterEach(async () => {
    access.denied = "";
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = originalExit;
    for (const [stream, descriptor] of [
        [process.stdin, inputTty],
        [process.stderr, errorTty],
    ] as const) {
        if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
        else Reflect.deleteProperty(stream, "isTTY");
    }
    if (
        path.dirname(root) !== parent ||
        !path.basename(root).startsWith("crafleet-selection-")
    )
        throw new Error("Unsafe fixture path");
    await fs.rm(root, { recursive: true, force: true });
});

async function execute(args: string[], json = true, cwd = root) {
    stdout = "";
    stderr = "";
    process.exitCode = 0;
    await runCli(
        ["-C", cwd, "--offline", ...(json ? ["--json"] : []), ...args],
        entry,
    );
    return {
        stdout,
        stderr,
        code: Number(process.exitCode),
        reply: json ? JSON.parse(stdout) : undefined,
    };
}

async function declarePlugins(name: string) {
    const directory = path.join(root, "servers", name);
    const { manifest } = await loadProject(directory, path.join(root, ".home"));
    await writeYaml(path.join(directory, "crafleet.yaml"), {
        ...manifest,
        plugins: { One: "modrinth:one", LongerName: "modrinth:longer-name" },
    });
}

describe("workspace command selection", () => {
    it.each(["status", "plugins", "server", "validate"])(
        "reads all workspace members with %s without prompting",
        async (command) => {
            const result = await execute([command]);
            expect(result.code).toBe(0);
            expect(result.reply.result).toHaveLength(2);
            expect(prompts.choose).not.toHaveBeenCalled();
        },
    );

    it.each([
        ["validate", "Validated 2 projects."],
        ["workspace list", "2 workspace projects:"],
        ["status", "Status for 2 servers."],
        ["server", "PROJECT"],
        ["deploy plan", "Deployment preview for 2 projects:"],
    ])("groups human %s results", async (command, summary) => {
        const result = await execute(command.split(" "), false);
        expect(result.code).toBe(0);
        expect(result.stdout.split(summary)).toHaveLength(2);
        if (command !== "deploy plan")
            expect(result.stdout.match(/^PROJECT\s+/gm)).toHaveLength(1);
        expect(result.stdout.indexOf("alpha")).toBeLessThan(
            result.stdout.indexOf("beta"),
        );
        expect(result.stderr).toContain(`${command}: Completed`);
    });

    it.each([false, true])(
        "groups all plugin rows per project (latest=%s)",
        async (latest) => {
            await declarePlugins("alpha");
            await declarePlugins("beta");
            vi.spyOn(NodeArtifactStore.prototype, "latest").mockImplementation(
                async (input) => ({
                    source: parseSource(input),
                    version: "2.0",
                }),
            );
            const args = ["plugins", ...(latest ? ["--latest"] : [])];
            const result = await execute(args, false);
            expect(result.code).toBe(0);
            expect(result.stdout.match(/^Project: alpha$/gm)).toHaveLength(1);
            expect(result.stdout.match(/^Project: beta$/gm)).toHaveLength(1);
            expect(result.stdout.match(/^NAME\s+/gm)).toHaveLength(2);
            expect(result.stdout.match(/^One\s+modrinth/gm)).toHaveLength(2);
            expect(
                result.stdout.match(/^LongerName\s+modrinth/gm),
            ).toHaveLength(2);
            expect(result.stdout).toContain("\n\nProject: beta\n");
            const rows = result.stdout
                .split("\n")
                .filter((line) => /^(One|LongerName)\s/u.test(line));
            expect(
                new Set(rows.map((row) => row.indexOf("modrinth"))).size,
            ).toBe(1);
            if (latest) expect(result.stdout.match(/LATEST/g)).toHaveLength(2);
            const json = await execute(args);
            expect(
                json.reply.result.map(
                    (project: { plugins: { name: string }[] }) =>
                        project.plugins.map((plugin) => plugin.name),
                ),
            ).toEqual([
                ["One", "LongerName"],
                ["One", "LongerName"],
            ]);
        },
    );

    it("totals update checks across projects and keeps empty and filtered lists readable", async () => {
        await declarePlugins("alpha");
        vi.spyOn(NodeArtifactStore.prototype, "latest").mockImplementation(
            async (input) => ({ source: parseSource(input), version: "2.0" }),
        );
        const empty = await execute(["plugins"], false);
        expect(empty.stdout.match(/^Project: /gm)).toHaveLength(2);
        expect(empty.stdout).toContain(
            "Project: beta\nPlugins: none declared.",
        );
        const filtered = await execute(["plugins", "--filter", "alpha"], false);
        expect(filtered.stdout.match(/^Project: /gm)).toHaveLength(1);
        expect(filtered.stdout).not.toContain("beta");
        await declarePlugins("beta");
        const checked = await execute(["plugins", "check"], false);
        expect(checked.code).toBe(0);
        expect(checked.stdout.match(/4 updates available\./g)).toHaveLength(1);
        expect(checked.stdout.match(/^Project: /gm)).toHaveLength(2);
        expect(checked.stdout.match(/^NAME\s+/gm)).toHaveLength(2);
        expect(checked.stdout).toContain("\n\nProject: beta\n");
    });

    it.each(
        ["--latest", "check"].flatMap((mode) =>
            [false, true].map((json) => ({ mode, json })),
        ),
    )(
        "retains completed plugin rows after a failure ($mode, json=$json)",
        async ({ mode, json }) => {
            await declarePlugins("alpha");
            await declarePlugins("beta");
            let calls = 0;
            vi.spyOn(NodeArtifactStore.prototype, "latest").mockImplementation(
                async (input) => {
                    if (++calls === 4)
                        throw new CrafleetError(
                            "TEST_PROVIDER",
                            "Provider unavailable.",
                            3,
                        );
                    return { source: parseSource(input), version: "2.0" };
                },
            );
            const result = await execute(["plugins", mode], json);
            expect(result.code).toBe(3);
            if (json) {
                expect(result.reply).toEqual({
                    ok: false,
                    error: {
                        code: "TEST_PROVIDER",
                        message: "Provider unavailable.",
                    },
                });
                expect(result.stderr).toBe("");
            } else {
                expect(result.stdout.match(/Partial results:/g)).toHaveLength(
                    1,
                );
                expect(result.stdout.match(/^Project: /gm)).toHaveLength(2);
                expect(result.stdout.match(/^NAME\s+/gm)).toHaveLength(2);
                expect(result.stdout.match(/^One\s+/gm)).toHaveLength(2);
                expect(result.stdout.match(/^LongerName\s+/gm)).toHaveLength(1);
                expect(result.stderr).toContain("Error [TEST_PROVIDER]");
                expect(result.stderr).toContain("Finished with errors");
            }
        },
    );

    it.each([
        "start",
        "restart",
        "stop",
        "install",
        "backup create",
        "config capture",
        "logs",
        "console",
        "supervise",
    ])("requires an explicit JSON target for %s", async (command) => {
        const result = await execute([...command.split(" "), "--dry-run"]);
        expect(result.code).toBe(2);
        expect(result.reply.error.code).toBe("INPUT_REQUIRED");
        expect(prompts.choose).not.toHaveBeenCalled();
        expect(
            await readRuntimeIntent(path.join(root, "servers/alpha")),
        ).toBeUndefined();
    });

    it("preserves explicit filters and project-relative runtime commands", async () => {
        const filtered = await execute(["status", "--filter", "beta"]);
        expect(
            filtered.reply.result.map(
                (row: { project: string }) => row.project,
            ),
        ).toEqual(["beta"]);
        expect(
            (
                await execute(
                    ["status"],
                    true,
                    path.join(root, "servers/alpha/runtime"),
                )
            ).reply.result.status,
        ).toBe("stopped");
        await fs.writeFile(
            path.join(root, "servers/alpha/crafleet.yaml"),
            "invalid: [\n",
        );
        expect(
            (await execute(["stop"], true, path.join(root, "servers/alpha")))
                .code,
        ).toBe(0);
    });

    it("stops only the interactively selected project", async () => {
        Object.defineProperty(process.stdin, "isTTY", {
            configurable: true,
            value: true,
        });
        Object.defineProperty(process.stderr, "isTTY", {
            configurable: true,
            value: true,
        });
        prompts.choose.mockImplementation((projects) =>
            projects.filter(
                (project: { manifest: { name: string } }) =>
                    project.manifest.name === "beta",
            ),
        );
        const result = await execute(["stop"], false);
        expect(result.code, result.stderr).toBe(0);
        expect(prompts.choose).toHaveBeenCalledOnce();
        expect(
            await readRuntimeIntent(path.join(root, "servers/alpha")),
        ).toBeUndefined();
        expect(
            await readRuntimeIntent(path.join(root, "servers/beta")),
        ).toMatchObject({ desired: "stopped" });
    });

    it.each(["CI", "yes", "cancel"])(
        "does not operate after %s prevents selection",
        async (boundary) => {
            Object.defineProperty(process.stdin, "isTTY", {
                configurable: true,
                value: true,
            });
            Object.defineProperty(process.stderr, "isTTY", {
                configurable: true,
                value: true,
            });
            if (boundary === "CI") vi.stubEnv("CI", "true");
            if (boundary === "cancel")
                prompts.choose.mockRejectedValue(
                    new CrafleetError("CANCELLED", "Selection cancelled.", 130),
                );
            const result = await execute(
                ["stop", ...(boundary === "yes" ? ["--yes"] : [])],
                false,
            );
            expect(result.code).toBe(boundary === "cancel" ? 130 : 2);
            expect(
                await readRuntimeIntent(path.join(root, "servers/alpha")),
            ).toBeUndefined();
            expect(
                await readRuntimeIntent(path.join(root, "servers/beta")),
            ).toBeUndefined();
        },
    );
});

describe("declared workspace traversal", () => {
    it("includes an explicitly declared workspace-root project", async () => {
        await initProject(root, {
            name: "root",
            kind: "velocity",
            version: "4.1.1",
        });
        await writeYaml(path.join(root, "crafleet-workspace.yaml"), {
            schemaVersion: 1,
            projects: [".", "servers/*"],
        });
        expect(await workspaceProjects(root)).toEqual([
            root,
            path.join(root, "servers/alpha"),
            path.join(root, "servers/beta"),
        ]);
    });

    it("refuses static glob bases that traverse a symbolic link", async () => {
        await fs.symlink(
            path.join(root, "servers"),
            path.join(root, "linked"),
            process.platform === "win32" ? "junction" : "dir",
        );
        await writeYaml(path.join(root, "crafleet-workspace.yaml"), {
            schemaVersion: 1,
            projects: ["linked/*"],
        });
        await expect(workspaceProjects(root)).rejects.toMatchObject({
            code: "SYMLINK_UNSAFE",
        });
    });

    it("refuses brace-expanded traversal outside the workspace", async () => {
        await writeYaml(path.join(root, "crafleet-workspace.yaml"), {
            schemaVersion: 1,
            projects: ["{../outside,servers}/*"],
        });
        await expect(workspaceProjects(root)).rejects.toMatchObject({
            code: "WORKSPACE_PATH",
        });
    });

    it("ignores explicit internal-data roots and preserves negative-project semantics", async () => {
        await initProject(path.join(root, "servers/alpha/child"), {
            name: "child",
            kind: "velocity",
            version: "4.1.1",
        });
        await writeYaml(path.join(root, "crafleet-workspace.yaml"), {
            schemaVersion: 1,
            projects: [
                "servers/**",
                "servers/alpha/runtime",
                "!servers/alpha",
                ".services/*",
            ],
        });
        await fs.mkdir(
            path.join(
                root,
                ".services/deep",
                ...Array<string>(15).fill("level"),
            ),
            { recursive: true },
        );
        expect(await workspaceProjects(root)).toEqual([
            path.join(root, "servers/alpha/child"),
            path.join(root, "servers/beta"),
        ]);
    });

    it("does not read unrelated data or descendants below a matched one-level project", async () => {
        const data = path.join(
            root,
            "postgres",
            ...Array<string>(16).fill("nested"),
        );
        const child = path.join(
            root,
            "servers/alpha",
            ...Array<string>(16).fill("nested"),
        );
        await fs.mkdir(data, { recursive: true });
        await fs.mkdir(child, { recursive: true });
        expect(await workspaceProjects(root)).toEqual([
            path.join(root, "servers/alpha"),
            path.join(root, "servers/beta"),
        ]);
    });

    it("supports braces, static members, recursive includes and subtree exclusions", async () => {
        await writeYaml(path.join(root, "crafleet-workspace.yaml"), {
            schemaVersion: 1,
            projects: [
                "{servers,proxies}/*",
                "nested/**",
                "!nested/retired/**",
            ],
        });
        await initProject(path.join(root, "proxies/main"), {
            name: "proxy",
            kind: "velocity",
            version: "4.1.1",
        });
        await initProject(path.join(root, "nested/valid/deep"), {
            name: "deep",
            kind: "velocity",
            version: "4.1.1",
        });
        await fs.mkdir(
            path.join(
                root,
                "nested/retired",
                ...Array<string>(16).fill("nested"),
            ),
            { recursive: true },
        );
        expect(await workspaceProjects(root)).toHaveLength(4);
        await writeYaml(path.join(root, "crafleet-workspace.yaml"), {
            schemaVersion: 1,
            projects: ["servers/alpha"],
        });
        expect(await workspaceProjects(root)).toEqual([
            path.join(root, "servers/alpha"),
        ]);
    });

    it("reports excessive depth inside a declared recursive subtree", async () => {
        await writeYaml(path.join(root, "crafleet-workspace.yaml"), {
            schemaVersion: 1,
            projects: ["nested/**"],
        });
        await fs.mkdir(
            path.join(root, "nested", ...Array<string>(14).fill("level")),
            { recursive: true },
        );
        await expect(workspaceProjects(root)).rejects.toMatchObject({
            code: "WORKSPACE_DEPTH",
        });
    });

    it("does not suppress permission errors inside a selected subtree", async () => {
        access.denied = path.join(root, "servers");
        await expect(workspaceProjects(root)).rejects.toMatchObject({
            code: "WORKSPACE_ACCESS",
        });
    });
});
