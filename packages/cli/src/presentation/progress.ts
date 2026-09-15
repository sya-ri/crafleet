import { progress, spinner } from "@clack/prompts";
import type { OperationProgress } from "@crafleet/core";
import { sanitizeInlineTerminalOutput } from "./terminal.js";

interface ActiveStep {
    event: OperationProgress;
    started: number;
}

function bytes(value: number): string {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

/** The CLI alone owns timers, terminal control and the human output stream. */
export class CommandProgress {
    private readonly active = new Map<string, ActiveStep>();
    private readonly started = Date.now();
    private lastOutput = this.started;
    private timer: ReturnType<typeof setInterval> | undefined;
    private display: ReturnType<typeof spinner> | undefined;
    private displayKey = "";
    private advanced = 0;
    private paused = 0;
    private closed = false;
    private completed = 0;
    private pendingLines: string[] = [];
    private readonly interactive: boolean;

    constructor(
        private readonly command: string,
        private readonly output: NodeJS.WriteStream = process.stderr,
        interactive = Boolean(
            output.isTTY && process.env.TERM !== "dumb" && !process.env.CI,
        ),
    ) {
        this.interactive = interactive;
        this.safely(() => this.write(`${command}: Starting`));
        this.timer = setInterval(
            () => this.safely(() => this.tick()),
            interactive ? 100 : 1000,
        );
        this.timer.unref();
        this.safely(() => this.tick());
    }

    readonly report = (event: OperationProgress): void =>
        this.safely(() => {
            if (this.closed) return;
            const previous = this.active.get(event.id);
            if (event.state === "start" || event.state === "update") {
                const step = {
                    event,
                    started: previous?.started ?? Date.now(),
                };
                this.active.set(event.id, step);
                if (!previous && !this.interactive)
                    this.write(this.label(step));
            } else {
                this.active.delete(event.id);
                if (event.state === "complete") this.completed++;
                this.clear();
                this.write(
                    `${event.state === "complete" ? "Done" : "Failed"}: ${this.label({ event, started: previous?.started ?? Date.now() })}`,
                );
            }
            this.tick();
        });

    pause(): void {
        this.paused++;
        this.safely(() => this.clear());
    }

    resume(): void {
        this.paused = Math.max(0, this.paused - 1);
        if (!this.paused) this.safely(() => this.flush());
        this.safely(() => this.tick());
    }

    finish(state: "complete" | "failed" | "cancelled"): void {
        if (this.closed) return;
        this.closed = true;
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        this.safely(() => {
            this.clear();
            this.paused = 0;
            this.flush();
            this.write(
                `${this.command}: ${state === "complete" ? "Completed" : state === "cancelled" ? "Cancelled" : "Finished with errors"} (${this.elapsed(this.started)})`,
            );
        });
        this.active.clear();
    }

    private safely(action: () => void): void {
        try {
            action();
        } catch {
            // Progress is best effort; command errors are rendered separately.
        }
    }

    private elapsed(started: number): string {
        return `${Math.floor((Date.now() - started) / 1000)}s`;
    }

    private label({ event, started }: ActiveStep): string {
        const count = event.completed;
        const quantity =
            count === undefined
                ? ""
                : event.unit === "bytes"
                  ? ` ${bytes(count)}${event.total === undefined ? "" : ` / ${bytes(event.total)}`}`
                  : ` ${count}${event.total === undefined ? "" : `/${event.total}`}`;
        return sanitizeInlineTerminalOutput(
            `${event.target ? `${event.target}: ` : ""}${event.message}${quantity} (${this.elapsed(started)})`,
        );
    }

    private write(message: string): void {
        if (this.paused) {
            this.pendingLines.push(message);
            return;
        }
        this.output.write(`${sanitizeInlineTerminalOutput(message)}\n`);
        this.lastOutput = Date.now();
    }

    private flush(): void {
        const lines = this.pendingLines;
        this.pendingLines = [];
        for (const line of lines) this.write(line);
    }

    private clear(): void {
        this.display?.clear();
        this.display = undefined;
        this.displayKey = "";
        this.advanced = 0;
    }

    private tick(): void {
        if (this.closed || this.paused) return;
        const current = [...this.active.values()].at(-1) ?? {
            event: {
                id: "command",
                message: `${this.command}: Processing`,
                state: "start" as const,
            },
            started: this.started,
        };
        const message = `${this.label(current)}${this.completed ? ` [${this.completed} steps completed; ${this.active.size} active]` : ""}`;
        if (!this.interactive) {
            if (Date.now() - this.lastOutput >= 10_000) this.write(message);
            return;
        }
        const { event } = current;
        const total =
            event.unit === "bytes" &&
            event.total !== undefined &&
            event.total > 0
                ? event.total
                : undefined;
        const key = `${event.id}:${total ?? "spinner"}`;
        if (this.displayKey !== key) {
            this.clear();
            this.display =
                total === undefined
                    ? spinner({ output: this.output, withGuide: false })
                    : progress({
                          output: this.output,
                          withGuide: false,
                          max: total,
                          size: Math.max(
                              5,
                              Math.min(
                                  24,
                                  Math.floor((this.output.columns || 80) / 4),
                              ),
                          ),
                      });
            this.displayKey = key;
            this.display.start(message);
        }
        if (total !== undefined && this.display && "advance" in this.display) {
            const next = Math.min(
                total,
                Math.max(this.advanced, event.completed ?? 0),
            );
            (this.display as ReturnType<typeof progress>).advance(
                next - this.advanced,
                message,
            );
            this.advanced = next;
        } else this.display?.message(message);
    }
}
