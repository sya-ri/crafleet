import { mkdir, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import {
    assertStopped,
    CrafleetError,
    stableStringify,
    validateConfigState,
    validateProject,
} from "@crafleet/core";
import { type } from "arktype";
import { parseDocument } from "yaml";
import { NodeServerController } from "../runtime/controller.js";
import { normalizeConfigRelative } from "./config.js";
import { streamFile } from "./file-content.js";
import {
    assertNoSymlinks,
    atomicWrite,
    exists,
    listFiles,
    readBoundedRegularFile,
    withMutex,
    writeJson,
} from "./io.js";
import { type ProjectContext, recoveryJournalPaths } from "./projects.js";
import { parseStateText } from "./state.js";

const Journal = type({
    "+": "reject",
    schemaVersion: "1",
    projectDir: "string",
    hadConfig: "boolean",
    manifest: { before: "string", after: "string" },
    state: { before: "string | null", after: "string | null" },
    observations: "string | null",
    files: type({
        relative: "string",
        sha256: /^[a-f0-9]{64}$/,
        size: "number.integer >= 0",
    }).array(),
});
function invalid(): never {
    throw new CrafleetError(
        "FILES_MIGRATION_CHANGED",
        "Migration inputs changed or the journal is invalid. Preserve the files and inspect before retrying.",
        3,
    );
}
async function text(file: string): Promise<string | null> {
    const result = await readBoundedRegularFile(file, {
        maxBytes: 96 * 1024 * 1024,
        failure: invalid,
    });
    return result
        ? new TextDecoder("utf-8", { fatal: true }).decode(result.bytes)
        : null;
}
function migrateManifest(value: ReturnType<typeof validateProject>) {
    if (value.files) invalid();
    const { config, ...rest } = value;
    return validateProject({
        ...rest,
        files: config ? { patterns: config.files } : {},
    });
}
async function tree(root: string) {
    const result = [];
    for (const relative of await listFiles(root)) {
        normalizeConfigRelative(relative);
        const content = await streamFile(
            await assertNoSymlinks(root, relative),
        );
        result.push({ relative, sha256: content.sha256, size: content.size });
    }
    return result;
}

/** Explicit, restartable conversion. Runtime and artifact resolutions are never written. */
export async function migrateFiles(
    project: ProjectContext,
    options: {
        dryRun?: boolean;
        rollback?: boolean;
        checkpoint?: (stage: string) => Promise<void>;
    } = {},
) {
    const journalFile = path.join(
        project.dir,
        ".crafleet/files-migration.json",
    );
    const manifestFile = path.join(project.dir, "crafleet.yaml");
    const stateFile = path.join(project.dir, ".crafleet/state.json");
    const oldObservations = path.join(
        project.dir,
        ".crafleet/config-state.json",
    );
    const newObservations = path.join(
        project.dir,
        ".crafleet/files-state.json",
    );
    const configRoot = path.join(project.dir, "config");
    const filesRoot = path.join(project.dir, "files");
    const operation = async () => {
        assertStopped(
            (await new NodeServerController(project.dir, project.home).status())
                .status,
        );
        for (const candidate of recoveryJournalPaths(project))
            if (candidate !== journalFile && (await exists(candidate)))
                throw new CrafleetError(
                    "RECOVERY_REQUIRED",
                    "Recover the existing operation before migrating configuration.",
                    3,
                );
        for (const candidate of [
            configRoot,
            filesRoot,
            oldObservations,
            newObservations,
            stateFile,
            journalFile,
            manifestFile,
        ])
            await assertNoSymlinks(candidate);
        const saved = await text(journalFile);
        let journal: typeof Journal.infer;
        if (saved !== null) {
            let input: unknown;
            try {
                input = JSON.parse(saved);
            } catch {
                invalid();
            }
            const parsed = Journal(input);
            if (
                parsed instanceof type.errors ||
                parsed.projectDir !== project.dir
            )
                invalid();
            journal = parsed;
            for (const file of journal.files)
                normalizeConfigRelative(file.relative);
            parseStateText(journal.state.before);
            parseStateText(journal.state.after);
            if (journal.observations)
                validateConfigState(JSON.parse(journal.observations));
            for (const declaration of [
                journal.manifest.before,
                journal.manifest.after,
            ])
                validateProject(parseDocument(declaration).toJS());
        } else {
            if (project.manifest.files) {
                if (
                    (await exists(configRoot)) ||
                    (await exists(oldObservations))
                )
                    invalid();
                return { migrated: false, alreadyMigrated: true, files: 0 };
            }
            if (options.rollback)
                throw new CrafleetError(
                    "FILES_MIGRATION_MISSING",
                    "There is no interrupted migration to roll back.",
                    3,
                );
            if ((await exists(filesRoot)) || (await exists(newObservations)))
                throw new CrafleetError(
                    "FILES_MIGRATION_COLLISION",
                    "files/ or its observations already exist; migration will not overwrite them.",
                    3,
                );
            const before = await text(manifestFile);
            if (
                before === null ||
                (project.manifestText !== undefined &&
                    before !== project.manifestText)
            )
                invalid();
            const document = parseDocument(before, {
                prettyErrors: false,
                uniqueKeys: true,
            });
            const current = validateProject(document.toJS());
            const next = migrateManifest(current);
            const patterns = document.getIn(["config", "files"], true);
            document.delete("config");
            document.set("files", {});
            if (patterns) document.setIn(["files", "patterns"], patterns);
            validateProject(document.toJS());
            const stateBefore = await text(stateFile);
            const state = parseStateText(stateBefore);
            for (const installation of [state.active, state.pending])
                if (installation) {
                    installation.manifest = migrateManifest(
                        installation.manifest,
                    );
                    installation.config = {
                        ...installation.config,
                        mode: "files",
                    };
                }
            const observations = await text(oldObservations);
            if (observations) validateConfigState(JSON.parse(observations));
            journal = {
                schemaVersion: 1,
                projectDir: project.dir,
                hadConfig: await exists(configRoot),
                manifest: { before, after: document.toString() },
                state: {
                    before: stateBefore,
                    after:
                        stateBefore === null
                            ? null
                            : `${JSON.stringify(state, null, 4)}\n`,
                },
                observations,
                files: await tree(configRoot),
            };
            // Cross-check the rendered declaration against the semantic conversion.
            if (
                stableStringify(validateProject(document.toJS())) !==
                stableStringify(next)
            )
                invalid();
        }
        const originalManifest = validateProject(
            parseDocument(journal.manifest.before).toJS(),
        );
        if (
            stableStringify(migrateManifest(originalManifest)) !==
            stableStringify(
                validateProject(parseDocument(journal.manifest.after).toJS()),
            )
        )
            invalid();
        const expectedState = parseStateText(journal.state.before);
        for (const installation of [
            expectedState.active,
            expectedState.pending,
        ]) {
            if (!installation) continue;
            installation.manifest = migrateManifest(installation.manifest);
            installation.config = { ...installation.config, mode: "files" };
        }
        if (
            stableStringify(expectedState) !==
            stableStringify(parseStateText(journal.state.after))
        )
            invalid();
        const assertInputs = async () => {
            const currentRoot = (await exists(configRoot))
                ? configRoot
                : filesRoot;
            if ((await exists(configRoot)) && (await exists(filesRoot)))
                invalid();
            if (
                JSON.stringify(await tree(currentRoot)) !==
                JSON.stringify(journal.files)
            )
                invalid();
            for (const [file, versions] of [
                [
                    manifestFile,
                    [journal.manifest.before, journal.manifest.after],
                ],
                [stateFile, [journal.state.before, journal.state.after]],
                [oldObservations, [journal.observations, null]],
                [newObservations, [journal.observations, null]],
            ] as const) {
                if (
                    !(versions as readonly (string | null)[]).includes(
                        await text(file),
                    )
                )
                    invalid();
            }
        };
        await assertInputs();
        const result = {
            migrated: !options.rollback,
            rollback: Boolean(options.rollback),
            files: journal.files.length,
            paths: journal.files.map((file) => file.relative),
            runtimeChanged: false,
        };
        if (options.dryRun) return result;
        if (saved === null) {
            await writeJson(journalFile, journal);
            await options.checkpoint?.("journal");
        }
        await assertInputs();
        const from = options.rollback ? filesRoot : configRoot;
        const to = options.rollback ? configRoot : filesRoot;
        if (await exists(from)) {
            await assertNoSymlinks(from);
            await assertNoSymlinks(to);
            await rename(from, to);
        } else if (!options.rollback && !(await exists(to)))
            await mkdir(to, { mode: 0o700 });
        await options.checkpoint?.("tree");
        await assertInputs();
        const state = options.rollback
            ? journal.state.before
            : journal.state.after;
        if (state !== null) await atomicWrite(stateFile, state);
        const destination = options.rollback
            ? oldObservations
            : newObservations;
        const previous = options.rollback ? newObservations : oldObservations;
        if (journal.observations !== null)
            await atomicWrite(destination, journal.observations);
        await rm(previous, { force: true });
        await options.checkpoint?.("state");
        await assertInputs();
        await atomicWrite(
            manifestFile,
            options.rollback ? journal.manifest.before : journal.manifest.after,
        );
        await options.checkpoint?.("manifest");
        await assertInputs();
        if (
            options.rollback &&
            !journal.hadConfig &&
            (await exists(configRoot))
        )
            await rmdir(configRoot); // Only an empty directory created by this migration.
        await rm(journalFile);
        return result;
    };
    return options.dryRun
        ? operation()
        : withMutex(
              path.join(project.lockRoot, ".crafleet/operation.lock"),
              () =>
                  withMutex(
                      path.join(project.dir, ".crafleet/config-mutex"),
                      () =>
                          withMutex(
                              path.join(project.dir, ".crafleet/files-mutex"),
                              operation,
                          ),
                  ),
          );
}
