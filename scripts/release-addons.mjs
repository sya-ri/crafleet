import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crafleetVersion } from "./version.mjs";

// Called after release:prepare has verified the signed tag and exact tarball.
// Existing release assets are immutable: retries verify bytes and never replace them.
const tag = `v${crafleetVersion}`;
const repository = "sya-ri/crafleet";
if (
    process.env.GITHUB_REF_NAME !== tag ||
    process.env.GITHUB_REPOSITORY !== repository
)
    throw new Error("Unexpected addon release identity");
const directory = path.resolve("artifacts/console");
const manifest = JSON.parse(
    await readFile(path.join(directory, "manifest.json"), "utf8"),
);
if (manifest.version !== crafleetVersion)
    throw new Error("Addon version does not match the CLI");
const files = [
    "crafleet-console-paper.jar",
    "crafleet-console-velocity.jar",
    "SHA256SUMS",
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const kind of ["paper", "velocity"]) {
    const bytes = await readFile(
        path.join(directory, `crafleet-console-${kind}.jar`),
    );
    if (
        digest(bytes) !== manifest.artifacts[kind]?.sha256 ||
        bytes.length !== manifest.artifacts[kind]?.size
    )
        throw new Error("Addon artifact changed after the CLI was built");
}
const gh = (args) =>
    execFileSync("gh", args, {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
    });
let existing = false;
try {
    const release = JSON.parse(
        gh(["api", `repos/${repository}/releases/tags/${tag}`]),
    );
    if (release.draft)
        throw new Error(
            "Publish the existing draft release before publishing npm",
        );
    existing = true;
} catch (error) {
    if (!String(error.stderr).includes("HTTP 404")) throw error;
}
if (!existing)
    gh([
        "release",
        "create",
        tag,
        ...files.map((file) => path.join(directory, file)),
        "--repo",
        repository,
        "--verify-tag",
        "--notes-file",
        `docs/releases/${tag}.md`,
        "--title",
        `Crafleet ${crafleetVersion}`,
    ]);
const parent = await realpath(os.tmpdir());
const downloaded = await mkdtemp(path.join(parent, "crafleet-release-addons-"));
try {
    for (const file of files) {
        gh([
            "release",
            "download",
            tag,
            "--repo",
            repository,
            "--pattern",
            file,
            "--dir",
            downloaded,
        ]);
        if (
            digest(await readFile(path.join(downloaded, file))) !==
            digest(await readFile(path.join(directory, file)))
        )
            throw new Error(`Published addon does not match the CLI: ${file}`);
        const response = await fetch(
            `https://github.com/${repository}/releases/download/${tag}/${file}`,
            { signal: AbortSignal.timeout(60000) },
        );
        if (
            !response.ok ||
            digest(Buffer.from(await response.arrayBuffer())) !==
                digest(await readFile(path.join(directory, file)))
        )
            throw new Error(
                `Addon is not publicly retrievable with the expected bytes: ${file}`,
            );
    }
} finally {
    if (path.dirname(await realpath(downloaded)) !== parent)
        console.error(
            "Skipped cleanup: unexpected release verification directory",
        );
    else await rm(downloaded, { recursive: true, force: true });
}
console.log(
    `Verified published console addons for ${tag}; npm publication may proceed.`,
);
