import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const mode = process.argv[2];
if (!["format", "check", "fix"].includes(mode))
    throw new Error("Expected format, check or fix");
// Explicit targets protect runtime data, downloads, backups, and verbatim fixtures.
const targets = [
    "addons",
    "packages/core/src",
    "packages/adapters/src",
    "packages/cli/src",
    "scripts",
    "tests/integration",
    "tests/e2e",
    "tests/support",
    "package.json",
    "packages/core/package.json",
    "packages/adapters/package.json",
    "packages/cli/package.json",
    "biome.json",
    "tsconfig.json",
    "tsdown.config.ts",
    "vitest.config.ts",
    ".pnpmfile.mjs",
];
const args = [
    mode === "format" ? "format" : "check",
    ...(mode === "check" ? [] : ["--write"]),
    ...targets,
];
const result = spawnSync(
    process.execPath,
    [require.resolve("@biomejs/biome/bin/biome"), ...args],
    { stdio: "inherit", windowsHide: true },
);
if (result.error) throw result.error;
const java = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./java-quality.mjs", import.meta.url)), mode],
    { stdio: "inherit", windowsHide: true },
);
if (java.error) throw java.error;
process.exitCode = (result.status ?? 1) || (java.status ?? 1);
