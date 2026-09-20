import { readFileSync } from "node:fs";

const manifest = JSON.parse(
    readFileSync(
        new URL("../packages/cli/package.json", import.meta.url),
        "utf8",
    ),
);

if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new TypeError("packages/cli/package.json must declare a version.");
}

export const crafleetVersion = manifest.version;
let consoleArtifacts = {};
try {
    const addons = JSON.parse(
        readFileSync(
            new URL("../artifacts/console/manifest.json", import.meta.url),
            "utf8",
        ),
    );
    if (addons.version === crafleetVersion) consoleArtifacts = addons.artifacts;
} catch {
    /* Source tests may run before Java artifacts are built. Release builds build them first. */
}
export const crafleetVersionDefine = {
    __CRAFLEET_VERSION__: JSON.stringify(crafleetVersion),
    __CRAFLEET_CONSOLE_ARTIFACTS__: JSON.stringify(consoleArtifacts),
};
