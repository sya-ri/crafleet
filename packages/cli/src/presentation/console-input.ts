import { runtimeLimit, validConsoleText } from "@crafleet/adapters";
import type { CommandSuggestion } from "@crafleet/core";
import {
    type Component,
    type Focusable,
    Input,
    Key,
    matchesKey,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalOutput } from "./terminal.js";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export class ConsoleInput implements Component, Focusable {
    focused = false;
    value = "";
    cursor = 0;
    private readonly display = new Input();
    private history: string[];
    private historyIndex: number;
    private draft = "";
    private paste: string | undefined;
    private undo: Array<{ value: string; cursor: number }> = [];
    private killed = "";
    constructor(
        private readonly onSubmit: (value: string) => void,
        history: readonly string[] = [],
        private readonly changed: () => void = () => {},
    ) {
        withSettingsMethods(this, captureRuntimeSettings());
        this.history = [...history];
        this.historyIndex = history.length;
    }
    get pasting(): boolean {
        return this.paste !== undefined;
    }
    clear(): void {
        this.set("", 0);
        this.historyIndex = this.history.length;
        this.draft = "";
    }
    set(value: string, cursor = value.length): void {
        this.value = value;
        this.cursor = Math.min(cursor, value.length);
        this.changed();
    }
    remember(value: string): void {
        if (value.trim() && this.history.at(-1) !== value)
            this.history.push(value);
        this.history = this.history.slice(
            -runtimeLimit("console.maxHistoryEntries"),
        );
        this.historyIndex = this.history.length;
        this.draft = "";
    }
    recall(direction: -1 | 1): void {
        if (this.historyIndex === this.history.length) this.draft = this.value;
        this.historyIndex = Math.max(
            0,
            Math.min(this.history.length, this.historyIndex + direction),
        );
        this.set(this.history[this.historyIndex] ?? this.draft);
    }
    apply(suggestion: CommandSuggestion): void {
        this.replace(suggestion.start, suggestion.end, suggestion.text);
    }
    private replace(start: number, end: number, text: string): void {
        text = sanitizeTerminalOutput(text)
            .replace(/[\r\n\u2028\u2029]/gu, "")
            .replaceAll("\t", "    ");
        if (
            this.value.length - (end - start) + text.length >
            runtimeLimit("console.maxCommandChars")
        )
            return;
        this.undo.push({ value: this.value, cursor: this.cursor });
        this.undo = this.undo.slice(-runtimeLimit("console.maxUndoEntries"));
        this.set(
            this.value.slice(0, start) + text + this.value.slice(end),
            start + text.length,
        );
    }
    private left(): number {
        return (
            [...segmenter.segment(this.value.slice(0, this.cursor))].at(-1)
                ?.index ?? 0
        );
    }
    private right(): number {
        return (
            this.cursor +
            ([...segmenter.segment(this.value.slice(this.cursor))][0]?.segment
                .length ?? 0)
        );
    }
    private wordLeft(): number {
        const prefix = this.value.slice(0, this.cursor);
        let start = prefix.trimEnd().length;
        if (start === 0) return prefix.length;
        while (start > 0 && /\S/u.test(prefix[start - 1] ?? "")) start--;
        return start;
    }
    private wordRight(): number {
        return (
            this.cursor +
            (/^\s*\S+\s*/u.exec(this.value.slice(this.cursor))?.[0].length ?? 0)
        );
    }
    handleInput(data: string): void {
        if (this.paste !== undefined) {
            this.paste += data;
            const end = this.paste.indexOf("\x1b[201~");
            if (end < 0) {
                if (this.paste.length > runtimeLimit("console.maxPasteChars"))
                    this.paste = this.paste.slice(
                        -runtimeLimit("console.maxPasteChars"),
                    );
                return;
            }
            const content = this.paste.slice(0, end);
            const rest = this.paste.slice(end + 6);
            this.paste = undefined;
            this.replace(this.cursor, this.cursor, content);
            if (rest) this.handleInput(rest);
            return;
        }
        const start = data.indexOf("\x1b[200~");
        if (start >= 0) {
            if (start) this.handleInput(data.slice(0, start));
            this.paste = "";
            this.handleInput(data.slice(start + 6));
            return;
        }
        const key = (name: Parameters<typeof matchesKey>[1]) =>
            matchesKey(data, name);
        if (key(Key.enter) || data === "\n") {
            this.onSubmit(this.value);
            return;
        }
        if (key(Key.up)) {
            this.recall(-1);
            return;
        }
        if (key(Key.down)) {
            this.recall(1);
            return;
        }
        if (key(Key.left) || key(Key.ctrl("b"))) this.cursor = this.left();
        else if (key(Key.right) || key(Key.ctrl("f")))
            this.cursor = this.right();
        else if (key(Key.ctrl("a")) || key(Key.home)) this.cursor = 0;
        else if (key(Key.ctrl("e")) || key(Key.end))
            this.cursor = this.value.length;
        else if (key(Key.alt("b")) || key(Key.ctrl("left")))
            this.cursor = this.wordLeft();
        else if (key(Key.alt("f")) || key(Key.ctrl("right")))
            this.cursor = this.wordRight();
        else if (key(Key.backspace)) {
            this.replace(this.left(), this.cursor, "");
            return;
        } else if (key(Key.delete) || key(Key.ctrl("d"))) {
            this.replace(this.cursor, this.right(), "");
            return;
        } else if (
            key(Key.ctrl("u")) ||
            key(Key.ctrl("w")) ||
            key(Key.alt("backspace"))
        ) {
            const from = key(Key.ctrl("u")) ? 0 : this.wordLeft();
            this.killed = this.value.slice(from, this.cursor);
            this.replace(from, this.cursor, "");
            return;
        } else if (key(Key.ctrl("k")) || key(Key.alt("d"))) {
            const end = key(Key.ctrl("k"))
                ? this.value.length
                : this.wordRight();
            this.killed = this.value.slice(this.cursor, end);
            this.replace(this.cursor, end, "");
            return;
        } else if (key(Key.ctrl("y"))) {
            this.replace(this.cursor, this.cursor, this.killed);
            return;
        } else if (data === "\x1f") {
            const previous = this.undo.pop();
            if (previous) this.set(previous.value, previous.cursor);
            return;
        } else if (validConsoleText(data)) {
            this.replace(this.cursor, this.cursor, data);
            return;
        } else return;
        this.changed();
    }
    invalidate(): void {}
    render(width: number): string[] {
        // Only public Input methods: our model owns the cursor, editing and history.
        this.display.focused = this.focused;
        this.display.setValue(this.value);
        this.display.handleInput("\x05");
        for (const _ of segmenter.segment(this.value.slice(this.cursor)))
            this.display.handleInput("\x1b[D");
        return this.display.render(Math.max(1, width));
    }
}

import {
    captureRuntimeSettings,
    withSettingsMethods,
} from "@crafleet/adapters";
