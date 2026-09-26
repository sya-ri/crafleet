import { describe, expect, it } from "vitest";
import { validateConfigBundle, validateConfigState } from "./config.js";
import { configCandidateRules } from "./config-candidates.js";
import {
    DEFAULT_SETTINGS,
    flattenSettings,
    parseSettingAssignments,
    RuntimeSettingsSchema,
    resolveSettings,
    SETTINGS,
    settingEnvironmentName,
    validateSetting,
} from "./settings.js";
import { reserveAutomaticStart } from "./supervision.js";

describe("runtime settings contract", () => {
    it("validates every catalog boundary, including unlimited and disallowed negatives", () => {
        for (const [key, spec] of Object.entries(SETTINGS)) {
            expect(validateSetting(key, spec.default)).toBe(spec.default);
            expect(validateSetting(key, spec.minimum)).toBe(spec.minimum);
            expect(() => validateSetting(key, -2)).toThrow();
            expect(() => validateSetting(key, 1.5)).toThrow();
            expect(() => validateSetting(key, Infinity)).toThrow();
            expect(() => validateSetting(key, spec.maximum + 1)).toThrow();
            if (spec.unlimited) expect(validateSetting(key, -1)).toBe(-1);
            else expect(() => validateSetting(key, -1)).toThrow();
            if (spec.minimum > 0)
                expect(() => validateSetting(key, 0)).toThrow();
        }
    });
    it("rejects unknown keys and malformed groups without echoing values", () => {
        expect(() => flattenSettings({ files: { typo: 7 } })).toThrow(
            "Unknown runtime setting",
        );
        expect(() => flattenSettings({ files: [] })).toThrow("mappings");
        expect(() => flattenSettings({ missing: {} })).toThrow();
        expect(() =>
            parseSettingAssignments(["backup.maxFiles=secret-value"]),
        ).toThrow("Input values are omitted");
        expect(() =>
            parseSettingAssignments(["backup.maxFiles=unlimited"]),
        ).toThrow();
        expect(() =>
            parseSettingAssignments(["backup.maxFiles=1e3"]),
        ).toThrow();
        expect(settingEnvironmentName("runtime.startupTimeoutMs")).toBe(
            "CRAFLEET_SETTINGS_RUNTIME_STARTUP_TIMEOUT_MS",
        );
    });
    it("uses numeric -1 in YAML, JSON and CLI with last assignment winning", () => {
        expect(
            RuntimeSettingsSchema.assert({ backup: { maxFiles: -1 } }),
        ).toEqual({ backup: { maxFiles: -1 } });
        expect(() =>
            RuntimeSettingsSchema.assert({ logs: { pageBytes: -1 } }),
        ).toThrow();
        const overrides = parseSettingAssignments([
            "backup.maxFiles=8",
            "backup.maxFiles=-1",
        ]);
        expect(JSON.parse(JSON.stringify(overrides))).toEqual({
            "backup.maxFiles": -1,
        });
    });
    it("resolves layers without changing defaults or the input maps", () => {
        const result = resolveSettings([
            {
                source: "workspace",
                values: { "backup.maxFiles": 8, "files.maxPatterns": 3 },
            },
            { source: "project", values: { "backup.maxFiles": 9 } },
            { source: "environment", values: { "backup.maxFiles": 10 } },
            { source: "cli", values: { "backup.maxFiles": -1 } },
        ]);
        expect(result.values["backup.maxFiles"]).toBe(-1);
        expect(result.sources["backup.maxFiles"]).toBe("cli");
        expect(result.sources["files.maxPatterns"]).toBe("workspace");
        expect(DEFAULT_SETTINGS["backup.maxFiles"]).toBe(250000);
        expect(Object.isFrozen(result.values)).toBe(true);
    });
    it("uses the supplied limits in core validators and restart budgets", () => {
        const limited = {
            ...DEFAULT_SETTINGS,
            "files.maxPatterns": 1,
            "files.maxTextBytes": 3,
            "supervision.maxAttempts": 1,
        };
        expect(() => configCandidateRules(["a", "b"], limited)).toThrow();
        expect(() =>
            validateConfigState(
                { schemaVersion: 1, files: { a: { observed: "four" } } },
                limited,
            ),
        ).toThrow("files.maxTextBytes");
        const unlimited = {
            ...limited,
            "files.maxPatterns": -1,
            "files.maxTextBytes": -1,
            "supervision.maxAttempts": -1,
        };
        expect(configCandidateRules(["a", "b"], unlimited)).toHaveLength(2);
        expect(
            validateConfigState(
                { schemaVersion: 1, files: { a: { observed: "four" } } },
                unlimited,
            ).files.a?.observed,
        ).toBe("four");
        const intent = {
            schemaVersion: 1 as const,
            desired: "running" as const,
            attempts: [10],
        };
        expect(() => reserveAutomaticStart(intent, 11, limited)).toThrow();
        expect(reserveAutomaticStart(intent, 11, unlimited).attempts).toEqual([
            10, 11,
        ]);
        expect(() =>
            validateConfigBundle(
                {
                    schemaVersion: 1,
                    projectId: "p",
                    stateFingerprint: "0".repeat(64),
                    state: { schemaVersion: 1, files: {} },
                    files: [],
                },
                unlimited,
            ),
        ).not.toThrow();
    });
});
