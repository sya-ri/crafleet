import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
    type BackupMetadata,
    type BackupRoot,
    type ConfigBundle,
    CrafleetError,
    type FileObject,
    snapshotEqual,
} from "@crafleet/core";
import { checkBackupSpace } from "./backup-files.js";
import { objectPath, retainObject, streamFile } from "./file-content.js";
import { assertNoSymlinks } from "./io.js";
import { validateInstallation } from "./state.js";

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function invalid(): never {
    throw new CrafleetError(
        "BACKUP_FILE_OBJECTS",
        "File object metadata or content does not match the active installation.",
        3,
    );
}
export function bundleObjects(bundle: ConfigBundle): FileObject[] {
    const values = [
        ...bundle.files.flatMap((file) => [
            file.base,
            file.observed,
            file.runtime,
            file.content,
        ]),
        ...Object.values(bundle.state.files).flatMap((entry) => [
            entry.observed,
            entry.appliedBase ?? null,
        ]),
    ];
    const objects = new Map<string, FileObject>();
    for (const value of values)
        if (typeof value === "object" && value !== null) {
            const previous = objects.get(value.sha256);
            if (previous && previous.size !== value.size) invalid();
            objects.set(value.sha256, value);
        }
    return [...objects.values()];
}
export function selectedFileObjects(active: Record<string, unknown>) {
    const installations: { rootId: string; value: unknown }[] = [];
    if (record(active.group) && Array.isArray(active.group.members)) {
        for (const member of active.group.members) {
            if (
                !record(member) ||
                !record(member.installation) ||
                !record(member.installation.config) ||
                member.installation.config.mode !== "files"
            )
                continue;
            if (!record(member) || typeof member.runtimeRootId !== "string")
                invalid();
            installations.push({
                rootId: member.runtimeRootId,
                value: member.installation,
            });
        }
    } else
        installations.push({ rootId: "runtime", value: active.installation });
    const result = new Map<string, { object: FileObject; roots: string[] }>();
    for (const { rootId, value } of installations) {
        if (value === undefined || value === null) continue;
        if (
            !record(value) ||
            !record(value.config) ||
            value.config.mode !== "files"
        )
            continue;
        const installation = validateInstallation(value);
        for (const object of bundleObjects(installation.config)) {
            if (installation.config.mode !== "files") invalid();
            const entry = result.get(object.sha256) ?? { object, roots: [] };
            if (entry.object.size !== object.size) invalid();
            entry.roots.push(rootId);
            result.set(object.sha256, entry);
        }
    }
    return result;
}
export function usesManagedFiles(active: Record<string, unknown>): boolean {
    const values =
        record(active.group) && Array.isArray(active.group.members)
            ? active.group.members.map((member) =>
                  record(member) ? member.installation : undefined,
              )
            : [active.installation];
    return values.some(
        (value) =>
            record(value) &&
            record(value.config) &&
            value.config.mode === "files",
    );
}
export function validateFileObjects(
    metadata: Pick<BackupMetadata, "format" | "active" | "fileObjects">,
): void {
    const expected = selectedFileObjects(metadata.active);
    if (!expected.size && metadata.fileObjects === undefined) return;
    if (
        metadata.format !== 3 ||
        !Array.isArray(metadata.fileObjects) ||
        metadata.fileObjects.length !== expected.size
    )
        invalid();
    const seen = new Set<string>();
    for (const file of metadata.fileObjects) {
        if (
            !record(file) ||
            typeof file.sha256 !== "string" ||
            seen.has(file.sha256) ||
            file.file !== `file-objects/${file.sha256}` ||
            expected.get(file.sha256)?.object.size !== file.size
        )
            invalid();
        seen.add(file.sha256);
    }
}
export async function stageFileObjects(
    active: Record<string, unknown>,
    roots: BackupRoot[],
    directory: string,
    signal?: AbortSignal,
): Promise<BackupMetadata["fileObjects"]> {
    const selected = selectedFileObjects(active);
    if (!selected.size) return usesManagedFiles(active) ? [] : undefined;
    await checkBackupSpace(
        directory,
        [...selected.values()].reduce(
            (sum, entry) => sum + entry.object.size,
            0,
        ),
    );
    await mkdir(path.join(directory, "file-objects"), { mode: 0o700 });
    const files: NonNullable<BackupMetadata["fileObjects"]> = [];
    for (const { object, roots: ids } of selected.values()) {
        signal?.throwIfAborted();
        const root = roots.find(
            (item) => ids.includes(item.id) && item.kind === "directory",
        );
        if (!root) invalid();
        const source = objectPath(path.dirname(root.path), object);
        const file = `file-objects/${object.sha256}`;
        if (
            !snapshotEqual(
                await streamFile(source, path.join(directory, file)),
                object,
            )
        )
            invalid();
        files.push({ file, sha256: object.sha256, size: object.size });
    }
    return files.sort((a, b) => a.file.localeCompare(b.file, "en"));
}
export async function verifyFileObjects(
    metadata: BackupMetadata,
    directory: string,
): Promise<void> {
    validateFileObjects(metadata);
    for (const file of metadata.fileObjects ?? []) {
        if (
            !snapshotEqual(
                await streamFile(await assertNoSymlinks(directory, file.file)),
                { kind: "binary", sha256: file.sha256, size: file.size },
            )
        )
            invalid();
    }
}
export async function restoreFileObjects(
    projectDir: string,
    metadata: BackupMetadata,
    directory: string,
): Promise<void> {
    await verifyFileObjects(metadata, directory);
    for (const file of metadata.fileObjects ?? [])
        await retainObject(
            projectDir,
            await assertNoSymlinks(directory, file.file),
            { kind: "binary", sha256: file.sha256, size: file.size },
        );
}
