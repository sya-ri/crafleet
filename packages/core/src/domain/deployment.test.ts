import { describe, expect, it, vi } from "vitest";
import {
    assertRuntimeAccess,
    LIVE_CAPTURE_WARNING,
    type RuntimeStatus,
    reportWarning,
} from "./deployment.js";

describe("live operation access", () => {
    it.each(["stopped", "running", "starting", "stopping", "unknown"] as const)(
        "checks %s with and without force",
        (status) => {
            for (const force of [false, true]) {
                const onWarning = vi.fn();
                if (status === "stopped" || (status === "running" && force)) {
                    expect(
                        assertRuntimeAccess(
                            status,
                            { force, onWarning },
                            LIVE_CAPTURE_WARNING,
                        ),
                    ).toBe(status === "running");
                    expect(onWarning).toHaveBeenCalledTimes(
                        status === "running" ? 1 : 0,
                    );
                } else
                    expect(() =>
                        assertRuntimeAccess(
                            status,
                            { force, onWarning },
                            LIVE_CAPTURE_WARNING,
                        ),
                    ).toThrow(expect.objectContaining({ code: "NOT_STOPPED" }));
            }
        },
    );
    it("permits read-only previews in every state and safe saved-only operations while running", () => {
        for (const status of [
            "stopped",
            "running",
            "starting",
            "stopping",
            "unknown",
        ] satisfies RuntimeStatus[])
            expect(() =>
                assertRuntimeAccess(status, { dryRun: true }),
            ).not.toThrow();
        expect(assertRuntimeAccess("running", {}, undefined, true)).toBe(true);
        expect(() => assertRuntimeAccess("running", {})).toThrow(
            expect.objectContaining({
                hint: expect.stringContaining("--force"),
            }),
        );
    });
    it("treats warning observers as display-only", () => {
        expect(() => reportWarning({}, LIVE_CAPTURE_WARNING)).not.toThrow();
        expect(() =>
            reportWarning(
                {
                    onWarning: () => {
                        throw new Error("broken output");
                    },
                },
                LIVE_CAPTURE_WARNING,
            ),
        ).not.toThrow();
    });
});
