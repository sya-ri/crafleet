import {
    type CommandCompletionRequest,
    type CommandSuggestion,
    validSuggestions,
} from "@crafleet/core";
import {
    type Component,
    Key,
    matchesKey,
    ScrollView,
    type ScrollViewScrollToOptions,
    type Terminal,
    TuiAltScreen,
    truncateToWidth,
    VStack,
} from "@earendil-works/pi-tui";
import { ConsoleInput } from "./console-input.js";
import { ConsoleTerminal } from "./console-terminal.js";
import { ConsoleTranscript, normalizeLogText } from "./console-transcript.js";
import { runtimeLogColorsEnabled } from "./log-format.js";
import { sanitizeInlineTerminalOutput } from "./terminal.js";

const EMPTY_HISTORY_PAGE_LIMIT = 8;
const LIVE_COMPACT_LINES = 2000;
const LIVE_COMPACT_BYTES = 4 * 1024 * 1024;

export interface ConsoleLogSnapshot<Cursor, Checkpoint> {
    text: string;
    older: Cursor | null;
    follow: Checkpoint;
}

export type ConsoleOlderPage<Cursor> =
    | { kind: "page"; text: string; older: Cursor | null }
    | { kind: "stale" };

export type ConsoleLogEvent =
    | { kind: "append"; text: string; lineCount?: number }
    | { kind: "reset" };

export interface InteractiveConsoleOptions<Cursor, Checkpoint> {
    loadRecent(): Promise<ConsoleLogSnapshot<Cursor, Checkpoint>>;
    loadOlder(cursor: Cursor): Promise<ConsoleOlderPage<Cursor>>;
    follow(
        checkpoint: Checkpoint,
        signal: AbortSignal,
    ): AsyncIterable<ConsoleLogEvent>;
    sendCommand(command: string): Promise<void>;
    history?: readonly string[];
    saveCommand?(command: string): Promise<void>;
    completeCommand?(
        request: CommandCompletionRequest,
        signal: AbortSignal,
    ): Promise<CommandSuggestion[]>;
    initialMessage?: string;
    signal?: AbortSignal;
    terminal?: Terminal;
    color?: boolean;
}

class MutableLine implements Component {
    private value: string;

    constructor(value: string) {
        this.value = value;
    }

    set(value: string): void {
        this.value = value;
    }

    invalidate(): void {}

    render(width: number): string[] {
        return [truncateToWidth(this.value, Math.max(1, width), "")];
    }
}

type ScrollIntent = "older" | "newer" | "start" | "end";

class LazyScrollView extends ScrollView {
    onScroll?: (intent: ScrollIntent) => void;
    private intentEpoch = 0;
    private pendingAnchor:
        | { position: number; addedRows: number; intentEpoch: number }
        | undefined;

    preserveAnchor(position: number, addedRows: number): void {
        this.pendingAnchor = {
            position,
            addedRows,
            intentEpoch: this.intentEpoch,
        };
    }

    override scrollBy(lines: number): number {
        if (lines !== 0) this.intentEpoch++;
        const remaining = super.scrollBy(lines);
        if (lines !== 0) this.onScroll?.(lines < 0 ? "older" : "newer");
        return remaining;
    }

    override scrollTo(
        position: number,
        options?: ScrollViewScrollToOptions,
    ): void {
        this.intentEpoch++;
        const previous = this.scrollTop;
        super.scrollTo(position, options);
        this.onScroll?.(this.scrollTop < previous ? "older" : "newer");
    }

    override scrollToStart(): void {
        this.intentEpoch++;
        super.scrollToStart();
        this.onScroll?.("start");
    }

    override scrollToEnd(): void {
        this.intentEpoch++;
        super.scrollToEnd();
        this.onScroll?.("end");
    }

    override updateLayout(
        contentHeight: number,
        viewportHeight: number,
        requestRender: () => void,
    ): void {
        super.updateLayout(contentHeight, viewportHeight, requestRender);
        const anchor = this.pendingAnchor;
        if (!anchor) return;
        this.pendingAnchor = undefined;
        if (this.isFollowingEnd) return;
        const position =
            anchor.intentEpoch === this.intentEpoch
                ? anchor.position
                : this.scrollTop;
        super.scrollTo(position + anchor.addedRows, {
            disableFollow: true,
        });
    }
}

function errorMessage(error: unknown): string {
    return sanitizeInlineTerminalOutput(
        error instanceof Error ? error.message : "Unknown console error.",
    );
}

function appendedLines(
    event: Extract<ConsoleLogEvent, { kind: "append" }>,
): number {
    if (event.lineCount !== undefined) return event.lineCount;
    const value = normalizeLogText(event.text);
    const breaks = value.match(/\n/g)?.length ?? 0;
    return value.length === 0 ? 0 : breaks + (value.endsWith("\n") ? 0 : 1);
}

class InteractiveConsole<Cursor, Checkpoint> {
    private readonly terminal: Terminal;
    private readonly tui: TuiAltScreen;
    private readonly transcript: ConsoleTranscript;
    private readonly status = new MutableLine("");
    private readonly input: ConsoleInput;
    private completionAbort: AbortController | undefined;
    private suggestions: CommandSuggestion[] = [];
    private suggestionIndex = 0;
    private historyWrites: Promise<void> = Promise.resolve();
    private readonly scroll: LazyScrollView;
    private readonly abort = new AbortController();
    private older: Cursor | null;
    private checkpoint: Checkpoint;
    private unread = 0;
    private loadingOlder = false;
    private historyVersion = 0;
    private closed = false;
    private commandQueue: Promise<void> = Promise.resolve();
    private detachedCommandFailure: { error: unknown } | undefined;
    private compactPending = false;
    private liveLines = 0;
    private liveBytes = 0;
    private notice: string | undefined;

    constructor(
        private readonly options: InteractiveConsoleOptions<Cursor, Checkpoint>,
        snapshot: ConsoleLogSnapshot<Cursor, Checkpoint>,
    ) {
        this.terminal = options.terminal ?? new ConsoleTerminal();
        this.notice = options.initialMessage;
        this.transcript = new ConsoleTranscript(
            snapshot.text,
            options.color ?? runtimeLogColorsEnabled(),
        );
        this.older = snapshot.older;
        this.checkpoint = snapshot.follow;
        this.scroll = new LazyScrollView(this.transcript, {
            follow: "end",
            primary: true,
            overscroll: "contain",
            scrollbar: "auto",
        });
        this.input = new ConsoleInput(
            (value) => {
                void this.queueCommand(value);
            },
            options.history,
            () => this.clearCompletion(),
        );
        this.tui = new TuiAltScreen(this.terminal, true, undefined, {
            mouse: true,
            wheelScrollLines: 3,
        });
        this.tui.setLayoutRoot(
            new VStack([
                {
                    component: this.scroll,
                    basis: 0,
                    grow: 1,
                    minSize: 1,
                },
                {
                    component: this.status,
                    basis: 1,
                    shrink: 0,
                    minSize: 1,
                },
                {
                    component: this.input,
                    basis: 1,
                    shrink: 0,
                    minSize: 1,
                },
            ]),
        );
        this.tui.setFocus(this.input);
        this.scroll.onScroll = (intent) => this.handleScroll(intent);
        this.updateStatus(options.initialMessage);
    }

    async run(): Promise<void> {
        const done = Promise.withResolvers<void>();
        const close = () => {
            if (this.closed) return;
            this.closed = true;
            this.abort.abort();
            done.resolve();
        };
        const fail = (error: unknown) => {
            if (this.closed) return;
            this.closed = true;
            this.abort.abort();
            done.reject(error);
        };
        const removeInputListener = this.tui.addInputListener((data) => {
            if (this.notice) {
                this.notice = undefined;
                this.updateStatus();
            }
            if (this.input.pasting || data.includes("\x1b[200~"))
                return undefined;
            if (
                matchesKey(data, Key.ctrl("c")) ||
                (matchesKey(data, Key.ctrl("d")) &&
                    this.input.value.length === 0)
            ) {
                close();
                return { consume: true };
            }
            if (this.suggestions.length) {
                if (matchesKey(data, Key.escape)) {
                    this.clearCompletion();
                    return { consume: true };
                }
                if (matchesKey(data, Key.enter) || data === "\n") {
                    const suggestion = this.suggestions[this.suggestionIndex];
                    if (suggestion) this.input.apply(suggestion);
                    return { consume: true };
                }
                if (
                    matchesKey(data, Key.tab) ||
                    matchesKey(data, Key.down) ||
                    matchesKey(data, Key.shift("tab")) ||
                    matchesKey(data, Key.up)
                ) {
                    const direction =
                        matchesKey(data, Key.up) ||
                        matchesKey(data, Key.shift("tab"))
                            ? -1
                            : 1;
                    this.suggestionIndex =
                        (this.suggestionIndex +
                            direction +
                            this.suggestions.length) %
                        this.suggestions.length;
                    this.showSuggestions();
                    return { consume: true };
                }
            }
            if (
                matchesKey(data, Key.tab) ||
                matchesKey(data, Key.shift("tab"))
            ) {
                void this.complete();
                return { consume: true };
            }
            if (matchesKey(data, Key.escape) && this.completionAbort) {
                this.clearCompletion();
                return { consume: true };
            }
            return undefined;
        });
        const onAbort = () => close();
        this.options.signal?.addEventListener("abort", onAbort, { once: true });
        const useProcessInput = this.options.terminal === undefined;
        if (useProcessInput) {
            process.stdin.once("end", close);
            process.stdin.once("close", close);
            process.stdin.once("error", fail);
        }
        let startAttempted = false;
        let follower: Promise<void> | undefined;
        try {
            if (this.options.signal?.aborted) return;
            startAttempted = true;
            this.tui.start();
            follower = this.followLogs();
            void follower.then(close, fail);
            await done.promise;
        } finally {
            this.closed = true;
            this.abort.abort();
            this.completionAbort?.abort();
            removeInputListener();
            this.options.signal?.removeEventListener("abort", onAbort);
            if (useProcessInput) {
                process.stdin.removeListener("end", close);
                process.stdin.removeListener("close", close);
                process.stdin.removeListener("error", fail);
            }
            await Promise.allSettled([
                this.commandQueue,
                this.historyWrites,
                follower ?? Promise.resolve(),
            ]);
            if (startAttempted) {
                try {
                    await this.terminal.drainInput(100, 20);
                } finally {
                    this.tui.stop({ preserveScreen: true });
                }
            }
        }
        if (this.detachedCommandFailure)
            throw this.detachedCommandFailure.error;
    }

    private handleScroll(intent: ScrollIntent): void {
        if (this.closed) return;
        if (
            (intent === "older" || intent === "start") &&
            this.scroll.scrollTop <= 2 &&
            this.older !== null
        ) {
            void this.loadOlder();
            return;
        }
        if (intent === "end" || this.scroll.isFollowingEnd) {
            this.unread = 0;
            this.updateStatus();
            return;
        }
        this.updateStatus();
    }

    private async loadOlder(): Promise<void> {
        if (this.loadingOlder || this.older === null || this.closed) return;
        this.loadingOlder = true;
        const cursor = this.older;
        const historyVersion = this.historyVersion;
        this.updateStatus("Loading older logs...");
        try {
            let next = cursor;
            for (
                let attempt = 0;
                attempt < EMPTY_HISTORY_PAGE_LIMIT;
                attempt++
            ) {
                const page = await this.options.loadOlder(next);
                if (this.closed || historyVersion !== this.historyVersion)
                    return;
                if (page.kind === "stale") {
                    this.older = null;
                    this.updateStatus(
                        "Log history changed; current live output is intact.",
                    );
                    return;
                }
                this.older = page.older;
                if (page.text.length > 0) {
                    const width = Math.max(1, this.terminal.columns);
                    const following = this.scroll.isFollowingEnd;
                    const anchor = this.scroll.scrollTop;
                    const addedRows = this.transcript.prepend(page.text, width);
                    if (!following)
                        this.scroll.preserveAnchor(anchor, addedRows);
                    this.tui.requestRender();
                    break;
                }
                if (page.older === null) break;
                next = page.older;
            }
            this.updateStatus(
                this.older === null && !this.scroll.isFollowingEnd
                    ? "Beginning of log history."
                    : undefined,
            );
        } catch (error) {
            if (!this.closed)
                this.updateStatus(
                    `Could not load older logs: ${errorMessage(error)}`,
                );
        } finally {
            this.loadingOlder = false;
        }
    }

    private async followLogs(): Promise<void> {
        while (!this.abort.signal.aborted) {
            let reset = false;
            let compacted = false;
            for await (const event of this.options.follow(
                this.checkpoint,
                this.abort.signal,
            )) {
                if (this.closed) return;
                if (event.kind === "reset") {
                    reset = true;
                    break;
                }
                if (event.text.length === 0) continue;
                const following = this.scroll.isFollowingEnd;
                this.transcript.append(event.text);
                if (!following) this.unread += appendedLines(event);
                const shouldCompact = this.recordLiveAppend(event);
                this.updateStatus();
                if (!shouldCompact) continue;

                const snapshot = await this.options.loadRecent();
                if (this.closed) return;
                if (!this.scroll.isFollowingEnd) continue;
                this.applyRecent(snapshot);
                compacted = true;
                break;
            }
            if (this.abort.signal.aborted) return;
            if (reset) {
                const snapshot = await this.options.loadRecent();
                if (this.closed) return;
                this.applyRecent(
                    snapshot,
                    "Log file changed; reloaded recent output.",
                );
                continue;
            }
            if (compacted) continue;
            return;
        }
    }

    private recordLiveAppend(
        event: Extract<ConsoleLogEvent, { kind: "append" }>,
    ): boolean {
        if (!this.compactPending) {
            this.liveLines += appendedLines(event);
            this.liveBytes += Buffer.byteLength(event.text, "utf8");
            this.compactPending =
                this.liveLines >= LIVE_COMPACT_LINES ||
                this.liveBytes >= LIVE_COMPACT_BYTES;
        }
        return this.compactPending && this.scroll.isFollowingEnd;
    }

    private applyRecent(
        snapshot: ConsoleLogSnapshot<Cursor, Checkpoint>,
        message?: string,
    ): void {
        this.historyVersion++;
        this.scroll.scrollToEnd();
        this.transcript.replace(snapshot.text);
        this.older = snapshot.older;
        this.checkpoint = snapshot.follow;
        this.unread = 0;
        this.compactPending = false;
        this.liveLines = 0;
        this.liveBytes = 0;
        this.tui.requestRender();
        this.updateStatus(message);
    }

    private queueCommand(value: string): void {
        if (this.closed) return;
        this.input.clear();
        if (!value.trim()) return;
        this.input.remember(value);
        this.historyWrites = this.historyWrites.then(async () => {
            try {
                await this.options.saveCommand?.(value);
            } catch {
                if (!this.closed)
                    this.updateStatus(
                        "Could not save command history; session history is still available.",
                    );
            }
        });
        this.commandQueue = this.commandQueue.then(async () => {
            if (!this.closed) this.updateStatus("Sending command...");
            try {
                await this.options.sendCommand(value);
                if (!this.closed) this.updateStatus("Command sent.");
            } catch (error) {
                if (this.closed) this.detachedCommandFailure ??= { error };
                else
                    this.updateStatus(`Command failed: ${errorMessage(error)}`);
            }
        });
    }

    private updateStatus(message?: string): void {
        if (this.suggestions.length && message === undefined) {
            this.showSuggestions();
            return;
        }
        const position = this.scroll.isFollowingEnd
            ? "Live"
            : `${this.unread} new ${this.unread === 1 ? "line" : "lines"}; End returns to live`;
        this.status.set(
            `${sanitizeInlineTerminalOutput(this.notice ?? message ?? position)} | PageUp or mouse wheel: history | Ctrl-C: detach | Up/Down: commands`,
        );
        this.tui.requestRender();
    }

    private clearCompletion(): void {
        this.completionAbort?.abort();
        this.completionAbort = undefined;
        const visible = this.suggestions.length > 0;
        this.suggestions = [];
        if (visible) this.updateStatus();
    }
    private showSuggestions(): void {
        const start = Math.max(0, this.suggestionIndex - 1);
        const choices = this.suggestions
            .slice(start, start + 4)
            .map((item, index) => {
                const text = sanitizeInlineTerminalOutput(item.text);
                return start + index === this.suggestionIndex
                    ? `[${text}]`
                    : text;
            })
            .join("  ");
        this.status.set(
            `Tab ${this.suggestionIndex + 1}/${this.suggestions.length}: ${choices} | Enter: accept | Esc: cancel`,
        );
        this.tui.requestRender();
    }
    private async complete(): Promise<void> {
        if (!this.options.completeCommand) return;
        this.clearCompletion();
        const abort = new AbortController();
        this.completionAbort = abort;
        const request = { line: this.input.value, cursor: this.input.cursor };
        const signal = AbortSignal.any([
            abort.signal,
            this.abort.signal,
            AbortSignal.timeout(2000),
        ]);
        try {
            const suggestions = await this.options.completeCommand(
                request,
                signal,
            );
            if (
                this.closed ||
                signal.aborted ||
                this.input.value !== request.line ||
                this.input.cursor !== request.cursor ||
                !validSuggestions(suggestions, request)
            )
                return;
            if (suggestions.length === 1 && suggestions[0])
                this.input.apply(suggestions[0]);
            else if (suggestions.length > 1) {
                this.suggestions = suggestions;
                this.suggestionIndex = 0;
                this.showSuggestions();
            }
            this.tui.requestRender();
        } catch {
            if (!this.closed && !abort.signal.aborted)
                this.updateStatus("Tab completion is temporarily unavailable.");
        }
    }
}

export async function openInteractiveConsole<Cursor, Checkpoint>(
    options: InteractiveConsoleOptions<Cursor, Checkpoint>,
): Promise<void> {
    const snapshot = await options.loadRecent();
    await new InteractiveConsole(options, snapshot).run();
}
