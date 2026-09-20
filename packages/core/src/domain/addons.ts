import type { ServerKind, SourceInput, SourceSpec } from "./artifacts.js";
import { CrafleetError } from "./errors.js";
import { parsePluginSource } from "./sources.js";

declare const __CRAFLEET_CONSOLE_ARTIFACTS__: Partial<
    Record<ServerKind, { sha256: string; size: number }>
>;
export const CONSOLE_ADDON_ARTIFACTS =
    typeof __CRAFLEET_CONSOLE_ARTIFACTS__ === "undefined"
        ? {}
        : __CRAFLEET_CONSOLE_ARTIFACTS__;

export const CONSOLE_ADDON = "console";
export const CONSOLE_ADDON_DESCRIPTION =
    "Server command and argument tab completion.";
export const CONSOLE_ADDON_IDS = {
    paper: "CrafleetConsole",
    velocity: "crafleetconsole",
} as const;
export const ADDON_PROTOCOL = 1;

// Deliberately finite: a new upstream version requires an explicit compatibility review.
export const PAPER_ADDON_VERSIONS = [
    "1.8.8",
    "1.9.4",
    "1.10.2",
    "1.11.2",
    "1.12",
    "1.12.1",
    "1.12.2",
    "1.13",
    "1.13.1",
    "1.13.2",
    "1.14",
    "1.14.1",
    "1.14.2",
    "1.14.3",
    "1.14.4",
    "1.15",
    "1.15.1",
    "1.15.2",
    "1.16.1",
    "1.16.2",
    "1.16.3",
    "1.16.4",
    "1.16.5",
    "1.17",
    "1.17.1",
    "1.18",
    "1.18.1",
    "1.18.2",
    "1.19",
    "1.19.1",
    "1.19.2",
    "1.19.3",
    "1.19.4",
    "1.20",
    "1.20.1",
    "1.20.2",
    "1.20.4",
    "1.20.5",
    "1.20.6",
    "1.21",
    "1.21.1",
    "1.21.3",
    "1.21.4",
    "1.21.5",
    "1.21.6",
    "1.21.7",
    "1.21.8",
    "1.21.9",
    "1.21.10",
    "1.21.11",
    "26.1.1",
    "26.1.2",
    "26.2",
    "26.3",
] as const;
export const VELOCITY_ADDON_VERSIONS = [
    "3.4.0-SNAPSHOT",
    "3.4.0",
    "3.5.0",
    "3.5.1",
    "4.0.0",
    "4.1.0",
    "4.1.1",
    "4.2.0",
] as const;
export interface AddonCompatibility {
    status: "supported" | "unsupported" | "unknown";
    reason: string;
    verification: "verified" | "untested";
}
// Executed with the built addon on Windows. The same pinned matrix gates releases on Linux.
export const CONSOLE_ADDON_VERIFIED_CONFIGURATIONS = [
    {
        kind: "paper",
        version: "1.8.8",
        build: "443",
        java: 8,
        platform: "windows",
    },
    {
        kind: "paper",
        version: "1.8.8",
        build: "444",
        java: 8,
        platform: "windows",
    },
    {
        kind: "paper",
        version: "1.8.8",
        build: "445",
        java: 8,
        platform: "windows",
    },
    {
        kind: "paper",
        version: "1.13.2",
        build: "657",
        java: 8,
        platform: "windows",
    },
    {
        kind: "paper",
        version: "1.20.6",
        build: "151",
        java: 21,
        platform: "windows",
    },
    {
        kind: "paper",
        version: "26.2",
        build: "120",
        java: 25,
        platform: "windows",
    },
    {
        kind: "velocity",
        version: "3.4.0-SNAPSHOT",
        build: "507",
        java: 17,
        platform: "windows",
    },
    {
        kind: "velocity",
        version: "4.1.1",
        build: "24",
        java: 25,
        platform: "windows",
    },
] as const;
export function consoleAddonCompatibility(
    kind: ServerKind,
    version: string,
    build?: string,
): AddonCompatibility {
    const verified = CONSOLE_ADDON_VERIFIED_CONFIGURATIONS.find(
        (entry) =>
            entry.kind === kind &&
            entry.version === version &&
            entry.build === build,
    );
    const result = (
        status: AddonCompatibility["status"],
        reason: string,
    ): AddonCompatibility => ({
        status,
        reason:
            status === "supported" && verified
                ? `Runtime verified on ${verified.platform} with Java ${verified.java}.`
                : reason,
        verification:
            status === "supported" && verified ? "verified" : "untested",
    });
    if (version === "latest" || !version)
        return result(
            "unknown",
            "The server version must be resolved before installation.",
        );
    if (kind === "paper") {
        return (PAPER_ADDON_VERSIONS as readonly string[]).includes(version)
            ? result(
                  "supported",
                  "Supported Paper version; this exact build has not been verified.",
              )
            : result(
                  "unsupported",
                  "Requires a catalogued Paper version starting at 1.8.8.",
              );
    }
    if (!(VELOCITY_ADDON_VERSIONS as readonly string[]).includes(version))
        return result(
            "unsupported",
            "Requires a catalogued Velocity version starting at 3.4.0-SNAPSHOT build 507.",
        );
    if (version === "3.4.0-SNAPSHOT") {
        if (!build || !/^\d+$/.test(build))
            return result(
                "unknown",
                "Velocity 3.4.0-SNAPSHOT requires a resolved build (507 or newer).",
            );
        if (Number(build) < 507)
            return result(
                "unsupported",
                "Velocity 3.4.0-SNAPSHOT requires build 507 or newer.",
            );
    }
    return result(
        "supported",
        "Supported Velocity version; this exact build has not been verified.",
    );
}
export function addonSource(
    kind: ServerKind,
    version: string,
): Extract<SourceSpec, { provider: "github" }> {
    return {
        provider: "github",
        owner: "sya-ri",
        repo: "crafleet",
        version: `v${version}`,
        asset: `crafleet-console-${kind}.jar`,
    };
}
export function isOfficialConsoleAddon(
    source: SourceInput | undefined,
    kind: ServerKind,
): boolean {
    if (!source) return false;
    try {
        const parsed = parsePluginSource(source);
        return (
            parsed.provider === "github" &&
            parsed.owner === "sya-ri" &&
            parsed.repo === "crafleet" &&
            parsed.asset === `crafleet-console-${kind}.jar` &&
            /^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(parsed.version)
        );
    } catch {
        return false;
    }
}
export function validateAddonNames(names: readonly string[]): void {
    if (names.some((name) => name !== CONSOLE_ADDON))
        throw new CrafleetError(
            "ADDON_UNKNOWN",
            "Unknown addon. Available addons: console.",
            2,
        );
}
