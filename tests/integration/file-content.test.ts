import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    FileSecrets,
    mergeFileContent,
    objectPath,
    readFileContent,
    retainObject,
    streamFile,
    writeFileContent,
} from "../../packages/adapters/src/filesystem/file-content.js";
import { ConfigSecrets } from "../../packages/adapters/src/filesystem/secrets.js";
import {
    backupTestDirectory,
    cleanupBackupTestDirectories,
    writeBackupTestFile as put,
} from "./backup-fixtures.js";

afterEach(cleanupBackupTestDirectories);

describe("file content boundaries", () => {
    it("preserves validation and exact formatting when no secrets are configured", () => {
        const plain = new ConfigSecrets(new Map());
        const files = new FileSecrets(plain);
        const text = "# unchanged\r\nvalue: 日本語\r\n";
        expect(files.tokenize("data.yml", text, [text])).toBe(
            plain.tokenize("data.yml", text, [text]),
        );
        expect(files.inject("data.yml", text)).toBe(
            plain.inject("data.yml", text),
        );
        for (const [relative, unsafe] of [
            ["server.properties", "rcon.password=unconfigured\n"],
            ["data.yml", "value: $" + "{secret:UNKNOWN}\n"],
            ["data.yml", "invalid: ["],
            ["key.txt", "-----BEGIN PRIVATE KEY-----\n"],
        ]) {
            if (relative === undefined || unsafe === undefined)
                throw new Error("Missing fixture");
            expect(() => files.tokenize(relative, unsafe)).toThrow();
            expect(() => files.inject(relative, unsafe)).toThrow();
        }
        expect(() =>
            files.tokenize("data.yml", text, [
                "value: $" + "{secret:UNKNOWN}\n",
            ]),
        ).toThrow();
    });
    it("distinguishes UTF-8 text, binary and unsupported structured files", async () => {
        const root = await backupTestDirectory();
        expect(await readFileContent(root, "missing.dat")).toBeNull();
        await put(root, "plain.txt", "日本語\n");
        expect(await readFileContent(root, "plain.txt")).toBe("日本語\n");
        await put(root, "opaque.bin", Buffer.from([0, 1, 2]));
        expect(await readFileContent(root, "opaque.bin")).toMatchObject({
            kind: "binary",
            size: 3,
        });
        await put(root, "broken.json", Buffer.from([0xff]));
        await expect(
            readFileContent(root, "broken.json"),
        ).rejects.toMatchObject({ code: "FILES_UNSUPPORTED" });
        await put(
            root,
            "oversized.yml",
            Buffer.alloc(4 * 1024 * 1024 + 1, 0x61),
        );
        await expect(
            readFileContent(root, "oversized.yml"),
        ).rejects.toMatchObject({ code: "FILES_UNSUPPORTED" });
        await mkdir(path.join(root, "directory"));
        await expect(
            streamFile(path.join(root, "directory")),
        ).rejects.toMatchObject({ code: "FILES_CHANGED" });
    });
    it("checks retained bytes and sizes before replacing targets", async () => {
        const root = await backupTestDirectory();
        const source = await put(root, "source.bin", Buffer.from([0x81, 0x82]));
        const object = await streamFile(source);
        await expect(
            retainObject(root, source, { ...object, size: 3 }),
        ).rejects.toMatchObject({ code: "FILES_CHANGED" });
        await retainObject(root, source, object);
        await retainObject(root, source, object);
        await writeFileContent(root, root, "output/data.bin", object);
        expect(await readFile(path.join(root, "output/data.bin"))).toEqual(
            await readFile(source),
        );
        await put(
            root,
            `.crafleet/file-objects/${object.sha256}`,
            Buffer.from([0x83, 0x84]),
        );
        await expect(retainObject(root, source, object)).rejects.toThrow();
        await expect(
            writeFileContent(root, root, "output/data.bin", object),
        ).rejects.toThrow();
        expect(await readFile(path.join(root, "output/data.bin"))).toEqual(
            Buffer.from([0x81, 0x82]),
        );
        expect(() =>
            objectPath(root, { ...object, sha256: "../outside" }),
        ).toThrow();
        await writeFileContent(root, root, "output/notes.txt", "exact\r\n");
        expect(
            await readFile(path.join(root, "output/notes.txt"), "utf8"),
        ).toBe("exact\r\n");
        await writeFileContent(root, root, "output/notes.txt", null);
        await writeFileContent(root, root, "output/notes.txt", null);
        await expect(
            writeFileContent(root, root, "output", null),
        ).rejects.toThrow();
    });
    it("keeps whole-file merge decisions distinct from text formatting", () => {
        const old = {
            kind: "binary" as const,
            sha256: "a".repeat(64),
            size: 2,
        };
        const next = { ...old, sha256: "b".repeat(64), size: 3 };
        const other = { ...old, sha256: "c".repeat(64) };
        expect(mergeFileContent("state.bin", old, next, next)).toEqual({
            content: next,
            conflicts: [],
        });
        expect(mergeFileContent("state.bin", old, next, old)).toEqual({
            content: next,
            conflicts: [],
        });
        expect(mergeFileContent("state.bin", old, old, null)).toEqual({
            content: null,
            conflicts: [],
        });
        expect(mergeFileContent("state.bin", old, next, other)).toEqual({
            content: next,
            conflicts: ["/"],
        });
        expect(
            mergeFileContent("state.yml", "a: 1\n", "# keep\na: 1\n", "a: 2\n"),
        ).toEqual({ content: "# keep\na: 2\n", conflicts: [] });
    });
    it("keeps secret validation scoped to exact text and opaque binaries", () => {
        const secrets = new FileSecrets(
            new ConfigSecrets(
                new Map([["PASSWORD", "disposable-long-secret"]]),
            ),
        );
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal Crafleet secret reference.
        const reference = "password: ${secret:PASSWORD}\n";
        secrets.assertTemplate("settings.yml", reference);
        secrets.assertTemplate("settings.yml", reference);
        expect(() =>
            secrets.assertTemplate(
                "settings.yml",
                "password: disposable-long-secret\n",
            ),
        ).toThrow();
        expect(secrets.inject("settings.yml", reference)).toBe(
            "password: disposable-long-secret\n",
        );
        expect(
            secrets.tokenize(
                "settings.yml",
                "password: disposable-long-secret\n",
                [reference],
            ),
        ).toBe(reference);
        const object = {
            kind: "binary" as const,
            sha256: "a".repeat(64),
            size: 10,
        };
        expect(secrets.inject("state.bin", object)).toBe(object);
        expect(secrets.tokenize("state.bin", object)).toBe(object);
        secrets.assertTemplate("state.bin", object);
        expect(secrets.redact("disposable-long-secret")).not.toContain(
            "disposable-long-secret",
        );
    });
});
