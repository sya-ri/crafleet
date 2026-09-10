import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
    chmod,
    mkdir,
    mkdtemp,
    realpath,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const shells = process.argv.slice(2);
if (!shells.length)
    shells.push(
        ...(process.platform === "win32"
            ? ["powershell"]
            : ["bash", "zsh", "fish", "powershell"]),
    );
assert(
    shells.every((shell) =>
        ["bash", "zsh", "fish", "powershell"].includes(shell),
    ),
    "Unknown shell",
);
const parent = await realpath(tmpdir());
const root = await mkdtemp(path.join(parent, "crafleet-shells-"));
const cli = path.resolve(
    import.meta.dirname,
    "../../packages/cli/dist/cli.mjs",
);
const probe = path.join(import.meta.dirname, "shell-completion.py");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;
const cases = [
    "crafleet statu",
    "crafleet plugins updat",
    "crafleet status --fil",
    "crafleet status --filter alph",
    "crafleet init --type velo",
    "crafleet plugins remove Too",
    "crafleet plugins inspect Map",
    "crafleet -C world",
    "crafleet status --filter=alph",
    "crafleet plugins add file:Map",
];

try {
    // JSON is a YAML subset. These generic fixtures need no network, Java, cache,
    // configured host credentials or platform-specific development dependencies.
    await writeFile(
        path.join(root, "crafleet-workspace.yaml"),
        JSON.stringify({ schemaVersion: 1, projects: ["servers/*"] }),
    );
    const project = path.join(root, "servers/alpha");
    await mkdir(project, { recursive: true });
    await writeFile(
        path.join(project, "crafleet.yaml"),
        JSON.stringify({
            schemaVersion: 1,
            name: "alpha",
            server: { type: "velocity", version: "4.1.1" },
            plugins: { Tools: "modrinth:example" },
        }),
    );
    await mkdir(path.join(root, "world backups"));
    await writeFile(path.join(root, "Map Tools.jar"), "fixture");
    const bin = path.join(root, ".bin");
    await mkdir(bin);
    const env = {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        CRAFLEET_HOME: path.join(root, ".home"),
        TERM: "xterm",
    };
    await writeFile(
        path.join(bin, "crafleet"),
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`,
    );
    await chmod(path.join(bin, "crafleet"), 0o755);
    // npm installs a PowerShell wrapper; flags must survive that extra hop.
    await writeFile(
        path.join(bin, "crafleet.ps1"),
        `& ${psQuote(process.execPath)} ${psQuote(cli)} @args\n`,
    );
    await writeFile(path.join(root, "cases.json"), JSON.stringify(cases));
    for (const shell of shells) {
        const { stdout } = await exec(
            process.execPath,
            [cli, "completion", shell],
            { cwd: root, env, windowsHide: true },
        );
        await writeFile(
            path.join(
                root,
                `completion.${shell === "powershell" ? "ps1" : shell}`,
            ),
            stdout,
        );
    }
    const insecureCompletions = path.join(root, ".insecure-completions");
    await mkdir(insecureCompletions);
    await chmod(insecureCompletions, 0o777);
    await writeFile(
        path.join(insecureCompletions, "_untrusted_fixture"),
        "#compdef never-run-fixture\nreturn 1\n",
    );
    for (const shell of shells.filter((shell) => shell !== "powershell")) {
        const setups = {
            bash: `source ${quote(path.join(root, "completion.bash"))}\nPS1='CF> '\n_crafleet_probe() { printf '\\n__RESULT__%s__END__\\n' "$READLINE_LINE"; }\nbind -x '"\\C-o":_crafleet_probe'\n`,
            zsh: `fpath=(${quote(insecureCompletions)} $fpath)\nautoload -Uz compinit\ncompinit -i -D\nsource ${quote(path.join(root, "completion.zsh"))}\nPROMPT='CF> '\n_crafleet_probe() { printf '\\n__RESULT__%s__END__\\n' "$BUFFER"; zle redisplay; }\nzle -N _crafleet_probe\nbindkey '^O' _crafleet_probe\n`,
            fish: `source ${quote(path.join(root, "completion.fish"))}\nfunction fish_prompt; printf 'CF> '; end\nfunction __crafleet_probe; printf '\\n__RESULT__%s__END__\\n' (commandline); commandline -f repaint; end\nbind \\co __crafleet_probe\n`,
        };
        for (const mode of [
            "manual",
            "installed",
            ...(shell === "bash" ? ["login"] : []),
        ]) {
            const startup = mode !== "manual";
            const userHome = path.join(root, `.startup-${shell}`);
            const startupEnv = {
                ...env,
                HOME: userHome,
                ZDOTDIR: userHome,
                XDG_CONFIG_HOME: path.join(userHome, ".config"),
            };
            if (startup) {
                await mkdir(userHome, { recursive: true });
                const installed = await exec(
                    process.execPath,
                    [cli, "completion", "install", shell, "--yes", "--json"],
                    { cwd: root, env: startupEnv, timeout: 30000 },
                );
                assert.equal(
                    JSON.parse(installed.stdout).result.diagnostic.status,
                    "pass",
                );
            }
            const setup = path.join(root, `setup.${shell}-${mode}`);
            // Keep just the editor probe widgets when testing normal startup loading.
            const widgets = setups[shell].slice(
                setups[shell].indexOf(
                    shell === "bash"
                        ? "PS1="
                        : shell === "zsh"
                          ? "PROMPT="
                          : "function fish_prompt",
                ),
            );
            // /etc/profile resets PATH in Bash login shells. Restore the fixture
            // executable directory after startup without loading any completion.
            await writeFile(
                setup,
                startup
                    ? `${shell === "bash" ? `export PATH=${quote(bin)}:$PATH\n` : ""}${widgets}`
                    : setups[shell],
            );
            const result = await exec(
                "python3",
                [
                    probe,
                    "--shell",
                    shell,
                    "--setup",
                    setup,
                    "--cwd",
                    root,
                    "--cases",
                    path.join(root, "cases.json"),
                    ...(startup ? ["--startup"] : []),
                    ...(mode === "login" ? ["--login"] : []),
                ],
                {
                    cwd: root,
                    env: startup ? startupEnv : env,
                    timeout: 180000,
                    maxBuffer: 2 * 1024 * 1024,
                },
            );
            const completed = JSON.parse(result.stdout).map((value) =>
                value.trim(),
            );
            assert.deepEqual(completed.slice(0, 6), [
                "crafleet status",
                "crafleet plugins update",
                "crafleet status --filter",
                "crafleet status --filter alpha",
                "crafleet init --type velocity",
                "crafleet plugins remove Tools",
            ]);
            assert.match(completed[6], /Map(?:\\ | )Tools\.jar/u);
            assert.match(completed[7], /world(?:\\ | )backups\//u);
            assert.equal(completed[8], "crafleet status --filter=alpha");
            assert.match(completed[9], /file:Map(?:\\ | )Tools\.jar/u);
            console.log(
                `Verified ${shell} ${mode} using real tab completion (${cases.length} cases).`,
            );
        }
    }
    if (shells.includes("powershell")) {
        const script = path.join(root, "probe.ps1");
        await writeFile(
            script,
            `
$ErrorActionPreference = 'Stop'
. ${psQuote(path.join(root, "completion.ps1"))}
$cases = Get-Content -Raw -LiteralPath ${psQuote(path.join(root, "cases.json"))} | ConvertFrom-Json
$result = foreach ($line in $cases) {
    $matches = [System.Management.Automation.CommandCompletion]::CompleteInput($line, $line.Length, $null).CompletionMatches
    @($matches | ForEach-Object { $_.CompletionText }) -join '|'
}
ConvertTo-Json -Compress -InputObject @($result)
`,
        );
        const result = await exec(
            "pwsh",
            ["-NoLogo", "-NoProfile", "-File", script],
            { cwd: root, env, windowsHide: true, timeout: 60000 },
        );
        assert.deepEqual(JSON.parse(result.stdout), [
            "status",
            "update",
            "--filter",
            "alpha",
            "velocity",
            "Tools",
            "'Map Tools.jar'",
            "'world backups/'",
            "--filter=alpha",
            "'file:Map Tools.jar'",
        ]);
        console.log(
            `Verified PowerShell using its native completion engine (${cases.length} cases).`,
        );
    }
} finally {
    assert.equal(path.dirname(root), parent);
    assert(path.basename(root).startsWith("crafleet-shells-"));
    await rm(root, { recursive: true, force: true });
}
