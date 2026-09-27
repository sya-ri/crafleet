import {
    type ProjectManifest,
    parsePluginSource,
    parseServerSource,
    type SourceInput,
} from "@crafleet/core";
import { validatePluginIdentities } from "../settings-validation.js";

export function serverSource(manifest: ProjectManifest): SourceInput {
    return (
        manifest.server.source ?? {
            provider: "paper",
            project: manifest.server.type,
            version: manifest.server.version,
            build: manifest.server.build ?? "latest",
        }
    );
}

export function validateManifestSources(manifest: ProjectManifest): void {
    parseServerSource(serverSource(manifest), manifest.server.type);
    validatePluginIdentities(
        [],
        manifest.server.type,
        Object.keys(manifest.plugins),
    );
    for (const source of Object.values(manifest.plugins))
        parsePluginSource(source);
}
