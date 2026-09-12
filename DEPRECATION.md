# Deprecations

## Legacy configuration management

| Milestone | Version |
| --- | --- |
| Deprecated | 0.4.0 |
| Supported for unmigrated projects | Through 0.5.x |
| Scheduled removal | 0.6.0 |

| Old interface | Replacement |
| --- | --- |
| `config/` saved tree | `files/` |
| `config.files` declaration | `files.patterns` |
| `config list / track / untrack / diff / capture / resolve` | The corresponding `files` subcommands |

New and migrated projects use `files`. Unmigrated projects retain legacy behavior with warnings on stderr; JSON stdout remains valid. On migrated projects, old commands show the replacement and exit without changes.

Upgrade all CLI operators and supervisors, stop the server, then preview and run `files migrate --from config`. See the [migration guide](docs/files.md#migrate-legacy-projects) for commands, preserved state, and interruption recovery. File mutations require a stopped server.

The scheduled 0.6.0 removal affects ordinary legacy commands and declarations. It does **not** remove migration, interrupted-migration recovery, readers for snapshot formats 1 and 2, or conversion of legacy installation metadata during restore. Existing saved files, runtime data, and backups are not deleted. The removal is not part of 0.4.0.
