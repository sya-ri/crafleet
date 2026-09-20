import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
    NodeArtifactStore,
    NodeServerController,
    readConsoleHistory,
    readState,
    saveConsoleCommand,
} from "@crafleet/adapters";
import {
    addonSource,
    CONSOLE_ADDON_IDS,
    CRAFLEET_VERSION,
    type ServerStatus,
    stableStringify,
} from "@crafleet/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
    loadProject,
    readLock,
    writeYaml,
} from "../../packages/adapters/src/filesystem/projects.js";
import {
    cleanupRealSuite,
    cli,
    initRealProject,
    prepareRealSuite,
    type RealSuite,
} from "./real-fixtures.js";

let suite: RealSuite;
beforeAll(async () => {
    suite = await prepareRealSuite();
});
afterEach((context) => {
    if (suite && context.task.result?.state === "fail") suite.failed = true;
});
afterAll(async () => {
    if (suite) await cleanupRealSuite(suite);
});

describe("console addon lifecycle through the distributable CLI", () => {
    it.each(["paper", "velocity"] as const)(
        "%s installs offline without restarting, connects after restart, and removes without losing data",
        async (kind) => {
            const directory = path.join(suite.root, `console-${kind}`);
            await initRealProject(suite, directory, kind, `console-${kind}`);
            await cli(suite, directory, ["install"]);
            await cli(suite, directory, ["start"]);
            const controller = new NodeServerController(directory, suite.home);
            const before = await controller.status();
            expect(before.status).toBe("running");
            expect((await controller.capabilities()).completion).toBe(false);
            // Seed the exact built release bytes in this isolated offline cache and lock.
            // This exercises the real installer without publishing test GitHub releases.
            const project = await loadProject(directory, suite.home);
            const store = new NodeArtifactStore(suite.home);
            const artifact = await store.resolve(
                `file:${path.resolve(`artifacts/console/crafleet-console-${kind}.jar`)}`,
                { projectDir: directory, serverKind: kind },
            );
            await store.ensure(artifact, {
                projectDir: directory,
                serverKind: kind,
            });
            const source = addonSource(kind, CRAFLEET_VERSION);
            const id = CONSOLE_ADDON_IDS[kind];
            const lock = await readLock(project.lockRoot);
            const locked = lock.projects[project.lockKey];
            if (!locked) throw new Error("Missing prepared server lock");
            locked.plugins[id] = { ...artifact, source };
            locked.requests.plugins[id] = stableStringify(source);
            await writeYaml(
                path.join(project.lockRoot, "crafleet-lock.yaml"),
                lock,
            );

            expect(
                await cli(suite, directory, [
                    "addons",
                    "add",
                    "console",
                    "--offline",
                ]),
            ).toMatchObject({ items: [{ outcome: "prepared" }] });
            const during = await controller.status();
            expect(during.javaPid).toBe(before.javaPid);
            expect(during.activeId).toBe(before.activeId);
            expect((await controller.capabilities()).completion).toBe(false);
            expect((await readState(directory)).pending).toBeDefined();
            await cli(suite, directory, ["restart"]);
            await expect
                .poll(
                    async () => (await controller.capabilities()).completion,
                    { timeout: 15000 },
                )
                .toBe(true);
            const line = kind === "paper" ? "st suffix" : "vel suffix";
            const cursor = kind === "paper" ? 2 : 3;
            const suggestions = await controller.completeCommand({
                line,
                cursor,
            });
            expect(suggestions.length).toBeGreaterThan(0);
            expect(suggestions.every((item) => item.end <= cursor)).toBe(true);
            expect(
                (await cli<ServerStatus>(suite, directory, ["status"])).status,
            ).toBe("running");
            await cli(suite, directory, [
                "command",
                kind === "paper" ? "version" : "velocity version",
            ]);
            await saveConsoleCommand(directory, "list");
            const data = path.join(directory, "runtime/plugins", id);
            await mkdir(data, { recursive: true });
            await writeFile(path.join(data, "preserved.txt"), "keep\n");
            await cli(suite, directory, [
                "addons",
                "remove",
                "console",
                "--offline",
            ]);
            expect((await controller.capabilities()).completion).toBe(true);
            await cli(suite, directory, ["restart"]);
            expect((await controller.capabilities()).completion).toBe(false);
            expect(await readConsoleHistory(directory)).toEqual(["list"]);
            expect(
                await readFile(path.join(data, "preserved.txt"), "utf8"),
            ).toBe("keep\n");
            await cli(suite, directory, ["stop"]);
        },
    );
});
