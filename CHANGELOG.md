# Changelog

Release-specific installation and upgrade guidance is in [docs/releases](docs/releases).

## 0.4.1 - 2026-09-12

### Fixed

- Supervision no longer treats normal operation lock handoffs as stale locks after interrupted reads or consecutive publication observations. Election, polling, and shutdown compare lock identities and retry; persistently unsafe locks still block.

## 0.4.0 - 2026-09-11

### Added

- Text and binary file management through `files/` and `files.patterns`, including hash/size diffs and whole-file binary conflicts.
- Stopped, atomic capture with repeatable `--include`, new-file discovery via `--initial`, `--keep-missing`, and interruption recovery.
- Restartable `files migrate --from config` with preview and rollback, preserving saved content, observations, and installation identities.
- Format 3 backups embed active file objects and restore without the original object store; formats 1 and 2 remain readable.

### Changed

- New projects use `files/` instead of `config/`.

### Deprecated

- Legacy configuration remains for unmigrated projects through 0.5.x; removal is scheduled in 0.6.0. Migration and old backup readers remain. See [deprecations](DEPRECATION.md).

## 0.3.1 - 2026-09-11

### Added

- `config.files` ordered discovery globs: omission keeps defaults, a list replaces them, and `[]` disables new discovery. Missing/non-directory roots yield no candidates.
- Previewed, confirmed `completion install [shell]` for Bash, Zsh, Fish, and PowerShell.
- `doctor --shell` checks persistent completion and offers setup in interactive terminals; automated diagnostics remain read-only.

### Changed

- `config list --candidates` lists only unmanaged files; use `config list` for managed files.

## 0.3.0 - 2026-09-10

### Added

- `backup.artifacts: none | local | all` embeds exact active JARs in format 2, deduplicates hashes, and seeds the restore cache. Format 1 remains readable; `all` removes source/cache/provider requirements for JAR recovery.
- PostgreSQL 17/18 backups with matching official clients and optional separate restore credentials. Staged, OID-checked replacement retains the original database and leaves Java stopped.
- Non-TTY `console --json` with bounded ordered requests, send acknowledgements, log events, backpressure, and detach-only EOF/Ctrl-C. No automatic reconnection or resend.
- Offline Bash/Zsh/Fish/PowerShell completion and interactive workspace project/recovery-group selection.
- Width-aware terminal tables, stderr progress, and labeled error hints.
- Structured `--help --json`, consistent finite JSON, and final results for foreground NDJSON streams.

### Fixed

- Runner acknowledgements wait for Java's stdin write callback.
- Workspace discovery prunes unrelated paths while retaining selected-path errors.
- Supervision retries maintenance-lock release races during owner reads.
- Failed checks and partial workspace operations return `ok: false` with retained results and nonzero exit codes.

## 0.2.1 - 2026-09-09

### Fixed

- Supervision retries transient lock contention during election, polling, and shutdown without stopping healthy Java. Abandoned/malformed locks and duplicate supervisors still block operation.

## 0.2.0 - 2026-09-09

### Added

- Foreground `supervise` with persisted intent, bounded restarts, and coordination with maintenance. Intentional stops remain stopped; automatic starts use active artifacts offline.
- Interactive Modrinth search and version selection in source-free `plugins add`.

### Fixed

- Accept Paper-compatible quoted multiline plugin descriptions while preserving descriptor validation and original JAR bytes.
- Support every Node.js 24 release in the published CLI.

### Compatibility

- CLI supports Node.js 24–26; development requires 24.11.1 or later.

## 0.1.0 - 2026-08-30

### Added

- Declarative Paper/Velocity projects, optional workspaces, and SHA-256-pinned locks.
- Server/plugin sources from Paper, Modrinth, Hangar, SpigotMC, GitHub Releases, and local JARs; descriptor inspection without code execution.
- Pending/active installations and managed deployment after a cold backup.
- Cross-platform runtime control, logs, and a detachable scrollback console.
- Three-way configuration capture, conflict resolution, and explicit secret references.
- Encrypted restic backups and staged restores for files, SQLite, and InnoDB MySQL/MariaDB, including shared recovery groups.
- Import, diagnostics, interruption recovery, cache pruning, and offline reuse.
- Human/JSON results, dry runs, explicit confirmation, and per-project failure reporting.
- Remembered Paper EULA consent, Git-worktree `.gitignore` setup, and a distributable agent skill.

### Fixed

- Private EULA receipt permissions for elevated Windows accounts.
- Retain successful project results alongside partial workspace failures.

### Compatibility

- Node.js 24.20.0 through 26 on Linux, Windows, and macOS; Java follows the selected server.
- Automatic restic: Linux/macOS x64 and arm64, Windows x64.

### Known limitations

- Java installation, remote access, and OS services are external to Crafleet.
- Plugin-specific secrets need review before captured files enter Git.
