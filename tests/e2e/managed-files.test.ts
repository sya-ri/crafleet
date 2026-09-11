import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ConfigCaptureResult } from "../../packages/core/src/domain/config.js";
import {
    cleanupRealSuite,
    cli,
    cliError,
    initRealProject,
    prepareRealSuite,
    type RealSuite,
    setupRealBackup,
} from "./real-fixtures.js";

let suite: RealSuite;
beforeAll(async () => {
    suite = await prepareRealSuite();
});
afterEach((context) => {
    if (suite && context.task.result?.state === "fail") suite.failed = true;
});
afterAll(async () => cleanupRealSuite(suite));

describe("managed files through packaged real servers", () => {
    it.each(["paper", "velocity"] as const)(
        "%s migrates, deploys binaries and only captures while stopped",
        async (kind) => {
            const directory = path.join(suite.root, `files-${kind}`);
            await initRealProject(suite, directory, kind, `files-${kind}`);
            await cli(suite, directory, [
                "files",
                "migrate",
                "--from",
                "config",
                "--dry-run",
            ]);
            await cli(suite, directory, [
                "files",
                "migrate",
                "--from",
                "config",
            ]);
            await setupRealBackup(
                suite,
                directory,
                "main",
                path.join(suite.root, `repository-${kind}`),
            );
            const relative = "fixture-data/state.bin";
            await mkdir(path.join(directory, "files/fixture-data"));
            const original = Buffer.alloc(16384, 0x81);
            await writeFile(path.join(directory, "files", relative), original);
            await cli(suite, directory, ["--offline", "install"]);
            await cli(suite, directory, ["start"]);
            expect(
                await readFile(path.join(directory, "runtime", relative)),
            ).toEqual(original);
            await cliError(
                suite,
                directory,
                ["files", "capture"],
                "NOT_STOPPED",
            );
            await cli(suite, directory, ["stop"]);
            const changed = Buffer.alloc(16385, 0x82);
            await writeFile(path.join(directory, "runtime", relative), changed);
            const captured = await cli<ConfigCaptureResult>(suite, directory, [
                "files",
                "capture",
                "--include",
                relative,
                "--keep-missing",
            ]);
            expect(captured.captured).toEqual([relative]);
            expect(
                await readFile(path.join(directory, "files", relative)),
            ).toEqual(changed);
            await cli(suite, directory, ["files", "capture", "--initial"]);
            await cli(suite, directory, [
                "--offline",
                "install",
                "--frozen-lockfile",
            ]);
            await cli(suite, directory, ["start"]);
            expect(
                await readFile(path.join(directory, "runtime", relative)),
            ).toEqual(changed);
            await cli(suite, directory, ["stop"]);
        },
        240000,
    );
});
