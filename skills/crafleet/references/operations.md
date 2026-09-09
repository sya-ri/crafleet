# Operational workflows

At a workspace root, multi-project read commands automatically list all members. Changes and single-target commands offer an interactive project or complete recovery-group picker. For agents and scripts, always provide `--filter`, `-r`, or `-C <project>` when an operation needs a target; `--json`, CI, and `--yes` do not infer consent or select a project. A direct `-C <project> stop` remains available when that project's declaration is broken.

For automation, pass `--json` and inspect both the top-level `ok` and exit code. Failed checks and partial workspace operations retain `result` alongside `error`; do not infer success from the presence of results. Finite operations return one JSON document. Followed logs and foreground operation streams use NDJSON, ending normally with an `event: "result"` record. Use `--help --json` for structured arguments, options, target cardinality, and input alternatives. Missing input and confirmation errors never authorize retrying with `--yes` unless that consent was already given.

Use this reference to choose Crafleet commands and preserve the desired, pending, and active model. Check the installed command's `--help` before relying on optional flags.

## Inspect before changing

From the project or workspace root:

```sh
crafleet validate
crafleet doctor
crafleet status
crafleet deploy plan
```

Use `--json` when the result will be parsed. Use `-C <directory>` instead of relying on an uncertain current directory. In a workspace, select explicitly with `-r` or `--filter`.

## Initialize or import

Create a new project:

```sh
crafleet init survival --name survival --type paper --version 26.2
crafleet -C survival install
crafleet -C survival doctor
crafleet -C survival start
```

For Paper, `init` may request Minecraft EULA consent. Read the authorization rules in [safety-and-recovery.md](safety-and-recovery.md) before interacting with that prompt or adding `--yes`.

Import copies a stopped server into a new project and leaves the source unchanged:

```sh
crafleet import /srv/old-server /srv/crafleet-server \
    --name survival \
    --type paper \
    --version 26.2 \
    --stopped
```

Inspect `crafleet import --help`, confirm the source server is stopped, and keep the source until the imported project is verified.

## Resolve and stage artifacts

```sh
crafleet plugins inspect ../build/MyPlugin.jar
crafleet plugins add
crafleet plugins add file:../build/MyPlugin.jar
crafleet plugins
crafleet server
crafleet install
crafleet plugins check
crafleet server check
crafleet plugins update MyPlugin
crafleet deploy plan
```

- `plugins` and `server` show desired, locked, pending, and active artifact state without querying providers. Add `--latest` to either inventory when the latest provider version and update status are needed.
- `plugins add` with no source opens an online Modrinth search for exactly one selected project in an interactive terminal outside CI. Space chooses the latest compatible release, Right Arrow opens exact versions, `a` includes prereleases, and Enter reviews then confirms the cart. It is unavailable with `--json`, `--yes`, or `--offline`; pass explicit sources for scripts and multi-project selections.
- `plugins add --dry-run` may use the interactive search, but does not download JARs or change declarations, the lock, cache, pending, or active state.
- `plugins add` and `plugins remove` update declarations and prepare pending. Removing a plugin leaves its data.
- `install` reproduces unchanged lock entries and resolves only changed declarations. `--frozen-lockfile` refuses missing or stale lock data.
- `plugins check [names...]` and `server check` only report provider updates.
- `plugins update [names...]` selects new plugin versions, updates declaration/lock state, and prepares pending; no names selects all declared plugins. `server update` does the same for the server artifact. Use `--to` only for an explicitly requested plugin version or server provider version/Paper build.
- None of these commands replaces a running JAR.

After reviewing pending, apply it with a managed start/restart or with stopped-only `deploy apply`:

```sh
crafleet restart
# or, while stopped:
crafleet deploy apply
```

`deploy apply` takes the required backup and does not start Java. `deploy discard` drops only pending; YAML and lock remain desired.

## Operate the server

| Command | Effect |
| --- | --- |
| `start` | Start a stopped server and apply verified pending when present. |
| `start --active` | Start the current active installation without applying pending. |
| `restart` | Gracefully stop, optionally apply pending after backup, then start. |
| `stop` | Gracefully stop and verify process exit; never apply pending. |
| `run` | Start and follow logs; Ctrl-C requests graceful stop. |
| `supervise` | Foreground, single-project active-only offline supervisor; respects persisted stops and operation locks. |
| `console` | Open with recent logs and command input; PageUp or the mouse wheel loads older history, End returns to live output, and Ctrl-C detaches without stopping the server. Use `--json` for a non-TTY NDJSON session. |
| `logs --follow` | Follow redacted logs; detaching does not stop the server. |
| `command <text>` | Send one command through the authenticated runner. |
| `status` | Report process state and persisted runtime intent (`running`, `stopped`, or absent). |

A timeout does not authorize force termination. Do not kill every Java process or trust a PID alone.

### Supervision

Run `crafleet -C <project> supervise` after an explicit successful start. A missing intent never starts an existing project automatically. Server-initiated clean exits and Java crashes preserve running intent; `stop` and cancelling `run` record stopped intent. Routine start, stop, backup, deploy and restore commands coordinate with the supervisor through the operation mutex.

From 0.2.1, transient operation-lock contention waits for a live owner or retries after the lock has been released. A newly created ownerless lock gets one polling interval for owner publication; a persistently ownerless, malformed or ended lock still blocks supervision. Supervisor election, polling and graceful shutdown use this same rule. No operation lock is removed automatically.

Automatic restarts use the active installation offline after 10 seconds, at most five attempts in five minutes. They never apply pending or accept EULA consent. Failed readiness, exhausted budget, unknown identity, unsafe locks and recovery journals stop automatic progress. Inspect the reported error and use an explicit successful start/restart to re-arm when appropriate. Do not invoke general recovery or remove state merely to make supervision resume.

SIGINT/SIGTERM to the supervisor gracefully stops Java while retaining intent for the next supervisor or host start. The supervisor stays alive while intentionally stopped during normal operation. OS services must invoke `supervise` directly rather than an unconditional `start`; systemd can use `Restart=on-failure`, `RestartPreventExitStatus=2 3 4`, and no automatic SIGKILL fallback. OS service installation requires separate user authorization. Every runtime operator must use Crafleet 0.2.0 or later.

## Track configuration

Initial capture after the first server-generated files exist:

```sh
crafleet config list --candidates
crafleet config capture --initial
crafleet config track plugins/MyPlugin/config.yml
crafleet config diff
crafleet config capture
crafleet install
```

Register secret references before capture. Later capture compares base, prior observation, and runtime. If a conflict is reported, inspect it and resolve deliberately:

```sh
crafleet config resolve plugins/MyPlugin/config.yml --use base
# or:
crafleet config resolve plugins/MyPlugin/config.yml --use runtime
```

Pass exact runtime-relative paths to `config capture <paths...>` when the request concerns only particular plugin files. An existing selected runtime file is captured and becomes tracked; `config track <paths...>` is the explicit alternative when beginning tracking. Omitting paths captures all currently tracked files and may exceed a narrowly scoped request.

Run `install` after a base change or capture so the new configuration becomes pending. Deployment rechecks runtime immediately before applying and refuses to overwrite unreviewed changes.

## Configure and create backups

Use an absolute local or mounted path outside runtime and staging. The destination's parent must already exist. `--init` explicitly creates a new encrypted restic repository; omit it when registering an existing one.

```sh
crafleet backup setup main \
  --path /mnt/backups/survival \
  --password-env CRAFLEET_BACKUP_PASSWORD \
  --init
crafleet backup plan
crafleet backup create
crafleet backup list
crafleet backup check --read-data
```

Crafleet verifies the repository and restic before stopping. A cold backup resumes only servers that were running, using the same active installation rather than pending. `--leave-stopped` prevents resume.

Inspect a snapshot before applying it:

```sh
crafleet backup show <snapshot-id>
crafleet backup restore <snapshot-id> --to /restore/survival
crafleet backup apply /restore/survival --dry-run
crafleet backup apply /restore/survival
```

`backup restore` requires one explicit snapshot ID of 8 to 64 lowercase hexadecimal characters. A phrase such as “yesterday” is not an ID and may match multiple snapshots or depend on timezone. Use `backup list --json` and `backup show <id> --json`, then have the operator or an explicit policy select one ID before extraction. `backup apply` takes the verified extraction directory produced by `backup restore`, not a snapshot ID.

`restore` extracts only into an empty separate directory. `apply` verifies it, stops the selected server group, takes a pre-restore backup, restores the snapshot's operating data and active installation, clears pending, and leaves Java stopped. The current desired YAML and shared lock remain unchanged. External roots and databases require explicit mappings/selections. After inspecting the restored state, use `crafleet start --active` to launch that restored active installation; a later `install` may prepare the still-declared desired state again.

After an update or restore, collect `status`, `plugins`, `server`, relevant logs, `config diff`, and the application's actual health signal. “Looks bad” remains an operator decision unless the user supplies a concrete, observable rollback condition; do not invent one.

Pruning is preview-only unless explicitly applied:

```sh
crafleet backup prune
crafleet backup prune --apply
crafleet cache prune
crafleet cache prune --apply
```

## Workspace operations

```sh
crafleet workspace list
crafleet -r status
crafleet --filter survival plugins check
```

Workspace operations have deterministic selection. Use all group members for shared backup/database production actions. Declaration preparation may target a subset, but a partial runtime result must be reported project by project.

## Diagnose and recover

```sh
crafleet doctor
crafleet recover --dry-run
crafleet recover
```

Use recovery only when Crafleet reports an interrupted journal or lock. Inspect the dry run and confirm the server state first. `recover --unlock` removes only locks belonging to ended operations; it does not terminate Java. Never delete journals manually to make an error disappear.

## Command groups

- Project: `init`, `import`, `workspace init/list`, `validate`, `doctor`
- Artifacts: `install`, `plugins [--latest]`, `plugins inspect/add/remove/check/update`, `server [--latest]`, `server check/update`
- Runtime: `start`, `restart`, `stop`, `status`, `command`, `logs`, `run`, `console`
- Deployment: `deploy plan/apply/discard`, `recover`
- Configuration: `config list/track/untrack/diff/capture/resolve`
- Backup: `backup setup/plan/create/list/show/diff/check/restore/apply/prune`
- Maintenance: `cache info/verify/prune`, `tools prepare restic`

## Machine console

Use an explicit single project with `console --json`. Send UTF-8 lines such as `{"id":"1","command":"list"}`; consume `connected`, `log`, `log-reset`, `command`, `disconnected`, and final `result` events. Correlate only `command` acknowledgements by ID: logs do not prove which request completed. `sent: true` with `execution: "unconfirmed"` is transport acknowledgement, not game-level success.

Keep IDs within 1–128 characters, each line within 16,384 bytes, and each command's JSON string within 8,192 bytes. Commands cannot contain CR, LF or NUL; only id/command fields are supported. Malformed input increments failures and resumes at the next line. Respect stdout backpressure. EOF processes the final line and detaches; Ctrl-C and connection loss detach without stopping Java. Never automatically resend an unacknowledged command or assume a replacement runner is the same session. The final summary can be absent if stdout closes or cannot drain during the bounded detach interval.
