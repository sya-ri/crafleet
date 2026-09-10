import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type CompletionShell, CrafleetError } from "@crafleet/core";
import { exists } from "./io.js";

const exec = promisify(execFile);
const processOptions = { windowsHide: true, timeout: 3000, maxBuffer: 65536 };
const utf8Output =
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ";

export interface CompletionShellProcess {
    shell: CompletionShell;
    executable: string;
}

export function completionShellProcess(
    executable: string,
): CompletionShellProcess | undefined {
    const name = executable
        .replaceAll("\\", "/")
        .split("/")
        .at(-1)
        ?.toLowerCase()
        ?.replace(/^-|\.exe$/gu, "");
    const shell =
        name === "pwsh" || name === "powershell" ? "powershell" : name;
    if (
        shell === "bash" ||
        shell === "zsh" ||
        shell === "fish" ||
        shell === "powershell"
    )
        return { shell, executable };
    return undefined;
}

/** Only inspect a bounded ancestor chain. Never start an interactive shell or read its profile. */
export async function detectCompletionShell(): Promise<
    CompletionShellProcess | undefined
> {
    try {
        if (process.platform === "win32") {
            const script = `$crafleetParent = ${process.ppid}; $crafleetRows = @(for ($i = 0; $i -lt 12 -and $crafleetParent -gt 0; $i++) { $p = Get-CimInstance Win32_Process -Filter "ProcessId = $crafleetParent"; if (!$p) { break }; if ($p.ExecutablePath) { [string]$p.ExecutablePath } else { [string]$p.Name }; $crafleetParent = $p.ParentProcessId }); ConvertTo-Json -Compress -InputObject $crafleetRows`;
            const { stdout } = await exec(
                "powershell.exe",
                [
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    utf8Output + script,
                ],
                processOptions,
            );
            const rows: unknown = JSON.parse(stdout);
            if (!Array.isArray(rows)) return undefined;
            for (const row of rows) {
                const detected =
                    typeof row === "string"
                        ? completionShellProcess(row)
                        : undefined;
                if (detected) return detected;
            }
        } else {
            let pid = process.ppid;
            const deadline = Date.now() + 3000;
            for (
                let depth = 0;
                depth < 12 && pid > 1 && Date.now() < deadline;
                depth++
            ) {
                const { stdout } = await exec(
                    "ps",
                    ["-p", String(pid), "-o", "ppid=", "-o", "comm="],
                    {
                        ...processOptions,
                        timeout: Math.max(1, deadline - Date.now()),
                    },
                );
                const row = /^\s*(\d+)\s+(.+?)\s*$/u.exec(stdout);
                if (!row) break;
                const detected = completionShellProcess(row[2] ?? "");
                if (detected) return detected;
                const parent = Number(row[1]);
                if (parent === pid) break;
                pid = parent;
            }
        }
    } catch {
        /* Unknown is preferable to guessing from the login-shell environment. */
    }
    return undefined;
}

export interface CompletionTarget {
    shell: CompletionShell;
    scriptPath: string;
    profiles: string[];
}

export async function resolveCompletionTarget(
    shell: CompletionShell,
    home: string,
    detected?: CompletionShellProcess,
    environment: { userHome: string; env: NodeJS.ProcessEnv } = {
        userHome: homedir(),
        env: process.env,
    },
): Promise<CompletionTarget> {
    const { userHome, env } = environment;
    const scriptPath = path.join(
        home,
        "completions",
        `crafleet.${shell === "powershell" ? "ps1" : shell}`,
    );
    if (shell === "fish")
        return {
            shell,
            scriptPath: path.resolve(
                env.XDG_CONFIG_HOME || path.join(userHome, ".config"),
                "fish/completions/crafleet.fish",
            ),
            profiles: [],
        };
    if (shell === "zsh")
        return {
            shell,
            scriptPath,
            profiles: [path.resolve(env.ZDOTDIR || userHome, ".zshrc")],
        };
    if (shell === "bash") {
        let login = path.join(userHome, ".bash_profile");
        for (const name of [".bash_profile", ".bash_login", ".profile"]) {
            const candidate = path.join(userHome, name);
            if (await exists(candidate)) {
                login = candidate;
                break;
            }
        }
        return {
            shell,
            scriptPath,
            profiles: [path.join(userHome, ".bashrc"), login],
        };
    }
    const executables =
        detected?.shell === "powershell"
            ? [detected.executable]
            : [
                  "pwsh",
                  ...(process.platform === "win32" ? ["powershell.exe"] : []),
              ];
    for (const executable of executables) {
        try {
            const { stdout } = await exec(
                executable,
                [
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    `${utf8Output}$PROFILE.CurrentUserAllHosts | ConvertTo-Json -Compress`,
                ],
                processOptions,
            );
            const profile: unknown = JSON.parse(stdout);
            if (typeof profile === "string" && path.isAbsolute(profile))
                return { shell, scriptPath, profiles: [profile] };
        } catch {
            /* Try the other installed PowerShell edition when none was selected. */
        }
    }
    throw new CrafleetError(
        "COMPLETION_SHELL",
        "The PowerShell profile path could not be determined.",
        2,
        "Run this command from the PowerShell edition you want to configure, or use crafleet completion powershell for manual setup.",
    );
}
