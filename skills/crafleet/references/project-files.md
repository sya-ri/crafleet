# Project files

## Layout and declarations

| Path | Ownership |
| --- | --- |
| `crafleet.yaml` | Reviewed server, plugin, Java, file, secret, and backup declarations. |
| `crafleet-lock.yaml` | Crafleet-resolved versions, locations, sizes, and hashes; commit, but do not edit manually. |
| `files/` | Saved files mirroring runtime-relative paths; review before committing. |
| `runtime/` | Live files and deployed JARs; private. |
| `.crafleet/` | Private installation state, file objects, observations, locks, intent, and journals. |
| `~/.crafleet/` | Shared cache, tools, repository registry, runner, and EULA receipt; override with `CRAFLEET_HOME`. |

Prefer `init` for initial declarations. Project names allow letters, digits, dot, underscore, and dash. Server type is `paper` or `velocity`; version means Minecraft version for Paper and proxy version for Velocity. `java.command` is a PATH executable or absolute path.

Relative source, secret-file, database, and backup paths resolve from `crafleet.yaml` unless the command requires an absolute path. `init` adds runtime/local-state/secret exclusions to `.gitignore` only inside an existing Git worktree; it does not initialize or operate Git.

## Artifact sources

```text
modrinth:<project>@<version>
spigotmc:<resource-id>@<version>
hangar:<project>@<version>
github:<owner>/<repo>@<tag>#<asset-name>
file:../build/MyPlugin.jar
file:../build/MyPlugin-*.jar
```

Omitted provider versions select the latest eligible release; the lock records exact artifacts. Local globs need exactly one match; `plugins update` imports changed local bytes. Provider versions are opaque, not SemVer ranges.

Plugin map keys come from descriptors: `name` in Bukkit/Paper YAML or `id` in Velocity JSON. Use `plugins inspect` or `plugins add` to discover them. Identity changes, incompatibility, and missing required dependencies are rejected without executing JAR code.

Structured sources use `provider` plus: Modrinth/Hangar `project`; SpigotMC `resource`; GitHub `owner`, `repo`, `asset`; file `path`. External providers also accept `version`.

## Managed files

Legacy migration requires upgrading every operator/supervisor and stopping Java. Preview and run `files migrate --from config`; it moves `config/`, converts `config.files` to `files.patterns`, and preserves bytes, references, observations, and installation identities. It does not touch runtime or resolve new artifacts. Conflicting destinations/mixed declarations are refused. Resume interruption with the same command or add `--rollback`; keep journals intact. Legacy commands remain for unmigrated projects through 0.5.x, with removal scheduled in 0.6.0. Migration and old backup readers remain afterward.

`files/` mirrors `runtime/` paths and supports text/binary content. Capture, track, untrack, and resolve require stopped state and the lifecycle lock. Do not infer that all plugin YAML is configuration or safe to commit.

```yaml
files:
    patterns:
        - server.properties
        - plugins/MyPlugin/progress/**/*.yml
        - "!**/draft/**"
```

Omission keeps standard candidates; an explicit list replaces them; `[]` disables discovery. Rules support `*`, `**`, `?`, character classes, and ordered `!` exclusions with last-match precedence. They are case-sensitive, include hidden files, and use runtime-relative `/` paths. No parent traversal, absolute paths, regex, braces, extglobs, JARs, or symlink targets. Prefer narrow roots.

`list --candidates` is read-only and shows only new files. Ordinary diff/capture uses managed files. `--initial` adds discovery; `--include` limits managed and new paths; `--keep-missing` retains saved files absent from runtime. Explicit patterns still bound discovery; without them, includes may select beyond standard defaults. Excluding candidates does not untrack files.

Binary diffs compare hash and size; divergent changes need whole-file resolution. Binary objects remain private in `.crafleet/file-objects/`, outside JSON state. Format 3 embeds required active objects and baselines regardless of JAR policy; restore verifies and repopulates the store. Do not edit/delete objects. Text keeps semantic merging and the 4 MiB structured-text bound; modified TOML comments are not preserved. Binary data is not redacted.

## Secrets

Register exact values before capture:

```yaml
secrets:
    DATABASE_PASSWORD:
        env: MINECRAFT_DB_PASSWORD
    PAPER_MANAGEMENT_SECRET:
        file: /private/paper-management-secret
```

Saved text uses `${secret:NAME}`. Capture tokenizes known values; deployment resolves them. Crafleet does not load `.env` files. Unregistered known server secrets are rejected, but plugin-specific secrets need review. Runtime/restored files may contain plaintext.

## Backup selection

`backup.files` uses project-relative ordered includes and `!` exclusions; last match wins. Re-include with a later normal rule. `.gitignore` and `!!` do not apply. Defaults include runtime/shared data and exclude JARs, logs, crash reports, libraries, and caches. External roots need explicit inclusion/mapping; symlink targets are not followed.

`backup.artifacts` is `none` (default), `local` (active file JARs), or `all` (active server/plugins). Embedding is independent of file exclusions, deduplicates hashes, and excludes pending/unmanaged JARs. All group members must agree. Formats 1–3 remain readable by this CLI; format 2 introduced embedded JARs and format 3 file objects.

`backup.databases` entries use `id` and `kind`. SQLite adds `path`. MySQL/MariaDB add connection settings and secret password references, require matching clients and InnoDB, and need `sslCa` outside loopback. PostgreSQL 17/18 requires matching-major `pg_dump`, `pg_restore`, and `psql`; optional `restore: { user, password, maintenanceDatabase }` separates recovery credentials. See [database recovery conditions](safety-and-recovery.md#databases) before restore.

Retention keys are `keepLast`, `keepDaily`, `keepWeekly`, and `keepMonthly`, each at least one.

## Workspaces

```yaml
schemaVersion: 1
projects:
    - servers/*
```

Each project retains its installation; the workspace shares the lock. `-r` selects all; repeated `--filter` selects names/relative paths. Zero matches is an error. Discovery stays in positive pattern scope, skips hidden/runtime/config/node_modules directories, rejects link bases/outside paths, and enforces 12-directory depth. Use `!servers/retired/**` for subtree exclusions; selected permission errors remain visible.

Shared writers need the same `backup.group` and compatible database, repository, artifact, and retention settings. `start`, `restart`, `deploy apply`, `backup create`, and `backup apply` require the complete group; artifact preparation may target a subset.
