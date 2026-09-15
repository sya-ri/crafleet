/** Display-only events. They must never control an operation or expose secrets. */
export interface OperationProgress {
    id: string;
    message: string;
    state: "start" | "update" | "complete" | "failed";
    target?: string;
    completed?: number;
    total?: number;
    unit?: "bytes" | "items";
}

export type ProgressObserver = (event: OperationProgress) => void;

export interface ProgressOptions {
    onProgress?: ProgressObserver;
}

export function reportProgress(
    observer: ProgressObserver | undefined,
    event: OperationProgress,
): void {
    try {
        observer?.(event);
    } catch {
        // A broken display must not turn a committed operation into a failure.
    }
}

/** A scope uses a distinct observer, so concurrent projects cannot overwrite it. */
export function progressScope(
    observer: ProgressObserver,
    target: string,
): ProgressObserver;
export function progressScope(
    observer: ProgressObserver | undefined,
    target: string,
): ProgressObserver | undefined;
export function progressScope(
    observer: ProgressObserver | undefined,
    target: string,
): ProgressObserver | undefined {
    if (!observer) return undefined;
    return (event) =>
        reportProgress(observer, {
            ...event,
            id: `${target}/${event.id}`,
            target: event.target ? `${target} / ${event.target}` : target,
        });
}

export async function progressStep<T>(
    observer: ProgressObserver | undefined,
    id: string,
    message: string,
    action: () => Promise<T>,
): Promise<T> {
    reportProgress(observer, { id, message, state: "start" });
    try {
        const result = await action();
        reportProgress(observer, { id, message, state: "complete" });
        return result;
    } catch (error) {
        reportProgress(observer, { id, message, state: "failed" });
        throw error;
    }
}
