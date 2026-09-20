import { createHash } from "node:crypto";
import {
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
    inspectAddon,
    manageAddons,
    NodeArtifactStore,
} from "@crafleet/adapters";
import {
    type ArtifactStore,
    addonSource,
    CRAFLEET_VERSION,
    type LockedArtifact,
    parseSource,
    type SourceInput,
    stableStringify,
} from "@crafleet/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    initProject,
    initWorkspace,
    readLock,
    loadProject as readProject,
    writeYaml,
} from "../../packages/adapters/src/filesystem/projects.js";
import { readState } from "../../packages/adapters/src/filesystem/state.js";
import { artifactJar, artifactZip } from "./artifacts-fixture.js";

const roots: string[] = [];
const parent = path.resolve(".test-tmp");
afterEach(async () => {
    for (const root of roots.splice(0)) {
        if (path.dirname(root) !== (await realpath(parent)))
            throw new Error("Unsafe cleanup");
        await rm(root, { recursive: true, force: true });
    }
});
async function directory() {
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(path.join(await realpath(parent), "addons-"));
    roots.push(root);
    return root;
}
const loadProject = (dir: string) =>
    readProject(dir, path.join(path.dirname(dir), "home"));
async function project(
    root: string,
    name = "server",
    version = "1.8.8",
    type: "paper" | "velocity" = "paper",
) {
    const dir = path.join(root, name);
    await initProject(dir, { name, kind: type, version });
    return loadProject(dir);
}
function fixtureStore(root: string) {
    const files = new Map<string, string>();
    const inspector = new NodeArtifactStore(path.join(root, "home"));
    const store = {
        resolve: vi.fn(async (input: SourceInput): Promise<LockedArtifact> => {
            const source = parseSource(input);
            let bytes: Buffer;
            let version: string;
            if (source.provider === "paper") {
                if (source.version === "latest") source.version = "1.8.8";
                if (source.build === "latest")
                    source.build = source.project === "paper" ? "443" : "507";
                version = source.build;
                bytes = artifactZip([
                    {
                        name: "META-INF/MANIFEST.MF",
                        content: "Manifest-Version: 1.0\n",
                    },
                ]);
            } else if (source.provider === "github") {
                version = source.version.replace(/^v/u, "");
                bytes =
                    version === CRAFLEET_VERSION
                        ? await readFile(`artifacts/console/${source.asset}`)
                        : artifactJar("CrafleetConsole", version);
            } else throw new Error("Unexpected fixture source");
            const sha256 = createHash("sha256").update(bytes).digest("hex");
            const file = path.join(root, `${sha256}.jar`);
            await writeFile(file, bytes);
            files.set(sha256, file);
            return {
                source,
                version,
                sha256,
                size: bytes.length,
                ...(source.provider === "paper"
                    ? {}
                    : { identity: await inspector.inspect(file) }),
            };
        }),
        ensure: vi.fn(async (artifact: LockedArtifact) => {
            const file = files.get(artifact.sha256);
            if (!file) throw new Error("Offline cache miss");
            await readFile(file);
            return file;
        }),
        inspect: inspector.inspect.bind(inspector),
        latest: vi.fn(async () => {
            throw new Error(
                "Addons must use the bundled catalog, not latest-provider queries",
            );
        }),
    } satisfies ArtifactStore;
    return store;
}
describe("official addon installation transactions", () => {
    it("rejects a lock changed during compatibility resolution instead of installing a different build", async () => {
        const root = await directory();
        const server = await project(
            root,
            "proxy",
            "3.4.0-SNAPSHOT",
            "velocity",
        );
        const store = fixtureStore(root);
        const resolve = store.resolve.getMockImplementation();
        if (!resolve) throw new Error("Missing fixture resolver");
        store.resolve.mockImplementation(async (input) => {
            const request = stableStringify(parseSource(input));
            const artifact = await resolve(input);
            if (artifact.source.provider === "paper") {
                await writeYaml(
                    path.join(server.lockRoot, "crafleet-lock.yaml"),
                    {
                        lockVersion: 1,
                        projects: {
                            [server.lockKey]: {
                                name: server.manifest.name,
                                requests: { server: request, plugins: {} },
                                server: {
                                    ...artifact,
                                    source: {
                                        ...artifact.source,
                                        build: "506",
                                    },
                                    version: "506",
                                },
                                plugins: {},
                            },
                        },
                    },
                );
            }
            return artifact;
        });
        await expect(
            manageAddons([server], store, "add", ["console"]),
        ).rejects.toMatchObject({ code: "CONCURRENT_EDIT" });
        expect((await loadProject(server.dir)).manifest.plugins).toEqual({});
        expect((await readState(server.dir)).pending).toBeUndefined();
        expect(
            (await readLock(server.lockRoot)).projects[server.lockKey]?.server
                .version,
        ).toBe("506");
        expect(store.ensure).not.toHaveBeenCalled();
    });
    it("prepares add, reuses the resolved server, repeats idempotently and removes without deleting history/data", async () => {
        const root = await directory();
        let server = await project(root);
        const store = fixtureStore(root);
        const added = await manageAddons([server], store, "add", ["console"]);
        expect(added.items[0]).toMatchObject({
            outcome: "prepared",
            after: CRAFLEET_VERSION,
            server: { version: "1.8.8", build: "443" },
        });
        expect(
            store.resolve.mock.calls.filter(
                ([input]) => parseSource(input).provider === "paper",
            ),
        ).toHaveLength(1);
        server = await loadProject(server.dir);
        expect(server.manifest.plugins.CrafleetConsole).toEqual(
            addonSource("paper", CRAFLEET_VERSION),
        );
        const pending = (await readState(server.dir)).pending;
        expect(pending).toBeDefined();
        expect((await readState(server.dir)).active).toBeUndefined();
        expect(
            (await manageAddons([server], store, "add", ["console"])).items[0]
                ?.outcome,
        ).toBe("unchanged");
        expect(
            (await manageAddons([server], store, "update", [])).items[0]
                ?.outcome,
        ).toBe("unchanged");
        expect(store.latest).not.toHaveBeenCalled();
        await writeFile(
            path.join(server.dir, ".crafleet/console-history.json"),
            "history",
        );
        await manageAddons([server], store, "remove", ["console"]);
        expect((await loadProject(server.dir)).manifest.plugins).toEqual({});
        expect(
            await readFile(
                path.join(server.dir, ".crafleet/console-history.json"),
                "utf8",
            ),
        ).toBe("history");
        expect(
            (
                await manageAddons(
                    [await loadProject(server.dir)],
                    store,
                    "remove",
                    ["console"],
                )
            ).items[0]?.outcome,
        ).toBe("unchanged");
    });
    it("skips unsupported projects while atomically preparing eligible workspace members", async () => {
        const root = await directory();
        await initWorkspace(root, ["servers/*"]);
        const good = await project(path.join(root, "servers"), "good");
        const old = await project(path.join(root, "servers"), "old", "1.7.10");
        const result = await manageAddons(
            [good, old],
            fixtureStore(root),
            "add",
            ["console"],
        );
        expect(result.summary).toEqual({
            unresolved: 0,
            prepared: 1,
            unchanged: 0,
            skipped: 1,
        });
        expect(result.noEligibleTargets).toBe(false);
        expect(result.items[1]?.reason).toContain("1.7.10");
        expect((await loadProject(old.dir)).manifest.plugins).toEqual({});
        expect(
            (await manageAddons([old], fixtureStore(root), "add", ["console"]))
                .noEligibleTargets,
        ).toBe(true);
    });
    it("dry-run never resolves/downloads/writes and identifies unresolved snapshot builds", async () => {
        const root = await directory();
        const server = await project(root);
        const velocity = await project(
            root,
            "proxy",
            "3.4.0-SNAPSHOT",
            "velocity",
        );
        const store = fixtureStore(root);
        expect(
            (
                await manageAddons([server], store, "add", ["console"], {
                    dryRun: true,
                })
            ).items[0]?.outcome,
        ).toBe("would-prepare");
        expect(
            (
                await manageAddons([velocity], store, "add", ["console"], {
                    dryRun: true,
                })
            ).items[0]?.outcome,
        ).toBe("needs-resolution");
        expect(store.resolve).not.toHaveBeenCalled();
        expect(store.ensure).not.toHaveBeenCalled();
        expect((await loadProject(server.dir)).manifest.plugins).toEqual({});
        expect((await readLock(server.lockRoot)).projects).toEqual({});
    });
    it("leaves every manifest untouched on acquisition or checksum failure", async () => {
        const root = await directory();
        await initWorkspace(root, ["servers/*"]);
        const one = await project(path.join(root, "servers"), "one");
        const two = await project(path.join(root, "servers"), "two");
        const store = fixtureStore(root);
        store.ensure.mockRejectedValue(new Error("Offline cache miss"));
        await expect(
            manageAddons([one, two], store, "add", ["console"], {
                offline: true,
            }),
        ).rejects.toThrow("Offline cache miss");
        for (const server of [one, two])
            expect((await loadProject(server.dir)).manifest.plugins).toEqual(
                {},
            );
        const bad = fixtureStore(root);
        const resolve = bad.resolve.getMockImplementation();
        if (!resolve) throw new Error("Missing fixture resolver");
        bad.resolve.mockImplementation(async (input) => {
            const artifact = await resolve(input);
            if (artifact.identity) artifact.sha256 = "0".repeat(64);
            return artifact;
        });
        await expect(
            manageAddons([one], bad, "add", ["console"]),
        ).rejects.toMatchObject({ code: "ADDON_CHECKSUM" });
    });
    it("protects conflicting plugin sources, skips uninstalled updates, and accepts empty bulk updates", async () => {
        const root = await directory();
        let server = await project(root);
        const store = fixtureStore(root);
        expect(
            (await manageAddons([server], store, "update", ["console"]))
                .noEligibleTargets,
        ).toBe(true);
        expect(
            (await manageAddons([server], store, "update", []))
                .noEligibleTargets,
        ).toBe(false);
        server.manifest.plugins.CrafleetConsole = {
            provider: "github",
            owner: "somebody",
            repo: "another",
            version: "1.0.0",
            asset: "another.jar",
        };
        await writeYaml(
            path.join(server.dir, "crafleet.yaml"),
            server.manifest,
        );
        server = await loadProject(server.dir);
        for (const action of ["add", "update", "remove"] as const)
            await expect(
                manageAddons([server], store, action, ["console"]),
            ).rejects.toMatchObject({ code: "ADDON_CONFLICT" });
        await expect(
            manageAddons([server], store, "add", ["unknown"]),
        ).rejects.toMatchObject({ code: "ADDON_UNKNOWN" });
    });
    it("finishes incomplete declarations, upgrades old addons, and never downgrades newer official versions", async () => {
        const root = await directory();
        let server = await project(root);
        const store = fixtureStore(root);
        server.manifest.plugins.CrafleetConsole = addonSource("paper", "0.0.1");
        await writeYaml(
            path.join(server.dir, "crafleet.yaml"),
            server.manifest,
        );
        server = await loadProject(server.dir);
        expect(
            (await manageAddons([server], store, "add", ["console"])).items[0],
        ).toMatchObject({ after: "0.0.1", outcome: "prepared" });
        server = await loadProject(server.dir);
        expect((await inspectAddon(server)).updateAvailable).toBe(true);
        await manageAddons([server], store, "update", ["console"]);
        server = await loadProject(server.dir);
        expect((await inspectAddon(server)).declared).toBe(CRAFLEET_VERSION);
        server.manifest.plugins.CrafleetConsole = addonSource(
            "paper",
            "99.0.0",
        );
        await writeYaml(
            path.join(server.dir, "crafleet.yaml"),
            server.manifest,
        );
        server = await loadProject(server.dir);
        expect(
            (await manageAddons([server], store, "update", ["console"]))
                .items[0]?.after,
        ).toBe("99.0.0");
    });
});
