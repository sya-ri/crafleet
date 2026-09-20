import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { type ArtifactStore, newProject, parseSource } from "@crafleet/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { NodeConfigManager } from "../../packages/adapters/src/filesystem/config.js";
import {
    DEFAULTS_STATE_PATH,
    isDefaultTransactionPath,
    prepareFileDefaults,
} from "../../packages/adapters/src/filesystem/file-defaults.js";
import {
    installProjects,
    recoverManifests,
} from "../../packages/adapters/src/filesystem/installations.js";
import * as io from "../../packages/adapters/src/filesystem/io.js";
import {
    loadProject,
    writeYaml,
} from "../../packages/adapters/src/filesystem/projects.js";
import { readState } from "../../packages/adapters/src/filesystem/state.js";
import { artifactZip } from "./artifacts-fixture.js";
import {
    backupTestDirectory,
    cleanupBackupTestDirectories,
    writeBackupTestFile as put,
} from "./backup-fixtures.js";

afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupBackupTestDirectories();
});
const relative = "plugins/OniGokko-Game/hosts.yml";
const source = "files/plugins/OniGokko-Game/hosts.example.yml";
const destination = `files/${relative}`;
const original =
    "address:\n  Staff: [admin.example.com]\n  Normal: [pub.example.com]\n";
const read = (root: string, file: string) =>
    readFile(path.join(root, file), "utf8");

async function fixture() {
    const root = await backupTestDirectory();
    const dir = path.join(root, "project");
    const manifest = newProject("defaults", "paper", "26.2");
    manifest.server.build = "123";
    manifest.files = { defaults: { [relative]: source } };
    await put(dir, source, original);
    await writeYaml(path.join(dir, "crafleet.yaml"), manifest);
    const context = await loadProject(dir, path.join(root, "home"));
    const jar = artifactZip([
        {
            name: "META-INF/MANIFEST.MF",
            content: "Manifest-Version: 1.0\nImplementation-Version: 123\n",
        },
    ]);
    const artifact = await put(root, "paper.jar", jar);
    const store = {
        resolve: vi.fn(async (input) => ({
            source: parseSource(input),
            version: "123",
            sha256: createHash("sha256").update(jar).digest("hex"),
            size: jar.length,
        })),
        ensure: vi.fn(async () => artifact),
        latest: vi.fn(),
        inspect: vi.fn(),
    } satisfies ArtifactStore;
    return { root, dir, manifest, context, store };
}

async function applyPending(dir: string) {
    const pending = (await readState(dir)).pending;
    if (!pending) throw new Error("Missing pending installation");
    expect(pending.config.files.map((file) => file.relative)).toEqual([
        relative,
    ]);
    await new NodeConfigManager(dir, {}, "files").apply(pending.config);
}

describe("local configuration defaults", () => {
    it.each([false, true])(
        "preserves UTF-8 BOM bytes in saved files and history (existing: %s)",
        async (existing) => {
            const { dir, context, store } = await fixture();
            await put(dir, source, `\uFEFF${original}`);
            if (existing) await put(dir, destination, `\uFEFF${original}`);
            await installProjects([context], store);
            expect(await read(dir, destination)).toBe(`\uFEFF${original}`);
            await applyPending(dir);
            await put(
                dir,
                source,
                `\uFEFF${original.replace("pub.example.com", "new.example.com")}`,
            );
            await installProjects([context], store);
            const updated = await read(dir, destination);
            expect(updated.startsWith("\uFEFF")).toBe(true);
            expect(parse(updated)).toEqual({
                address: {
                    Staff: ["admin.example.com"],
                    Normal: ["new.example.com"],
                },
            });
            await applyPending(dir);
            expect(await read(dir, `runtime/${relative}`)).toContain(
                "new.example.com",
            );
        },
    );
    it("creates, deploys and repeats install without deploying examples or exposing local edits in Git", async () => {
        const { dir, context, store } = await fixture();
        await put(
            dir,
            ".gitignore",
            `/${destination}\n/.crafleet/\n/runtime/\n/crafleet-lock.yaml\n`,
        );
        const git = (...args: string[]) =>
            promisify(execFile)(
                "git",
                [
                    "-c",
                    `safe.directory=${dir.replaceAll(path.sep, "/")}`,
                    ...args,
                ],
                { cwd: dir, windowsHide: true },
            );
        await git("init");
        await git("add", ".");
        const initialStatus = (await git("status", "--porcelain")).stdout;
        expect((await installProjects([context], store))[0]?.defaults).toEqual([
            { relative, action: "created", retained: [] },
        ]);
        expect(await read(dir, destination)).toBe(original);
        expect(await io.exists(path.join(dir, "runtime"))).toBe(false);
        const history = await read(dir, DEFAULTS_STATE_PATH);
        expect(
            (await installProjects([context], store))[0]?.defaults?.[0]?.action,
        ).toBe("unchanged");
        expect(await read(dir, DEFAULTS_STATE_PATH)).toBe(history);
        await applyPending(dir);
        expect(await read(dir, `runtime/${relative}`)).toBe(original);
        expect(
            await io.exists(
                path.join(
                    dir,
                    "runtime/plugins/OniGokko-Game/hosts.example.yml",
                ),
            ),
        ).toBe(false);
        await put(
            dir,
            destination,
            original.replace("admin.example.com", "local.example.com"),
        );
        await installProjects([context], store);
        await applyPending(dir);
        expect(await read(dir, `runtime/${relative}`)).toContain(
            "local.example.com",
        );
        expect((await git("status", "--porcelain")).stdout).toBe(initialStatus);
        expect(await read(dir, source)).toBe(original);
    });

    it("updates untouched values and additions/deletions while preserving local values, arrays and deletions", async () => {
        const { dir, context, store } = await fixture();
        const old = {
            keep: 1,
            update: 1,
            remove: 1,
            keepRemoved: 1,
            localDelete: 1,
            conflict: 1,
            array: [1, 2],
            nested: { update: 1, local: 1 },
        };
        await writeYaml(path.join(dir, source), old);
        await installProjects([context], store);
        await writeYaml(path.join(dir, destination), {
            keep: 1,
            update: 1,
            remove: 1,
            keepRemoved: 5,
            conflict: 5,
            array: [9],
            localOnly: true,
            nested: { update: 1, local: 5 },
        });
        await writeYaml(path.join(dir, source), {
            keep: 1,
            update: 2,
            localDelete: 2,
            conflict: 2,
            array: [1, 2, 3],
            added: true,
            nested: { update: 2, local: 2 },
        });
        const result = await installProjects([context], store);
        expect(parse(await read(dir, destination))).toEqual({
            keep: 1,
            update: 2,
            keepRemoved: 5,
            conflict: 5,
            array: [9],
            localOnly: true,
            added: true,
            nested: { update: 2, local: 5 },
        });
        expect(result[0]?.defaults?.[0]?.retained).toEqual(
            expect.arrayContaining([
                "/array",
                "/conflict",
                "/localDelete",
                "/keepRemoved",
                "/nested/local",
            ]),
        );
        const current = await read(dir, destination);
        await installProjects([context], store);
        expect(await read(dir, destination)).toBe(current);
    });

    it("preserves existing local files without history and registers the new comparison baseline", async () => {
        const { dir, context, store } = await fixture();
        const local =
            "# personal config\naddress:\n  Staff: [local.example.com]\n  Normal: [pub.example.com]\n";
        await put(dir, destination, local);
        await installProjects([context], store);
        expect(await read(dir, destination)).toBe(local);
        expect(
            JSON.parse(await read(dir, DEFAULTS_STATE_PATH)).defaults[relative]
                .content,
        ).toBe(original);
        await put(
            dir,
            source,
            original.replace("pub.example.com", "new.example.com"),
        );
        await installProjects([context], store);
        expect(parse(await read(dir, destination))).toEqual({
            address: {
                Staff: ["local.example.com"],
                Normal: ["new.example.com"],
            },
        });
    });

    it.each([
        [
            "json",
            '{"local":1,"default":1}\n',
            '{"local":9,"default":1}\n',
            '{"local":2,"default":2}\n',
        ],
        [
            "toml",
            "local = 1\ndefault = 1\n",
            "local = 9\ndefault = 1\n",
            "local = 2\ndefault = 2\n",
        ],
        [
            "properties",
            "local=1\ndefault=1\n",
            "local=9\ndefault=1\n",
            "local=2\ndefault=2\n",
        ],
    ])(
        "merges %s through the install transaction",
        async (ext, old, local, latest) => {
            const { dir, context, store } = await fixture();
            const target = `settings.${ext}`;
            const example = `examples/settings.${ext}`;
            context.manifest.files = { defaults: { [target]: example } };
            await writeYaml(path.join(dir, "crafleet.yaml"), context.manifest);
            const updated = await loadProject(dir, context.home);
            await put(dir, example, old);
            await installProjects([updated], store);
            await put(dir, `files/${target}`, local);
            await put(dir, example, latest);
            await installProjects([updated], store);
            const output = await read(dir, `files/${target}`);
            expect(output).toMatch(/local["\s]*[=:]\s*9/);
            expect(output).toMatch(/default["\s]*[=:]\s*2/);
        },
    );

    it("previews missing files without writing files, history, state or cache", async () => {
        const { root, dir, context, store } = await fixture();
        const before = await io.listFiles(root);
        const result = await installProjects([context], store, {
            dryRun: true,
        });
        expect(result[0]?.defaults?.[0]?.action).toBe("created");
        expect(await io.listFiles(root)).toEqual(before);
        expect(store.resolve).not.toHaveBeenCalled();
        expect(store.ensure).not.toHaveBeenCalled();
        expect(await io.exists(path.join(dir, destination))).toBe(false);
    });

    it.each([source, destination, DEFAULTS_STATE_PATH])(
        "rejects a concurrent edit to %s before committing local files",
        async (file) => {
            const { dir, context, store } = await fixture();
            await installProjects([context], store);
            const initial = await read(dir, destination);
            await put(
                dir,
                source,
                original.replace("pub.example.com", "new.example.com"),
            );
            const changed =
                file === DEFAULTS_STATE_PATH
                    ? JSON.stringify({ schemaVersion: 1, defaults: {} })
                    : original.replace(
                          "admin.example.com",
                          "concurrent.example.com",
                      );
            const ensure = store.ensure.getMockImplementation();
            store.ensure.mockImplementationOnce(async () => {
                await put(dir, file, changed);
                return ensure?.() ?? "";
            });
            await expect(
                installProjects([context], store),
            ).rejects.toMatchObject({ code: "CONCURRENT_EDIT" });
            expect(await read(dir, file)).toBe(changed);
            if (file !== destination)
                expect(await read(dir, destination)).toBe(initial);
        },
    );

    it.each([false, true])(
        "recovers generated files and history after an interrupted install (existing: %s)",
        async (existing) => {
            const { dir, context, store } = await fixture();
            if (existing) await installProjects([context], store);
            const names = [
                destination,
                DEFAULTS_STATE_PATH,
                "crafleet-lock.yaml",
                ".crafleet/state.json",
            ];
            const snapshot = async () =>
                Promise.all(
                    names.map(async (file) =>
                        (await io.exists(path.join(dir, file)))
                            ? read(dir, file)
                            : null,
                    ),
                );
            const before = await snapshot();
            await put(
                dir,
                source,
                original.replace("pub.example.com", "new.example.com"),
            );
            const atomicWrite = io.atomicWrite;
            const failure = vi
                .spyOn(io, "atomicWrite")
                .mockImplementation(async (file, content) => {
                    if (file === path.join(dir, ".crafleet/state.json"))
                        throw new Error("simulated interruption");
                    return atomicWrite(file, content);
                });
            await expect(
                installProjects([context], store),
            ).rejects.toMatchObject({ code: "MANIFEST_INTERRUPTED" });
            failure.mockRestore();
            const interrupted = await snapshot();
            expect(interrupted).not.toEqual(before);
            expect(await recoverManifests(dir, true)).toBe(true);
            expect(await snapshot()).toEqual(interrupted);
            expect(await recoverManifests(dir)).toBe(true);
            expect(await snapshot()).toEqual(before);
            expect(await read(dir, source)).toContain("new.example.com");
            await installProjects([context], store);
            expect(await read(dir, destination)).toContain("new.example.com");
        },
    );

    it("excludes sources from automatic capture and rejects explicit source mutation", async () => {
        const { dir, context, store } = await fixture();
        await installProjects([context], store);
        await applyPending(dir);
        const manager = new NodeConfigManager(dir, {}, "files");
        const example = source.slice("files/".length);
        await put(dir, `runtime/${example}`, "address: {}\n");
        await manager.capture({ initial: true, kind: "paper" });
        expect(await read(dir, source)).toBe(original);
        await expect(manager.track(example)).rejects.toMatchObject({
            code: "FILES_DEFAULTS_SOURCE",
        });
        await expect(manager.untrack(example)).rejects.toMatchObject({
            code: "FILES_DEFAULTS_SOURCE",
        });
        await expect(manager.resolve(example, "runtime")).rejects.toMatchObject(
            { code: "FILES_DEFAULTS_SOURCE" },
        );
        await expect(
            manager.capture({ paths: [example] }),
        ).rejects.toMatchObject({ code: "FILES_DEFAULTS_SOURCE" });
    });

    it.each([
        "not json",
        '{"schemaVersion":2,"defaults":{}}',
        '{"schemaVersion":1,"defaults":[]}',
    ])(
        "rejects malformed comparison history without writing outputs: %s",
        async (history) => {
            const { dir, manifest } = await fixture();
            await put(dir, DEFAULTS_STATE_PATH, history);
            await expect(
                prepareFileDefaults(dir, manifest),
            ).rejects.toMatchObject({ code: "FILES_DEFAULTS_STATE" });
            expect(await io.exists(path.join(dir, destination))).toBe(false);
        },
    );

    it.each([Buffer.from([0xff]), Buffer.alloc(4 * 1024 * 1024 + 1, "x")])(
        "rejects invalid or oversized example text",
        async (bytes) => {
            const { dir, manifest } = await fixture();
            await put(dir, source, bytes);
            await expect(
                prepareFileDefaults(dir, manifest),
            ).rejects.toMatchObject({ code: "FILES_DEFAULTS_INPUT" });
        },
    );

    it("rejects missing examples, preserves local files when a source changes, and permits no defaults", async () => {
        const { dir, manifest, context, store } = await fixture();
        await installProjects([context], store);
        manifest.files = { defaults: { [relative]: "examples/new.yml" } };
        await expect(prepareFileDefaults(dir, manifest)).rejects.toMatchObject({
            code: "FILES_DEFAULTS_MISSING",
        });
        await put(dir, "examples/new.yml", "address: {}\n");
        expect(
            (await prepareFileDefaults(dir, manifest)).bases.get(relative),
        ).toBe(original);
        manifest.files = {};
        expect((await prepareFileDefaults(dir, manifest)).changes).toEqual([]);
    });

    it("limits recovery paths to generated structured files and history", () => {
        expect(isDefaultTransactionPath(DEFAULTS_STATE_PATH)).toBe(true);
        expect(isDefaultTransactionPath(`servers/test/${destination}`)).toBe(
            true,
        );
        expect(isDefaultTransactionPath("myfiles/hosts.yml")).toBe(false);
        expect(isDefaultTransactionPath("files/server.jar")).toBe(false);
        expect(isDefaultTransactionPath("runtime/hosts.yml")).toBe(false);
    });
});
