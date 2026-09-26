import { type } from "arktype";
import { CrafleetError } from "./errors.js";

export interface SettingDefinition {
    default: number;
    unit: "bytes" | "ms" | "characters" | "count";
    description: string;
    unlimited: boolean;
    minimum: number;
    maximum: number;
}

function setting(
    value: number,
    unit: SettingDefinition["unit"],
    description: string,
    unlimited = true,
    minimum = 1,
    maximum = unit === "ms" ? 2_147_483_647 : Number.MAX_SAFE_INTEGER,
): SettingDefinition {
    return Object.freeze({
        default: value,
        unit,
        description,
        unlimited,
        minimum,
        maximum,
    });
}
const MiB = 1024 * 1024;

/** Operational policy only: protocol identities, hashes and path safety are not settings. */
export const SETTINGS = {
    "database.connectTimeoutMs": setting(
        10000,
        "ms",
        "PostgreSQL connection deadline (libpq rounds to seconds)",
    ),
    "state.maxGroupOwnerBytes": setting(
        16384,
        "bytes",
        "Group restore workspace owner record",
    ),
    "console.exitDrainTimeoutMs": setting(
        100,
        "ms",
        "Terminal input drain deadline on exit",
    ),
    "console.exitDrainIdleMs": setting(
        20,
        "ms",
        "Terminal input idle interval on exit",
        false,
    ),
    "logs.pageLines": setting(
        200,
        "count",
        "Default console log page size",
        false,
    ),
    "display.maxTableColumns": setting(
        500,
        "characters",
        "Human table terminal width",
    ),
    "display.maxErrorChars": setting(
        220,
        "characters",
        "Plugin picker error text",
    ),
    "display.maxSelectionChars": setting(
        60,
        "characters",
        "Plugin picker selection labels",
    ),
    "display.maxListTitleChars": setting(
        80,
        "characters",
        "Plugin picker list titles and version IDs",
    ),
    "display.maxAuthorChars": setting(50, "characters", "Plugin author names"),
    "display.maxVersionChars": setting(
        90,
        "characters",
        "Plugin version labels",
    ),
    "display.maxDateChars": setting(
        30,
        "characters",
        "Plugin publication date",
    ),
    "display.maxReviewChars": setting(
        70,
        "characters",
        "Plugin selection review labels",
    ),
    "completion.maxInputBytes": setting(
        65536,
        "bytes",
        "Total shell completion request size",
    ),
    "files.readChunkBytes": setting(
        65536,
        "bytes",
        "Bounded text read chunk",
        false,
        1,
        2147483647,
    ),
    "files.hashChunkBytes": setting(
        262144,
        "bytes",
        "Managed file hashing chunk",
        false,
        1,
        2147483647,
    ),
    "backup.copyChunkBytes": setting(
        1048576,
        "bytes",
        "Backup file copy chunk",
        false,
        1,
        2147483647,
    ),
    "backup.maxArchiveEntries": setting(16, "count", "Restic ZIP entry count"),
    "runtime.maxConnections": setting(32, "count", "Runner IPC connections"),
    "artifacts.hangarMaxVersionPages": setting(
        1,
        "count",
        "Hangar version lookup pages",
    ),
    "artifacts.hangarPageSize": setting(
        25,
        "count",
        "Hangar version page size",
        false,
        1,
        25,
    ),
    "artifacts.spigotPageSize": setting(
        100,
        "count",
        "Spiget version page size",
        false,
        1,
        100,
    ),
    "logs.readRetries": setting(
        1,
        "count",
        "Log rotation read retries",
        true,
        0,
    ),
    "console.maxVisibleSuggestions": setting(
        4,
        "count",
        "Visible completion candidates",
    ),
    "database.sqliteRetryMs": setting(
        50,
        "ms",
        "SQLite busy retry delay",
        false,
    ),
    "files.maxYamlBytes": setting(
        2 * MiB,
        "bytes",
        "Declaration and lockfile size",
    ),
    "files.maxGitignoreBytes": setting(MiB, "bytes", ".gitignore size"),
    "files.maxTextBytes": setting(
        4 * MiB,
        "bytes",
        "Managed structured text size",
    ),
    "files.maxStateBytes": setting(
        32 * MiB,
        "bytes",
        "File observation and defaults state size",
    ),
    "files.maxJournalBytes": setting(
        96 * MiB,
        "bytes",
        "File capture and migration journal size",
    ),
    "files.maxPaths": setting(
        10000,
        "count",
        "Managed file paths per operation",
    ),
    "files.maxDiscoveryEntries": setting(
        10000,
        "count",
        "Entries visited during file discovery",
    ),
    "files.maxDiscoveryDepth": setting(
        16,
        "count",
        "File discovery directory depth",
    ),
    "files.maxPatterns": setting(512, "count", "File selection patterns"),
    "files.maxPatternChars": setting(
        4096,
        "characters",
        "Glob pattern length (picomatch also imposes its own ceiling)",
        true,
        1,
        65536,
    ),
    "files.maxStructureNodes": setting(
        100000,
        "count",
        "Nodes in structured configuration",
    ),
    "files.maxStructureDepth": setting(
        100,
        "count",
        "Structured configuration nesting",
    ),
    "files.maxYamlAliases": setting(50, "count", "YAML alias expansion"),
    "files.maxMergeCells": setting(
        1000000,
        "count",
        "Text merge comparison cells",
    ),
    "files.readConcurrency": setting(4, "count", "Concurrent file reads"),
    "files.maxValidatedCacheEntries": setting(
        10000,
        "count",
        "Validated file object cache entries",
        true,
        0,
    ),
    "files.maxTokenizedCacheEntries": setting(
        10000,
        "count",
        "Tokenized file cache entries",
        true,
        0,
    ),
    "files.maxTokenizedCacheBytes": setting(
        16 * MiB,
        "bytes",
        "Tokenized file cache size",
        true,
        0,
    ),
    "files.windowsRetries": setting(
        5,
        "count",
        "Retries after Windows sharing violations",
        true,
        0,
    ),
    "files.windowsRetryDelayMs": setting(
        10,
        "ms",
        "Initial Windows sharing retry delay",
        false,
    ),
    "files.windowsRetryMaxDelayMs": setting(
        80,
        "ms",
        "Maximum Windows sharing retry delay",
        false,
    ),
    "files.maxSecretBytes": setting(65536, "bytes", "Secret file size"),
    "files.maxSecretChars": setting(
        65536,
        "characters",
        "Resolved secret length",
    ),
    "files.maxEulaBytes": setting(
        65536,
        "bytes",
        "EULA and consent record size",
    ),
    "workspace.maxDepth": setting(12, "count", "Workspace directory depth"),
    "state.maxBytes": setting(128 * MiB, "bytes", "Installation state size"),
    "state.maxDeployJournalBytes": setting(
        32 * MiB,
        "bytes",
        "Deployment journal size",
    ),
    "state.maxManifestJournalBytes": setting(
        256 * MiB,
        "bytes",
        "Managed-files declaration transaction size",
    ),
    "state.maxLegacyManifestJournalBytes": setting(
        32 * MiB,
        "bytes",
        "Legacy declaration transaction size",
    ),
    "state.maxManifestChanges": setting(
        4096,
        "count",
        "Declaration transaction changes",
    ),
    "state.maxRestoreJournalBytes": setting(
        128 * MiB,
        "bytes",
        "Restore and group restore journal size",
    ),
    "state.maxRestoreChanges": setting(
        250100,
        "count",
        "Single-project restore changes",
    ),
    "state.maxGroupRestoreChanges": setting(
        300000,
        "count",
        "Group restore changes",
    ),
    "state.maxGuardBytes": setting(
        4096,
        "bytes",
        "Operation guard and supervision intent record size",
    ),
    "state.maxRecoveryRecordBytes": setting(
        65536,
        "bytes",
        "Runtime recovery record size",
    ),
    "backup.maxFiles": setting(
        250000,
        "count",
        "Backup files, database dumps and embedded objects",
    ),
    "backup.maxRoots": setting(513, "count", "Backup roots"),
    "backup.maxGroupMembers": setting(512, "count", "Recovery group members"),
    "backup.maxMetadataBytes": setting(
        64 * MiB,
        "bytes",
        "Backup metadata size",
    ),
    "backup.maxActiveMetadataBytes": setting(
        4 * MiB,
        "bytes",
        "Legacy active installation metadata size",
    ),
    "backup.maxFilesActiveMetadataBytes": setting(
        32 * MiB,
        "bytes",
        "Managed-files active installation metadata size",
    ),
    "backup.maxPathChars": setting(
        4096,
        "characters",
        "Backup relative path length",
    ),
    "backup.maxPatterns": setting(512, "count", "Backup selection patterns"),
    "backup.commandTimeoutMs": setting(
        30 * 60 * 1000,
        "ms",
        "Backup subprocess deadline",
    ),
    "backup.maxOutputBytes": setting(
        16 * MiB,
        "bytes",
        "Backup subprocess captured output",
    ),
    "backup.killGraceMs": setting(
        1000,
        "ms",
        "Subprocess termination grace period",
        false,
    ),
    "backup.probeTimeoutMs": setting(
        10000,
        "ms",
        "Backup and database executable probe deadline",
    ),
    "backup.maxProbeOutputBytes": setting(
        8192,
        "bytes",
        "Executable probe output size",
    ),
    "backup.maxBinaryBytes": setting(
        64 * MiB,
        "bytes",
        "Expanded restic executable size",
    ),
    "backup.decodeTimeoutMs": setting(
        30000,
        "ms",
        "Restic archive decode deadline",
    ),
    "backup.downloadTimeoutMs": setting(
        120000,
        "ms",
        "Restic download deadline",
    ),
    "backup.maxDownloadRedirects": setting(
        4,
        "count",
        "Restic download redirects",
        true,
        0,
    ),
    "database.queryTimeoutMs": setting(
        30000,
        "ms",
        "Database verification query deadline",
    ),
    "database.lockTimeoutMs": setting(
        5000,
        "ms",
        "PostgreSQL lock acquisition deadline",
    ),
    "database.maxOutputBytes": setting(
        8 * MiB,
        "bytes",
        "PostgreSQL command output size",
    ),
    "database.maxVerificationOutputBytes": setting(
        65536,
        "bytes",
        "Database verification output size",
    ),
    "database.sqliteTimeoutMs": setting(
        5000,
        "ms",
        "SQLite lock wait deadline",
    ),
    "database.sqliteBackupRate": setting(
        128,
        "count",
        "SQLite pages copied per backup step",
        false,
        1,
        2147483647,
    ),
    "http.timeoutMs": setting(120000, "ms", "Provider request deadline"),
    "http.maxMetadataBytes": setting(
        8 * MiB,
        "bytes",
        "Provider metadata response size",
    ),
    "http.maxRedirects": setting(
        5,
        "count",
        "Provider download redirects",
        true,
        0,
    ),
    "artifacts.maxBytes": setting(512 * MiB, "bytes", "Artifact JAR size"),
    "artifacts.maxGlobEntries": setting(
        20000,
        "count",
        "Entries visited while resolving local JARs",
    ),
    "artifacts.maxGlobDepth": setting(64, "count", "Local JAR discovery depth"),
    "artifacts.maxJarEntries": setting(100000, "count", "JAR ZIP entries"),
    "artifacts.maxDescriptorBytes": setting(
        256 * 1024,
        "bytes",
        "Expanded plugin descriptor size",
    ),
    "artifacts.maxPluginIdChars": setting(
        128,
        "characters",
        "Plugin identifier length",
    ),
    "artifacts.maxVersionPages": setting(
        10,
        "count",
        "SpigotMC version label search pages",
    ),
    "runtime.startupTimeoutMs": setting(
        180000,
        "ms",
        "Server readiness deadline",
    ),
    "runtime.stopTimeoutMs": setting(
        120000,
        "ms",
        "Graceful server stop deadline",
    ),
    "runtime.requestTimeoutMs": setting(
        5000,
        "ms",
        "Runner IPC request deadline",
    ),
    "runtime.stopGraceMs": setting(
        5000,
        "ms",
        "Runner stop acknowledgement grace",
        false,
    ),
    "runtime.pollMs": setting(150, "ms", "Readiness polling interval", false),
    "runtime.stopPollMs": setting(
        50,
        "ms",
        "Runner exit polling interval",
        false,
    ),
    "runtime.statusPollMs": setting(
        500,
        "ms",
        "Foreground server status polling interval",
        false,
    ),
    "runtime.pingTimeoutMs": setting(
        2000,
        "ms",
        "Minecraft status ping deadline",
    ),
    "runtime.maxPingBytes": setting(
        MiB,
        "bytes",
        "Minecraft status response size",
    ),
    "runtime.maxFrameBytes": setting(65536, "bytes", "Runner IPC frame size"),
    "runtime.maxRecordBytes": setting(32768, "bytes", "Runner record size"),
    "runtime.javaProbeTimeoutMs": setting(
        5000,
        "ms",
        "Java executable probe deadline",
    ),
    "runtime.maxJavaProbeBytes": setting(
        65536,
        "bytes",
        "Java executable probe output",
    ),
    "supervision.pollMs": setting(
        1000,
        "ms",
        "Supervisor polling interval",
        false,
    ),
    "supervision.restartDelayMs": setting(
        10000,
        "ms",
        "Automatic restart delay",
        false,
    ),
    "supervision.windowMs": setting(
        300000,
        "ms",
        "Automatic restart accounting window",
        false,
    ),
    "supervision.maxAttempts": setting(
        5,
        "count",
        "Automatic starts within the accounting window",
    ),
    "console.maxCommandChars": setting(
        8192,
        "characters",
        "Console command and completion text length",
    ),
    "console.maxCommandBytes": setting(
        8192,
        "bytes",
        "JSON-encoded console command size",
    ),
    "console.maxInputBytes": setting(
        16384,
        "bytes",
        "JSON console input line size",
    ),
    "console.maxRequestIdChars": setting(
        128,
        "characters",
        "JSON console request identifier length",
    ),
    "console.maxHistoryEntries": setting(
        1000,
        "count",
        "Retained console command history",
    ),
    "console.maxHistoryBytes": setting(
        40 * MiB,
        "bytes",
        "Console history file size",
    ),
    "console.maxUndoEntries": setting(
        100,
        "count",
        "Console input undo history",
    ),
    "console.maxPasteChars": setting(
        65536,
        "characters",
        "Buffered terminal paste length",
    ),
    "console.historyLockTimeoutMs": setting(
        10000,
        "ms",
        "Console history lock wait deadline",
    ),
    "console.historyLockPollMs": setting(
        25,
        "ms",
        "Console history lock retry interval",
        false,
    ),
    "console.maxPreferenceBytes": setting(
        1024,
        "bytes",
        "Console addon preference record size",
    ),
    "console.escapeTimeoutMs": setting(
        10,
        "ms",
        "Terminal escape sequence idle time; defaults to 100 ms over SSH",
        false,
    ),
    "console.drainTimeoutMs": setting(
        1000,
        "ms",
        "Terminal input drain deadline",
    ),
    "console.drainIdleMs": setting(
        50,
        "ms",
        "Terminal input drain idle interval",
        false,
    ),
    "console.flushTimeoutMs": setting(
        1000,
        "ms",
        "JSON console output flush deadline",
    ),
    "console.capabilitiesTimeoutMs": setting(
        1000,
        "ms",
        "Console capability request deadline",
    ),
    "console.completionTimeoutMs": setting(
        2000,
        "ms",
        "Console completion IPC deadline",
    ),
    "console.maxLiveLines": setting(
        2000,
        "count",
        "Retained live console transcript lines",
    ),
    "console.maxLiveBytes": setting(
        4 * MiB,
        "bytes",
        "Retained live console transcript bytes",
    ),
    "console.maxEmptyHistoryPages": setting(
        8,
        "count",
        "Empty log pages inspected per scroll",
    ),
    "addon.maxConnections": setting(8, "count", "Console bridge connections"),
    "addon.maxPending": setting(
        32,
        "count",
        "Concurrent console completion requests",
    ),
    "addon.maxSuggestions": setting(
        256,
        "count",
        "Completion suggestions per response",
    ),
    "addon.maxFrameBytes": setting(
        65536,
        "bytes",
        "Console addon transport frame size",
    ),
    "addon.maxResponseBytes": setting(
        60000,
        "bytes",
        "Console addon completion response size",
    ),
    "addon.requestTimeoutMs": setting(
        1500,
        "ms",
        "Console addon completion deadline",
    ),
    "addon.handshakeTimeoutMs": setting(
        3000,
        "ms",
        "Console addon authentication deadline",
    ),
    "addon.connectTimeoutMs": setting(
        2000,
        "ms",
        "Console addon connection deadline",
    ),
    "addon.reconnectDelayMs": setting(
        1000,
        "ms",
        "Console addon reconnect interval",
        false,
    ),
    "logs.maxLines": setting(10000, "count", "Requested log lines"),
    "logs.maxLineBytes": setting(
        256 * 1024,
        "bytes",
        "Displayed server log line size",
    ),
    "logs.maxOutputChars": setting(
        65536,
        "characters",
        "Captured Java output line length",
    ),
    "logs.pageBytes": setting(
        MiB,
        "bytes",
        "Log history read page size",
        false,
    ),
    "logs.followBytes": setting(
        65536,
        "bytes",
        "Live log read chunk size",
        false,
    ),
    "logs.anchorBytes": setting(
        4096,
        "bytes",
        "Log rotation identity anchor size",
        false,
    ),
    "logs.pollMs": setting(150, "ms", "Live log polling interval", false),
    "logs.maxStyleChars": setting(
        128,
        "characters",
        "ANSI style sequence length",
    ),
    "cache.maxRegistryBytes": setting(
        2 * MiB,
        "bytes",
        "Cache project registry size",
    ),
    "cache.maxProjects": setting(10000, "count", "Registered cache projects"),
    "cache.partialMaxAgeMs": setting(
        24 * 60 * 60 * 1000,
        "ms",
        "Minimum age of abandoned cache partials",
        false,
    ),
    "completion.maxInputChars": setting(
        4096,
        "characters",
        "Shell completion word length",
    ),
    "completion.maxWords": setting(
        128,
        "count",
        "Shell completion request words",
    ),
    "completion.maxScanEntries": setting(
        10000,
        "count",
        "Shell completion directory entries",
    ),
    "completion.maxCandidates": setting(
        200,
        "count",
        "Shell completion candidates",
    ),
    "completion.maxProfileBytes": setting(
        MiB,
        "bytes",
        "Shell startup profile size",
    ),
    "completion.hostTimeoutMs": setting(
        3000,
        "ms",
        "Shell host discovery deadline",
    ),
    "completion.maxHostBytes": setting(
        65536,
        "bytes",
        "Shell host process output size",
    ),
    "completion.maxParentDepth": setting(
        12,
        "count",
        "Shell host parent process depth",
    ),
    "search.debounceMs": setting(
        300,
        "ms",
        "Plugin search debounce interval",
        false,
    ),
    "search.pageSize": setting(
        20,
        "count",
        "Plugin search API page size",
        false,
        1,
        100,
    ),
    "search.maxResults": setting(
        100,
        "count",
        "Plugin search results retained",
    ),
    "search.maxQueryChars": setting(
        120,
        "characters",
        "Plugin search query length",
    ),
    "display.maxItems": setting(
        20,
        "count",
        "Items shown in human-readable summaries",
    ),
    "display.maxTextChars": setting(
        240,
        "characters",
        "Inline terminal text length",
    ),
    "display.maxCatalogChars": setting(
        160,
        "characters",
        "Default plugin catalog text length",
    ),
    "display.maxDescriptionChars": setting(
        180,
        "characters",
        "Plugin description length",
    ),
    "display.maxTitleChars": setting(100, "characters", "Plugin title length"),
    "display.progressTickMs": setting(
        100,
        "ms",
        "Interactive progress refresh interval",
        false,
    ),
    "display.progressPollMs": setting(
        1000,
        "ms",
        "Noninteractive progress refresh interval",
        false,
    ),
    "display.progressReportMs": setting(
        10000,
        "ms",
        "Noninteractive waiting report interval",
        false,
    ),
    "process.permissionsTimeoutMs": setting(
        15000,
        "ms",
        "Filesystem permission command deadline",
    ),
    "process.maxPermissionsBytes": setting(
        4096,
        "bytes",
        "Filesystem permission command output",
    ),
    "process.maxAclBytes": setting(65536, "bytes", "ACL inspection output"),
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type RuntimeSettings = Readonly<Record<SettingKey, number>>;
export type SettingsOverrides = Partial<Record<SettingKey, number>>;
export type SettingsSource =
    | "default"
    | "workspace"
    | "project"
    | "environment"
    | "cli";
export interface ResolvedSettings {
    values: RuntimeSettings;
    sources: Readonly<Record<SettingKey, SettingsSource>>;
    deprecated: readonly string[];
}
export const DEFAULT_SETTINGS: RuntimeSettings = Object.freeze(
    Object.fromEntries(
        Object.entries(SETTINGS).map(([key, definition]) => [
            key,
            definition.default,
        ]),
    ) as Record<SettingKey, number>,
);
export const DEPRECATED_SETTINGS = {
    "java.startupTimeout": "runtime.startupTimeoutMs",
    "java.stopTimeout": "runtime.stopTimeoutMs",
    PI_TUI_ESC_TIMEOUT: "console.escapeTimeoutMs",
} as const satisfies Record<string, SettingKey>;

export function settingEnvironmentName(key: SettingKey): string {
    return `CRAFLEET_SETTINGS_${key
        .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
        .replaceAll(".", "_")
        .toUpperCase()}`;
}

export function validateSetting(key: string, value: unknown): number {
    if (!Object.hasOwn(SETTINGS, key))
        throw new CrafleetError(
            "SETTINGS_KEY",
            `Unknown runtime setting: ${/^[A-Za-z][A-Za-z0-9.]*$/u.test(key) ? key : "(invalid key)"}. Use crafleet settings list.`,
            2,
        );
    const definition = SETTINGS[key as SettingKey];
    if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        (!(value === -1 && definition.unlimited) &&
            (value < definition.minimum || value > definition.maximum))
    )
        throw new CrafleetError(
            "SETTINGS_VALUE",
            `Invalid ${key}; expected an integer from ${definition.minimum} to ${definition.maximum}${definition.unlimited ? ", or -1 for unlimited" : ""}. Input values are omitted.`,
            2,
        );
    return value;
}

const nestedSchema: Record<string, Record<string, unknown>> = {};
for (const [key, definition] of Object.entries(SETTINGS)) {
    const [group = "", name = ""] = key.split(".");
    const number = type(
        `number.integer >= ${definition.minimum} & number <= ${definition.maximum}`,
    );
    const members = nestedSchema[`${group}?`] ?? { "+": "reject" };
    nestedSchema[`${group}?`] = members;
    members[`${name}?`] = definition.unlimited ? number.or("-1") : number;
}
export const RuntimeSettingsSchema = type({ "+": "reject", ...nestedSchema });

export function flattenSettings(input: unknown): SettingsOverrides {
    if (input === undefined) return {};
    if (!input || typeof input !== "object" || Array.isArray(input))
        throw new CrafleetError(
            "SETTINGS_VALUE",
            "settings must be a mapping.",
            2,
        );
    const output: SettingsOverrides = {};
    for (const [group, entries] of Object.entries(input)) {
        if (!entries || typeof entries !== "object" || Array.isArray(entries))
            throw new CrafleetError(
                "SETTINGS_VALUE",
                "Settings groups must be mappings.",
                2,
            );
        if (!Object.keys(SETTINGS).some((key) => key.startsWith(`${group}.`)))
            validateSetting(group, 0);
        for (const [name, value] of Object.entries(entries)) {
            const key = `${group}.${name}`;
            output[key as SettingKey] = validateSetting(key, value);
        }
    }
    return output;
}

export function parseSettingAssignments(
    assignments: readonly string[],
): SettingsOverrides {
    const result: SettingsOverrides = {};
    for (const assignment of assignments) {
        const separator = assignment.indexOf("=");
        if (separator < 1)
            throw new CrafleetError(
                "SETTINGS_VALUE",
                "Use --set key=integer. Input values are omitted.",
                2,
            );
        const key = assignment.slice(0, separator);
        const value = assignment.slice(separator + 1);
        result[key as SettingKey] = validateSetting(
            key,
            /^-?\d+$/u.test(value) ? Number(value) : undefined,
        );
    }
    return result;
}

export function resolveSettings(
    layers: readonly { source: SettingsSource; values: SettingsOverrides }[],
    deprecated: readonly string[] = [],
): ResolvedSettings {
    const values = { ...DEFAULT_SETTINGS };
    const sources = Object.fromEntries(
        Object.keys(SETTINGS).map((key) => [key, "default"]),
    ) as Record<SettingKey, SettingsSource>;
    for (const layer of layers)
        for (const [name, value] of Object.entries(layer.values)) {
            const key = name as SettingKey;
            values[key] = validateSetting(key, value);
            sources[key] = layer.source;
        }
    return Object.freeze({
        values: Object.freeze(values),
        sources: Object.freeze(sources),
        deprecated: Object.freeze([...new Set(deprecated)]),
    });
}

/** Infinity is only a local comparison bound, never a stored setting or allocation size. */
export function settingLimit(
    settings: RuntimeSettings,
    key: SettingKey,
): number {
    return settings[key] === -1 ? Number.POSITIVE_INFINITY : settings[key];
}
export function assertSettingLimit(
    size: number,
    settings: RuntimeSettings,
    key: SettingKey,
    code = "SETTINGS_LIMIT",
): void {
    if (size > settingLimit(settings, key))
        throw new CrafleetError(
            code,
            `${key} exceeds its configured limit (${settings[key]} ${SETTINGS[key].unit}).`,
            3,
            `Adjust settings.${key}, ${settingEnvironmentName(key)}, or --set ${key}=<integer>; -1 removes this application limit.`,
        );
}
