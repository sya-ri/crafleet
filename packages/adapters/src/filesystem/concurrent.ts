import { runtimeLimit } from "../settings.js";

/** Preserve input order and drain active reads before propagating an error. */
export async function mapConcurrentReads<T, R>(
    items: readonly T[],
    read: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const pending = items.entries();
    const results: R[] = new Array(items.length);
    let failure: { index: number; error: unknown } | undefined;
    function failed(index: number, error: unknown): void {
        if (!failure || index < failure.index) failure = { index, error };
    }
    async function worker(): Promise<void> {
        while (!failure) {
            const next = pending.next();
            if (next.done) return;
            const [index, item] = next.value;
            try {
                results[index] = await read(item, index);
            } catch (error) {
                failed(index, error);
            }
        }
    }
    await Promise.all(
        Array.from(
            {
                length: Math.min(
                    runtimeLimit("files.readConcurrency"),
                    items.length,
                ),
            },
            worker,
        ),
    );
    if (failure) throw failure.error;
    return results;
}
