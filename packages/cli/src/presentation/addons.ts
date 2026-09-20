import type { AddonInventory, AddonOperationResult } from "@crafleet/adapters";
import { sanitizeTerminalOutput } from "./terminal.js";

export function renderAddonResult(value: unknown, command: string): string {
    if (value && typeof value === "object" && "items" in value) {
        const result = value as AddonOperationResult;
        const lines = [
            `Addons: ${result.summary.prepared} prepared, ${result.summary.unchanged} unchanged, ${result.summary.skipped} skipped${result.summary.unresolved ? `, ${result.summary.unresolved} need resolution` : ""}.`,
        ];
        for (const item of result.items)
            lines.push(
                `${item.project}: ${item.name} ${item.outcome} (${item.before ?? "not installed"} -> ${item.after ?? (result.action === "remove" && item.before ? "removed" : "not installed")})`,
                `  ${item.reason}`,
            );
        if (result.items.some((item) => item.pendingId))
            lines.push(
                "Apply pending changes with crafleet start or crafleet restart.",
            );
        return sanitizeTerminalOutput(lines.join("\n"));
    }
    const catalog = value as {
        name: string;
        description: string;
        available: string;
        support: {
            paper: readonly string[];
            velocity: readonly string[];
            velocitySnapshotMinimumBuild: number;
            verifiedConfigurations: readonly {
                kind: string;
                version: string;
                build: string;
                java: number;
                platform: string;
            }[];
        };
        projects: Array<
            AddonInventory & { completion: boolean; addonVersion?: string }
        >;
    };
    const lines = [
        `${catalog.name}: ${catalog.description}`,
        `Available with this CLI: ${catalog.available}`,
    ];
    for (const project of catalog.projects) {
        lines.push(
            `${project.project}: declared ${project.declared ?? "none"} | active ${project.active ?? "none"} | pending ${project.pendingAction === "remove" ? "removal" : (project.pending ?? "none")} | ${project.completion ? "connected" : "not connected"}${project.updateAvailable ? " | update available" : ""}`,
        );
        if (command === "addons info")
            lines.push(
                `  Next server: ${project.server.kind} ${project.server.version}${project.server.build ? ` build ${project.server.build}` : ""}; active server: ${project.activeServer ? `${project.activeServer.kind} ${project.activeServer.version}${project.activeServer.build ? ` build ${project.activeServer.build}` : ""}` : "none"}`,
                `  ${project.server.kind} ${project.server.version}: ${project.compatibility.status} (${project.compatibility.verification})`,
                `  ${project.compatibility.reason}`,
            );
    }
    if (command === "addons info")
        lines.push(
            "Supports catalogued Paper versions from 1.8.8 and Velocity from 3.4.0-SNAPSHOT build 507.",
            `Paper: ${catalog.support.paper.join(", ")}`,
            `Velocity: ${catalog.support.velocity.join(", ")} (3.4.0-SNAPSHOT builds >= ${catalog.support.velocitySnapshotMinimumBuild})`,
            `Runtime verified: ${catalog.support.verifiedConfigurations.map((entry) => `${entry.kind} ${entry.version} build ${entry.build} (${entry.platform}, Java ${entry.java})`).join("; ")}`,
            "Install: crafleet addons add console",
            "Changes take effect on the next start or restart.",
            "Restore the installation question once: crafleet console --ask-addon",
        );
    return sanitizeTerminalOutput(lines.join("\n"));
}
