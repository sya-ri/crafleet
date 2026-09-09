import type { Dirent } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { CrafleetError } from "@crafleet/core";
import glob from "fast-glob";
import picomatch from "picomatch";
import { assertNoSymlinks, exists } from "./io.js";

const OMITTED_DIRECTORIES = new Set(["node_modules", "runtime", "config"]);
type DirectoryCallback = (
    error: NodeJS.ErrnoException | null,
    entries: Dirent[],
) => void;
type NamesCallback = (
    error: NodeJS.ErrnoException | null,
    entries: string[],
) => void;

function workspacePath(
    base: string,
    file: string,
): { file: string; ignored: boolean } {
    const absolute = path.resolve(base, file);
    const relative = path.relative(base, absolute);
    if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
    )
        throw new CrafleetError(
            "WORKSPACE_PATH",
            "Workspace traversal must remain under the declared workspace.",
            2,
        );
    const segments = relative ? relative.split(path.sep) : [];
    const ignored = segments.some(
        (segment) =>
            segment.startsWith(".") || OMITTED_DIRECTORIES.has(segment),
    );
    if (!ignored && segments.length > 12)
        throw new CrafleetError(
            "WORKSPACE_DEPTH",
            "Workspace nesting exceeds 12 directories.",
            2,
        );
    return { file: absolute, ignored };
}

/** Check static glob bases as well as dynamic reads: neither may follow a link. */
function workspaceFilesystem(base: string): Partial<glob.FileSystemAdapter> {
    const read: glob.FileSystemAdapter["readdir"] = (
        file,
        options: { withFileTypes: true } | NamesCallback,
        callback?: DirectoryCallback,
    ) => {
        const operation = async () => {
            const checked = workspacePath(base, file);
            if (checked.ignored) return [];
            await assertNoSymlinks(
                base,
                path.relative(base, checked.file) || ".",
            );
            return readdir(checked.file, { withFileTypes: true });
        };
        if (typeof options === "function")
            void operation().then(
                (entries) =>
                    options(
                        null,
                        entries.map((entry) => entry.name),
                    ),
                (error: Error) => options(error, []),
            );
        else if (callback)
            void operation().then(
                (entries) => callback(null, entries),
                (error: Error) => callback(error, []),
            );
    };
    const inspect =
        (follow: boolean): glob.FileSystemAdapter["lstat"] =>
        (file, callback) => {
            const operation = async () => {
                const checked = workspacePath(base, file);
                if (checked.ignored)
                    throw Object.assign(new Error("Omitted workspace path"), {
                        code: "ENOENT",
                    });
                await assertNoSymlinks(
                    base,
                    path.relative(base, checked.file) || ".",
                );
                return follow ? stat(checked.file) : lstat(checked.file);
            };
            void operation().then(
                (value) => callback(null, value),
                // The adapter types require stats even on the error branch.
                (error: Error) => callback(error, undefined as never),
            );
        };
    return { readdir: read, lstat: inspect(false), stat: inspect(true) };
}

export async function discoverWorkspaceProjects(
    base: string,
    includes: readonly string[],
    excludes: readonly string[],
): Promise<string[]> {
    if (!includes.length) return [];
    for (const task of glob.generateTasks([...includes]))
        workspacePath(base, task.base);
    // A negative project match need not exclude nested projects. Only explicit
    // subtree exclusions are passed to the walker's directory pruning filter.
    const ignored = [
        "**/.*",
        "**/node_modules/**",
        "**/runtime/**",
        "**/config/**",
        ...excludes.filter((pattern) => pattern.endsWith("/**")),
    ];
    const directories = await glob([...includes], {
        cwd: base,
        onlyDirectories: true,
        followSymbolicLinks: false,
        dot: false,
        unique: true,
        suppressErrors: false,
        ignore: ignored,
        fs: workspaceFilesystem(base),
    }).catch((error: unknown) => {
        if (
            error instanceof Error &&
            "code" in error &&
            ["EACCES", "EPERM"].includes(String(error.code))
        )
            throw new CrafleetError(
                "WORKSPACE_ACCESS",
                "Cannot read a directory within the declared workspace project patterns.",
                2,
                "Check access permissions for the selected project directories.",
            );
        throw error;
    });
    const matchesInclude = includes.map((pattern) =>
        picomatch(pattern, { dot: false, nonegate: true }),
    );
    const matchesExclude = excludes.map((pattern) =>
        picomatch(pattern, { dot: false, nonegate: true }),
    );
    const projects: string[] = [];
    // The glob walk omits '.', but Crafleet permits an explicitly selected root.
    for (const directory of [...new Set([".", ...directories])].sort()) {
        const checked = workspacePath(base, directory);
        const relative =
            path.relative(base, checked.file).replaceAll(path.sep, "/") || ".";
        if (
            checked.ignored ||
            !matchesInclude.some((matches) => matches(relative)) ||
            matchesExclude.some((matches) => matches(relative))
        )
            continue;
        await assertNoSymlinks(base, relative);
        if (await exists(path.join(checked.file, "crafleet.yaml")))
            projects.push(checked.file);
    }
    return projects.sort();
}
