# Project files and declarations

Read this reference before creating or editing a Crafleet project, workspace, artifact source, configuration template, secret reference, or backup selection.

## Layout and ownership

A standalone server has one `crafleet.yaml`. A workspace has `crafleet-workspace.yaml` at its root and one `crafleet.yaml` per server.

`crafleet init` creates or extends `.gitignore` only when the destination is already inside a Git worktree. The generated rules cover `runtime/`, `shared-data/`, `.crafleet/`, `imports/`, `.env`, and `.env.*`. It does not initialize Git, commit files, or touch `.gitignore` outside Git.

| Path | Ownership |
| --- | --- |
| `crafleet.yaml` | User-reviewed desired server, plugin, Java, secret-reference, and backup settings. |
| `crafleet-lock.yaml` | Crafleet-resolved artifact versions, locations, sizes, and SHA-256 hashes. Commit it; do not edit it by hand. |
| `config/` | Git-managed base configuration whose relative paths mirror `runtime/`. |
| `runtime/` | Live server files, worlds, plugin data, databases, and deployed JAR copies. |
| `.crafleet/` | Local active, pending, observations, locks, and recovery journals. Do not commit or edit it manually. |
| `.crafleet/runtime-intent.json` | Private running/stopped intent and recent automatic-start attempts. Managed only by Crafleet, excluded from Git and installation backups. |
| `~/.crafleet/` | Default shared home for the content-addressed artifact cache, tools, repository registry, runner, and EULA receipt. Override only with `CRAFLEET_HOME`. |

Relative source, secret-file, database, and backup patterns are resolved from the directory containing the relevant `crafleet.yaml`, unless a command requires an absolute path.

## Minimal declaration

Let `crafleet init` create the initial file when possible. A representative declaration is:

```yaml
schemaVersion: 1
name: survival
server:
    type: paper
    version: "26.2"
    build: latest
java:
    command: java
    args:
        - -Xms2G
        - -Xmx4G
plugins: {}
backup:
    files:
        - runtime/**
        - shared-data/**
        - "!**/*.[jJ][aA][rR]"
        - "!runtime/logs/**"
        - "!runtime/crash-reports/**"
        - "!runtime/libraries/**"
        - "!runtime/cache/**"
        - "!runtime/versions/**"
```

Project names contain only letters, digits, dot, underscore, and dash. Server type is `paper` or `velocity`. Use the Minecraft version for Paper and the proxy version for Velocity. Routine `server update` does not silently change this declared version.

`java.command` may be an executable on `PATH` or an absolute path. Crafleet diagnoses Java but does not install it.

## Artifact sources

Compact source syntax:

```text
modrinth:<project>@<version>
spigotmc:<resource-id>@<version>
hangar:<project>@<version>
github:<owner>/<repo>@<tag>#<asset-name>
file:../build/MyPlugin.jar
file:../build/MyPlugin-*.jar
```

A local glob must match exactly one JAR. `plugins update` imports changed local bytes. External providers may use non-SemVer identifiers; do not compare every version as SemVer.

Structured forms are available when compact syntax is ambiguous:

```yaml
plugins:
    ViaVersion:
        provider: modrinth
        project: viaversion
        version: latest
    MyPlugin:
        provider: file
        path: ../build/MyPlugin.jar
```

Other structured providers use:

```yaml
# SpigotMC
provider: spigotmc
resource: "19254"
version: latest

# Hangar
provider: hangar
project: ViaVersion
version: latest

# GitHub release asset
provider: github
owner: example
repo: plugin
version: v1.2.3
asset: plugin.jar
```

Plugin map keys are identities read from the JAR, not arbitrary labels:

- Bukkit/Spigot: `name` from `plugin.yml`
- Paper: `name` from `paper-plugin.yml`
- Velocity: `id` from `velocity-plugin.json`

Use `crafleet plugins inspect <jar>` or `crafleet plugins add <source>` to discover the identity. Crafleet rejects duplicate or incompatible identities, missing required dependencies, and silent identity changes. It inspects descriptors without executing JAR code.

## Configuration and secrets

Every tracked base file mirrors its runtime-relative path:

```text
config/server.properties             -> runtime/server.properties
config/config/paper-global.yml       -> runtime/config/paper-global.yml
config/plugins/MyPlugin/config.yml   -> runtime/plugins/MyPlugin/config.yml
```

Do not add arbitrary plugin YAML automatically. Use `config list --candidates`, then explicitly capture or track intended files. Omitting `config.files` keeps the existing standard candidates. An explicit list replaces those defaults; `[]` disables discovery of new files:

```yaml
config:
    files:
        - server.properties
        - config/paper-global.yml
        - plugins/MyPlugin/items/**/*.yml
        - plugins/MyPlugin/shops/**/*.yml
        - "!**/draft/**"
```

Rules support `*`, `**`, `?`, and character classes, are case-sensitive, and include hidden files. Normal rules include, `!` excludes, and the last match wins. Paths are relative to `runtime/`, with no `runtime/` prefix or parent traversal. JARs and symlink targets are never discovered. Prefer narrow plugin roots to keep discovery bounded. Regex, braces, and extglobs are unsupported.

`config capture --initial` uses the same candidate rules. Candidate listing is read-only and does not start tracking. Ordinary `config diff` and `config capture` use managed files only; removing a rule or excluding a path does not untrack existing configuration. Crafleet preserves source text where possible and does not run Biome or another source formatter over server configuration.

Declare a secret reference before capturing plaintext that must not enter Git:

```yaml
secrets:
    DATABASE_PASSWORD:
        env: MINECRAFT_DB_PASSWORD
    PAPER_MANAGEMENT_SECRET:
        file: /private/paper-management-secret
```

Use `${secret:NAME}` only in tracked base files. Crafleet resolves it at deployment, restores the reference during capture, and omits values from diffs and errors. It does not load `.env` files. Runtime files and restored data may still contain real secrets.

## Backup selection

`backup.files` is one ordered list. A normal pattern includes, `!` excludes, and the last matching rule wins. A later normal pattern re-includes. `.gitignore` is unrelated, and `!!` has no special meaning.

The defaults select runtime and shared operating data while excluding every JAR, logs, crash reports, downloaded libraries, and caches. Add or exclude project-specific data deliberately. Symlink targets are not followed; external roots need explicit configuration and mapping.

`backup.artifacts` is `none` (default), `local` (active `file:` JARs), or `all` (active server and plugin JARs). Embedding is separate from `backup.files` exclusions, deduplicates identical SHA-256 values, and never captures pending or unmanaged JARs. Recovery-group members must agree on the policy. Snapshots with embedded artifact metadata use format 2; new CLI versions read both formats 1 and 2.

SQLite declaration:

```yaml
backup:
    repository: main
    files:
        - runtime/**
        - "!**/*.[jJ][aA][rR]"
    databases:
        - id: permissions
          kind: sqlite
          path: runtime/plugins/Permissions/data.db
```

MySQL and MariaDB require `host`, optional `port`, `database`, `user`, a secret `password` reference, and optionally dump/restore command paths and `sslCa`. Only InnoDB tables are supported. Crafleet cannot stop writers outside its managed server group.

PostgreSQL 17/18 uses `kind: postgres`, `host`, optional `port` (5432), `database`, `user`, and secret `password`. `command`, `restoreCommand`, and `queryCommand` select matching-major official `pg_dump`, `pg_restore`, and `psql`; `sslCa` enables verified TLS and is required outside loopback. Optional `restore: { user, password, maintenanceDatabase }` separates recovery credentials from the backup account. The target must already exist and differ from maintenance/template databases. Crafleet does not create roles or grant restore privileges. See `docs/postgresql-backup.md` in the source repository for the full contract.

Retention supports `keepLast`, `keepDaily`, `keepWeekly`, and `keepMonthly`, each at least one. `backup prune` previews by default.

## Workspace declaration

Discovery is limited to the positive project patterns and skips unrelated data directories. Hidden directories, `runtime`, `config`, and `node_modules` are not workspace members. Explicit subtree exclusions such as `!servers/retired/**` prevent traversal; a negative match for only a project directory does not exclude independently matched children. Permissions errors in the selected search scope are reported. Symbolic-link glob bases, paths outside the workspace, and traversal beyond 12 directories are rejected.

```yaml
schemaVersion: 1
projects:
    - servers/*
```

Workspace globs select project directories. The lock is shared, while each server keeps an independent desired, pending, and active installation.
Use `-r` to select every workspace member or repeat `--filter <name-or-relative-path-pattern>` for a subset. Zero matches are an error.
Servers sharing a database must use the same `backup.group` and compatible repository, database, and retention settings. Production operations on such a group require selecting every member.
