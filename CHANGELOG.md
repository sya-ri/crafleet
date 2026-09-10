# Changelog

All notable changes to Crafleet are documented in this file.

## 0.3.1 - 2026-09-11

### Added

- `config.files` in `crafleet.yaml` configures runtime-relative discovery globs, with ordered exclusions and reinclusion. Omission retains the existing standard candidates, an explicit list replaces them, and an empty list disables discovery of new files. Missing or non-directory discovery roots produce no candidates on all supported platforms. `config capture --initial` uses the same rules; ordinary diff/capture continue to operate on managed files.
- `completion install [shell]` previews and confirms persistent user completion setup for Bash, Zsh, Fish, and PowerShell. Dry runs, explicit noninteractive confirmation, managed updates, and preservation of existing profile content are supported.
- `doctor --shell <shell>` checks persistent completion settings and offers confirmed setup in interactive terminals. JSON, CI, non-terminal, `--yes`, and dry-run diagnostics remain read-only; structured help describes the optional interactive setup.

### Changed

- `config list --candidates` now lists only files not yet managed by Crafleet. Use `config list` for managed files; no additional filtering option is needed.

## 0.3.0 - 2026-09-10

### Added

- `backup.artifacts: none | local | all` embeds exact active JARs by SHA-256 in snapshot format 2, with format 1 reading retained and the default unchanged.
- Single-project and recovery-group restoration verifies embedded artifacts, seeds the shared artifact cache, and supports `all` without original JARs, artifact cache entries, or provider network access. Pending and different versions are never substitutes.

- PostgreSQL 17/18 custom-format backups using verified matching-major official clients and separate optional recovery credentials.
- OID-checked PostgreSQL replacement through `backup apply --database` and `recover`, preserving database ownership, grants and settings, retaining the disabled original database, and leaving Java stopped.

- Non-TTY `console --json` sessions with bounded sequential requests, correlated send acknowledgements, log events, backpressure, and detach-only EOF/Ctrl-C handling. Sessions pin the original authenticated runner and never resend commands or attach to replacement processes. This replaces the previous `CONSOLE_TTY` rejection for JSON callers.

- Bash, Zsh, Fish, and PowerShell completion scripts with offline command, option, workspace project, plugin, and local path suggestions. Structured help exposes the same completion input kinds.
- Workspace-root read commands list all supported members, while changes and single-target commands offer an explicit project or recovery-group selection in interactive terminals.

- Width-aware human tables for inventories, workspace status, update checks, validation, and backup lists, with complete wrapped values and a labeled layout for narrow terminals.
- Plain-text operation announcements on interactive stderr and clearly labeled error hints, without color-dependent meanings or JSON output changes.
- Structured `--help --json` command, argument, option, and operation-policy metadata, including explicit alternatives to prompted inputs.
- Consistent finite JSON documents and framed terminal results for foreground NDJSON streams.

### Fixed

- Runner command acknowledgements wait for the Java stdin write callback, so a slow Java reader applies backpressure before another request is acknowledged.

- Workspace discovery prunes paths outside declared project patterns and explicit subtree exclusions. Unrelated database/data directories no longer break workspace commands; selected-path permission, symlink, and depth failures remain visible.

- Supervisor election, polling, and graceful shutdown retry when maintenance releases its lock during the bounded owner-file read, while retaining blocked states for unsafe or abandoned locks.
- Failed checks and partial workspace operations now return top-level `ok: false` while retaining their results and existing nonzero exit codes. Consumers must not assume that a returned result indicates success.

## 0.2.1 - 2026-09-09

### Fixed

- Supervisors retry transient operation-lock contention even when the competing operation finishes before owner inspection. Concurrent supervisors in a shared workspace no longer stop healthy Java processes for this race.
- Supervisor election and graceful shutdown use the same bounded owner-publication check while retaining fail-closed behavior for abandoned locks, malformed owners and duplicate supervisors.

## 0.2.0 - 2026-09-09

### Added

- Foreground `crafleet supervise` automatically restarts a stopped active installation after a server-initiated shutdown or crash, while preserving explicit operator stops across supervisor and host restarts.
- Durable runtime intent, exposed by `status`, coordinates supervision with deployment, backup, restore, and workspace operation locks. Failed maintenance stays stopped, and automatic restarts never apply pending changes or contact artifact providers.
- Bounded automatic restart attempts, duplicate-supervisor protection, and explicit blocked states for unknown processes and recovery journals.
- Interactive Modrinth search and version selection when `plugins add` is run without a source in a supported terminal.

### Fixed

- Plugin inspection accepts Paper-compatible unindented continuation lines in quoted root descriptions while retaining strict descriptor validation and the original JAR bytes.
- The published CLI now supports every Node.js 24 release by separating its runtime requirement from the newer Node.js version required by the development toolchain.

### Compatibility

- The published CLI supports Node.js 24, 25, and 26. Building Crafleet requires Node.js 24.11.1 or later because of its build dependencies and a config-loading bug in Node.js 24.11.0.

## 0.1.0 - 2026-08-30

### Added

- Declarative Paper and Velocity projects backed by `crafleet.yaml`, a SHA-256-pinned lock file, and optional multi-project workspaces.
- Server and plugin artifact resolution from Paper, Modrinth, Hangar, SpigotMC, GitHub Releases, and local JARs, with plugin identity read from Bukkit, Paper, and Velocity descriptors without executing the JAR.
- Separate pending and active installations so server and plugin updates can be prepared while a server is running, reviewed, and applied after the required safety backup during a managed start or restart.
- Cross-platform process control with graceful start, stop, restart, status, log following, and a scrollback console that detaches without stopping the server.
- Three-way configuration capture and conflict resolution, explicit secret references, tracked configuration inventories, and safe regeneration of pending installations.
- Encrypted restic backups and staged restores for files, SQLite databases, and InnoDB-only MySQL and MariaDB databases, including coordinated backup and recovery for groups of servers that share data.
- Existing-server import, deployment planning, diagnostics, interruption recovery, cache pruning, and offline artifact reuse.
- Human-readable command output alongside stable JSON output, dry-run previews, explicit confirmation, and per-project results for workspace operations.
- Remembered Minecraft EULA consent for Paper and automatic `.gitignore` entries when a project is created inside a Git worktree.
- A distributable `crafleet` agent skill covering project files, routine operations, safety boundaries, backups, and recovery.

### Fixed

- EULA consent files receive private permissions even when Crafleet runs from an elevated Windows account.
- Partial failures in multi-project commands retain and report the successful project results alongside the failures.

### Compatibility

- The CLI requires Node.js 24.20.0 or later and earlier than Node.js 27, and runs on Linux, Windows, and macOS with the Java version required by the selected server.
- Automatic restic setup supports Linux x64 and arm64, macOS x64 and arm64, and Windows x64. Other architectures can use artifact and configuration management but cannot run restic-backed backup operations in this release.

### Known limitations

- Crafleet does not install Java, establish SSH connections, or register operating-system services. It must be installed on each remote server host that it manages.
- Crafleet rejects known unregistered server secrets, but plugin-specific secret fields still require operator review before captured configuration is committed.
