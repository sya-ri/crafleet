# Operations

## Target and inspect

Use explicit `-C <project>`, `--filter`, or `-r`. Workspace-root read commands can list all members, but JSON/CI/noninteractive mutations never select a project implicitly. Complete recovery groups are required for grouped lifecycle and backup operations. `-C <project> stop` works even with a broken declaration.

```sh
crafleet validate --json
crafleet status --json
crafleet doctor --json
crafleet deploy plan --json
```

Check both JSON `ok` and exit code; partial failures retain successful per-project results. Finite commands return one document. Followed logs, `run`, `supervise`, and JSON console use NDJSON with a final result event on normal completion. Use `--help --json` for arguments, target cardinality, and input alternatives. Human tables and completion output are not authoritative machine inventories.

## Initialize or import

```sh
crafleet init survival --name survival --type paper --version 26.2
crafleet -C survival install
crafleet -C survival start
```

Resolve [EULA consent](safety-and-recovery.md#consent) before Paper initialization or launch. A pristine standalone first start needs no backup repository; existing runtime data and recovery groups require one before apply/start as appropriate.

`import <source> <destination> --name <name> --type <type> --version <version> --stopped` copies a stopped server, preserving the source. Verify the source is stopped and retain it until the imported project is checked.

## Prepare artifacts

| Command | Effect |
| --- | --- |
| `plugins`, `server` | Local declared/locked/pending/active inventory; `--latest` adds provider status. |
| `plugins inspect <jar>` | Read the plugin's descriptor identity. |
| `plugins add <sources...>`, `plugins remove <names...>` | Update declarations and pending; removal retains data. |
| `install` | Reproduce unchanged locks and resolve changed declarations; `--frozen-lockfile` rejects stale/missing entries. |
| `plugins check [names...]`, `server check` | Report provider updates without mutation. |
| `plugins update [names...]`, `server update` | Select new versions and stage pending. No names updates all plugins; plugin `--to` needs one name. |
| `deploy apply`, `deploy discard` | Apply while stopped, or drop pending while retaining desired YAML/lock. |

Use explicit sources for automation. Source-free `plugins add` opens an online, single-project Modrinth picker only in an interactive terminal, without `--json`, `--yes`, or `--offline`. Picker dry runs may search but do not download or stage.

## Runtime and supervision

`start` launches; `restart` gracefully stops then launches; both can apply pending. `--active` keeps the deployed installation. `run` follows logs and Ctrl-C requests a stop. `console` and `logs --follow` detach without stopping; console PageUp/mouse loads history and End returns live. `command <text>` sends one command.

Run `supervise` for one project after an explicit start. It restarts active artifacts offline after 10 seconds, at most five starts in five minutes. Failed readiness, exhausted budget, unknown processes, unsafe locks, and journals block automatic progress. An explicit successful start/restart re-arms it. Missing intent never implicitly starts a project.

`stop` and cancelling `run` persist stopped intent. SIGINT/SIGTERM to the supervisor stops Java while preserving intent. Services invoke `supervise` directly; unconditional `start` overrides intentional stops. Every operator needs at least 0.2.0, and supervisors must understand any newer declaration fields before those are added.

## Capture files

Read [project files](project-files.md#managed-files) first. After registering secrets and stopping the server, select exact paths or a bounded capture:

```sh
crafleet files list --candidates
crafleet files capture --initial --include 'plugins/MyPlugin/progress/**/*.yml' --keep-missing
crafleet files diff
crafleet install
```

No paths captures all managed files and can exceed a narrow request. Exact runtime-relative paths capture and track selected files. Inspect conflicts before `files resolve <path> --use base|runtime`. Deployment rechecks runtime and refuses unreviewed changes.

## Back up and restore

Register an absolute repository outside runtime/staging with an existing parent. `backup setup <id> --path <path> --password-env <name> --init` creates a new repository; omit `--init` for an existing one. `--password-file` is an alternative.

Use `backup plan`, `create`, `list`, `show <id>`, and `check --read-data` as needed. Cold backup resumes only previously running servers with the same active installation; `--leave-stopped` prevents resume.

Choose one exact 8–64-character lowercase hexadecimal snapshot ID from `backup list --json` and inspect it. Resolve ambiguous dates or rollback criteria with the user or an explicit policy before applying.

```sh
crafleet backup restore <snapshot-id> --to /restore/survival
crafleet backup apply /restore/survival --dry-run
crafleet backup apply /restore/survival
```

`restore` extracts to an empty separate directory. `apply` takes that directory, verifies targets, stops the group, makes a pre-restore snapshot, restores data and the snapshot's active installation, clears pending, and leaves Java stopped. Desired YAML/lock remain unchanged. Select external roots with `--map root-id=absolute-path` and databases with `--database id`.

After inspecting restored state, `start --active` starts the restored installation. A later `install` can prepare the current desired declaration again. Check status, artifacts, relevant logs/files, and the application's actual health signal. See [recovery constraints](safety-and-recovery.md).

## Maintenance

`backup prune` and `cache prune` preview; `--apply` deletes. `recover --dry-run` previews journal recovery; run `recover` within the authorized scope. `--unlock` is for ended operation owners, not process termination. File migration has its own resume/rollback command.

`completion <shell>` generates a script. `completion install [shell]` previews persistent setup and asks for confirmation; explicit noninteractive installation requires `--yes`. It preserves custom settings. `doctor --json`, `--dry-run`, `--yes`, CI, and non-TTY runs do not install completion. A passing check describes persistent setup, not the current shell's loaded state.

## JSON console

`console --json` accepts bounded UTF-8 NDJSON requests such as `{"id":"1","command":"list"}` for one running project. Inspect `connected` for input limits. IDs are echoed without deduplication. Command `ok` acknowledges a stdin write with `execution: "unconfirmed"`, not game-level success; logs cannot be attributed to requests.

EOF processes accepted input then detaches. Ctrl-C, pipe failure, or the original runner ending also detaches without stopping, reconnecting, or retrying. An unacknowledged command may have reached Java. `serverStopped: false` describes detachment, not current Java state. Full protocol: [automation contract](https://github.com/sya-ri/crafleet/blob/master/docs/automation.md#json-console-sessions).
