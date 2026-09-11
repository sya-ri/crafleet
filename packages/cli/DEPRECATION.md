# Deprecation List

This document groups deprecated interfaces by release, with their replacements and migration examples. Scheduled removals do not delete user data.

## v0.4.0 — Deprecated

### Legacy configuration management

- **Deprecated in**: v0.4.0
- **Supported through**: v0.5.x for unmigrated projects
- **Scheduled for removal**: v0.6.0
- **Replacement**: `files` commands, `files.patterns`, and the `files/` saved tree

The replacement extends the existing configuration workflow to worlds, plugin data and binary assets. Existing unmigrated projects keep their previous behavior with deprecation warnings.

#### Replacements

| Deprecated interface | Replacement |
| --- | --- |
| `config/` saved tree | `files/` |
| `config.files` declaration | `files.patterns` |
| `crafleet config list` | `crafleet files list` |
| `crafleet config track` | `crafleet files track` |
| `crafleet config untrack` | `crafleet files untrack` |
| `crafleet config diff` | `crafleet files diff` |
| `crafleet config capture` | `crafleet files capture` |
| `crafleet config resolve` | `crafleet files resolve` |

New projects use `files`. Migrated projects must use the replacement commands; invoking an old command explains the replacement and exits without changes. Unmigrated projects receive warnings on stderr, leaving JSON stdout valid.

The `files` feature retains existing text merging and secret references and adds binary file management. Hashes and byte sizes are compared together. Capture requires a confirmed stopped server and uses the lifecycle operation lock. See the [file management guide](docs/files.md) for capture filters, binary conflicts and recovery.

#### Example migration

Upgrade every CLI operator and long-running supervisor before migration. Stop the server, review the preview, then migrate:

```sh
crafleet stop
crafleet files migrate --from config --dry-run
crafleet files migrate --from config
crafleet files diff
```

Migration preserves saved file bytes, secret references, comparison observations and active/pending installation identities. It moves `config/` to `files/` and converts `config.files` to `files.patterns`. It does not modify runtime, redownload server or plugin JARs, or operate Git. Mixed declarations, conflicting destinations, unknown process state and unsafe links are refused before the conversion is committed.

If interrupted, repeat `crafleet files migrate --from config` to finish, or add `--rollback` to restore the previous layout. Both support `--dry-run`. After successful completion, repeating migration makes no changes. Do not manually edit recovery journals or use an older CLI against a migrated project.

## v0.6.0 — Scheduled removal

Remove the legacy `config list / track / untrack / diff / capture / resolve` commands and ordinary operation using `config.files` and the `config/` saved-tree layout. Migrate projects using the v0.4.0 procedure above before updating to this release. This removal is scheduled; it is not part of v0.4.0.

### Retained migration and recovery paths

- `crafleet files migrate --from config`, including preview and interrupted-migration recovery.
- Reading and restoring legacy backups, including snapshot formats 1 and 2.
- Compatibility conversion needed to restore legacy installation metadata into a migrated project.

Removal of ordinary legacy operation does not remove these recovery paths or delete existing `config/` directories, saved data, runtime files or backups. The 0.4.0 release does not perform the scheduled removal.
