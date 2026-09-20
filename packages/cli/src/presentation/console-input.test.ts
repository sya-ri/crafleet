import { describe, expect, it, vi } from "vitest";
import { ConsoleInput } from "./console-input.js";

describe("console input", () => {
    it("recalls history without execution and restores the draft", () => {
        const send = vi.fn();
        const input = new ConsoleInput(send, ["list", "say hi"]);
        input.handleInput("draft");
        input.handleInput("\x1b[A");
        expect(input.value).toBe("say hi");
        input.handleInput("\x1b[A");
        expect(input.value).toBe("list");
        input.handleInput("\x1b[B");
        input.handleInput("\x1b[B");
        expect(input.value).toBe("draft");
        expect(send).not.toHaveBeenCalled();
        input.handleInput("\r");
        expect(send).toHaveBeenCalledWith("draft");
    });
    it("replaces text at the cursor while preserving the suffix", () => {
        const input = new ConsoleInput(vi.fn());
        input.set("say he tail", 6);
        input.apply({ start: 4, end: 6, text: "hello" });
        expect(input.value).toBe("say hello tail");
        expect(input.cursor).toBe(9);
        input.handleInput("\x7f");
        expect(input.value).toBe("say hell tail");
    });
    it("handles graphemes, word movement, kill/yank, undo, and safe paste", () => {
        const input = new ConsoleInput(vi.fn());
        input.handleInput("a😀");
        input.handleInput("\x7f");
        expect(input.value).toBe("a");
        input.handleInput("\x1f");
        expect(input.value).toBe("a😀");
        input.set("one two");
        input.handleInput("\x17");
        expect(input.value).toBe("one ");
        input.handleInput("\x19");
        expect(input.value).toBe("one two");
        input.clear();
        input.handleInput("\x1b[200~say\nhello\t");
        expect(input.pasting).toBe(true);
        input.handleInput("world\x1b[201~");
        expect(input.value).toBe("sayhello    world");
        expect(input.pasting).toBe(false);
        input.handleInput("\x01");
        expect(input.cursor).toBe(0);
        input.handleInput("\x1b[3~");
        expect(input.value).toBe("ayhello    world");
        expect(input.render(30).join("")).toContain("yhello");
    });
    it("keeps remembered history bounded and skips consecutive duplicates", () => {
        const input = new ConsoleInput(vi.fn());
        input.remember("list");
        input.remember("list");
        input.set("draft");
        input.recall(-1);
        input.recall(-1);
        expect(input.value).toBe("list");
        input.recall(1);
        expect(input.value).toBe("draft");
    });
});
