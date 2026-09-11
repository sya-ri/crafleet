# Managed files and migration from config

Crafleet 0.4.0 introduces `files` for reviewed configuration, worlds, plugin data, and binary assets. `files/` mirrors paths relative to `runtime/`. JARs remain owned by server and plugin artifact management.

## Compatibility schedule

The versioned removal scope and replacement table are maintained in [DEPRECATION.md](../DEPRECATION.md).

`config` is deprecated in 0.4.0, supported for unmigrated projects through 0.5.x, and scheduled for removal in 0.6.0. The migration command and readers for old backups remain available after removal. Migrated projects use `files` commands exclusively; old `config` commands explain the replacement and exit without changes. Deprecation warnings go to stderr, preserving JSON stdout.

Stop the server and preview the migration:

```sh
crafleet stop
crafleet files migrate --from config --dry-run
crafleet files migrate --from config
```

Migration moves `config/` to `files/`, converts `config.files` to `files.patterns`, and carries forward observations and active/pending installations. It preserves file bytes, secret references, installation identities, and artifact resolutions. It never writes runtime files, starts Java, downloads replacement JARs, or operates Git.

An existing `files/` destination or simultaneous old and new declarations blocks migration. An interrupted migration blocks ordinary mutations. Repeat `files migrate --from config` to finish it, or use `files migrate --from config --rollback` to restore its previous layout. Both support `--dry-run`. A successful migration is idempotent. Old CLI versions cannot operate migrated projects; upgrade every operator and supervisor first.

## Declare capture candidates

```yaml
files:
    patterns:
        - server.properties
        - plugins/MyPlugin/config.yml
        - plugins/MyPlugin/progress/**/*.yml
        - world/**
        - server-icon.png
        - "!**/session.lock"
```

Omitting `patterns` keeps the standard configuration candidates; `[]` disables discovery of new candidates. Explicit patterns replace the defaults. Ordered glob rules use `*`, `**`, `?`, character classes, and `!` exclusions; the last matching rule wins. Removing a pattern does not untrack saved files. Prefer narrow roots: discovery is bounded and refuses symbolic links in a selected tree.

```sh
crafleet files list --candidates
crafleet files track server-icon.png
crafleet files capture --initial
crafleet files diff
crafleet files capture --initial --include 'plugins/MyPlugin/progress/**/*.yml' --keep-missing
crafleet files resolve world/level.dat --use runtime
crafleet install --frozen-lockfile
crafleet run
```

`--include` is repeatable and limits both managed paths and new candidates. Explicitly declared `files.patterns` continue to bound discovery, including exclusions and an empty list. With no declared patterns, `--include` can select new paths beyond the standard configuration defaults. `--initial` includes new candidates. `--keep-missing` retains saved files absent from runtime. Without it, tracked deletions participate in the usual three-way comparison. `untrack` removes saved files and observations while retaining runtime files.

Capture, tracking, untracking, and conflict resolution require a confirmed stopped server and share the lifecycle operation lock. They do not stop Java automatically. Capture is all-or-nothing on conflicts and validates source snapshots before writing. Use `crafleet recover --dry-run` and `crafleet recover` after an interrupted capture. Unknown process state, unsafe paths, or external edits block recovery instead of overwriting data.

If the CLI process was forcibly terminated, preview `crafleet recover --unlock --dry-run`, then run `crafleet recover --unlock`. It clears operation and file locks only when every recorded owner has exited. For an interrupted migration, repeat `files migrate --from config` afterward. Do not remove lock directories manually.

## Text and binary behavior

YAML, JSON, properties, and TOML retain semantic merging, source formatting, and secret references. Structured configuration remains bounded to 4 MiB per file. Declare secrets before capturing text containing credentials. Binary data is opaque: Crafleet does not substitute or redact bytes inside databases or archives.

Binary snapshots store SHA-256 and byte size rather than encoded file contents in JSON. Diffs show saved, previously observed, and current runtime sizes, their byte change, and hashes. Equal size does not mean equal content. Independent changes on both sides conflict; Crafleet never attempts to merge binary contents.

Install prepares immutable snapshots without changing runtime. Start, run, restart, and stopped deployment use the existing preflight, stop, backup, apply, and recovery workflow. Capturing a stopped world records files consistently with respect to the managed server; other applications must not write those files during capture. Use snapshot backup recovery for coupled world/database restores.

Binary objects are private local state under `.crafleet/file-objects/`. Do not edit, delete, or commit them. Backups embed the objects required by the active installation independently of `backup.artifacts`, including the comparison baselines required for later deployment or recovery. Snapshot format 3 carries this payload; Crafleet continues reading formats 1 and 2. Restore verifies every object's hash and size and repopulates the local object store, so recovery does not depend on an old cache.
