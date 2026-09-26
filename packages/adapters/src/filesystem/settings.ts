import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
    CrafleetError,
    flattenSettings,
    type ResolvedSettings,
    type SettingsOverrides,
    settingLimit,
} from "@crafleet/core";
import { parseDocument } from "yaml";
import {
    resolveRuntimeSettings,
    type SettingsInputs,
    settingsInputs,
} from "../settings.js";
import { assertNoSymlinks, exists } from "./io.js";

async function nearest(
    directory: string,
    name: string,
): Promise<string | undefined> {
    for (let current = path.resolve(directory); ; ) {
        const file = path.join(current, name);
        if (await exists(file)) return file;
        const parent = path.dirname(current);
        if (parent === current) return undefined;
        current = parent;
    }
}
async function declaration(
    file: string,
    resolved: ResolvedSettings,
): Promise<Record<string, unknown>> {
    await assertNoSymlinks(path.dirname(file), path.basename(file));
    const maximum = settingLimit(resolved.values, "files.maxYamlBytes");
    if ((await stat(file)).size > maximum)
        throw new CrafleetError(
            "YAML_SIZE",
            `${path.basename(file)} exceeds files.maxYamlBytes (${resolved.values["files.maxYamlBytes"]} bytes). Set its limit in the enclosing workspace, environment or --set.`,
            2,
        );
    const text = await readFile(file, "utf8");
    if (Buffer.byteLength(text) > maximum)
        throw new CrafleetError(
            "YAML_SIZE",
            "Declaration exceeds files.maxYamlBytes.",
            2,
        );
    const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: false });
    if (doc.errors.length)
        throw new CrafleetError(
            "YAML_SYNTAX",
            "Invalid settings declaration YAML; input values omitted.",
            2,
        );
    try {
        const value: unknown = doc.toJS({
            maxAliasCount: resolved.values["files.maxYamlAliases"],
        });
        if (!value || typeof value !== "object" || Array.isArray(value))
            return {};
        return value as Record<string, unknown>;
    } catch {
        throw new CrafleetError(
            "YAML_ALIASES",
            "Declaration exceeds files.maxYamlAliases.",
            2,
        );
    }
}

export async function readRuntimeSettings(
    directory: string,
    inputs: SettingsInputs = settingsInputs(),
    tolerateBrokenDeclaration = false,
): Promise<{
    resolved: ResolvedSettings;
    workspace: ResolvedSettings;
    bootstrap: ResolvedSettings;
}> {
    const bootstrap = resolveRuntimeSettings({}, {}, [], inputs);
    let workspaceValues: SettingsOverrides = {};
    const file = await nearest(directory, "crafleet-workspace.yaml");
    try {
        if (file)
            workspaceValues = flattenSettings(
                (await declaration(file, bootstrap)).settings,
            );
    } catch (error) {
        if (
            !tolerateBrokenDeclaration ||
            !(error instanceof CrafleetError) ||
            error.code.startsWith("SETTINGS_")
        )
            throw error;
    }
    const workspace = resolveRuntimeSettings(workspaceValues, {}, [], inputs);
    let projectValues: SettingsOverrides = {};
    const deprecated: string[] = [];
    const projectFile = await nearest(directory, "crafleet.yaml");
    try {
        if (projectFile) {
            const project = await declaration(projectFile, workspace);
            const java = project.java as Record<string, unknown> | undefined;
            for (const [old, key] of [
                ["startupTimeout", "runtime.startupTimeoutMs"],
                ["stopTimeout", "runtime.stopTimeoutMs"],
            ] as const) {
                if (java && Object.hasOwn(java, old)) {
                    deprecated.push(`java.${old}`);
                    if (typeof java[old] === "number")
                        projectValues[key] = java[old] * 1000;
                }
            }
            projectValues = {
                ...projectValues,
                ...flattenSettings(project.settings),
            };
        }
    } catch (error) {
        if (
            !tolerateBrokenDeclaration ||
            !(error instanceof CrafleetError) ||
            error.code.startsWith("SETTINGS_")
        )
            throw error;
    }
    return {
        resolved: resolveRuntimeSettings(
            workspaceValues,
            projectValues,
            deprecated,
            inputs,
        ),
        workspace,
        bootstrap,
    };
}
