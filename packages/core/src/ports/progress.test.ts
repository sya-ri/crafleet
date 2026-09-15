import { describe, expect, it, vi } from "vitest";
import { progressScope, progressStep, reportProgress } from "./progress.js";

describe("display-only progress", () => {
    it("emits start before waiting, completion after success and the original result", async () => {
        const observer = vi.fn();
        const gate = Promise.withResolvers<number>();
        const running = progressStep(
            observer,
            "install",
            "Preparing",
            () => gate.promise,
        );
        expect(observer.mock.calls).toEqual([
            [{ id: "install", message: "Preparing", state: "start" }],
        ]);
        gate.resolve(42);
        expect(await running).toBe(42);
        expect(observer).toHaveBeenLastCalledWith({
            id: "install",
            message: "Preparing",
            state: "complete",
        });
    });

    it("preserves operation errors and ignores observer errors", async () => {
        const error = new Error("operation failed");
        const observer = vi.fn();
        await expect(
            progressStep(observer, "stop", "Stopping", async () => {
                throw error;
            }),
        ).rejects.toBe(error);
        expect(observer).toHaveBeenLastCalledWith({
            id: "stop",
            message: "Stopping",
            state: "failed",
        });
        const broken = () => {
            throw new Error("display failed");
        };
        expect(
            await progressStep(broken, "save", "Saving", async () => true),
        ).toBe(true);
        expect(
            await progressStep(undefined, "save", "Saving", async () => 7),
        ).toBe(7);
        reportProgress(undefined, {
            id: "test",
            message: "Test",
            state: "update",
        });
    });

    it("keeps nested and concurrent scopes distinct without requiring an observer", () => {
        const observer = vi.fn();
        const event = {
            id: "read",
            message: "Reading",
            state: "start" as const,
        };
        progressScope(observer, "alpha")(event);
        progressScope(observer, "beta")({ ...event, target: "server" });
        expect(
            observer.mock.calls.map(([item]) => [item.id, item.target]),
        ).toEqual([
            ["alpha/read", "alpha"],
            ["beta/read", "beta / server"],
        ]);
        expect(progressScope(undefined, "alpha")).toBeUndefined();
    });
});
