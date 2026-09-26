# Deprecations

## Runtime settings compatibility inputs

Deprecated on introduction of configurable runtime settings. These inputs remain accepted in the introduction release and throughout the compatibility period until a future removal release is announced.

| Old input | Replacement | Units |
| --- | --- | --- |
| `java.startupTimeout` | `settings.runtime.startupTimeoutMs` | Convert seconds to milliseconds |
| `java.stopTimeout` | `settings.runtime.stopTimeoutMs` | Convert seconds to milliseconds |
| `PI_TUI_ESC_TIMEOUT` | `CRAFLEET_SETTINGS_CONSOLE_ESCAPE_TIMEOUT_MS` or `settings.console.escapeTimeoutMs` | Milliseconds unchanged |

**将来のリリースで削除予定。具体的な削除バージョンは未定。** Removal is planned for a future release; no specific version is scheduled. The 0.6.0 removal below is for a separate feature.

Old YAML inputs belong to the project layer and the old environment variable belongs to the environment layer. New forms win within the same layer. Reading an old key emits one deprecation warning per command on stderr even when a new value overrides it. Warnings omit input values; JSON stdout is preserved. Existing files are not automatically rewritten.

For example, replace `java: {startupTimeout: 180, stopTimeout: 120}` with:

```yaml
settings:
    runtime:
        startupTimeoutMs: 180000
        stopTimeoutMs: 120000
```

Replace `PI_TUI_ESC_TIMEOUT=100` with `CRAFLEET_SETTINGS_CONSOLE_ESCAPE_TIMEOUT_MS=100`. Use integer `-1` for supported unlimited limits. See the [settings reference](docs/settings.md) for precedence, supported limits and process restart requirements.

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
