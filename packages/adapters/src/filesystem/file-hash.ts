import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export async function fileSha256(
    file: string,
    signal?: AbortSignal,
): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file, signal ? { signal } : {}))
        hash.update(chunk);
    return hash.digest("hex");
}
