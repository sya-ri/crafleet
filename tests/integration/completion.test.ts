import { createHash } from "node:crypto";
import {
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    realpath,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
    completePaths,
    initProject,
    initWorkspace,
    writeYaml,
} from "@crafleet/adapters";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCli, runCli } from "../../packages/cli/src/application.js";
import {
    bashWords,
    completionCandidates,
} from "../../packages/cli/src/commands/completion.js";

const parent = await realpath(tmpdir());
const entry = pathToFileURL(path.resolve("packages/cli/dist/cli.mjs")).href;
const originalExit = process.exitCode;
let root: string;
let home: string;
let alpha: string;

beforeEach(async () => {
    root = await mkdtemp(path.join(parent, "crafleet-completion-"));
    home = path.join(root, ".home");
    alpha = path.join(root, "servers", "alpha");
    await initWorkspace(root, ["servers/*"]);
    for (const name of ["alpha", "beta"]) {
        const directory = path.join(root, "servers", name);
        const manifest = await initProject(directory, {
            name,
            kind: "velocity",
            version: "4.1.1",
        });
        await writeYaml(path.join(directory, "crafleet.yaml"), {
            ...manifest,
            plugins: {
                [name === "alpha" ? "Tools" : "Utility"]: "modrinth:example",
            },
        });
    }
    await mkdir(path.join(root, "world backups"));
    await writeFile(path.join(root, "Map Tools.jar"), "fixture");
    await writeFile(path.join(root, "Read Me.txt"), "fixture");
    await writeFile(path.join(root, ".hidden.jar"), "fixture");
    vi.stubEnv("CRAFLEET_HOME", home);
    vi.stubEnv("CI", "true");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
        new Error("Network use is forbidden in completion"),
    );
});
afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = originalExit;
    if (
        path.dirname(root) !== parent ||
        !path.basename(root).startsWith("crafleet-completion-")
    )
        throw new Error("Unsafe fixture path");
    await rm(root, { recursive: true, force: true });
});

const complete = (words: string[], cwd = root) =>
    completionCandidates(createCli(entry).program, words, cwd, home);

async function fingerprint(directory: string): Promise<unknown[]> {
    const result: unknown[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        result.push([
            entry.name,
            entry.isDirectory()
                ? await fingerprint(file)
                : createHash("sha256")
                      .update(await readFile(file))
                      .digest("hex"),
        ]);
    }
    return result;
}

describe("offline command completion", () => {
    it("completes commands, inherited flags and declared choices from the real command tree", async () => {
        expect(await complete(["statu"])).toEqual(["status"]);
        expect(await complete(["plugins", "up"])).toEqual(["update"]);
        expect(await complete(["status", "--f"])).toEqual(["--filter"]);
        expect(await complete(["plugins", "update", "--"])).toContain("--to");
        expect(await complete(["init", "--type", "v"])).toEqual(["velocity"]);
        expect(await complete(["init", "--type=v"])).toEqual([
            "--type=velocity",
        ]);
        expect(
            await complete(["files", "resolve", "ops.json", "--use", ""]),
        ).toEqual(["base", "runtime"]);
        expect(await complete(["completion", "p"])).toEqual(["powershell"]);
        expect(await complete(["tools", "prepare", "r"])).toEqual(["restic"]);
        expect(await complete([""])).not.toContain("__complete");
        expect(await complete(["logs", "-n100", "--f"])).toContain("--follow");
        expect(await complete(["--bogus", ""])).toEqual([]);
    });

    it("uses workspace project names and scoped plugin names without prompting", async () => {
        expect(await complete(["status", "--filter", "a"])).toEqual(["alpha"]);
        expect(await complete(["status", "--filter=servers/a"])).toEqual([
            "--filter=servers/alpha",
        ]);
        expect(await complete(["plugins", "remove", ""])).toEqual([
            "Tools",
            "Utility",
        ]);
        expect(
            await complete(["--filter", "alpha", "plugins", "update", ""]),
        ).toEqual(["Tools"]);
        expect(await complete(["plugins", "check", ""], alpha)).toEqual([
            "Tools",
        ]);
        expect(await complete(["plugins", "check", "Tools", "U"])).toEqual([
            "Utility",
        ]);
        expect(await complete(["-C", alpha, "plugins", "remove", ""])).toEqual([
            "Tools",
        ]);
        expect(await complete(["-r", "plugins", "remove", ""], alpha)).toEqual([
            "Tools",
            "Utility",
        ]);
    });

    it("completes only relevant paths and handles spaces and file sources literally", async () => {
        expect(await complete(["-C", "world"])).toEqual(["world backups/"]);
        expect(await complete(["-Cworld"])).toEqual(["-Cworld backups/"]);
        expect(await complete(["plugins", "inspect", "M"])).toEqual([
            "Map Tools.jar",
        ]);
        expect(await complete(["plugins", "inspect", "R"])).toEqual([]);
        expect(await complete(["init", "--source", "file:M"])).toEqual([
            "file:Map Tools.jar",
        ]);
        expect(await complete(["plugins", "add", "file:M"])).toEqual([
            "file:Map Tools.jar",
        ]);
        expect(await complete(["plugins", "add", "mod"])).toEqual([
            "modrinth:",
        ]);
        expect(await complete(["import", "world"])).toEqual(["world backups/"]);
        expect(
            await complete(["backup", "restore", "snapshot", "--to", "world"]),
        ).toEqual(["world backups/"]);
        expect(
            await complete([
                "backup",
                "apply",
                "restore",
                "--map",
                "extra=world",
            ]),
        ).toEqual(["extra=world backups/"]);
        expect(
            await complete(["backup", "apply", "restore", "--map", "extra"]),
        ).toEqual([]);
        expect(
            await complete(["backup", "setup", "--password-file", "R"]),
        ).toEqual(["Read Me.txt"]);
        expect(await complete(["plugins", "inspect", "."])).toEqual([
            ".hidden.jar",
        ]);
        expect(await complete(["plugins", "inspect", "missing/"])).toEqual([]);
        expect(await complete(["plugins", "inspect", "Read Me.txt/"])).toEqual(
            [],
        );
    });

    it("never treats words after -- as options or subcommands", async () => {
        expect(await complete(["plugins", "remove", "--", "T"])).toEqual([
            "Tools",
        ]);
        expect(await complete(["plugins", "remove", "--", "--f"])).toEqual([]);
        expect(await complete(["--", "statu"])).toEqual([]);
    });

    it("uses runtime and managed paths for config commands and the source directory for imported JARs", async () => {
        await mkdir(path.join(alpha, "runtime"), { recursive: true });
        await mkdir(path.join(alpha, "files"), { recursive: true });
        await writeFile(
            path.join(alpha, "runtime", "server.properties"),
            "motd=Fixture",
        );
        await writeFile(path.join(alpha, "runtime", "untracked.json"), "{}");
        await writeFile(
            path.join(alpha, "files", "server.properties"),
            "motd=Template",
        );
        await writeFile(
            path.join(root, "world backups", "Inside.jar"),
            "fixture",
        );
        expect(await complete(["files", "track", "serv"], alpha)).toEqual([
            "server.properties",
        ]);
        expect(
            await complete(["--filter", "alpha", "files", "untrack", "serv"]),
        ).toEqual(["server.properties"]);
        expect(
            await complete(["files", "capture", "untracked"], alpha),
        ).toEqual([]);
        expect(await complete(["files", "resolve", "serv"], alpha)).toEqual([
            "server.properties",
        ]);
        expect(
            await complete(["import", "world backups", "--server-jar", "In"]),
        ).toEqual(["Inside.jar"]);
        expect(
            await complete([
                "backup",
                "apply",
                "restored",
                "--map",
                "extra=Read",
            ]),
        ).toEqual(["extra=Read Me.txt"]);
        expect(await complete(["plugins", "add", "Map"])).toEqual([
            "Map Tools.jar",
        ]);
        expect(await complete(["plugins", "add", "spi"])).toEqual([
            "spigotmc:",
        ]);
    });

    it("preserves the declaration, runtime and home byte-for-byte without network activity", async () => {
        const before = await fingerprint(root);
        for (const words of [
            ["plugins", "remove", ""],
            ["status", "--filter", ""],
            ["plugins", "add", "file:M"],
            ["backup", "apply", ""],
        ])
            await complete(words);
        expect(await fingerprint(root)).toEqual(before);
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(await readdir(root)).not.toContain(".home");
    });

    it("refuses ambiguous, corrupt or out-of-scope project metadata instead of writing or crawling unrelated trees", async () => {
        await mkdir(path.join(root, "database", "deep"), { recursive: true });
        await writeFile(
            path.join(root, "database", "crafleet.yaml"),
            "invalid: [",
        );
        expect(await complete(["--filter", ""])).toEqual([
            "alpha",
            "beta",
            "servers/alpha",
            "servers/beta",
        ]);
        await writeFile(path.join(alpha, "crafleet.yaml"), "invalid: [");
        await expect(complete(["--filter", ""])).rejects.toThrow();
        expect(await complete(["plugins", "--la"])).toEqual(["--latest"]);
    });

    it("bounds requests and omits control characters without evaluating names", async () => {
        await expect(complete(Array(129).fill(""))).rejects.toMatchObject({
            code: "COMPLETION_INPUT",
        });
        await expect(complete(["x".repeat(65537)])).rejects.toMatchObject({
            code: "COMPLETION_INPUT",
        });
        expect(await complete(["plugins", "inspect", "\n"])).toEqual([]);
        expect(
            await complete(["plugins", "inspect", "x".repeat(4097)]),
        ).toEqual([]);
        await writeFile(path.join(root, "literal; echo unsafe.jar"), "fixture");
        expect(await complete(["plugins", "inspect", "literal"])).toEqual([
            "literal; echo unsafe.jar",
        ]);
        expect(
            await complete(["plugins", "inspect", "$(echo injected)"]),
        ).toEqual([]);
        expect(
            await complete(["statu"], path.join(root, "world backups")),
        ).toEqual(["status"]);
    });

    it("normalizes Bash word breaks without changing the replacement prefix", () => {
        expect(bashWords(["status", "--filter", "=", "al"])).toEqual({
            words: ["status", "--filter=al"],
            trim: 9,
        });
        expect(bashWords(["plugins", "add", "file", ":", "M"])).toEqual({
            words: ["plugins", "add", "file:M"],
            trim: 5,
        });
        expect(bashWords(["plugins", "add", "file", ":"])).toEqual({
            words: ["plugins", "add", "file:"],
            trim: 4,
        });
        expect(bashWords(["--filter=alpha", "plugins", ""])).toEqual({
            words: ["--filter=alpha", "plugins", ""],
            trim: 0,
        });
    });

    it("returns one JSON result or raw shell script with no extra output", async () => {
        let stdout = "";
        let stderr = "";
        vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
            stdout += String(chunk);
            return true;
        });
        vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
            stderr += String(chunk);
            return true;
        });
        await runCli(
            [
                "-C",
                root,
                "__complete",
                "--json",
                "--shell",
                "bash",
                "--",
                "status",
                "--filter",
                "=",
                "al",
            ],
            entry,
        );
        expect(JSON.parse(stdout)).toEqual({ ok: true, result: ["alpha"] });
        for (const shell of ["bash", "zsh", "fish", "powershell"]) {
            stdout = "";
            await runCli(["completion", shell, "--json"], entry);
            const json = JSON.parse(stdout);
            expect(json.ok).toBe(true);
            expect(json.result).toContain(`crafleet completion ${shell}`);
            stdout = "";
            await runCli(["completion", shell], entry);
            expect(stdout).toBe(`${json.result}\n`);
        }
        expect(stderr).toBe("");
    });

    it("lists one explicit directory and distinguishes files from directories", async () => {
        expect(await completePaths(root, "world", "file")).toEqual([
            "world backups/",
        ]);
        expect(await completePaths(root, "Read Me.txt", "directory")).toEqual(
            [],
        );
    });
});
