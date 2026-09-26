# Runtime settings

Operational limits for files, backups, downloads, the runner and the console can be configured per key. Defaults preserve the existing behavior. `crafleet settings list` lists the catalog and `crafleet settings show` lists effective values with their sources. Both accept `--json` and the usual directory/workspace target options.

```sh
crafleet settings show --json
crafleet --set files.maxTextBytes=8388608 files list
crafleet backup create --set backup.maxFiles=-1
crafleet settings show --set backup.maxFiles=1000 --set backup.maxFiles=-1
```

The priority is **CLI > environment > project > workspace > defaults**, separately for each key. Repeat `--set key=integer` anywhere before or after the command; the last occurrence of the same key wins. Environment variable names use `CRAFLEET_SETTINGS_` followed by the uppercase snake-case key: `backup.maxFiles` becomes `CRAFLEET_SETTINGS_BACKUP_MAX_FILES`.

Both `crafleet.yaml` and `crafleet-workspace.yaml` accept an optional mapping:

```yaml
settings:
    files:
        maxTextBytes: 8388608
    backup:
        maxFiles: -1
    runtime:
        startupTimeoutMs: 180000
        stopTimeoutMs: 120000
    console:
        escapeTimeoutMs: 10
```

All values are integers. **`-1` means unlimited**, only for keys marked below. `unlimited` is not accepted. Zero never means unlimited; it is accepted only when the finite range starts at zero (for example, no retries). Polling/delay intervals and chunk/page sizes must remain positive and finite. Millisecond values cannot exceed 2147483647, so Node timers cannot overflow. Invalid values and unknown keys fail before the operation starts.

Each project operation uses its own immutable settings. Workspace discovery, shared locks and group journals use the workspace settings; individual members use their own project settings. The workspace declaration itself is read with defaults, environment and CLI settings; project declarations additionally use the enclosing workspace. A file cannot increase the limit used to read itself. Raise that limit in a higher layer. Writing declarations uses the same enclosing limits.

Settings are resolved on the next command or process start. The runner saves the settings used at startup and forwards the required settings to the Java console addon. Restart the runner to apply changes to a running server. Older runners/addons keep their original limits: update them and restart before relying on raised limits. Cancellation, disconnects and process shutdown remain effective with an unlimited timeout. Operating-system resource limits and upstream API/library limits still apply; unlimited does not guarantee unlimited memory or storage.

Lowering a limit can make existing state, journals or backups unreadable. Crafleet retains these files: increase the indicated setting and retry recovery. Do not delete recovery records to bypass a size error. `stop` and `status` retain their recovery path when declaration YAML is broken.

Resolved declarations are cached for the current command, including concurrent reads and shared workspace settings. A new command gets a fresh cache. Processing loops reuse their limits from the current immutable project or workspace snapshot.

## Deprecated compatibility inputs

| Deprecated input | Replacement | Conversion |
| --- | --- | --- |
| `java.startupTimeout` | `settings.runtime.startupTimeoutMs` | seconds × 1000 |
| `java.stopTimeout` | `settings.runtime.stopTimeoutMs` | seconds × 1000 |
| `PI_TUI_ESC_TIMEOUT` | `CRAFLEET_SETTINGS_CONSOLE_ESCAPE_TIMEOUT_MS` or `settings.console.escapeTimeoutMs` | milliseconds |

These inputs remain accepted during the compatibility period. Old YAML belongs to the project layer; the old environment variable belongs to the environment layer. New inputs win within the same layer. Every old key read produces one warning on stderr per command, even when overridden. The warning never includes its input value and does not affect JSON stdout.

**将来のリリースで削除予定。具体的な削除バージョンは未定。** No removal release has been scheduled. The separate legacy configuration removal in 0.6.0 does not apply to these aliases. Files are not automatically rewritten. See [DEPRECATION.md](../DEPRECATION.md).

The SSH-specific default for `console.escapeTimeoutMs` is 100 ms when `SSH_CONNECTION` or `SSH_TTY` is present, preserving existing terminal behavior; its ordinary default is 10 ms.

## Scope of the limits

The source audit covers production modules under `packages/core/src`, `packages/adapters/src`, `packages/cli/src`, and the Java console bridge. Exported legacy `MAX_*` and supervision constants refer to catalog defaults; operations use the resolved values. The three addon-only keys `addon.maxResponseBytes`, `addon.connectTimeoutMs`, and `addon.reconnectDelayMs` are transported to Java rather than consumed as Node limits.

Remaining numeric constants describe formats or algorithms: UUID/hash lengths and truncated internal identifiers; archive headers and conservative disk-space estimates; character/ANSI codes and terminal layout geometry; network ports and VarInt widths; SQL identifier/OID formats; supported Java/server versions and verified release assets; two-phase stale-owner recovery and process identity rechecks. The libpq connection timeout is expressed in seconds by the external library. API page sizes stay within provider ceilings while configurable page counts control total lookup work. Java's inline defaults are compatibility fallbacks for an older runner that does not send settings. Development, test and release script deadlines are outside this runtime catalog.

## Catalog

This table and the JSON Schemas are generated from `packages/core/src/domain/settings.ts` during the build. Runtime validation and `settings list` use the same catalog.

<!-- catalog:start -->

| Key | Default | Unit | Supports -1 | Finite range | Applies to |
| --- | ---: | --- | --- | --- | --- |
| `database.connectTimeoutMs` | 10000 | ms | yes | 1–2147483647 | PostgreSQL connection deadline (libpq rounds to seconds) |
| `state.maxGroupOwnerBytes` | 16384 | bytes | yes | 1–9007199254740991 | Group restore workspace owner record |
| `console.exitDrainTimeoutMs` | 100 | ms | yes | 1–2147483647 | Terminal input drain deadline on exit |
| `console.exitDrainIdleMs` | 20 | ms | no | 1–2147483647 | Terminal input idle interval on exit |
| `logs.pageLines` | 200 | count | no | 1–9007199254740991 | Default console log page size |
| `display.maxTableColumns` | 500 | characters | yes | 1–9007199254740991 | Human table terminal width |
| `display.maxErrorChars` | 220 | characters | yes | 1–9007199254740991 | Plugin picker error text |
| `display.maxSelectionChars` | 60 | characters | yes | 1–9007199254740991 | Plugin picker selection labels |
| `display.maxListTitleChars` | 80 | characters | yes | 1–9007199254740991 | Plugin picker list titles and version IDs |
| `display.maxAuthorChars` | 50 | characters | yes | 1–9007199254740991 | Plugin author names |
| `display.maxVersionChars` | 90 | characters | yes | 1–9007199254740991 | Plugin version labels |
| `display.maxDateChars` | 30 | characters | yes | 1–9007199254740991 | Plugin publication date |
| `display.maxReviewChars` | 70 | characters | yes | 1–9007199254740991 | Plugin selection review labels |
| `completion.maxInputBytes` | 65536 | bytes | yes | 1–9007199254740991 | Total shell completion request size |
| `files.readChunkBytes` | 65536 | bytes | no | 1–2147483647 | Bounded text read chunk |
| `files.hashChunkBytes` | 262144 | bytes | no | 1–2147483647 | Managed file hashing chunk |
| `backup.copyChunkBytes` | 1048576 | bytes | no | 1–2147483647 | Backup file copy chunk |
| `backup.maxArchiveEntries` | 16 | count | yes | 1–9007199254740991 | Restic ZIP entry count |
| `runtime.maxConnections` | 32 | count | yes | 1–9007199254740991 | Runner IPC connections |
| `artifacts.hangarMaxVersionPages` | 1 | count | yes | 1–9007199254740991 | Hangar version lookup pages |
| `artifacts.hangarPageSize` | 25 | count | no | 1–25 | Hangar version page size |
| `artifacts.spigotPageSize` | 100 | count | no | 1–100 | Spiget version page size |
| `logs.readRetries` | 1 | count | yes | 0–9007199254740991 | Log rotation read retries |
| `console.maxVisibleSuggestions` | 4 | count | yes | 1–9007199254740991 | Visible completion candidates |
| `database.sqliteRetryMs` | 50 | ms | no | 1–2147483647 | SQLite busy retry delay |
| `files.maxYamlBytes` | 2097152 | bytes | yes | 1–9007199254740991 | Declaration and lockfile size |
| `files.maxGitignoreBytes` | 1048576 | bytes | yes | 1–9007199254740991 | .gitignore size |
| `files.maxTextBytes` | 4194304 | bytes | yes | 1–9007199254740991 | Managed structured text size |
| `files.maxStateBytes` | 33554432 | bytes | yes | 1–9007199254740991 | File observation and defaults state size |
| `files.maxJournalBytes` | 100663296 | bytes | yes | 1–9007199254740991 | File capture and migration journal size |
| `files.maxPaths` | 10000 | count | yes | 1–9007199254740991 | Managed file paths per operation |
| `files.maxDiscoveryEntries` | 10000 | count | yes | 1–9007199254740991 | Entries visited during file discovery |
| `files.maxDiscoveryDepth` | 16 | count | yes | 1–9007199254740991 | File discovery directory depth |
| `files.maxPatterns` | 512 | count | yes | 1–9007199254740991 | File selection patterns |
| `files.maxPatternChars` | 4096 | characters | yes | 1–65536 | Glob pattern length (picomatch also imposes its own ceiling) |
| `files.maxStructureNodes` | 100000 | count | yes | 1–9007199254740991 | Nodes in structured configuration |
| `files.maxStructureDepth` | 100 | count | yes | 1–9007199254740991 | Structured configuration nesting |
| `files.maxYamlAliases` | 50 | count | yes | 1–9007199254740991 | YAML alias expansion |
| `files.maxMergeCells` | 1000000 | count | yes | 1–9007199254740991 | Text merge comparison cells |
| `files.readConcurrency` | 4 | count | yes | 1–9007199254740991 | Concurrent file reads |
| `files.maxValidatedCacheEntries` | 10000 | count | yes | 0–9007199254740991 | Validated file object cache entries |
| `files.maxTokenizedCacheEntries` | 10000 | count | yes | 0–9007199254740991 | Tokenized file cache entries |
| `files.maxTokenizedCacheBytes` | 16777216 | bytes | yes | 0–9007199254740991 | Tokenized file cache size |
| `files.windowsRetries` | 5 | count | yes | 0–9007199254740991 | Retries after Windows sharing violations |
| `files.windowsRetryDelayMs` | 10 | ms | no | 1–2147483647 | Initial Windows sharing retry delay |
| `files.windowsRetryMaxDelayMs` | 80 | ms | no | 1–2147483647 | Maximum Windows sharing retry delay |
| `files.maxSecretBytes` | 65536 | bytes | yes | 1–9007199254740991 | Secret file size |
| `files.maxSecretChars` | 65536 | characters | yes | 1–9007199254740991 | Resolved secret length |
| `files.maxEulaBytes` | 65536 | bytes | yes | 1–9007199254740991 | EULA and consent record size |
| `workspace.maxDepth` | 12 | count | yes | 1–9007199254740991 | Workspace directory depth |
| `state.maxBytes` | 134217728 | bytes | yes | 1–9007199254740991 | Installation state size |
| `state.maxDeployJournalBytes` | 33554432 | bytes | yes | 1–9007199254740991 | Deployment journal size |
| `state.maxManifestJournalBytes` | 268435456 | bytes | yes | 1–9007199254740991 | Managed-files declaration transaction size |
| `state.maxLegacyManifestJournalBytes` | 33554432 | bytes | yes | 1–9007199254740991 | Legacy declaration transaction size |
| `state.maxManifestChanges` | 4096 | count | yes | 1–9007199254740991 | Declaration transaction changes |
| `state.maxRestoreJournalBytes` | 134217728 | bytes | yes | 1–9007199254740991 | Restore and group restore journal size |
| `state.maxRestoreChanges` | 250100 | count | yes | 1–9007199254740991 | Single-project restore changes |
| `state.maxGroupRestoreChanges` | 300000 | count | yes | 1–9007199254740991 | Group restore changes |
| `state.maxGuardBytes` | 4096 | bytes | yes | 1–9007199254740991 | Operation guard and supervision intent record size |
| `state.maxRecoveryRecordBytes` | 65536 | bytes | yes | 1–9007199254740991 | Runtime recovery record size |
| `backup.maxFiles` | 250000 | count | yes | 1–9007199254740991 | Backup files, database dumps and embedded objects |
| `backup.maxRoots` | 513 | count | yes | 1–9007199254740991 | Backup roots |
| `backup.maxGroupMembers` | 512 | count | yes | 1–9007199254740991 | Recovery group members |
| `backup.maxMetadataBytes` | 67108864 | bytes | yes | 1–9007199254740991 | Backup metadata size |
| `backup.maxActiveMetadataBytes` | 4194304 | bytes | yes | 1–9007199254740991 | Legacy active installation metadata size |
| `backup.maxFilesActiveMetadataBytes` | 33554432 | bytes | yes | 1–9007199254740991 | Managed-files active installation metadata size |
| `backup.maxPathChars` | 4096 | characters | yes | 1–9007199254740991 | Backup relative path length |
| `backup.maxPatterns` | 512 | count | yes | 1–9007199254740991 | Backup selection patterns |
| `backup.commandTimeoutMs` | 1800000 | ms | yes | 1–2147483647 | Backup subprocess deadline |
| `backup.maxOutputBytes` | 16777216 | bytes | yes | 1–9007199254740991 | Backup subprocess captured output |
| `backup.killGraceMs` | 1000 | ms | no | 1–2147483647 | Subprocess termination grace period |
| `backup.probeTimeoutMs` | 10000 | ms | yes | 1–2147483647 | Backup and database executable probe deadline |
| `backup.maxProbeOutputBytes` | 8192 | bytes | yes | 1–9007199254740991 | Executable probe output size |
| `backup.maxBinaryBytes` | 67108864 | bytes | yes | 1–9007199254740991 | Expanded restic executable size |
| `backup.decodeTimeoutMs` | 30000 | ms | yes | 1–2147483647 | Restic archive decode deadline |
| `backup.downloadTimeoutMs` | 120000 | ms | yes | 1–2147483647 | Restic download deadline |
| `backup.maxDownloadRedirects` | 4 | count | yes | 0–9007199254740991 | Restic download redirects |
| `database.queryTimeoutMs` | 30000 | ms | yes | 1–2147483647 | Database verification query deadline |
| `database.lockTimeoutMs` | 5000 | ms | yes | 1–2147483647 | PostgreSQL lock acquisition deadline |
| `database.maxOutputBytes` | 8388608 | bytes | yes | 1–9007199254740991 | PostgreSQL command output size |
| `database.maxVerificationOutputBytes` | 65536 | bytes | yes | 1–9007199254740991 | Database verification output size |
| `database.sqliteTimeoutMs` | 5000 | ms | yes | 1–2147483647 | SQLite lock wait deadline |
| `database.sqliteBackupRate` | 128 | count | no | 1–2147483647 | SQLite pages copied per backup step |
| `http.timeoutMs` | 120000 | ms | yes | 1–2147483647 | Provider request deadline |
| `http.maxMetadataBytes` | 8388608 | bytes | yes | 1–9007199254740991 | Provider metadata response size |
| `http.maxRedirects` | 5 | count | yes | 0–9007199254740991 | Provider download redirects |
| `artifacts.maxBytes` | 536870912 | bytes | yes | 1–9007199254740991 | Artifact JAR size |
| `artifacts.maxGlobEntries` | 20000 | count | yes | 1–9007199254740991 | Entries visited while resolving local JARs |
| `artifacts.maxGlobDepth` | 64 | count | yes | 1–9007199254740991 | Local JAR discovery depth |
| `artifacts.maxJarEntries` | 100000 | count | yes | 1–9007199254740991 | JAR ZIP entries |
| `artifacts.maxDescriptorBytes` | 262144 | bytes | yes | 1–9007199254740991 | Expanded plugin descriptor size |
| `artifacts.maxPluginIdChars` | 128 | characters | yes | 1–9007199254740991 | Plugin identifier length |
| `artifacts.maxVersionPages` | 10 | count | yes | 1–9007199254740991 | SpigotMC version label search pages |
| `runtime.startupTimeoutMs` | 180000 | ms | yes | 1–2147483647 | Server readiness deadline |
| `runtime.stopTimeoutMs` | 120000 | ms | yes | 1–2147483647 | Graceful server stop deadline |
| `runtime.requestTimeoutMs` | 5000 | ms | yes | 1–2147483647 | Runner IPC request deadline |
| `runtime.stopGraceMs` | 5000 | ms | no | 1–2147483647 | Runner stop acknowledgement grace |
| `runtime.pollMs` | 150 | ms | no | 1–2147483647 | Readiness polling interval |
| `runtime.stopPollMs` | 50 | ms | no | 1–2147483647 | Runner exit polling interval |
| `runtime.statusPollMs` | 500 | ms | no | 1–2147483647 | Foreground server status polling interval |
| `runtime.pingTimeoutMs` | 2000 | ms | yes | 1–2147483647 | Minecraft status ping deadline |
| `runtime.maxPingBytes` | 1048576 | bytes | yes | 1–9007199254740991 | Minecraft status response size |
| `runtime.maxFrameBytes` | 65536 | bytes | yes | 1–9007199254740991 | Runner IPC frame size |
| `runtime.maxRecordBytes` | 32768 | bytes | yes | 1–9007199254740991 | Runner record size |
| `runtime.javaProbeTimeoutMs` | 5000 | ms | yes | 1–2147483647 | Java executable probe deadline |
| `runtime.maxJavaProbeBytes` | 65536 | bytes | yes | 1–9007199254740991 | Java executable probe output |
| `supervision.pollMs` | 1000 | ms | no | 1–2147483647 | Supervisor polling interval |
| `supervision.restartDelayMs` | 10000 | ms | no | 1–2147483647 | Automatic restart delay |
| `supervision.windowMs` | 300000 | ms | no | 1–2147483647 | Automatic restart accounting window |
| `supervision.maxAttempts` | 5 | count | yes | 1–9007199254740991 | Automatic starts within the accounting window |
| `console.maxCommandChars` | 8192 | characters | yes | 1–9007199254740991 | Console command and completion text length |
| `console.maxCommandBytes` | 8192 | bytes | yes | 1–9007199254740991 | JSON-encoded console command size |
| `console.maxInputBytes` | 16384 | bytes | yes | 1–9007199254740991 | JSON console input line size |
| `console.maxRequestIdChars` | 128 | characters | yes | 1–9007199254740991 | JSON console request identifier length |
| `console.maxHistoryEntries` | 1000 | count | yes | 1–9007199254740991 | Retained console command history |
| `console.maxHistoryBytes` | 41943040 | bytes | yes | 1–9007199254740991 | Console history file size |
| `console.maxUndoEntries` | 100 | count | yes | 1–9007199254740991 | Console input undo history |
| `console.maxPasteChars` | 65536 | characters | yes | 1–9007199254740991 | Buffered terminal paste length |
| `console.historyLockTimeoutMs` | 10000 | ms | yes | 1–2147483647 | Console history lock wait deadline |
| `console.historyLockPollMs` | 25 | ms | no | 1–2147483647 | Console history lock retry interval |
| `console.maxPreferenceBytes` | 1024 | bytes | yes | 1–9007199254740991 | Console addon preference record size |
| `console.escapeTimeoutMs` | 10 | ms | no | 1–2147483647 | Terminal escape sequence idle time; defaults to 100 ms over SSH |
| `console.drainTimeoutMs` | 1000 | ms | yes | 1–2147483647 | Terminal input drain deadline |
| `console.drainIdleMs` | 50 | ms | no | 1–2147483647 | Terminal input drain idle interval |
| `console.flushTimeoutMs` | 1000 | ms | yes | 1–2147483647 | JSON console output flush deadline |
| `console.capabilitiesTimeoutMs` | 1000 | ms | yes | 1–2147483647 | Console capability request deadline |
| `console.completionTimeoutMs` | 2000 | ms | yes | 1–2147483647 | Console completion IPC deadline |
| `console.maxLiveLines` | 2000 | count | yes | 1–9007199254740991 | Retained live console transcript lines |
| `console.maxLiveBytes` | 4194304 | bytes | yes | 1–9007199254740991 | Retained live console transcript bytes |
| `console.maxEmptyHistoryPages` | 8 | count | yes | 1–9007199254740991 | Empty log pages inspected per scroll |
| `addon.maxConnections` | 8 | count | yes | 1–9007199254740991 | Console bridge connections |
| `addon.maxPending` | 32 | count | yes | 1–9007199254740991 | Concurrent console completion requests |
| `addon.maxSuggestions` | 256 | count | yes | 1–9007199254740991 | Completion suggestions per response |
| `addon.maxFrameBytes` | 65536 | bytes | yes | 1–9007199254740991 | Console addon transport frame size |
| `addon.maxResponseBytes` | 60000 | bytes | yes | 1–9007199254740991 | Console addon completion response size |
| `addon.requestTimeoutMs` | 1500 | ms | yes | 1–2147483647 | Console addon completion deadline |
| `addon.handshakeTimeoutMs` | 3000 | ms | yes | 1–2147483647 | Console addon authentication deadline |
| `addon.connectTimeoutMs` | 2000 | ms | yes | 1–2147483647 | Console addon connection deadline |
| `addon.reconnectDelayMs` | 1000 | ms | no | 1–2147483647 | Console addon reconnect interval |
| `logs.maxLines` | 10000 | count | yes | 1–9007199254740991 | Requested log lines |
| `logs.maxLineBytes` | 262144 | bytes | yes | 1–9007199254740991 | Displayed server log line size |
| `logs.maxOutputChars` | 65536 | characters | yes | 1–9007199254740991 | Captured Java output line length |
| `logs.pageBytes` | 1048576 | bytes | no | 1–9007199254740991 | Log history read page size |
| `logs.followBytes` | 65536 | bytes | no | 1–9007199254740991 | Live log read chunk size |
| `logs.anchorBytes` | 4096 | bytes | no | 1–9007199254740991 | Log rotation identity anchor size |
| `logs.pollMs` | 150 | ms | no | 1–2147483647 | Live log polling interval |
| `logs.maxStyleChars` | 128 | characters | yes | 1–9007199254740991 | ANSI style sequence length |
| `cache.maxRegistryBytes` | 2097152 | bytes | yes | 1–9007199254740991 | Cache project registry size |
| `cache.maxProjects` | 10000 | count | yes | 1–9007199254740991 | Registered cache projects |
| `cache.partialMaxAgeMs` | 86400000 | ms | no | 1–2147483647 | Minimum age of abandoned cache partials |
| `completion.maxInputChars` | 4096 | characters | yes | 1–9007199254740991 | Shell completion word length |
| `completion.maxWords` | 128 | count | yes | 1–9007199254740991 | Shell completion request words |
| `completion.maxScanEntries` | 10000 | count | yes | 1–9007199254740991 | Shell completion directory entries |
| `completion.maxCandidates` | 200 | count | yes | 1–9007199254740991 | Shell completion candidates |
| `completion.maxProfileBytes` | 1048576 | bytes | yes | 1–9007199254740991 | Shell startup profile size |
| `completion.hostTimeoutMs` | 3000 | ms | yes | 1–2147483647 | Shell host discovery deadline |
| `completion.maxHostBytes` | 65536 | bytes | yes | 1–9007199254740991 | Shell host process output size |
| `completion.maxParentDepth` | 12 | count | yes | 1–9007199254740991 | Shell host parent process depth |
| `search.debounceMs` | 300 | ms | no | 1–2147483647 | Plugin search debounce interval |
| `search.pageSize` | 20 | count | no | 1–100 | Plugin search API page size |
| `search.maxResults` | 100 | count | yes | 1–9007199254740991 | Plugin search results retained |
| `search.maxQueryChars` | 120 | characters | yes | 1–9007199254740991 | Plugin search query length |
| `display.maxItems` | 20 | count | yes | 1–9007199254740991 | Items shown in human-readable summaries |
| `display.maxTextChars` | 240 | characters | yes | 1–9007199254740991 | Inline terminal text length |
| `display.maxCatalogChars` | 160 | characters | yes | 1–9007199254740991 | Default plugin catalog text length |
| `display.maxDescriptionChars` | 180 | characters | yes | 1–9007199254740991 | Plugin description length |
| `display.maxTitleChars` | 100 | characters | yes | 1–9007199254740991 | Plugin title length |
| `display.progressTickMs` | 100 | ms | no | 1–2147483647 | Interactive progress refresh interval |
| `display.progressPollMs` | 1000 | ms | no | 1–2147483647 | Noninteractive progress refresh interval |
| `display.progressReportMs` | 10000 | ms | no | 1–2147483647 | Noninteractive waiting report interval |
| `process.permissionsTimeoutMs` | 15000 | ms | yes | 1–2147483647 | Filesystem permission command deadline |
| `process.maxPermissionsBytes` | 4096 | bytes | yes | 1–9007199254740991 | Filesystem permission command output |
| `process.maxAclBytes` | 65536 | bytes | yes | 1–9007199254740991 | ACL inspection output |

<!-- catalog:end -->
