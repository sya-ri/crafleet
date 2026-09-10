import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    completionShellProcess,
    detectCompletionShell,
    resolveCompletionTarget,
} from "./completion-host.js";

const processMock = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("node:child_process", () => ({
    execFile: (...args: unknown[]) => {
        const callback = args.at(-1) as (
            error: Error | null,
            stdout?: string,
            stderr?: string,
        ) => void;
        Promise.resolve()
            .then(() => processMock.run(...args.slice(0, -1)))
            .then(
                (stdout) => callback(null, stdout, ""),
                (error) => callback(error),
            );
    },
}));
// promisify(execFile) expects the named stdout/stderr result provided by Node.
vi.mock("node:util", async (original) => ({
    ...(await original<typeof import("node:util")>()),
    promisify:
        (fn: (...args: unknown[]) => void) =>
        (...args: unknown[]) =>
            new Promise((resolve, reject) => {
                fn(
                    ...args,
                    (error: Error | null, stdout: string, stderr: string) =>
                        error ? reject(error) : resolve({ stdout, stderr }),
                );
            }),
}));
const platform = Object.getOwnPropertyDescriptor(
    process,
    "platform",
) as PropertyDescriptor;
beforeEach(() => {
    processMock.run.mockReset();
});
afterEach(() => {
    Object.defineProperty(process, "platform", platform);
    vi.restoreAllMocks();
});
const on = (value: string) =>
    Object.defineProperty(process, "platform", { configurable: true, value });

describe("completion shell discovery", () => {
    it.each([
        ["/bin/bash", "bash"],
        ["-zsh", "zsh"],
        ["fish", "fish"],
        ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "powershell"],
        ["powershell.exe", "powershell"],
        ["node", undefined],
    ])("recognizes %s", (executable, shell) => {
        expect(completionShellProcess(executable as string)?.shell).toBe(shell);
    });
    it("walks POSIX ancestors, choosing the closest actual shell", async () => {
        on("linux");
        processMock.run
            .mockResolvedValueOnce(" 98765 node\n")
            .mockResolvedValueOnce(" 1 /bin/zsh\n");
        expect(await detectCompletionShell()).toEqual({
            shell: "zsh",
            executable: "/bin/zsh",
        });
        expect(processMock.run).toHaveBeenCalledTimes(2);
    });
    it.each(["", "bad", ` ${process.ppid} node\n`, " 1 node\n"])(
        "stops on invalid or ended ancestry: %s",
        async (stdout) => {
            on("darwin");
            processMock.run.mockResolvedValue(stdout);
            expect(await detectCompletionShell()).toBeUndefined();
        },
    );
    it("bounds discovery and treats command failures as unknown", async () => {
        on("linux");
        let parent = 90000;
        processMock.run.mockImplementation(() => `${parent--} node\n`);
        expect(await detectCompletionShell()).toBeUndefined();
        expect(processMock.run).toHaveBeenCalledTimes(12);
        processMock.run.mockRejectedValue(new Error("unavailable"));
        expect(await detectCompletionShell()).toBeUndefined();
    });
    it("inspects a bounded Windows process chain without loading profiles", async () => {
        on("win32");
        processMock.run.mockResolvedValue(
            JSON.stringify([
                null,
                "node.exe",
                "C:\\pwsh.exe",
                "powershell.exe",
            ]),
        );
        expect(await detectCompletionShell()).toEqual({
            shell: "powershell",
            executable: "C:\\pwsh.exe",
        });
        expect(processMock.run.mock.calls[0]?.[1]).toContain("-NoProfile");
    });
    it.each(["{}", "[null]", "not JSON"])(
        "handles unavailable Windows discovery: %s",
        async (stdout) => {
            on("win32");
            processMock.run.mockResolvedValue(stdout);
            expect(await detectCompletionShell()).toBeUndefined();
        },
    );
    it("asks the selected PowerShell edition for its real all-hosts profile", async () => {
        const profile = path.resolve("profile.ps1");
        processMock.run.mockResolvedValue(JSON.stringify(profile));
        expect(
            (
                await resolveCompletionTarget(
                    "powershell",
                    path.resolve("home"),
                    { shell: "powershell", executable: "selected-pwsh" },
                )
            ).profiles,
        ).toEqual([profile]);
        expect(processMock.run.mock.calls[0]?.[0]).toBe("selected-pwsh");
        expect(processMock.run.mock.calls[0]?.[1].at(-1)).toContain(
            "$PROFILE.CurrentUserAllHosts | ConvertTo-Json -Compress",
        );
        expect(processMock.run.mock.calls[0]?.[1].at(-1)).toContain(
            "UTF8Encoding",
        );
    });
    it("falls back to Windows PowerShell only when no edition was selected", async () => {
        on("win32");
        processMock.run
            .mockRejectedValueOnce(new Error("missing"))
            .mockResolvedValueOnce(JSON.stringify(path.resolve("profile.ps1")));
        await resolveCompletionTarget("powershell", path.resolve("home"));
        expect(processMock.run.mock.calls.map((call) => call[0])).toEqual([
            "pwsh",
            "powershell.exe",
        ]);
    });
    it.each(["null", '"relative"', "invalid"])(
        "refuses invalid profile paths: %s",
        async (stdout) => {
            on("linux");
            processMock.run.mockResolvedValue(stdout);
            await expect(
                resolveCompletionTarget("powershell", path.resolve("home")),
            ).rejects.toMatchObject({ code: "COMPLETION_SHELL" });
        },
    );
});
