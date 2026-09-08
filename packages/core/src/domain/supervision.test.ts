import { describe, expect, it } from "vitest";
import { reserveAutomaticStart } from "./supervision.js";

describe("automatic restart budget", () => {
    it("reserves the next start while keeping failed launches stopped", () => {
        expect(
            reserveAutomaticStart(
                {
                    schemaVersion: 1,
                    desired: "running",
                    attempts: [1, 400_000],
                },
                500_000,
            ),
        ).toEqual({
            schemaVersion: 1,
            desired: "stopped",
            attempts: [400_000, 500_000],
        });
    });
    it("refuses a sixth attempt in five minutes, including across supervisor restarts", () => {
        expect(() =>
            reserveAutomaticStart(
                {
                    schemaVersion: 1,
                    desired: "running",
                    attempts: [1, 2, 3, 4, 5],
                },
                6,
            ),
        ).toThrowError(/limit reached/);
    });
});
