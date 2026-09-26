import path from "node:path";
import {
    CrafleetError,
    type ProjectLock,
    parsePluginSource,
    parseServerSource,
    type ServerKind,
} from "@crafleet/core";
import { captureRuntimeSettings, withRuntimeSettings } from "../settings.js";
import { validatePluginSet } from "../settings-validation.js";
import { NodeConfigManager } from "./config.js";
import { exists } from "./io.js";
import { validateManifestSources } from "./manifest-sources.js";
import { type ProjectContext, readLock } from "./projects.js";
import { installationJars, readState } from "./state.js";

export function validateManagedProjectLock(
    lock: ProjectLock,
    serverKind: ServerKind,
): void {
    parseServerSource(lock.server.source, serverKind);
    const identities = Object.entries(lock.plugins).map(([name, artifact]) => {
        parsePluginSource(artifact.source);
        if (!artifact.identity || artifact.identity.id !== name)
            throw new CrafleetError(
                "LOCK_IDENTITY",
                `Lock plugin ${name} does not match its descriptor identity.`,
                2,
            );
        return artifact.identity;
    });
    validatePluginSet(identities, serverKind);
}

async function validateManagedProjectConfigured(project: ProjectContext) {
    if (
        await exists(path.join(project.dir, ".crafleet/import-incomplete.json"))
    )
        throw new CrafleetError(
            "IMPORT_INCOMPLETE",
            "The imported destination is incomplete; it cannot be started safely.",
            4,
        );
    validateManifestSources(project.manifest);
    const lock = (await readLock(project.lockRoot)).projects[project.lockKey];
    const state = await readState(project.dir);
    if (state.active) installationJars(state.active);
    if (state.pending) installationJars(state.pending);
    if (lock) validateManagedProjectLock(lock, project.manifest.server.type);
    const configuration = await new NodeConfigManager(
        project.dir,
        project.manifest.secrets,
        project.manifest.files ? "files" : "config",
    ).diff();
    if (configuration.some((file) => file.conflicts.length))
        throw new CrafleetError(
            "CONFIG_CONFLICT",
            "Managed configuration has conflicts. Run config diff and config resolve.",
            3,
        );
    return {
        project: project.manifest.name,
        valid: true,
        locked: Boolean(lock),
        active: state.active?.id ?? null,
        pending: state.pending?.id ?? null,
        configurations: configuration.length,
    };
}

export const validateManagedProject = (
    ...args: Parameters<typeof validateManagedProjectConfigured>
): ReturnType<typeof validateManagedProjectConfigured> =>
    withRuntimeSettings(args[0].settings ?? captureRuntimeSettings(), () =>
        validateManagedProjectConfigured(...args),
    );
