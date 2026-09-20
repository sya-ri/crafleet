import { describe, expect, it } from "vitest";
import { validCompletionRequest, validSuggestions } from "../ports/console.js";
import {
    addonSource,
    consoleAddonCompatibility,
    isOfficialConsoleAddon,
    validateAddonNames,
} from "./addons.js";

describe("official console compatibility", () => {
    it("distinguishes verified builds from installable untested builds", () => {
        expect(
            consoleAddonCompatibility("paper", "1.8.8", "443").verification,
        ).toBe("verified");
        expect(
            consoleAddonCompatibility("paper", "1.8.8", "442").verification,
        ).toBe("untested");
        expect(
            consoleAddonCompatibility("velocity", "4.1.1", "24").verification,
        ).toBe("verified");
    });
    it.each(["443", "444", "445"])(
        "allows the published Paper 1.8.8 build %s",
        (build) =>
            expect(
                consoleAddonCompatibility("paper", "1.8.8", build).status,
            ).toBe("supported"),
    );
    it("rejects unsupported and uncatalogued versions", () => {
        expect(consoleAddonCompatibility("paper", "1.7.10").status).toBe(
            "unsupported",
        );
        expect(consoleAddonCompatibility("paper", "99.1").status).toBe(
            "unsupported",
        );
        expect(
            consoleAddonCompatibility("velocity", "3.3.0-SNAPSHOT", "999")
                .status,
        ).toBe("unsupported");
    });
    it("distinguishes the Velocity build boundary and unresolved builds", () => {
        expect(
            consoleAddonCompatibility("velocity", "3.4.0-SNAPSHOT", "506")
                .status,
        ).toBe("unsupported");
        expect(
            consoleAddonCompatibility("velocity", "3.4.0-SNAPSHOT", "507")
                .status,
        ).toBe("supported");
        expect(
            consoleAddonCompatibility("velocity", "3.4.0-SNAPSHOT", "latest")
                .status,
        ).toBe("unknown");
        expect(consoleAddonCompatibility("velocity", "3.4.0").status).toBe(
            "supported",
        );
        expect(consoleAddonCompatibility("paper", "latest").status).toBe(
            "unknown",
        );
    });
    it("identifies the source, not just a matching plugin name", () => {
        expect(
            isOfficialConsoleAddon(addonSource("paper", "0.1.0"), "paper"),
        ).toBe(true);
        expect(
            isOfficialConsoleAddon(addonSource("paper", "0.1.0"), "velocity"),
        ).toBe(false);
        expect(isOfficialConsoleAddon("file:console.jar", "paper")).toBe(false);
        expect(isOfficialConsoleAddon(undefined, "paper")).toBe(false);
        expect(() => validateAddonNames(["typo"])).toThrow(
            "Available addons: console",
        );
    });
    it("validates request bounds, replacement ranges and terminal controls", () => {
        const request = { line: "say hello", cursor: 6 };
        expect(validCompletionRequest(request)).toBe(true);
        expect(validCompletionRequest({ ...request, cursor: 20 })).toBe(false);
        expect(validCompletionRequest({ line: "stop\n", cursor: 5 })).toBe(
            false,
        );
        expect(
            validSuggestions([{ text: "hello", start: 4, end: 6 }], request),
        ).toBe(true);
        expect(
            validSuggestions([{ text: "x", start: 4, end: 9 }], request),
        ).toBe(false);
        expect(
            validSuggestions([{ text: "\x1b[2J", start: 4, end: 6 }], request),
        ).toBe(false);
        expect(validSuggestions(null, request)).toBe(false);
    });
});
