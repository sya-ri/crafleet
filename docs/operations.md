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
| `deploy apply` | Apply pending to a stopped server after the required backup; leave it stopped. |

`start`, `run`, and `restart` can apply pending after shutdown, file checks, and the required backup. `--active` uses the deployed installation. Routine server updates retain the declared Minecraft version; plugin versions are opaque provider labels, not SemVer ranges.

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

### Supervision

After a successful explicit start, run `crafleet -C <project> supervise` in a separate terminal or foreground OS service. It restarts server-initiated exits and crashes after 10 seconds, using active artifacts offline. The limit is five automatic starts in five minutes. Failed readiness or an exhausted budget requires an explicit successful start/restart to re-arm.

`stop` and cancelling `run` persist stopped intent. The supervisor respects that intent and waits during maintenance. Unknown processes, interrupted operations, and unsafe locks block automatic starts. It never applies pending, accepts fresh EULA consent, or force-kills Java.

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

Servers sharing a database need the same `backup.group` and compatible database, repository, artifact, and retention settings. Select every group member for `start`, `restart`, `deploy apply`, `backup create`, and `backup apply`; configure its repository before first start. Artifact preparation may target a subset. See [backups](backups.md) for recovery.

## Diagnostics and completion

`validate` checks declarations and metadata; `doctor` checks Java, managed files, runtime, backups, and persistent completion. `doctor --json` or `--dry-run` is read-only. Interactive diagnosis may offer completion setup after a preview and confirmation.

```sh
crafleet completion install
crafleet completion install bash --dry-run
crafleet doctor --shell bash
```

Supported shells are Bash, Zsh, Fish, and PowerShell. The installer detects the calling shell or asks for one, shows changed paths, and preserves text outside its managed blocks. Edited or custom settings are not overwritten. For explicit noninteractive setup, use `completion install <shell> --yes`. Open a new shell or use the displayed loading command afterward; diagnosis cannot prove completion is loaded in the current terminal.

For manual setup, generate a script with `completion <shell>` and load it in that shell. Completion uses local state and requested directories only, with up to 200 candidates; a longer prefix narrows results. It does not query providers or execute the command being completed. Use [JSON results](automation.md), not terminal tables or completion suggestions, as a machine interface.
