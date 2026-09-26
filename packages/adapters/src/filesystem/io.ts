import { randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import {
    access,
    type FileHandle,
    link,
    lstat,
    mkdir,
    open,
    readdir,
    readFile,
    realpath,
    rename,
    rm,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
    assertSettingLimit,
    CrafleetError,
    type SettingKey,
} from "@crafleet/core";
import {
    runtimeLimit,
    runtimeSettings,
    runtimeSignal,
    runtimeValue,
} from "../settings.js";
import { MutexBusyError } from "./mutex-error.js";

const WINDOWS_SHARING_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);

export async function exists(file: string): Promise<boolean> {
    try {
        await lstat(file);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

export type BoundedFileFailure =
    | "changed"
    | "too-large"
    | "unreadable"
    | "unsafe";

export interface BoundedFileSnapshot {
    bytes: Buffer;
    stats: BigIntStats;
}

class BoundedFileError extends Error {
    constructor(readonly reason: BoundedFileFailure) {
        super(reason);
    }
}

function assertBoundedRegularFile(info: BigIntStats, maxBytes: number): void {
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n)
        throw new BoundedFileError("unsafe");
    if (
        Number.isFinite(maxBytes) &&
        maxBytes !== -1 &&
        info.size > BigInt(maxBytes)
    )
        throw new BoundedFileError("too-large");
}

function sameFile(before: BigIntStats, after: BigIntStats): boolean {
    return (
        sameFileIdentity(before, after) &&
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs
    );
}

function sameFileIdentity(before: BigIntStats, after: BigIntStats): boolean {
    return (
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.birthtimeNs === after.birthtimeNs &&
        before.nlink === after.nlink
    );
}

/** Read one bounded regular file without following links or accepting a changed identity. */
export async function readBoundedRegularFile(
    file: string,
    options: {
        maxBytes: number;
        signal?: AbortSignal;
        failure: (reason: BoundedFileFailure) => never;
    },
): Promise<BoundedFileSnapshot | null> {
    const { maxBytes, signal } = options;
    signal?.throwIfAborted();
    await assertNoSymlinks(file);
    let before: BigIntStats;
    try {
        before = await lstat(file, { bigint: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
    let handle: FileHandle | undefined;
    try {
        assertBoundedRegularFile(before, maxBytes);
        const noFollow =
            process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
        const nonblock =
            process.platform === "win32" ? 0 : constants.O_NONBLOCK;
        handle = await open(file, constants.O_RDONLY | noFollow | nonblock);
        const opened = await handle.stat({ bigint: true });
        assertBoundedRegularFile(opened, maxBytes);
        if (!sameFile(before, opened)) throw new BoundedFileError("changed");
        const chunks: Buffer[] = [];
        const maximum = maxBytes === -1 ? Number.POSITIVE_INFINITY : maxBytes;
        let size = 0;
        for (;;) {
            signal?.throwIfAborted();
            const bytes = Buffer.allocUnsafe(
                Math.min(
                    runtimeValue("files.readChunkBytes"),
                    maximum - size + 1,
                ),
            );
            const result = await handle.read(bytes, 0, bytes.length, size);
            if (result.bytesRead === 0) break;
            size += result.bytesRead;
            if (size > maximum) throw new BoundedFileError("too-large");
            chunks.push(bytes.subarray(0, result.bytesRead));
        }
        await assertNoSymlinks(file);
        const after = await lstat(file, { bigint: true });
        assertBoundedRegularFile(after, maxBytes);
        if (
            BigInt(size) !== before.size ||
            !sameFile(before, after) ||
            !sameFile(before, await handle.stat({ bigint: true }))
        )
            throw new BoundedFileError("changed");
        signal?.throwIfAborted();
        return { bytes: Buffer.concat(chunks, size), stats: before };
    } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof CrafleetError) throw error;
        if (error instanceof BoundedFileError)
            return options.failure(error.reason);
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return options.failure("changed");
        return options.failure("unreadable");
    } finally {
        await handle?.close();
    }
}

/** Append without replacing the file, after checking the identity read by the caller. */
export async function appendToBoundedRegularFile(
    file: string,
    expected: BigIntStats,
    content: string | Uint8Array,
    options: {
        maxBytes: number;
        failure: (reason: BoundedFileFailure) => never;
    },
): Promise<void> {
    await assertNoSymlinks(file);
    let handle: FileHandle | undefined;
    try {
        const noFollow =
            process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
        const nonblock =
            process.platform === "win32" ? 0 : constants.O_NONBLOCK;
        handle = await open(
            file,
            constants.O_WRONLY | constants.O_APPEND | noFollow | nonblock,
        );
        const opened = await handle.stat({ bigint: true });
        assertBoundedRegularFile(opened, options.maxBytes);
        if (!sameFile(expected, opened)) throw new BoundedFileError("changed");
        const bytes =
            typeof content === "string" ? Buffer.from(content) : content;
        if (
            Number.isFinite(options.maxBytes) &&
            options.maxBytes !== -1 &&
            opened.size + BigInt(bytes.byteLength) > BigInt(options.maxBytes)
        )
            throw new BoundedFileError("too-large");
        let offset = 0;
        while (offset < bytes.byteLength) {
            const { bytesWritten } = await handle.write(
                bytes,
                offset,
                bytes.byteLength - offset,
            );
            if (bytesWritten === 0) throw new BoundedFileError("unreadable");
            offset += bytesWritten;
        }
        await handle.sync();
        await assertNoSymlinks(file);
        const after = await lstat(file, { bigint: true });
        const written = await handle.stat({ bigint: true });
        assertBoundedRegularFile(after, options.maxBytes);
        assertBoundedRegularFile(written, options.maxBytes);
        if (
            !sameFileIdentity(opened, after) ||
            !sameFileIdentity(opened, written)
        )
            throw new BoundedFileError("changed");
    } catch (error) {
        if (error instanceof CrafleetError) throw error;
        if (error instanceof BoundedFileError)
            return options.failure(error.reason);
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return options.failure("changed");
        return options.failure("unreadable");
    } finally {
        await handle?.close();
    }
}

function isWindowsSharingError(
    platform: NodeJS.Platform,
    error: unknown,
): boolean {
    return (
        platform === "win32" &&
        WINDOWS_SHARING_ERRORS.has((error as NodeJS.ErrnoException).code ?? "")
    );
}

async function removeTemporary(file: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        try {
            await rm(file, { force: true });
            return;
        } catch (error) {
            if (
                attempt >= runtimeLimit("files.windowsRetries") ||
                !isWindowsSharingError(process.platform, error)
            )
                throw error;
            runtimeSignal()?.throwIfAborted();
            await delay(
                Math.min(
                    runtimeValue("files.windowsRetryDelayMs") * 2 ** attempt,
                    runtimeValue("files.windowsRetryMaxDelayMs"),
                ),
                undefined,
                { signal: runtimeSignal() },
            );
        }
    }
}

export async function atomicWrite(
    file: string,
    content: string | Uint8Array,
    mode = 0o600,
): Promise<void> {
    await assertNoSymlinks(path.dirname(file), path.basename(file));
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = path.join(
        path.dirname(file),
        `.${path.basename(file)}.${randomUUID()}.tmp`,
    );
    const handle = await open(temporary, "wx", mode);
    try {
        try {
            await handle.writeFile(content);
            await handle.sync();
        } finally {
            await handle.close();
        }
        await renameWithSharingRetry(temporary, file);
    } finally {
        await removeTemporary(temporary);
    }
}

export async function atomicCreate(
    file: string,
    content: string | Uint8Array,
    mode = 0o600,
): Promise<void> {
    await assertNoSymlinks(path.dirname(file), path.basename(file));
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = path.join(
        path.dirname(file),
        `.${path.basename(file)}.${randomUUID()}.tmp`,
    );
    const handle = await open(temporary, "wx", mode);
    try {
        try {
            await handle.writeFile(content);
            await handle.sync();
        } finally {
            await handle.close();
        }
        await assertNoSymlinks(file);
        try {
            await link(temporary, file);
        } catch (error) {
            if (
                [
                    "EACCES",
                    "EMLINK",
                    "ENOSYS",
                    "ENOTSUP",
                    "EOPNOTSUPP",
                    "EPERM",
                    "EXDEV",
                ].includes((error as NodeJS.ErrnoException).code ?? "")
            )
                throw new CrafleetError(
                    "ATOMIC_CREATE_UNSUPPORTED",
                    "The filesystem refused safe exclusive file creation.",
                    3,
                    "Use a filesystem with hard-link support and verify write permission.",
                );
            throw error;
        }
    } catch (error) {
        await removeTemporary(temporary).catch(() => undefined);
        throw error;
    }
    // Publication is the commit point; cleanup cannot turn success into failure.
    await removeTemporary(temporary).catch(() => undefined);
}

/** Windows readers may transiently deny replacement; never unlink the destination. */
export async function renameWithSharingRetry(
    source: string,
    destination: string,
    options: {
        platform?: NodeJS.Platform;
        rename?: (source: string, destination: string) => Promise<void>;
    } = {},
): Promise<void> {
    const platform = options.platform ?? process.platform;
    const perform = options.rename ?? rename;
    for (let attempt = 0; ; attempt++) {
        await assertNoSymlinks(source);
        await assertNoSymlinks(destination);
        try {
            await perform(source, destination);
            return;
        } catch (error) {
            if (
                attempt >= runtimeLimit("files.windowsRetries") ||
                !isWindowsSharingError(platform, error)
            )
                throw error;
            runtimeSignal()?.throwIfAborted();
            await delay(
                Math.min(
                    runtimeValue("files.windowsRetryDelayMs") * 2 ** attempt,
                    runtimeValue("files.windowsRetryMaxDelayMs"),
                ),
                undefined,
                { signal: runtimeSignal() },
            );
        }
    }
}

export async function readJson<T>(file: string): Promise<T> {
    return JSON.parse(await readFile(file, "utf8")) as T;
}

export async function writeJson(file: string, value: unknown): Promise<void> {
    const text = `${JSON.stringify(value, null, 4)}\n`;
    const limits: Record<string, SettingKey> = {
        "state.json": "state.maxBytes",
        "deploy.json": "state.maxDeployJournalBytes",
        "restore.json": "state.maxRestoreJournalBytes",
        "runner.json": "runtime.maxRecordBytes",
        "runner-launch.json": "runtime.maxRecordBytes",
        "runtime-intent.json": "state.maxGuardBytes",
    };
    const key = limits[path.basename(file)];
    if (key)
        assertSettingLimit(Buffer.byteLength(text), runtimeSettings(), key);
    await atomicWrite(file, text);
}

export function pathContains(parent: string, child: string): boolean {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return (
        relative === "" ||
        (relative !== ".." &&
            !relative.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relative))
    );
}

export function pathsOverlap(first: string, second: string): boolean {
    return pathContains(first, second) || pathContains(second, first);
}

export function containedPath(root: string, relative: string): string {
    const target = path.resolve(root, relative);
    if (!pathContains(root, target)) {
        throw new CrafleetError(
            "PATH_ESCAPE",
            `Path leaves its managed directory: ${relative}`,
            3,
        );
    }
    return target;
}

export async function assertNoSymlinks(
    root: string,
    relative = "",
): Promise<string> {
    const target = containedPath(root, relative);
    const resolvedRoot = path.resolve(root);
    // Check root and every existing ancestor; never write through a runtime/config link.
    let current = path.parse(resolvedRoot).root;
    for (const segment of path
        .relative(current, target)
        .split(path.sep)
        .filter(Boolean)) {
        current = path.join(current, segment);
        try {
            if (!(await lstat(current)).isSymbolicLink()) continue;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
        }
        throw new CrafleetError(
            "SYMLINK_UNSAFE",
            `Refusing managed path through a symbolic link: ${current}`,
            3,
        );
    }
    return target;
}

export async function listFiles(root: string): Promise<string[]> {
    await assertNoSymlinks(root);
    if (!(await exists(root))) return [];
    const files: string[] = [];
    async function walk(directory: string, prefix: string) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isSymbolicLink())
                throw new CrafleetError(
                    "SYMLINK_UNSAFE",
                    `Symbolic link in managed files: ${relative}`,
                    3,
                );
            if (entry.isDirectory())
                await walk(path.join(directory, entry.name), relative);
            else if (entry.isFile()) files.push(relative);
        }
    }
    await walk(root, "");
    return files.sort();
}

export async function readable(file: string): Promise<boolean> {
    try {
        await access(file, constants.R_OK);
        return true;
    } catch {
        return false;
    }
}

export async function canonicalPath(file: string): Promise<string> {
    return realpath(file);
}

export async function withMutex<T>(
    directory: string,
    action: () => Promise<T>,
): Promise<T> {
    await assertNoSymlinks(path.dirname(directory), path.basename(directory));
    await mkdir(path.dirname(directory), { recursive: true });
    try {
        await mkdir(directory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new MutexBusyError(directory);
        }
        throw error;
    }
    try {
        await writeJson(path.join(directory, "owner.json"), {
            pid: process.pid,
            started: new Date().toISOString(),
        });
        return await action();
    } finally {
        await assertNoSymlinks(
            path.dirname(directory),
            path.basename(directory),
        );
        await rm(directory, { recursive: true, force: true });
    }
}
