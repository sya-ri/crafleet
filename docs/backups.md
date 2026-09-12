# Backups and recovery

Backups use encrypted restic repositories on a local disk or mounted NAS. Automatic restic setup supports Linux x64/arm64, macOS x64/arm64, and Windows x64. Other architectures can preview `backup plan`, but cannot perform restic-backed operations.

## Register a repository

Choose an absolute path outside runtime and staging, with an existing parent. Set the password securely in the environment or use `--password-file` with a private file. The reference must remain available in later sessions.

```sh
crafleet backup setup main --path /mnt/backups/survival --password-env CRAFLEET_BACKUP_PASSWORD --init
crafleet backup plan
crafleet backup create
crafleet backup list
crafleet backup check --read-data
```

Replace the path for your host, for example `C:\Backups\survival`. `--init` creates a repository in an empty or absent destination; omit it for an existing repository. Crafleet verifies the registered path, repository ID, and restic before shutdown. A missing mount does not trigger a replacement repository.

A cold backup stops the managed writers, saves data, and resumes only previously running servers with the same active installation. `--leave-stopped` prevents resume. A failure before shutdown leaves the server running; a failure after shutdown leaves it stopped.

## Select data and artifacts

`backup.files` uses project-relative ordered globs: normal rules include, `!` excludes, and the last match wins. Re-include with a later normal rule; `.gitignore` and `!!` do not apply. Defaults include runtime/shared data and exclude JARs, logs, crash reports, libraries, and caches. Symlink targets are not followed; include external roots explicitly.

| `backup.artifacts` | JARs embedded in the snapshot |
| --- | --- |
| `none` (default) | None; restore requires the exact source or cache. |
| `local` | Active `file:` artifacts. |
| `all` | Active server and plugin artifacts. |

```yaml
backup:
    repository: main
    artifacts: all
    files:
        - runtime/**
        - "!**/*.[jJ][aA][rR]"
```

Embedding is independent of file exclusions, deduplicates SHA-256-identical JARs, and excludes pending and unmanaged JARs. Group members must use the same policy. `all` permits exact-artifact restore without original JARs, artifact cache entries, or provider access; repository, restic, Java, and secret requirements still apply. Keep old custom JARs retrievable when they are not embedded.

Snapshot format 2 adds embedded JARs. Format 3 also embeds the binary objects required by active managed files, independently of `backup.artifacts`. This CLI reads formats 1–3; older CLIs may reject newer formats. Restore verifies hashes and sizes before populating the relevant stores.

### Databases

Declare SQLite with `id`, `kind: sqlite`, and a project-relative `path` under `backup.databases`. MySQL/MariaDB require connection settings, a secret password reference, and matching dump/client commands; only InnoDB is supported. Non-loopback connections require `sslCa`. PostgreSQL 17/18 has a separate [configuration and recovery guide](postgresql-backup.md).

All managed writers to shared data must belong to the selected [backup group](operations.md#workspaces), and unmanaged writers must already be stopped.

## Restore a snapshot

Choose an exact ID from `backup list` and inspect it with `backup show <id>`. IDs contain 8–64 lowercase hexadecimal characters. Extract into a separate empty directory before applying:

```sh
crafleet backup restore <snapshot-id> --to /restore/survival
crafleet backup apply /restore/survival --dry-run
crafleet backup apply /restore/survival
```

Apply verifies the extraction and targets, stops the recovery group, takes a pre-restore snapshot, restores operating data and the recorded active installation, clears pending, and leaves Java stopped. Declarations and the shared lock remain unchanged. Inspect the result, then use `start --active` to start the restored installation; `install` may prepare the still-declared desired state again.

External roots require `--map root-id=absolute-path`; databases require `--database id`. Missing or corrupt embedded artifacts fail verification; pending or newer bytes are never substituted. After Java has run, recover coupled files and databases from a snapshot rather than reverting only a JAR.

## Interrupted operations

```sh
crafleet doctor --json
crafleet recover --dry-run
crafleet recover
```

Review the proposed recovery and process state. `recover --unlock` clears only locks whose recorded owners have exited; it does not kill Java. Keep journals and partially applied files intact.

A failed MySQL/MariaDB restore requires manual database recovery from the pre-restore `backupId` in the journal; Crafleet does not replay it automatically. PostgreSQL resumes verified stages and retains the replaced database under a connection-disabled name. See its [interruption procedure](postgresql-backup.md#interrupted-recovery).

For interrupted file capture or migration, follow the [file recovery procedure](files.md#recovery).

## Pruning

`backup prune` and `cache prune` preview deletions; `--apply` performs them. Retention supports `keepLast`, `keepDaily`, `keepWeekly`, and `keepMonthly`, each at least one. Cache pruning protects registered locks, active/pending installations, and operations in progress. The default JAR cache is `~/.crafleet/cache/artifacts/sha256/`; `CRAFLEET_HOME` changes the shared home.
