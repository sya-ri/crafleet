import { execFile } from "node:child_process";
import {
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    stat,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
    applyCompletionSetup,
    type CompletionTarget,
    planCompletionSetup,
    resolveCompletionTarget,
} from "@crafleet/adapters";
import { COMPLETION_SHELLS } from "@crafleet/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as io from "../../packages/adapters/src/filesystem/io.js";
import { COMPLETION_SCRIPTS } from "../../packages/cli/src/presentation/completion.js";

const parent = await realpath(tmpdir());
let root: string;
beforeEach(async () => {
    root = await mkdtemp(path.join(parent, "crafleet-setup-"));
});
afterEach(async () => {
    vi.restoreAllMocks();
    if (
        path.dirname(root) !== parent ||
        !path.basename(root).startsWith("crafleet-setup-")
    )
        throw new Error("Unsafe fixture path");
    await rm(root, { recursive: true, force: true });
});

async function target(
    shell: CompletionTarget["shell"],
): Promise<CompletionTarget> {
    const userHome = path.join(root, "user 日本語 ' space");
    await mkdir(userHome, { recursive: true });
    return shell === "powershell"
        ? {
              shell,
              scriptPath: path.join(userHome, "crafleet.ps1"),
              profiles: [path.join(userHome, "profile.ps1")],
          }
        : resolveCompletionTarget(
              shell,
              path.join(userHome, ".crafleet"),
              undefined,
              { userHome, env: {} },
          );
}

describe("persistent completion setup", () => {
    it("reports write failures and detects changes between individual writes", async () => {
        const location = await target("bash");
        const plan = await planCompletionSetup(
            location,
            COMPLETION_SCRIPTS.bash,
        );
        const create = io.atomicCreate;
        const mocked = vi
            .spyOn(io, "atomicCreate")
            .mockRejectedValueOnce(new Error("Permission denied"));
        await expect(applyCompletionSetup(plan)).rejects.toMatchObject({
            code: "COMPLETION_WRITE",
        });
        mocked.mockImplementationOnce(async (...args) => {
            await create(...args);
            await writeFile(
                location.profiles[0] as string,
                "# edited during installation\n",
            );
        });
        await expect(applyCompletionSetup(plan)).rejects.toMatchObject({
            code: "COMPLETION_CHANGED",
        });
        expect(await readFile(location.profiles[0] as string, "utf8")).toBe(
            "# edited during installation\n",
        );
    });
    it.runIf(process.platform === "win32").each(["pwsh", "powershell.exe"])(
        "loads the installed profile in a clean %s native completion engine",
        async (executable) => {
            const location = await target("powershell");
            await applyCompletionSetup(
                await planCompletionSetup(
                    location,
                    COMPLETION_SCRIPTS.powershell,
                ),
            );
            const bin = path.join(root, "bin");
            await mkdir(bin);
            await writeFile(
                path.join(bin, "crafleet.ps1"),
                "Write-Output 'status'\n",
            );
            const psQuote = (value: string) =>
                `'${value.replaceAll("'", "''")}'`;
            const command = `$ErrorActionPreference = 'Stop'; . ${psQuote(location.profiles[0] as string)}; [System.Management.Automation.CommandCompletion]::CompleteInput('crafleet statu', 14, $null).CompletionMatches.CompletionText | ConvertTo-Json -Compress`;
            const { stdout } = await promisify(execFile)(
                executable,
                [
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    command,
                ],
                {
                    windowsHide: true,
                    timeout: 15000,
                    env: {
                        ...process.env,
                        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
                    },
                },
            );
            expect(JSON.parse(stdout)).toBe("status");
        },
    );
    it.each(COMPLETION_SHELLS)(
        "installs, verifies, updates and does not rewrite unchanged %s settings",
        async (shell) => {
            const location = await target(shell);
            const script = COMPLETION_SCRIPTS[shell];
            for (const profile of location.profiles)
                await writeFile(profile, "# My profile\nCUSTOM=preserved\n");
            const plan = await planCompletionSetup(location, script);
            expect(plan.diagnostic.status).toBe("warn");
            await expect(stat(location.scriptPath)).rejects.toMatchObject({
                code: "ENOENT",
            });
            expect(JSON.stringify(plan)).not.toContain("CUSTOM=preserved");
            await applyCompletionSetup(plan);
            const checked = await planCompletionSetup(location, script);
            expect(checked.diagnostic.status).toBe("pass");
            expect(
                checked.files.every((file) => file.action === "unchanged"),
            ).toBe(true);
            const before = await stat(location.scriptPath);
            await applyCompletionSetup(checked);
            expect((await stat(location.scriptPath)).mtimeMs).toBe(
                before.mtimeMs,
            );
            for (const profile of location.profiles)
                expect(await readFile(profile, "utf8")).toMatch(
                    /^# My profile\nCUSTOM=preserved\n/u,
                );
            const updated = await planCompletionSetup(
                location,
                `${script}# New release\n`,
            );
            expect(updated.files[0]?.action).toBe("update");
            await applyCompletionSetup(updated);
            expect(
                (
                    await planCompletionSetup(
                        location,
                        `${script}# New release\n`,
                    )
                ).diagnostic.status,
            ).toBe("pass");
            await rm(location.scriptPath);
            expect(
                (await planCompletionSetup(location, script)).diagnostic.status,
            ).toBe("warn");
        },
    );

    it.each(["utf8", "utf8-bom", "utf16le", "utf16be"])(
        "preserves %s, CRLF and text outside the managed block",
        async (encoding) => {
            const location = await target("powershell");
            const profile = location.profiles[0] as string;
            const text = "# 日本語\r\n$custom = 'retained'";
            const encode = (value: string) =>
                encoding === "utf8"
                    ? Buffer.from(value)
                    : encoding === "utf8-bom"
                      ? Buffer.concat([
                            Buffer.from([239, 187, 191]),
                            Buffer.from(value),
                        ])
                      : Buffer.concat([
                            Buffer.from(
                                encoding === "utf16le"
                                    ? [255, 254]
                                    : [254, 255],
                            ),
                            encoding === "utf16le"
                                ? Buffer.from(value, "utf16le")
                                : Buffer.from(value, "utf16le").swap16(),
                        ]);
            const original = encode(text);
            await writeFile(profile, original);
            await applyCompletionSetup(
                await planCompletionSetup(
                    location,
                    COMPLETION_SCRIPTS.powershell,
                ),
            );
            expect(
                (await readFile(profile)).subarray(0, original.length),
            ).toEqual(original);
            const nextLocation = {
                ...location,
                scriptPath: path.join(
                    path.dirname(location.scriptPath),
                    "next.ps1",
                ),
            };
            await applyCompletionSetup(
                await planCompletionSetup(
                    nextLocation,
                    COMPLETION_SCRIPTS.powershell,
                ),
            );
            expect(
                (await readFile(profile)).subarray(0, original.length),
            ).toEqual(original);
            expect(
                (
                    await planCompletionSetup(
                        nextLocation,
                        COMPLETION_SCRIPTS.powershell,
                    )
                ).files.every((file) => file.action === "unchanged"),
            ).toBe(true);
        },
    );

    it.each([
        "source <(crafleet completion bash)\n",
        ". '/custom/crafleet-completion.ps1'\n",
        "# >>> crafleet completion >>>\n",
        "# <<< crafleet completion <<<\n# >>> crafleet completion >>>\n",
        "# >>> crafleet completion >>>\nchanged\n# <<< crafleet completion <<<\n",
        "# >>> crafleet completion >>>\n# >>> crafleet completion >>>\n",
        " # >>> crafleet completion >>>\n",
    ])(
        "refuses custom or malformed profile settings without any writes: %s",
        async (contents) => {
            const location = await target("bash");
            await writeFile(location.profiles[0] as string, contents);
            const plan = await planCompletionSetup(
                location,
                COMPLETION_SCRIPTS.bash,
            );
            expect(plan.diagnostic.status).toBe("unknown");
            await expect(applyCompletionSetup(plan)).rejects.toMatchObject({
                code: "COMPLETION_CONFIG",
            });
            await expect(stat(location.scriptPath)).rejects.toMatchObject({
                code: "ENOENT",
            });
            expect(await readFile(location.profiles[0] as string, "utf8")).toBe(
                contents,
            );
        },
    );

    it("refuses a manually edited script, including a generated but unmanaged script", async () => {
        const location = await target("fish");
        await mkdir(path.dirname(location.scriptPath), { recursive: true });
        await writeFile(location.scriptPath, COMPLETION_SCRIPTS.fish);
        expect(
            (await planCompletionSetup(location, COMPLETION_SCRIPTS.fish))
                .canApply,
        ).toBe(false);
        await rm(location.scriptPath);
        await applyCompletionSetup(
            await planCompletionSetup(location, COMPLETION_SCRIPTS.fish),
        );
        await writeFile(
            location.scriptPath,
            `${await readFile(location.scriptPath, "utf8")}# custom\n`,
        );
        expect(
            (await planCompletionSetup(location, COMPLETION_SCRIPTS.fish))
                .diagnostic.status,
        ).toBe("unknown");
    });

    it.each([
        Buffer.from([0xff]),
        Buffer.from([255, 254, 1]),
        Buffer.from("a\0b"),
        Buffer.alloc(1024 * 1024 + 1, 65),
    ])("retains unreadable encodings and oversized files", async (bytes) => {
        const location = await target("zsh");
        await writeFile(location.profiles[0] as string, bytes);
        const plan = await planCompletionSetup(
            location,
            COMPLETION_SCRIPTS.zsh,
        );
        expect(plan.canApply).toBe(false);
        expect(await readFile(location.profiles[0] as string)).toEqual(bytes);
    });

    it.each(["create", "edit", "delete"])(
        "detects %s after confirmation planning before writing any file",
        async (action) => {
            const location = await target("bash");
            const profile = location.profiles[1] as string;
            if (action !== "create") await writeFile(profile, "# original\n");
            const plan = await planCompletionSetup(
                location,
                COMPLETION_SCRIPTS.bash,
            );
            if (action === "delete") await rm(profile);
            else await writeFile(profile, "# changed\n");
            await expect(applyCompletionSetup(plan)).rejects.toMatchObject({
                code: "COMPLETION_CHANGED",
            });
            await expect(stat(location.scriptPath)).rejects.toMatchObject({
                code: "ENOENT",
            });
        },
    );

    it("refuses symlinked settings and reports invalid paths", async () => {
        const location = await target("bash");
        const other = path.join(root, "other");
        await mkdir(other);
        const link = path.join(root, "link");
        await symlink(other, link, "junction");
        const plan = await planCompletionSetup(
            { ...location, scriptPath: path.join(link, "file") },
            "# test\n",
        );
        expect(plan.canApply).toBe(false);
        expect(
            (
                await planCompletionSetup(
                    { ...location, scriptPath: "relative" },
                    "# test\n",
                )
            ).canApply,
        ).toBe(false);
        const abort = new AbortController();
        abort.abort();
        await expect(
            applyCompletionSetup(
                await planCompletionSetup(location, "# test\n"),
                abort.signal,
            ),
        ).rejects.toMatchObject({ name: "AbortError" });
    });

    it("respects login-file precedence, ZDOTDIR and XDG_CONFIG_HOME", async () => {
        const env = {
            ZDOTDIR: path.join(root, "zsh"),
            XDG_CONFIG_HOME: path.join(root, "xdg"),
        };
        const options = { userHome: root, env };
        await writeFile(path.join(root, ".profile"), "# keep\n");
        expect(
            (await resolveCompletionTarget("bash", root, undefined, options))
                .profiles[1],
        ).toBe(path.join(root, ".profile"));
        await writeFile(path.join(root, ".bash_login"), "# preferred\n");
        expect(
            (await resolveCompletionTarget("bash", root, undefined, options))
                .profiles[1],
        ).toBe(path.join(root, ".bash_login"));
        expect(
            (await resolveCompletionTarget("zsh", root, undefined, options))
                .profiles,
        ).toEqual([path.join(env.ZDOTDIR, ".zshrc")]);
        expect(
            (await resolveCompletionTarget("fish", root, undefined, options))
                .scriptPath,
        ).toBe(
            path.join(env.XDG_CONFIG_HOME, "fish/completions/crafleet.fish"),
        );
    });
});
