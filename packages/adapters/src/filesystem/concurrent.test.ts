import { describe, expect, it, vi } from "vitest";
import { mapConcurrentReads } from "./concurrent.js";

describe("concurrent file reads", () => {
    it("bounds active reads and preserves input order across completion order", async () => {
        const gates = Array.from({ length: 7 }, () =>
            Promise.withResolvers<string>(),
        );
        const started: number[] = [];
        let active = 0;
        let peak = 0;
        const result = mapConcurrentReads(gates, async (gate, index) => {
            started.push(index);
            peak = Math.max(peak, ++active);
            const value = await gate.promise;
            active--;
            return value;
        });
        expect(started).toEqual([0, 1, 2, 3]);
        for (const index of [3, 2, 1]) {
            gates[index]?.resolve(`file-${index}`);
            await vi.waitFor(() => expect(started.length).toBe(7 - index + 1));
        }
        for (const index of [6, 5, 4, 0])
            gates[index]?.resolve(`file-${index}`);
        expect(await result).toEqual(gates.map((_, index) => `file-${index}`));
        expect(peak).toBe(4);
        expect(active).toBe(0);
    });

    it("stops scheduling after failure and drains active reads before rejecting", async () => {
        const gates = Array.from({ length: 8 }, () =>
            Promise.withResolvers<void>(),
        );
        const started: number[] = [];
        const finished: number[] = [];
        const settled = vi.fn();
        const result = mapConcurrentReads(gates, async (gate, index) => {
            started.push(index);
            try {
                await gate.promise;
            } finally {
                finished.push(index);
            }
        }).then(settled, (error: unknown) => {
            settled();
            return error;
        });
        const failure = new Error("read failed");
        gates[2]?.reject(failure);
        await vi.waitFor(() => expect(finished).toEqual([2]));
        expect(settled).not.toHaveBeenCalled();
        gates[3]?.resolve();
        await vi.waitFor(() => expect(finished).toEqual([2, 3]));
        expect(started).toEqual([0, 1, 2, 3]);
        expect(settled).not.toHaveBeenCalled();
        gates[0]?.resolve();
        gates[1]?.resolve();
        expect(await result).toBe(failure);
        expect(finished.sort()).toEqual([0, 1, 2, 3]);
        expect(settled).toHaveBeenCalledOnce();
    });

    it("reports the earliest input failure even if it finishes later or is falsy", async () => {
        const gates = Array.from({ length: 4 }, () =>
            Promise.withResolvers<void>(),
        );
        const observed = mapConcurrentReads(gates, (gate) => gate.promise).then(
            () => "unexpected success",
            (error: unknown) => error,
        );
        gates[2]?.reject(new Error("later input"));
        // Let the later input fail first before settling the earlier input.
        await Promise.resolve();
        gates[0]?.reject(undefined);
        gates[1]?.resolve();
        gates[3]?.resolve();
        expect(await observed).toBeUndefined();
    });

    it("handles empty input and synchronous failures without starting more reads", async () => {
        const read = vi.fn();
        expect(await mapConcurrentReads([], read)).toEqual([]);
        expect(read).not.toHaveBeenCalled();
        const failure = new Error("invalid path");
        read.mockImplementation(() => {
            throw failure;
        });
        await expect(mapConcurrentReads([1, 2, 3, 4, 5], read)).rejects.toBe(
            failure,
        );
        expect(read).toHaveBeenCalledOnce();
    });
});
