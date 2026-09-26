import {
    type AddonCompatibility,
    type ArtifactStore,
    addonSource,
    CONSOLE_ADDON_ARTIFACTS,
    CONSOLE_ADDON_IDS,
    CRAFLEET_VERSION,
    CrafleetError,
    consoleAddonCompatibility,
    isOfficialConsoleAddon,
    type LockedArtifact,
    type LockFile,
    parsePluginSource,
    parseServerSource,
    parseSource,
    stableStringify,
    validateAddonNames,
} from "@crafleet/core";
import { captureRuntimeSettings, withRuntimeSettings } from "../settings.js";
import {
    artifactContext,
    type InstallOptions,
    installProjects,
    prepareInstallProjects,
    serverSource,
    snapshotInstallInputs,
} from "./installations.js";
import { type ProjectContext, parseLockText, readLock } from "./projects.js";
import { readState } from "./state.js";

export interface AddonInventory {
    project: string;
    name: "console";
    declared: string | null;
    active: string | null;
    pending: string | null;
    pendingAction: "add" | "update" | "remove" | null;
    available: string;
    owned: boolean;
    server: {
        kind: "paper" | "velocity";
        version: string;
        build: string | undefined;
    };
    compatibility: AddonCompatibility;
    activeServer: {
        kind: "paper" | "velocity";
        version: string;
        build?: string;
    } | null;
    updateAvailable: boolean;
}
function newer(left: string, right: string): boolean {
    const a = left.replace(/^v/u, "").split(".").map(Number);
    const b = right.replace(/^v/u, "").split(".").map(Number);
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
    }
    return false;
}
function verifyOfficialArtifact(
    artifact: LockedArtifact,
    kind: "paper" | "velocity",
): void {
    if (!isOfficialConsoleAddon(artifact.source, kind)) return;
    if (artifact.identity?.id !== CONSOLE_ADDON_IDS[kind])
        throw new CrafleetError(
            "ADDON_IDENTITY",
            "Official addon has an unexpected plugin identity.",
            3,
        );
    if (
        artifact.source.provider === "github" &&
        artifact.source.version === `v${CRAFLEET_VERSION}`
    ) {
        const expected = CONSOLE_ADDON_ARTIFACTS[kind];
        if (!expected)
            throw new CrafleetError(
                "ADDON_RELEASE_MISSING",
                "This CLI build does not contain console addon checksums. Build the addons before packaging.",
                3,
            );
        if (
            artifact.sha256 !== expected.sha256 ||
            artifact.size !== expected.size
        )
            throw new CrafleetError(
                "ADDON_CHECKSUM",
                "Official addon does not match this CLI's release checksum.",
                3,
            );
    }
}
async function inspectAddonConfigured(
    project: ProjectContext,
    suppliedLock?: LockFile,
): Promise<AddonInventory> {
    const kind = project.manifest.server.type;
    const id = CONSOLE_ADDON_IDS[kind];
    const source = project.manifest.plugins[id];
    const lock = (suppliedLock ?? (await readLock(project.lockRoot))).projects[
        project.lockKey
    ];
    const state = await readState(project.dir);
    const requested = parseServerSource(serverSource(project.manifest), kind);
    const resolved =
        lock?.requests.server === stableStringify(requested)
            ? lock.server.source
            : requested;
    const version =
        resolved.provider === "paper"
            ? resolved.version
            : project.manifest.server.version;
    const build = resolved.provider === "paper" ? resolved.build : undefined;
    const parsed = source ? parsePluginSource(source) : undefined;
    const declared =
        parsed?.provider === "github"
            ? parsed.version.replace(/^v/u, "")
            : source
              ? "external"
              : null;
    const active = state.active?.lock.plugins[id]?.version ?? null;
    const pending = state.pending?.lock.plugins[id]?.version ?? null;
    return {
        project: project.manifest.name,
        name: "console",
        declared,
        active,
        pending,
        pendingAction: !state.pending
            ? null
            : active && !pending
              ? "remove"
              : pending && !active
                ? "add"
                : pending !== active
                  ? "update"
                  : null,
        available: CRAFLEET_VERSION,
        owned: isOfficialConsoleAddon(source, kind),
        server: { kind, version, build },
        activeServer: state.active
            ? {
                  kind: state.active.manifest.server.type,
                  version:
                      state.active.lock.server.source.provider === "paper"
                          ? state.active.lock.server.source.version
                          : state.active.manifest.server.version,
                  ...(state.active.lock.server.source.provider === "paper"
                      ? { build: state.active.lock.server.source.build }
                      : {}),
              }
            : null,
        compatibility: consoleAddonCompatibility(kind, version, build),
        updateAvailable: !!declared && newer(CRAFLEET_VERSION, declared),
    };
}
export interface AddonOperationItem {
    project: string;
    name: "console";
    outcome:
        | "prepared"
        | "unchanged"
        | "skipped"
        | "would-prepare"
        | "needs-resolution";
    reason: string;
    before: string | null;
    after: string | null;
    pendingId?: string;
    server: AddonInventory["server"];
    compatibility: AddonCompatibility;
}
export interface AddonOperationResult {
    action: "add" | "update" | "remove";
    items: AddonOperationItem[];
    summary: {
        prepared: number;
        unchanged: number;
        skipped: number;
        unresolved: number;
    };
    noEligibleTargets: boolean;
}

async function manageAddonsConfigured(
    projects: ProjectContext[],
    store: ArtifactStore,
    action: AddonOperationResult["action"],
    names: string[],
    options: InstallOptions = {},
): Promise<AddonOperationResult> {
    validateAddonNames(names);
    const items: AddonOperationItem[] = [];
    const changes: ProjectContext[] = [];
    const resolved = new Map<string, LockedArtifact>();
    const snapshot = projects.length
        ? await snapshotInstallInputs(projects)
        : undefined;
    const lock = parseLockText(snapshot?.lockText ?? null);
    const key = (directory: string, source: unknown) =>
        `${directory}\n${stableStringify(source)}`;
    for (const project of projects) {
        const inventory = await inspectAddon(project, lock);
        const kind = project.manifest.server.type;
        const id = CONSOLE_ADDON_IDS[kind];
        const entry: AddonOperationItem = {
            project: project.manifest.name,
            name: "console",
            outcome: "unchanged",
            reason: "No changes needed.",
            before: inventory.declared,
            after: inventory.declared,
            server: inventory.server,
            compatibility: inventory.compatibility,
        };
        items.push(entry);
        if (action === "update" && !inventory.declared) {
            entry.outcome = names.length ? "skipped" : "unchanged";
            entry.reason = "Not installed.";
            continue;
        }
        if (action === "remove" && !inventory.declared) continue;
        if (inventory.declared && !inventory.owned)
            throw new CrafleetError(
                "ADDON_CONFLICT",
                `${project.manifest.name}: ${id} belongs to another source; use plugins to manage it explicitly.`,
                3,
            );
        const state = await readState(project.dir);
        for (const installation of [state.active, state.pending]) {
            const existing = installation?.lock.plugins[id];
            if (existing && !isOfficialConsoleAddon(existing.source, kind))
                throw new CrafleetError(
                    "ADDON_CONFLICT",
                    `${project.manifest.name}: ${id} conflicts with a deployed plugin.`,
                    3,
                );
        }
        let compatibility = inventory.compatibility;
        if (action !== "remove") {
            const request = parseServerSource(
                serverSource(project.manifest),
                kind,
            );
            const locked = lock.projects[project.lockKey];
            if (
                compatibility.status !== "unsupported" &&
                !options.dryRun &&
                locked?.requests.server !== stableStringify(request)
            ) {
                const server = await store.resolve(
                    request,
                    artifactContext(project, options),
                );
                resolved.set(key(project.dir, request), server);
                if (server.source.provider === "paper")
                    entry.server = {
                        kind,
                        version: server.source.version,
                        build: server.source.build,
                    };
                compatibility = consoleAddonCompatibility(
                    kind,
                    server.source.provider === "paper"
                        ? server.source.version
                        : project.manifest.server.version,
                    server.source.provider === "paper"
                        ? server.source.build
                        : undefined,
                );
            }
            entry.compatibility = compatibility;
            if (compatibility.status === "unsupported") {
                entry.outcome = "skipped";
                entry.reason = `${kind} ${entry.server.version}${entry.server.build ? ` build ${entry.server.build}` : ""}: ${compatibility.reason}`;
                continue;
            }
            if (compatibility.status === "unknown") {
                if (!options.dryRun)
                    throw new CrafleetError(
                        "ADDON_SERVER_UNRESOLVED",
                        `${project.manifest.name}: ${compatibility.reason}`,
                        2,
                    );
                entry.outcome = "needs-resolution";
                entry.reason = compatibility.reason;
                entry.after =
                    inventory.declared &&
                    (action === "add" || !inventory.updateAvailable)
                        ? inventory.declared
                        : CRAFLEET_VERSION;
                continue;
            }
        }
        const next = {
            ...project,
            manifest: structuredClone(project.manifest),
        };
        if (action === "remove") {
            delete next.manifest.plugins[id];
            entry.after = null;
        } else {
            const keep =
                !!inventory.declared &&
                (action === "add" || !inventory.updateAvailable);
            if (!keep)
                next.manifest.plugins[id] = addonSource(kind, CRAFLEET_VERSION);
            entry.after = keep ? inventory.declared : CRAFLEET_VERSION;
            const ready = state.pending ?? state.active;
            const desiredSource = next.manifest.plugins[id];
            if (
                keep &&
                desiredSource &&
                ready &&
                ready.lock.requests.server ===
                    stableStringify(
                        parseServerSource(serverSource(next.manifest), kind),
                    ) &&
                ready.lock.requests.plugins[id] ===
                    stableStringify(parsePluginSource(desiredSource)) &&
                ready.lock.plugins[id]
            ) {
                if (!options.dryRun) {
                    verifyOfficialArtifact(ready.lock.plugins[id], kind);
                    await store.ensure(
                        ready.lock.plugins[id],
                        artifactContext(project, options),
                    );
                }
                if (state.pending) entry.pendingId = state.pending.id;
                if (action === "add" && inventory.updateAvailable)
                    entry.reason =
                        "Already installed. Update with crafleet addons update console.";
                continue;
            }
        }
        entry.outcome = options.dryRun ? "would-prepare" : "prepared";
        entry.reason =
            action === "remove"
                ? "Removal takes effect on the next start or restart; plugin data and history are retained."
                : `${compatibility.verification} build. Changes take effect on the next start or restart.${action === "add" && inventory.updateAvailable ? " Update available: crafleet addons update console." : ""}`;
        if (options.dryRun)
            entry.reason +=
                " Missing server or artifact information will be resolved at execution time.";
        changes.push(next);
    }
    if (changes.length && !options.dryRun) {
        const originals = projects.filter((project) =>
            changes.some((next) => next.dir === project.dir),
        );
        const preparation = await prepareInstallProjects(originals, options);
        if (
            !snapshot ||
            preparation.snapshot.lockText !== snapshot.lockText ||
            preparation.snapshot.projects.some(
                (entry) =>
                    stableStringify(entry) !==
                    stableStringify(
                        snapshot.projects.find(
                            (initial) => initial.dir === entry.dir,
                        ),
                    ),
            )
        )
            throw new CrafleetError(
                "CONCURRENT_EDIT",
                "A project declaration, shared lockfile or installation state changed during addon compatibility checks. Reload the project and retry; no newer input was overwritten.",
                3,
            );
        const wrapped: ArtifactStore = {
            inspect: (file) => store.inspect(file),
            latest: (source, context) => store.latest(source, context),
            resolve: async (source, context) =>
                resolved.get(
                    key(
                        context.projectDir,
                        typeof source === "string"
                            ? parseSource(source)
                            : source,
                    ),
                ) ?? store.resolve(source, context),
            ensure: async (artifact, context) => {
                verifyOfficialArtifact(artifact, context.serverKind);
                return store.ensure(artifact, context);
            },
        };
        const installed = await installProjects(
            changes,
            wrapped,
            options,
            preparation,
        );
        for (const result of installed) {
            const item = items.find(
                (entry) =>
                    entry.project === result.project &&
                    entry.outcome === "prepared",
            );
            if (item) {
                if (result.pendingId) item.pendingId = result.pendingId;
                if (!result.changed) item.outcome = "unchanged";
            }
        }
    }
    return {
        action,
        items,
        summary: {
            prepared: items.filter((item) =>
                ["prepared", "would-prepare"].includes(item.outcome),
            ).length,
            unchanged: items.filter((item) => item.outcome === "unchanged")
                .length,
            skipped: items.filter((item) => item.outcome === "skipped").length,
            unresolved: items.filter(
                (item) => item.outcome === "needs-resolution",
            ).length,
        },
        noEligibleTargets:
            items.length > 0 &&
            items.every((item) => item.outcome === "skipped"),
    };
}

export const inspectAddon = (
    ...args: Parameters<typeof inspectAddonConfigured>
): ReturnType<typeof inspectAddonConfigured> =>
    withRuntimeSettings(args[0].settings ?? captureRuntimeSettings(), () =>
        inspectAddonConfigured(...args),
    );
export const manageAddons = (
    ...args: Parameters<typeof manageAddonsConfigured>
): ReturnType<typeof manageAddonsConfigured> =>
    withRuntimeSettings(
        args[0][0]?.workspaceSettings ?? captureRuntimeSettings(),
        () => manageAddonsConfigured(...args),
    );
