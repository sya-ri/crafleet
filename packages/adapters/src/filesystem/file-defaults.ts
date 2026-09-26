import path from "node:path";
import {
    CrafleetError,
    DEFAULT_SETTINGS,
    fileDefaultEntries,
    mergeConfigValues,
    type ProjectManifest,
} from "@crafleet/core";
import { type } from "arktype";
import { parseConfigDocument } from "../formats/config.js";
import { runtimeLimit } from "../settings.js";
import { assertNoSymlinks, readBoundedRegularFile } from "./io.js";
import { loadConfigSecrets } from "./secrets.js";

export const DEFAULTS_STATE_PATH = ".crafleet/file-defaults.json";
export const MAX_DEFAULTS_STATE_BYTES = DEFAULT_SETTINGS["files.maxStateBytes"];
const StateSchema = type({
    "+": "reject",
    schemaVersion: "1",
    defaults: {
        "[string]": {
            "+": "reject",
            source: "string > 0",
            content: "string",
        },
    },
});

export interface DefaultFileChange {
    relative: string;
    before: string | null;
    after: string;
}

export interface DefaultFileResult {
    relative: string;
    action: "created" | "updated" | "unchanged";
    retained: string[];
}

export interface DefaultFilesPlan {
    bases: ReadonlyMap<string, string>;
    checks: readonly { relative: string; before: string | null }[];
    changes: readonly DefaultFileChange[];
    results: readonly DefaultFileResult[];
}

async function readText(
    root: string,
    relative: string,
): Promise<string | null> {
    const file = await assertNoSymlinks(root, relative);
    const maximum =
        relative === DEFAULTS_STATE_PATH
            ? runtimeLimit("files.maxStateBytes")
            : runtimeLimit("files.maxTextBytes");
    const snapshot = await readBoundedRegularFile(file, {
        maxBytes: maximum,
        failure: () => {
            throw new CrafleetError(
                "FILES_DEFAULTS_INPUT",
                "A default configuration input is not a bounded regular text file.",
                3,
            );
        },
    });
    if (snapshot === null) return null;
    try {
        // Preserve the exact bytes for transaction comparison and rollback.
        return new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
        }).decode(snapshot.bytes);
    } catch {
        throw new CrafleetError(
            "FILES_DEFAULTS_INPUT",
            "A default configuration input cannot be read as bounded UTF-8 text.",
            3,
        );
    }
}

function configText(text: string): string {
    return text.replace(/^\uFEFF/, "");
}

function state(raw: string | null): typeof StateSchema.infer {
    if (raw === null) return { schemaVersion: 1, defaults: {} };
    const invalid = () =>
        new CrafleetError(
            "FILES_DEFAULTS_STATE",
            "Default configuration history is invalid; no inputs were changed.",
            3,
        );
    let input: unknown;
    try {
        input = JSON.parse(configText(raw));
    } catch {
        throw invalid();
    }
    const parsed = StateSchema(input);
    if (parsed instanceof type.errors || Array.isArray(parsed.defaults))
        throw invalid();
    const configuredMaxTextBytes = runtimeLimit("files.maxTextBytes");
    for (const entry of Object.values(parsed.defaults)) {
        if (Buffer.byteLength(entry.content) > configuredMaxTextBytes)
            throw new CrafleetError(
                "FILES_DEFAULTS_STATE",
                `Stored defaults exceed files.maxTextBytes (${configuredMaxTextBytes}); raise this setting before reading or restoring them.`,
                3,
            );
    }
    fileDefaultEntries(
        Object.fromEntries(
            Object.entries(parsed.defaults).map(([relative, entry]) => [
                relative,
                entry.source,
            ]),
        ),
    );
    return parsed;
}

/** Plan local saved files without changing them before the installation commits. */
export async function prepareFileDefaults(
    projectDir: string,
    manifest: ProjectManifest,
): Promise<DefaultFilesPlan> {
    const entries = fileDefaultEntries(manifest.files?.defaults);
    const bases = new Map<string, string>();
    const checks: { relative: string; before: string | null }[] = [];
    const changes: DefaultFileChange[] = [];
    const results: DefaultFileResult[] = [];
    if (entries.length === 0) return { bases, checks, changes, results };
    const previousText = await readText(projectDir, DEFAULTS_STATE_PATH);
    const previous = state(previousText);
    const next: typeof StateSchema.infer = {
        schemaVersion: 1,
        defaults: Object.create(null),
    };
    const secrets = await loadConfigSecrets(projectDir, manifest.secrets);
    checks.push({ relative: DEFAULTS_STATE_PATH, before: previousText });
    const configuredMaxTextBytes2 = runtimeLimit("files.maxTextBytes");
    for (const { relative, source } of entries) {
        const example = await readText(projectDir, source);
        if (example === null)
            throw new CrafleetError(
                "FILES_DEFAULTS_MISSING",
                `Default configuration example is missing: ${source}`,
                3,
            );
        const destination = `files/${relative}`;
        const local = await readText(projectDir, destination);
        checks.push(
            { relative: source, before: example },
            { relative: destination, before: local },
        );
        secrets.assertTemplate(relative, configText(example));
        const latest = parseConfigDocument(relative, configText(example));
        let output = example;
        let retained: string[] = [];
        if (local !== null) {
            secrets.assertTemplate(relative, configText(local));
            const current = parseConfigDocument(relative, configText(local));
            const old = previous.defaults[relative];
            output = local;
            if (old?.source === source) {
                secrets.assertTemplate(relative, configText(old.content));
                const merged = mergeConfigValues(
                    parseConfigDocument(relative, configText(old.content))
                        .value,
                    current.value,
                    latest.value,
                );
                // The left side wins overlapping edits; arrays remain atomic.
                output = `${local.startsWith("\uFEFF") ? "\uFEFF" : ""}${current.render(merged.value)}`;
                retained = merged.conflicts.map((pointer) =>
                    secrets.redact(pointer),
                );
            }
        }
        if (Buffer.byteLength(output) > configuredMaxTextBytes2)
            throw new CrafleetError(
                "FILES_DEFAULTS_INPUT",
                "The merged default configuration exceeds its size limit.",
                3,
            );
        secrets.assertTemplate(relative, configText(output));
        // Match the BOM-free snapshots read by the managed-file layer.
        bases.set(relative, configText(output));
        next.defaults[relative] = { source, content: example };
        if (output !== local)
            changes.push({
                relative: destination,
                before: local,
                after: output,
            });
        results.push({
            relative,
            action:
                local === null
                    ? "created"
                    : output === local
                      ? "unchanged"
                      : "updated",
            retained,
        });
    }
    const nextText = `${JSON.stringify(next, null, 2)}\n`;
    if (Buffer.byteLength(nextText) > runtimeLimit("files.maxStateBytes"))
        throw new CrafleetError(
            "FILES_DEFAULTS_STATE",
            "Default configuration history exceeds its size limit.",
            3,
        );
    if (nextText !== previousText)
        changes.push({
            relative: DEFAULTS_STATE_PATH,
            before: previousText,
            after: nextText,
        });
    return { bases, checks, changes, results };
}

export async function assertFileDefaultsUnchanged(
    projectDir: string,
    plan: DefaultFilesPlan,
): Promise<void> {
    for (const input of plan.checks)
        if ((await readText(projectDir, input.relative)) !== input.before)
            throw new CrafleetError(
                "CONCURRENT_EDIT",
                "A default example, local configuration or its history changed during install. Retry without overwriting the newer input.",
                3,
            );
}

/** Recovery may touch only generated structured files or their bounded history. */
export function isDefaultTransactionPath(relative: string): boolean {
    if (/(^|\/)\.crafleet\/file-defaults\.json$/.test(relative)) return true;
    const marker = relative.indexOf("files/");
    if (marker < 0 || (marker > 0 && relative[marker - 1] !== "/"))
        return false;
    const destination = relative.slice(marker + "files/".length);
    try {
        fileDefaultEntries({
            [destination]: `examples/${path.posix.basename(destination)}`,
        });
        return true;
    } catch {
        return false;
    }
}
