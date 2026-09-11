import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import {
    type FileHandle,
    lstat,
    mkdir,
    open,
    rename,
    rm,
} from "node:fs/promises";
import path from "node:path";
import {
    type ConfigSnapshot,
    CrafleetError,
    type FileObject,
    snapshotEqual,
} from "@crafleet/core";
import { mergeConfigDocuments } from "../formats/config.js";
import { checkBackupSpace } from "./backup-files.js";
import {
    assertNoSymlinks,
    atomicWrite,
    exists,
    readBoundedRegularFile,
} from "./io.js";
import { ensurePrivateDirectory } from "./private.js";
import { type ConfigSecrets, loadConfigSecrets } from "./secrets.js";

function changed(): never {
    throw new CrafleetError(
        "FILES_CHANGED",
        "A managed file changed or cannot be accessed safely; no replacement was committed.",
        3,
    );
}
function same(left: BigIntStats, right: BigIntStats): boolean {
    return (
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.size === right.size &&
        left.mtimeNs === right.mtimeNs &&
        left.ctimeNs === right.ctimeNs &&
        left.nlink === right.nlink
    );
}

/** Hash and optionally copy through one checked descriptor, with bounded memory. */
export async function streamFile(
    source: string,
    destination?: string,
): Promise<FileObject> {
    await assertNoSymlinks(source);
    const before = await lstat(source, { bigint: true });
    if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.size > BigInt(Number.MAX_SAFE_INTEGER)
    )
        changed();
    let input: FileHandle | undefined;
    let output: FileHandle | undefined;
    try {
        input = await open(
            source,
            constants.O_RDONLY |
                (process.platform === "win32"
                    ? 0
                    : constants.O_NOFOLLOW | constants.O_NONBLOCK),
        );
        if (!same(before, await input.stat({ bigint: true }))) changed();
        if (destination) output = await open(destination, "wx", 0o600);
        const hash = createHash("sha256");
        const buffer = Buffer.alloc(256 * 1024);
        let size = 0;
        for (;;) {
            const { bytesRead } = await input.read(
                buffer,
                0,
                buffer.length,
                size,
            );
            if (!bytesRead) break;
            size += bytesRead;
            if (BigInt(size) > before.size) changed();
            hash.update(buffer.subarray(0, bytesRead));
            if (output) {
                let offset = 0;
                while (offset < bytesRead) {
                    const result = await output.write(
                        buffer,
                        offset,
                        bytesRead - offset,
                    );
                    if (!result.bytesWritten) changed();
                    offset += result.bytesWritten;
                }
            }
        }
        await assertNoSymlinks(source);
        if (
            BigInt(size) !== before.size ||
            !same(before, await input.stat({ bigint: true })) ||
            !same(before, await lstat(source, { bigint: true }))
        )
            changed();
        await output?.sync();
        return { kind: "binary", sha256: hash.digest("hex"), size };
    } finally {
        await input?.close();
        await output?.close();
    }
}

export function objectPath(projectDir: string, object: FileObject): string {
    if (!/^[a-f0-9]{64}$/.test(object.sha256)) changed();
    return path.join(projectDir, ".crafleet", "file-objects", object.sha256);
}

const preparedDirectories = new Map<string, Promise<void>>();
export async function retainObject(
    projectDir: string,
    source: string,
    expected: FileObject,
): Promise<void> {
    const target = objectPath(projectDir, expected);
    await assertNoSymlinks(target);
    if (await exists(target)) {
        if (!snapshotEqual(await streamFile(target), expected)) changed();
        return;
    }
    const directory = path.dirname(target);
    if (!(await exists(directory))) preparedDirectories.delete(directory);
    if (!preparedDirectories.has(directory))
        preparedDirectories.set(directory, ensurePrivateDirectory(directory));
    await preparedDirectories.get(directory);
    await checkBackupSpace(directory, expected.size);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
        if (!snapshotEqual(await streamFile(source, temporary), expected))
            changed();
        await assertNoSymlinks(target);
        await rename(temporary, target);
    } finally {
        await rm(temporary, { force: true });
    }
}

export async function readFileContent(
    root: string,
    relative: string,
): Promise<ConfigSnapshot> {
    const source = await assertNoSymlinks(root, relative);
    if (!(await exists(source))) return null;
    const snapshot = await streamFile(source);
    const structured = /\.(?:ya?ml|json|properties|toml)$/i.test(relative);
    if (snapshot.size <= 4 * 1024 * 1024) {
        const bounded = await readBoundedRegularFile(source, {
            // The streamed snapshot already fixes this read's expected size.
            // Do not allocate the full 4 MiB ceiling for every small YAML file.
            maxBytes: snapshot.size,
            failure: changed,
        });
        if (!bounded) changed();
        const bytes = bounded.bytes;
        if (
            createHash("sha256").update(bytes).digest("hex") !== snapshot.sha256
        )
            changed();
        try {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(
                bytes,
            );
            if (structured || !text.includes("\0")) return text;
        } catch {
            /* Non-text files are compared by hash. */
        }
    }
    if (structured)
        throw new CrafleetError(
            "FILES_UNSUPPORTED",
            "Structured configuration must be valid UTF-8 within the existing 4 MiB limit.",
            3,
        );
    return snapshot;
}

export async function writeFileContent(
    projectDir: string,
    root: string,
    relative: string,
    content: ConfigSnapshot,
): Promise<void> {
    const target = await assertNoSymlinks(root, relative);
    if (content === null) {
        if (await exists(target)) {
            if (!(await lstat(target)).isFile()) changed();
            await rm(target);
        }
    } else if (typeof content === "string") {
        await atomicWrite(target, content);
    } else {
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        const temporary = `${target}.${randomUUID()}.tmp`;
        try {
            if (
                !snapshotEqual(
                    await streamFile(
                        objectPath(projectDir, content),
                        temporary,
                    ),
                    content,
                )
            )
                changed();
            await assertNoSymlinks(root, relative);
            await rename(temporary, target);
        } finally {
            await rm(temporary, { force: true });
        }
    }
}

export function mergeFileContent(
    relative: string,
    previous: ConfigSnapshot,
    base: ConfigSnapshot,
    runtime: ConfigSnapshot,
): { content: ConfigSnapshot; conflicts: string[] } {
    if (
        ![previous, base, runtime].some(
            (value) => typeof value === "object" && value !== null,
        )
    )
        return mergeConfigDocuments(
            relative,
            previous as string | null,
            base as string | null,
            runtime as string | null,
        );
    if (snapshotEqual(base, runtime)) return { content: base, conflicts: [] };
    if (snapshotEqual(base, previous))
        return { content: runtime, conflicts: [] };
    if (snapshotEqual(runtime, previous))
        return { content: base, conflicts: [] };
    return { content: base, conflicts: ["/"] };
}

/** Binary values are never interpreted as secret templates or printed as file content. */
export class FileSecrets {
    // Validation is deterministic for this resolved secret set. Reuse successful
    // checks of identical text during one operation, without caching file reads.
    private readonly validated = new Set<string>();
    constructor(private readonly text: ConfigSecrets) {}
    assertTemplate(relative: string, content: ConfigSnapshot): void {
        if (typeof content === "string") {
            const key = `${relative}\0${createHash("sha256").update(content).digest("hex")}`;
            if (this.validated.has(key)) return;
            this.text.assertTemplate(relative, content);
            if (this.validated.size < 10000) this.validated.add(key);
        }
    }
    tokenize(
        relative: string,
        content: ConfigSnapshot,
        templates?: string[],
    ): ConfigSnapshot {
        if (typeof content !== "string") return content;
        if (!this.text.hasSecrets) {
            // Without resolved values, a valid template cannot contain tokens
            // and there is nothing to substitute or relocate. Keep all syntax,
            // known-credential and unknown-token validation before this shortcut.
            this.assertTemplate(relative, content);
            for (const template of templates ?? [])
                this.assertTemplate(relative, template);
            return content;
        }
        return this.text.tokenize(relative, content, templates);
    }
    inject(relative: string, content: ConfigSnapshot): ConfigSnapshot {
        if (typeof content !== "string") return content;
        if (!this.text.hasSecrets) {
            this.assertTemplate(relative, content);
            return content;
        }
        return this.text.inject(relative, content);
    }
    redact(value: string): string {
        return this.text.redact(value);
    }
}
export async function loadFileSecrets(
    ...args: Parameters<typeof loadConfigSecrets>
): Promise<FileSecrets> {
    return new FileSecrets(await loadConfigSecrets(...args));
}
