# Server operations

For installation, see the [README](../README.md). Commands below run from a project directory; use `-C <directory>` to select another project.

## Artifacts and deployment

| Command | Effect |
| --- | --- |
| `plugins`, `server` | Show declared, locked, pending, and active versions locally. |
| `plugins --latest`, `server --latest` | Add the provider's latest eligible version. |
| `plugins check [names...]`, `server check` | Report updates without changing files. |
| `plugins add <sources...>`, `plugins remove <names...>` | Change declarations and prepare pending; removal retains plugin data. |
| `plugins update [names...]`, `server update` | Select versions and prepare pending. No plugin names selects all; plugin `--to` requires one name. |
| `install` | Reproduce unchanged lock entries and resolve changed declarations. `--frozen-lockfile` rejects missing or stale entries. |
| `deploy plan`, `deploy discard` | Inspect or discard pending; discard retains declarations and lock. |
| `deploy apply` | Apply pending to a stopped server after a backup when configured; leave it stopped. |

`start`, `run`, and `restart` can apply pending after shutdown, file checks, and a backup when configured. Omitting `backup.repository` skips automatic backups; configured backup failures block deployment. `--active` uses the deployed installation. Routine server updates retain the declared Minecraft version; plugin versions are opaque provider labels, not SemVer ranges.

### Plugin sources

```text
modrinth:<project>@<version>
spigotmc:<resource-id>@<version>
hangar:<project>@<version>
github:<owner>/<repo>@<tag>#<asset-name>
file:../build/MyPlugin.jar
file:../build/MyPlugin-*.jar
```

Omit a provider version for its latest eligible release. The lock records exact bytes and SHA-256. Local paths are relative to `crafleet.yaml`; a glob must match exactly one file. Structured YAML such as `{ provider: file, path: ../build/MyPlugin.jar }` is also accepted. Restricted providers may require a separately downloaded `file:` source.

`plugins inspect <jar>` reads the identity without executing the JAR: `name` from `plugin.yml` or `paper-plugin.yml`, or `id` from `velocity-plugin.json`. Use that identity in subsequent commands. Identity changes, incompatible plugins, and missing required dependencies are rejected.

Run `plugins add` without sources for the interactive Modrinth browser. Space selects a release, Right Arrow opens versions, `a` includes prereleases, and Enter reviews then confirms. It requires one project and an online terminal outside CI; scripts use explicit sources. `--dry-run` can search but does not download or stage JARs.

## Runtime

| Command | Effect |
| --- | --- |
| `status` | Show process state and persisted running/stopped intent. |
| `start`, `restart`, `stop` | Start, gracefully restart, or stop and verify Java's exit. |
| `run` | Start and follow logs; Ctrl-C requests shutdown. |
| `console` | Show recent logs and accept commands; Ctrl-C detaches. |
| `logs --follow` | Follow logs; detaching leaves Java running. |
| `command <text>` | Send one command to the managed runner. |
| `supervise` | Restart one project's active installation while respecting intentional stops. |

Stop timeouts do not force termination. An unidentifiable process is reported as `unknown` and needs inspection.

### Log display

`console`, `logs`, `logs --follow`, and `run` preserve ANSI colors and text decorations and convert Minecraft `§` color codes, including `§#RRGGBB` and `§x§R§R§G§G§B§B`. Obfuscated text remains readable. Colors survive console wrapping, resizing, history loading, and live updates. Cursor movement, screen clearing, and other untrusted terminal controls remain disabled.

Color is enabled only when stdout is a terminal, `TERM` is not `dumb`, and `NO_COLOR` is unset or empty. Redirected output strips supported formatting; JSON preserves the original log text and its existing framing.

New Paper and Velocity launches default to `-Dterminal.ansi=true` and `-Dterminal.jline=false`, so piped server output retains colors without an interactive Java prompt. Explicit values in `java.args` take precedence. These defaults apply on the next start or restart; colors already absent from stored logs cannot be recovered.

### Supervision

After a successful explicit start, run `crafleet -C <project> supervise` in a separate terminal or foreground OS service. It restarts server-initiated exits and crashes after 10 seconds, using active artifacts offline. The limit is five automatic starts in five minutes. Failed readiness or an exhausted budget requires an explicit successful start/restart to re-arm.

`stop` and cancelling `run` persist stopped intent. The supervisor respects that intent and waits during maintenance. Unknown processes, interrupted operations, and unsafe locks block automatic starts. It never applies pending, accepts fresh EULA consent, or force-kills Java.

If an operation lock is replaced during inspection, supervision retries normal lock acquisition. Owner publication and failed reads get one polling interval to settle; observations of different lock identities do not count as one abandoned operation. Persistently unreadable or unsafe owners under the same lock still block supervision. No operation lock is removed automatically.

SIGINT/SIGTERM to the supervisor gracefully stops Java but preserves intent for the next supervisor or host start. A project without recorded intent is not started implicitly. Every runtime operator must use Crafleet 0.2.0 or later; upgrade supervisors before adopting newer declaration fields.

For systemd, invoke `supervise` directly with fixed executable paths, `Restart=on-failure`, `RestartPreventExitStatus=2 3 4`, and no automatic SIGKILL fallback. An unconditional `start` in the service would override intentional stops. Crafleet does not install services.

## Workspaces

Create `crafleet-workspace.yaml` above independent projects:

```yaml
schemaVersion: 1
projects:
    - servers/*
```

Each project retains its own declaration and installation; the workspace shares a lock. `workspace list` shows members. Workspace-root read commands show all members, while mutations and single-project commands offer an interactive selection. In scripts, explicitly use `-r`, `--filter <name-or-path-pattern>`, or `-C <project>`. `--yes` does not select targets; zero matches is an error. `console`, `logs`, and `supervise` require one project.

Discovery stays within positive patterns, excludes hidden and runtime/config/node_modules directories, and rejects links or traversal outside the workspace. Use `!servers/retired/**` to exclude an entire subtree. Selected-path permission errors and the 12-directory depth limit are reported rather than treated as an empty result.

Servers sharing a database need the same `backup.group` and compatible database, repository, artifact, and retention settings. Select every group member for `start`, `restart`, `deploy apply`, `backup create`, and `backup apply`. For startup and deployment, omit `backup.repository` on every member to skip automatic backups, or configure the same alias on every member. Mixed configured/unconfigured members and differing aliases are rejected. Artifact preparation may target a subset. See [backups](backups.md) for recovery.

## Diagnostics and completion

`validate` checks declarations and metadata; `doctor` checks Java, managed files, runtime, backups, and persistent completion. `doctor --json` or `--dry-run` is read-only. Interactive diagnosis may offer completion setup after a preview and confirmation.

```sh
crafleet completion install
crafleet completion install bash --dry-run
crafleet doctor --shell bash
```

Supported shells are Bash, Zsh, Fish, and PowerShell. The installer detects the calling shell or asks for one, shows changed paths, and preserves text outside its managed blocks. Edited or custom settings are not overwritten. For explicit noninteractive setup, use `completion install <shell> --yes`. Open a new shell or use the displayed loading command afterward; diagnosis cannot prove completion is loaded in the current terminal.

For manual setup, generate a script with `completion <shell>` and load it in that shell. Completion uses local state and requested directories only, with up to 200 candidates; a longer prefix narrows results. It does not query providers or execute the command being completed. Use [JSON results](automation.md), not terminal tables or completion suggestions, as a machine interface.

## Console history and completion

Up/Down recalls saved commands for the current server and restores the draft when you return to the newest position. History keeps the latest 1,000 nonempty submissions, and consecutive duplicates are collapsed.

### Console completion addon

`console` can offer installation of the optional completion addon before entering the screen. Command history works without it. Read the [addon guide](../addons/console/README.md) for the three choices, per-server dismissal, `--ask-addon`, manual `addons` commands and compatibility. JSON console sessions remain non-interactive and never offer installation.

## Command progress

Human-readable commands report their start and current operation on stderr. Lists and checks such as `validate`, `status`, and `plugins` show their results together when inspection finishes; plugin tables are grouped by project. If inspection fails or is cancelled, available results appear under `Partial results:` before the error. Operations such as starting or updating servers continue to show results as each item becomes ready, as do diagnostics from `doctor` and cache inspection. Interactive terminals use a spinner and measured download bytes; redirected output uses plain lines with a waiting update every ten seconds. Download completion is distinct from verification and saving the pending installation. `--json` disables progress and preserves the complete structured result.
