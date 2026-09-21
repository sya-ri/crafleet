import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertPrivateFile } from "./private.js";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), stat: vi.fn() }));
vi.mock("node:child_process", async () => {
    const { promisify } = await import("node:util");
    return {
        execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.execute }),
    };
});
vi.mock("node:fs/promises", async (original) => ({
    ...(await original<typeof import("node:fs/promises")>()),
    lstat: mocks.stat,
}));
vi.mock("./io.js", () => ({
    assertNoSymlinks: vi.fn().mockResolvedValue(undefined),
}));

const platform = Object.getOwnPropertyDescriptor(
    process,
    "platform",
) as PropertyDescriptor;
const file = path.resolve("private-file");
const stats = {
    dev: 1,
    ino: 1,
    size: 7,
    nlink: 1,
    uid: process.getuid?.() ?? 1000,
    mode: 0o600,
    isFile: () => true,
    isSymbolicLink: () => false,
};
beforeEach(() => {
    Object.defineProperty(process, "platform", {
        ...platform,
        value: "darwin",
    });
    mocks.execute.mockReset();
    mocks.stat.mockReset().mockResolvedValue(stats);
});
afterEach(() => {
    Object.defineProperty(process, "platform", platform);
});

describe("macOS private file ACL inspection", () => {
    it.each([
        "-rw------- 1 owner group 7 Sep 21 12:00 private-file\n",
        "\n".repeat(60_000),
        `${" \n".repeat(30_000)}123x\n`,
        "-rw------- 1 owner group 7 Sep 21 12:00 file 0: name\n",
    ])("accepts output without ACL entries in case %#", async (stdout) => {
        mocks.execute.mockResolvedValue({ stdout });
        await expect(assertPrivateFile(file)).resolves.toBeUndefined();
        expect(mocks.execute).toHaveBeenCalledWith(
            "/bin/ls",
            ["-lde", file],
            expect.objectContaining({
                timeout: 15000,
                maxBuffer: 64 * 1024,
                env: expect.objectContaining({ LC_ALL: "C" }),
            }),
        );
        expect(mocks.stat).toHaveBeenCalledTimes(2);
    });
    it.each(["\n", "\r", "\r\n", "\u2028", "\u2029"])(
        "refuses ACL entries after %j line endings",
        async (newline) => {
            mocks.execute.mockResolvedValue({
                stdout: `-rw-------+ private-file${newline} \t${newline}\u00a0 12: group:everyone allow read${newline}`,
            });
            await expect(assertPrivateFile(file)).rejects.toMatchObject({
                code: "PRIVATE_FILE",
            });
        },
    );
    it("fails closed if ls fails or the file changes during inspection", async () => {
        mocks.execute.mockRejectedValueOnce(new Error("unreadable"));
        await expect(assertPrivateFile(file)).rejects.toMatchObject({
            code: "PRIVATE_FILE",
        });
        mocks.execute.mockResolvedValue({
            stdout: "-rw------- private-file\n",
        });
        mocks.stat
            .mockResolvedValueOnce(stats)
            .mockResolvedValueOnce({ ...stats, ino: 2 });
        await expect(assertPrivateFile(file)).rejects.toMatchObject({
            code: "PRIVATE_FILE",
        });
    });
});
