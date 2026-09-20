// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Literal secret-token fixtures.
import {
    link,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeConfigManager } from "../../packages/adapters/src/filesystem/config.js";
import { exists } from "../../packages/adapters/src/filesystem/io.js";
import { MANAGEMENT_SECRET_FILE } from "../../packages/adapters/src/filesystem/managed-server-secret.js";
import { assertPrivateFile } from "../../packages/adapters/src/filesystem/private.js";
import {
    loadConfigSecrets,
    prepareManagementServerSecret,
} from "../../packages/adapters/src/filesystem/secrets.js";

const temporaryParent = await realpath(os.tmpdir());
const roots: string[] = [];
const token = "${secret:crafleet.management-server}";
const original = "A".repeat(40);
const paper = { type: "paper", version: "26.2", build: "latest" } as const;
async function put(root: string, relative: string, text: string) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
}
async function fixture(files: Record<string, string> = {}) {
    const root = await mkdtemp(
        path.join(temporaryParent, "crafleet-managed-secret-"),
    );
    roots.push(root);
    for (const [relative, text] of Object.entries(files))
        await put(root, relative, text);
    return root;
}
const get = (root: string, relative: string) =>
    readFile(path.join(root, relative), "utf8");
const stored = (root: string) =>
    exists(path.join(root, MANAGEMENT_SECRET_FILE));
afterEach(async () => {
    for (const root of roots.splice(0)) {
        if (
            path.dirname(root) !== temporaryParent ||
            !path.basename(root).startsWith("crafleet-managed-secret-")
        )
            throw new Error("Invalid cleanup root");
        await rm(root, { recursive: true, force: true });
    }
});

describe("automatically managed server credentials", () => {
    it.each(["1.21.9", "1.21.11"])(
        "generates a key before the first Paper %s startup",
        async (version) => {
            const root = await fixture();
            await prepareManagementServerSecret(root, { ...paper, version });
            expect((await get(root, MANAGEMENT_SECRET_FILE)).trim()).toMatch(
                /^[A-Za-z0-9]{40}$/,
            );
        },
    );
    it("retains adopted keys when pending metadata is published", async () => {
        const root = await fixture({
            "files/server.properties": `management-server-enabled=false\nmanagement-server-secret=${token}\n`,
            "runtime/server.properties": `management-server-enabled=false\nmanagement-server-secret=${original}\n`,
        });
        const manager = new NodeConfigManager(root, {}, "files");
        const bundle = await manager.prepare({ persist: false });
        expect(await stored(root)).toBe(false);
        await manager.retainPrepared(bundle);
        expect(await get(root, MANAGEMENT_SECRET_FILE)).toBe(`${original}\n`);
        expect(JSON.stringify(bundle)).not.toContain(original);
    });
    it("adopts restored keys before publishing comparison observations", async () => {
        const source = await fixture({
            "runtime/server.properties": `management-server-secret=${original}\n`,
        });
        const sourceManager = new NodeConfigManager(source, {}, "files");
        await sourceManager.capture({ initial: true, kind: "paper" });
        const bundle = await sourceManager.prepare();
        const target = await fixture({
            "runtime/server.properties": `management-server-secret=${original}\n`,
        });
        const targetManager = new NodeConfigManager(target, {}, "files");
        const restored = await targetManager.prepareRestoredBundle(
            bundle,
            true,
        );
        expect(await stored(target)).toBe(false);
        await targetManager.observeRestored(restored);
        expect(await get(target, MANAGEMENT_SECRET_FILE)).toBe(`${original}\n`);
        expect(await get(target, ".crafleet/files-state.json")).not.toContain(
            original,
        );
    });
    it.each(["config", "files"] as const)(
        "adopts runtime-generated credentials during %s capture without exposing them",
        async (mode) => {
            const root = await fixture({
                "runtime/server.properties": `management-server-enabled=false\nmanagement-server-secret=${original}\n`,
            });
            const manager = new NodeConfigManager(root, {}, mode);
            const preview = await manager.capture({
                initial: true,
                kind: "paper",
                dryRun: true,
            });
            expect(preview.conflicts).toEqual([]);
            expect(await stored(root)).toBe(false);
            await manager.capture({ initial: true, kind: "paper" });
            expect(await get(root, `${mode}/server.properties`)).toContain(
                token,
            );
            expect(await get(root, MANAGEMENT_SECRET_FILE)).toBe(
                `${original}\n`,
            );
            await assertPrivateFile(path.join(root, MANAGEMENT_SECRET_FILE));
            expect(
                await get(root, `.crafleet/${mode}-state.json`),
            ).not.toContain(original);
            const bundle = await manager.prepare({ persist: false });
            expect(JSON.stringify(bundle)).not.toContain(original);
            await manager.apply(bundle);
            expect(await get(root, "runtime/server.properties")).toContain(
                original,
            );
            expect(
                (await loadConfigSecrets(root)).redact(`secret=${original}`),
            ).toBe("secret=[redacted]");
        },
    );
    it.each(["config", "files"] as const)(
        "generates and reuses credentials when applying a blank %s property",
        async (mode) => {
            const base =
                "# Keep comments\r\nmanagement-server-enabled=false\r\nmanagement-server-secret=\r\nmotd=hello\r\n";
            const root = await fixture({ [`${mode}/server.properties`]: base });
            const manager = new NodeConfigManager(root, {}, mode);
            const bundle = await manager.prepare({ persist: false });
            await manager.diff();
            expect(await stored(root)).toBe(false);
            await manager.apply(bundle);
            const secret = (await get(root, MANAGEMENT_SECRET_FILE)).trim();
            expect(secret).toMatch(/^[A-Za-z0-9]{40}$/);
            const runtime = await get(root, "runtime/server.properties");
            expect(runtime).toContain(`management-server-secret=${secret}`);
            expect(runtime).toContain("management-server-enabled=false");
            expect(runtime).toContain("# Keep comments\r\n");
            expect(await get(root, `${mode}/server.properties`)).toBe(base);
            await manager.apply(await manager.prepare());
            expect(await get(root, "runtime/server.properties")).toBe(runtime);
            await manager.capture();
            expect(await get(root, `${mode}/server.properties`)).toContain(
                token,
            );
            expect(await get(root, MANAGEMENT_SECRET_FILE)).toBe(`${secret}\n`);
        },
    );
    it("prepares a fresh supported Paper server before its first launch without enabling management", async () => {
        const root = await fixture();
        await prepareManagementServerSecret(root, paper);
        const secret = (await get(root, MANAGEMENT_SECRET_FILE)).trim();
        expect(secret).toMatch(/^[A-Za-z0-9]{40}$/);
        expect(await get(root, "runtime/server.properties")).toBe(
            `management-server-secret=${secret}\n`,
        );
        await prepareManagementServerSecret(root, paper);
        expect(await get(root, MANAGEMENT_SECRET_FILE)).toBe(`${secret}\n`);
    });
    it("preserves unrelated runtime credentials and server settings during startup", async () => {
        const text =
            "# custom\nmanagement-server-enabled=true\nmanagement-server-secret=\nrcon.password=unregistered-password\nmotd=hello\n";
        const root = await fixture({ "runtime/server.properties": text });
        await prepareManagementServerSecret(root, paper);
        const secret = (await get(root, MANAGEMENT_SECRET_FILE)).trim();
        expect(await get(root, "runtime/server.properties")).toBe(
            text.replace(
                "management-server-secret=",
                `management-server-secret=${secret}`,
            ),
        );
    });
    it.each(["1.21.8", "1.20.6", "unknown"])(
        "does not invent properties on older or unknown Paper %s",
        async (version) => {
            const root = await fixture();
            await prepareManagementServerSecret(root, { ...paper, version });
            expect(await stored(root)).toBe(false);
            expect(
                await exists(path.join(root, "runtime/server.properties")),
            ).toBe(false);
        },
    );
    it("does not provision Paper credentials on Velocity", async () => {
        const root = await fixture();
        await prepareManagementServerSecret(root, {
            ...paper,
            type: "velocity",
        });
        expect(await stored(root)).toBe(false);
    });
    it("preserves explicit credential references instead of creating an automatic secret", async () => {
        const root = await fixture({
            credential: `${original}\n`,
            "files/server.properties":
                "management-server-secret=${secret:MY_KEY}\n",
        });
        const references = { MY_KEY: { file: "credential" } };
        const manager = new NodeConfigManager(root, references, "files");
        await manager.apply(await manager.prepare());
        await prepareManagementServerSecret(root, paper, references);
        await manager.capture();
        expect(await stored(root)).toBe(false);
        expect(await get(root, "files/server.properties")).toContain(
            "${secret:MY_KEY}",
        );
        expect(await get(root, "runtime/server.properties")).toContain(
            original,
        );
    });
    it("rejects secret movement, exposed saved values, and other unregistered server secrets", async () => {
        const root = await fixture({
            "runtime/server.properties": `management-server-secret=${original}\n`,
        });
        const secrets = await loadConfigSecrets(root);
        expect(() =>
            secrets.tokenize("other.properties", `password=${original}\n`),
        ).toThrow();
        expect(() =>
            secrets.tokenize("server.properties", `motd=${original}\n`),
        ).toThrow();
        expect(() =>
            secrets.assertTemplate(
                "server.properties",
                `management-server-secret=${original}\n`,
            ),
        ).toThrow();
        expect(() =>
            secrets.tokenize(
                "server.properties",
                "rcon.password=unregistered\n",
            ),
        ).toThrow();
        expect(() =>
            secrets.inject("other.properties", `password=${token}\n`),
        ).toThrow();
        expect(await stored(root)).toBe(false);
    });
    it("refuses unexpected credential replacement without rotating the stored key", async () => {
        const root = await fixture();
        await prepareManagementServerSecret(root, paper);
        const prior = await get(root, MANAGEMENT_SECRET_FILE);
        await put(
            root,
            "runtime/server.properties",
            `management-server-secret=${original}\n`,
        );
        await expect(loadConfigSecrets(root)).rejects.toMatchObject({
            code: "MANAGED_SECRET_INVALID",
        });
        expect(await get(root, MANAGEMENT_SECRET_FILE)).toBe(prior);
    });
    it("rejects invalid and hard-linked managed secret files", async () => {
        const root = await fixture();
        await prepareManagementServerSecret(root, paper);
        const file = path.join(root, MANAGEMENT_SECRET_FILE);
        const prior = await get(root, MANAGEMENT_SECRET_FILE);
        await writeFile(file, "invalid\n");
        await expect(loadConfigSecrets(root)).rejects.toMatchObject({
            code: "MANAGED_SECRET_INVALID",
        });
        await writeFile(file, prior);
        await link(file, path.join(root, "alias"));
        await expect(loadConfigSecrets(root)).rejects.toMatchObject({
            code: "MANAGED_SECRET_INVALID",
        });
    });
    it("keeps recovery previews read-only and restores with the same generated key", async () => {
        const root = await fixture({
            "files/server.properties": "management-server-secret=\n",
        });
        const manager = new NodeConfigManager(root, {}, "files");
        const first = await manager.prepare();
        await manager.assertRestorable(first);
        expect(await stored(root)).toBe(false);
        await manager.apply(first);
        const secret = await get(root, MANAGEMENT_SECRET_FILE);
        await manager.capture();
        await put(
            root,
            "files/server.properties",
            `management-server-secret=${token}\nmotd=changed\n`,
        );
        const next = await manager.prepare();
        const runtime = await get(root, "runtime/server.properties");
        await manager.apply(next);
        await manager.assertRestorable(next);
        await manager.restore(next);
        expect(await get(root, "runtime/server.properties")).toBe(runtime);
        expect(await get(root, MANAGEMENT_SECRET_FILE)).toBe(secret);
    });
});
