import { lstat } from "node:fs/promises";
import {
    type ArtifactContext,
    type ArtifactStore,
    type BackupArtifacts,
    type BackupConfig,
    type BackupMetadata,
    type BackupPlan,
    type BackupRoot,
    CrafleetError,
    type LockedArtifact,
} from "@crafleet/core";
import {
    checkBackupSpace,
    hashBackupFile,
    stageBackupPlan,
} from "./backup-files.js";
import { assertNoSymlinks, exists } from "./io.js";
import { installationJars, validateInstallation } from "./state.js";

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function selectedBackupArtifacts(
    active: Record<string, unknown>,
    policy: "local" | "all",
) {
    const installations: { rootId: string; installation: unknown }[] = [];
    if (
        record(active.group) &&
        Array.isArray(active.group.members) &&
        !Object.hasOwn(active, "installation")
    ) {
        if (!active.group.members.length || active.group.members.length > 512)
            throw new CrafleetError(
                "BACKUP_ARTIFACTS",
                "Invalid recovery group artifact metadata.",
                3,
            );
        const roots = new Set<string>();
        for (const member of active.group.members) {
            if (
                !record(member) ||
                typeof member.runtimeRootId !== "string" ||
                roots.has(member.runtimeRootId)
            )
                throw new CrafleetError(
                    "BACKUP_ARTIFACTS",
                    "Invalid or duplicate artifact runtime root.",
                    3,
                );
            roots.add(member.runtimeRootId);
            installations.push({
                rootId: member.runtimeRootId,
                installation: member.installation,
            });
        }
    } else if (!Object.hasOwn(active, "group")) {
        installations.push({
            rootId: "runtime",
            installation: active.installation,
        });
    } else
        throw new CrafleetError(
            "BACKUP_ARTIFACTS",
            "Invalid active installation metadata.",
            3,
        );
    const selected = new Map<
        string,
        {
            artifact: LockedArtifact;
            locations: { rootId: string; relative: string }[];
        }
    >();
    for (const item of installations) {
        if (item.installation === null || item.installation === undefined)
            continue;
        for (const [relative, artifact] of installationJars(
            validateInstallation(item.installation),
        )) {
            if (policy === "local" && artifact.source.provider !== "file")
                continue;
            const found = selected.get(artifact.sha256);
            if (found && found.artifact.size !== artifact.size)
                throw new CrafleetError(
                    "BACKUP_ARTIFACTS",
                    "Active artifacts disagree about a shared hash's size.",
                    3,
                );
            const entry = found ?? { artifact, locations: [] };
            entry.locations.push({ rootId: item.rootId, relative });
            selected.set(artifact.sha256, entry);
        }
    }
    return selected;
}

/** Embedded files must be exactly the selected active hashes, including empty selections. */
export function validateBackupArtifacts(
    value: unknown,
    active: Record<string, unknown>,
): BackupArtifacts {
    if (
        !record(value) ||
        !["local", "all"].includes(String(value.policy)) ||
        !Array.isArray(value.files) ||
        value.files.length > 250000 ||
        Object.keys(value).some((key) => !["policy", "files"].includes(key))
    )
        throw new CrafleetError(
            "BACKUP_ARTIFACTS",
            "Invalid embedded artifact manifest.",
            3,
        );
    const expected = selectedBackupArtifacts(
        active,
        value.policy as "local" | "all",
    );
    if (expected.size !== value.files.length)
        throw new CrafleetError(
            "BACKUP_ARTIFACTS",
            "Embedded artifacts do not cover exactly the selected active installation.",
            3,
        );
    const seen = new Set<string>();
    for (const file of value.files) {
        if (
            !record(file) ||
            typeof file.sha256 !== "string" ||
            !/^[a-f0-9]{64}$/u.test(file.sha256) ||
            file.file !== `artifacts/${file.sha256}.jar` ||
            !Number.isSafeInteger(file.size) ||
            expected.get(file.sha256)?.artifact.size !== file.size ||
            seen.has(file.sha256) ||
            Object.keys(file).some(
                (key) => !["file", "sha256", "size"].includes(key),
            )
        )
            throw new CrafleetError(
                "BACKUP_ARTIFACTS",
                "An embedded artifact is duplicated, unrelated, or inconsistent with active metadata.",
                3,
            );
        seen.add(file.sha256);
    }
    return value as unknown as BackupArtifacts;
}

/** Copy installed bytes through the same bounded, identity-checked stager as world files. */
export async function stageInstallationArtifacts(
    active: Record<string, unknown>,
    roots: BackupRoot[],
    policy: BackupConfig["artifacts"],
    directory: string,
    signal?: AbortSignal,
): Promise<BackupArtifacts | undefined> {
    if (policy === undefined || policy === "none") return undefined;
    if (policy !== "local" && policy !== "all")
        throw new CrafleetError(
            "BACKUP_ARTIFACTS",
            "Choose none, local, or all artifacts.",
            2,
        );
    const selected = selectedBackupArtifacts(active, policy);
    const files: BackupPlan["files"] = [];
    for (const { artifact, locations } of selected.values()) {
        signal?.throwIfAborted();
        let source: string | undefined;
        for (const location of locations) {
            const root = roots.find(
                (item) =>
                    item.id === location.rootId && item.kind === "directory",
            );
            if (!root)
                throw new CrafleetError(
                    "BACKUP_ARTIFACTS",
                    "An active artifact has no declared runtime root.",
                    3,
                );
            const candidate = await assertNoSymlinks(
                root.path,
                location.relative,
            );
            if (await exists(candidate)) {
                source = candidate;
                break;
            }
        }
        if (!source)
            throw new CrafleetError(
                "BACKUP_ARTIFACT_MISSING",
                "An active JAR is missing from its installed runtime. No pending or newer artifact was substituted.",
                3,
            );
        const info = await lstat(source);
        if (!info.isFile() || info.size !== artifact.size)
            throw new CrafleetError(
                "BACKUP_ARTIFACT_HASH",
                "An installed JAR differs from active metadata.",
                3,
            );
        files.push({
            source,
            destination: `artifacts/${artifact.sha256}.jar`,
            rootId: "artifacts",
            size: info.size,
            mtimeMs: info.mtimeMs,
            ctimeMs: info.ctimeMs,
            device: info.dev,
            inode: info.ino,
            mode: 0o600,
            matchedRule: 0,
        });
    }
    const bytes = files.reduce((sum, file) => sum + file.size, 0);
    await checkBackupSpace(directory, bytes);
    const staged = await stageBackupPlan(
        {
            roots: [],
            files,
            bytes,
            stagingBytes: bytes,
            databaseIds: [],
            warnings: [],
        },
        directory,
        signal,
    );
    for (const file of staged)
        if (
            file.destination !== `artifacts/${file.sha256}.jar` ||
            selected.get(file.sha256)?.artifact.size !== file.size
        )
            throw new CrafleetError(
                "BACKUP_ARTIFACT_HASH",
                "An installed JAR does not match its active checksum. The snapshot was not created.",
                3,
            );
    return {
        policy,
        files: staged.map(({ destination, sha256, size }) => ({
            file: destination,
            sha256,
            size,
        })),
    };
}

export async function verifyEmbeddedArtifacts(
    metadata: BackupMetadata,
    directory: string,
): Promise<Map<string, string>> {
    const sources = new Map<string, string>();
    for (const file of metadata.artifacts?.files ?? []) {
        const source = await assertNoSymlinks(directory, file.file);
        const integrity = await hashBackupFile(source);
        if (integrity.sha256 !== file.sha256 || integrity.bytes !== file.size)
            throw new CrafleetError(
                "RESTORE_HASH",
                "An embedded JAR does not match its snapshot hash and size.",
                3,
            );
        sources.set(file.sha256, source);
    }
    return sources;
}

export async function restoreArtifactSource(
    artifact: LockedArtifact,
    embedded: ReadonlyMap<string, string>,
    store: ArtifactStore,
    context: ArtifactContext,
): Promise<string> {
    const seed = embedded.get(artifact.sha256);
    if (seed) {
        const integrity = await hashBackupFile(await assertNoSymlinks(seed));
        if (
            integrity.sha256 !== artifact.sha256 ||
            integrity.bytes !== artifact.size
        )
            throw new CrafleetError(
                "RESTORE_HASH",
                "An embedded JAR changed after extraction verification.",
                3,
            );
    }
    const source = seed
        ? await store.ensure(artifact, context, seed)
        : await store.ensure(artifact, context);
    const integrity = await hashBackupFile(await assertNoSymlinks(source));
    if (
        integrity.sha256 !== artifact.sha256 ||
        integrity.bytes !== artifact.size
    )
        throw new CrafleetError(
            "RESTORE_HASH",
            "An exact active JAR is unavailable at its recorded hash and size.",
            3,
        );
    return source;
}
