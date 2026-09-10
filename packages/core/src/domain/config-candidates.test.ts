import { describe, expect, it } from "vitest";
import {
    configCandidateRules,
    selectConfigCandidate,
} from "./config-candidates.js";
import { newProject, ProjectSchema, validateProject } from "./project.js";

describe("configuration candidate patterns", () => {
    it("accepts manifest rules and generates the corresponding JSON schema", () => {
        const project = {
            ...newProject("test", "paper", "26.2"),
            config: {
                files: ["plugins/Example/items/**/*.yml", "!**/draft/**"],
            },
        };
        expect(validateProject(project)).toEqual(project);
        expect(ProjectSchema.toJsonSchema()).toMatchObject({
            properties: {
                config: {
                    type: "object",
                    properties: {
                        files: {
                            type: "array",
                            items: { type: "string" },
                        },
                    },
                },
            },
        });
        for (const config of [
            [],
            {},
            { files: "*.yml" },
            { files: [1] },
            { files: [], typo: true },
        ]) {
            expect(() => validateProject({ ...project, config })).toThrow();
        }
    });

    it("supports nested globs, ordered exclusions and reinclusion, Unicode and Windows separators", () => {
        const rules = configCandidateRules([
            "./plugins\\Example\\items\\**\\*.yml",
            "!**/draft/**",
            "plugins/Example/items/draft/公開[12]?.yml",
        ]);
        expect(rules.map((rule) => rule.root)).toEqual([
            "plugins/Example/items",
            "",
            "plugins/Example/items/draft",
        ]);
        expect(
            selectConfigCandidate("plugins/Example/items/new.yml", rules),
        ).toBe(true);
        expect(
            selectConfigCandidate("plugins/Example/items/head/眼鏡.yml", rules),
        ).toBe(true);
        expect(
            selectConfigCandidate(
                "plugins/Example/items/draft/private.yml",
                rules,
            ),
        ).toBe(false);
        expect(
            selectConfigCandidate(
                "plugins/Example/items/draft/公開1a.yml",
                rules,
            ),
        ).toBe(true);
        expect(selectConfigCandidate("plugins/Example/cache.yml", rules)).toBe(
            false,
        );
        expect(selectConfigCandidate("server.properties", rules, true)).toBe(
            true,
        );
        expect(
            selectConfigCandidate(
                "server.properties",
                configCandidateRules(["!server.properties"]),
                true,
            ),
        ).toBe(false);
        expect(
            configCandidateRules(["plugins/Example/config.yml"])[0]?.root,
        ).toBe("plugins/Example");
        expect(configCandidateRules(["config.yml"])[0]?.root).toBe("");
        expect(selectConfigCandidate("a.yml", [])).toBe(false);
    });

    it.each([
        "",
        "!",
        "!!*.yml",
        "/etc/*.yml",
        "C:\\private\\*.yml",
        "../*.yml",
        "plugins/../*.yml",
        "plugins//*.yml",
        "plugins/./*.yml",
        "plugins/",
        "[abc",
        "a{b,c}",
        "@(a|b)",
        "^a.*(b)$",
        "a|b",
        "a\nb",
        "a\u007fb",
        "x".repeat(4097),
    ])(
        "rejects unsupported or escaping patterns without echoing input (#%#)",
        (pattern) => {
            expect(() => configCandidateRules([pattern])).toThrow(
                expect.objectContaining({ code: "CONFIG_PATTERNS" }),
            );
            expect(() =>
                validateProject({
                    ...newProject("test", "paper", "26.2"),
                    config: { files: [pattern] },
                }),
            ).toThrow();
        },
    );
    it("bounds rule count", () => {
        expect(() => configCandidateRules(Array(513).fill("*.yml"))).toThrow();
    });
});
