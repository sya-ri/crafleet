import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandProgress } from "./progress.js";

const displays = vi.hoisted(() => ({
    spinner: vi.fn(),
    progress: vi.fn(),
    instances: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
}));
vi.mock("@clack/prompts", () => ({
    spinner: displays.spinner,
    progress: displays.progress,
}));
let output: NodeJS.WriteStream;
let text: string;
let reporter: CommandProgress;
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    text = "";
    output = new Writable({
        write(chunk, _encoding, done) {
            text += String(chunk);
            done();
        },
    }) as NodeJS.WriteStream;
    displays.instances.length = 0;
    const create = (bar = false) => {
        const instance = {
            start: vi.fn(),
            message: vi.fn(),
            clear: vi.fn(),
            ...(bar ? { advance: vi.fn() } : {}),
        };
        displays.instances.push(instance);
        return instance;
    };
    displays.spinner.mockReset().mockImplementation(() => create());
    displays.progress.mockReset().mockImplementation(() => create(true));
});
afterEach(() => {
    reporter?.finish("complete");
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

describe("command progress presentation", () => {
    it("prints immediately, throttles redirected output, and retains completed steps", () => {
        reporter = new CommandProgress("install", output, false);
        expect(text).toBe("install: Starting\n");
        reporter.report({
            id: "download",
            message: "Downloading",
            target: "alpha",
            state: "start",
            unit: "bytes",
            completed: 0,
            total: 2048,
        });
        expect(text).toContain("alpha: Downloading 0 B / 2.0 KiB (0s)");
        for (let completed = 1; completed <= 100; completed++)
            reporter.report({
                id: "download",
                message: "Downloading",
                state: "update",
                unit: "bytes",
                completed,
                total: 2048,
            });
        expect(text.split("\n")).toHaveLength(3);
        vi.advanceTimersByTime(10_000);
        expect(text).toContain("100 B / 2.0 KiB (10s)");
        reporter.report({
            id: "download",
            message: "Downloaded",
            state: "complete",
            unit: "bytes",
            completed: 2048,
            total: 2048,
        });
        expect(text).toContain("Done: Downloaded 2.0 KiB / 2.0 KiB (10s)");
        vi.advanceTimersByTime(10_000);
        expect(text).toContain("1 steps completed");
        expect(text).not.toContain("\u001b");
    });

    it("updates a byte gauge and falls back to unknown-size and item progress", () => {
        reporter = new CommandProgress("install", output, true);
        reporter.report({
            id: "download",
            message: "Downloading",
            state: "start",
            unit: "bytes",
            completed: 0,
            total: 3 * 1024 * 1024,
        });
        const bar = displays.instances.at(-1);
        expect(displays.progress).toHaveBeenCalledWith(
            expect.objectContaining({ max: 3 * 1024 * 1024, size: 20 }),
        );
        reporter.report({
            id: "download",
            message: "Downloading",
            state: "update",
            unit: "bytes",
            completed: 1024 * 1024,
            total: 3 * 1024 * 1024,
        });
        expect(bar?.advance).toHaveBeenLastCalledWith(
            1024 * 1024,
            expect.stringContaining("1.0 MiB / 3.0 MiB"),
        );
        reporter.report({
            id: "download",
            message: "Downloading",
            state: "update",
            unit: "bytes",
            total: 3 * 1024 * 1024,
        });
        expect(bar?.advance).toHaveBeenLastCalledWith(0, expect.any(String));
        reporter.report({
            id: "unknown",
            message: "Downloading",
            state: "start",
            unit: "bytes",
            completed: 1024,
        });
        expect(displays.instances.at(-1)?.message).toHaveBeenLastCalledWith(
            expect.stringContaining("1.0 KiB"),
        );
        reporter.report({
            id: "unknown",
            message: "Downloaded",
            state: "complete",
        });
        reporter.report({
            id: "items",
            message: "Checking",
            state: "start",
            unit: "items",
            completed: 1,
            total: 2,
        });
        expect(displays.instances.at(-1)?.message).toHaveBeenLastCalledWith(
            expect.stringContaining("1/2"),
        );
        reporter.report({
            id: "items",
            message: "Checking",
            state: "update",
            completed: 2,
        });
        vi.advanceTimersByTime(1000);
        expect(displays.instances.at(-1)?.message).toHaveBeenLastCalledWith(
            expect.stringContaining("(1s)"),
        );
    });

    it("preserves independent active work, pauses for output, and resumes with the elapsed time", () => {
        reporter = new CommandProgress("status", output, true);
        reporter.report({ id: "a", message: "Alpha", state: "start" });
        reporter.report({ id: "b", message: "Beta", state: "start" });
        reporter.pause();
        reporter.pause();
        const calls = displays.spinner.mock.calls.length;
        reporter.report({
            id: "during-prompt",
            message: "Deferred message",
            state: "complete",
        });
        expect(text).not.toContain("Deferred message");
        vi.advanceTimersByTime(15_000);
        reporter.resume();
        expect(displays.spinner).toHaveBeenCalledTimes(calls);
        reporter.resume();
        expect(text).toContain("Deferred message");
        expect(displays.instances.at(-1)?.start).toHaveBeenLastCalledWith(
            expect.stringContaining("Beta (15s)"),
        );
        reporter.report({ id: "b", message: "Beta", state: "failed" });
        expect(text).toContain("Failed: Beta");
        expect(displays.instances.at(-1)?.message).toHaveBeenLastCalledWith(
            expect.stringContaining("Alpha (15s)"),
        );
    });

    it.each(["complete", "failed", "cancelled"] as const)(
        "cleans up %s without printing late events",
        (state) => {
            reporter = new CommandProgress("check", output, false);
            reporter.report({ id: "x", message: "Checking", state: "update" });
            reporter.finish(state);
            const before = text;
            reporter.finish(state);
            reporter.report({ id: "x", message: "late", state: "complete" });
            vi.advanceTimersByTime(20_000);
            expect(text).toBe(before);
            if (state !== "complete") expect(text).not.toContain(": Completed");
        },
    );

    it("sanitizes targets and tolerates broken output and UI", () => {
        reporter = new CommandProgress("install", output, true);
        reporter.report({
            id: "bad",
            message: "unsafe\u001b[2J",
            target: "x\n\u0007",
            state: "complete",
        });
        expect(text).not.toContain("\u001b");
        expect(text).not.toContain("\u0007");
        reporter.finish("failed");
        vi.spyOn(output, "write").mockImplementation(() => {
            throw new Error("broken pipe");
        });
        displays.spinner.mockImplementation(() => {
            throw new Error("broken UI");
        });
        expect(() => {
            reporter = new CommandProgress("install", output, true);
            reporter.finish("failed");
        }).not.toThrow();
    });

    it("uses plain output for dumb terminals and CI", () => {
        Object.defineProperty(output, "isTTY", { value: true });
        vi.stubEnv("TERM", "dumb");
        reporter = new CommandProgress("status", output);
        vi.advanceTimersByTime(10_000);
        expect(displays.spinner).not.toHaveBeenCalled();
        expect(text).toContain("Processing (10s)");
    });
});
