import { describe, expect, it } from "vitest";
import { fileDefaultEntries } from "./file-defaults.js";
import { newProject, validateProject } from "./project.js";

describe("file default declarations", () => {
    it("accepts an empty declaration and sorts supported configuration formats", () => {
        expect(fileDefaultEntries()).toEqual([]);
        const defaults = Object.fromEntries(
            ["yml", "yaml", "json", "toml", "properties"].map((ext) => [
                `plugins/Plugin/config.${ext}`,
                `examples/default.${ext}`,
            ]),
        );
        expect(fileDefaultEntries(defaults)).toEqual(
            Object.entries(defaults)
                .sort(([a], [b]) => a.localeCompare(b, "en"))
                .map(([relative, source]) => ({ relative, source })),
        );
        expect(
            validateProject({
                ...newProject("test", "paper", "26.2"),
                files: { defaults },
            }).files?.defaults,
        ).toEqual(defaults);
    });

    it.each([
        { "../hosts.yml": "examples/hosts.yml" },
        { "hosts.yml": "../hosts.yml" },
        { "hosts.yml": "runtime/hosts.yml" },
        { "hosts.yml": ".crafleet/hosts.yml" },
        { "hosts.yml": ".git/hosts.yml" },
        { "/hosts.yml": "examples/hosts.yml" },
        { "C:/hosts.yml": "examples/hosts.yml" },
        { "plugins\\hosts.yml": "examples/hosts.yml" },
        { "nul.yml": "examples/hosts.yml" },
        { "plugins./hosts.yml": "examples/hosts.yml" },
        { "hosts.yml": "examples/hosts.json" },
        { "hosts.txt": "examples/hosts.txt" },
        { "hosts.yml": "files/hosts.yml" },
        {
            "hosts.yml": "examples/hosts.yml",
            "HOSTS.YML": "examples/hosts.yml",
        },
        { "hosts.yml": "files/hosts.yml/child.yml" },
        { "hosts.yml/child.yml": "files/hosts.yml" },
        {
            "hosts.yml": "examples/hosts.yml",
            "hosts.yml/child.yml": "examples/child.yml",
        },
    ])("rejects unsafe, mismatched or overlapping paths: %j", (defaults) => {
        expect(() => fileDefaultEntries(defaults)).toThrow();
    });

    it("rejects array declarations and non-string sources", () => {
        const manifest = newProject("test", "paper", "26.2");
        expect(() =>
            validateProject({ ...manifest, files: { defaults: [] } }),
        ).toThrow();
        expect(() =>
            validateProject({
                ...manifest,
                files: { defaults: { "hosts.yml": 42 } },
            }),
        ).toThrow();
    });
});
