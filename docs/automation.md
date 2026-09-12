# Automation contract

Use explicit targets (`-C <project>`, `--filter`, or `-r`) and `--json`. Human tables, progress messages, and completion suggestions are not stable interfaces. JSON, CI, non-terminal, and `--yes` invocations never open a project picker; `--yes` does not choose a target.

## Results and exit codes

Finite commands write one JSON document to stdout:

```json
{"ok":true,"result":{}}
```

```json
{"ok":false,"error":{"code":"…","message":"…","hint":"…"}}
```

`hint` is optional. Failed checks and partial workspace operations can retain `result` beside `error`. Check both `ok` and the exit code; the presence of results does not mean success.

| Exit code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Unexpected failure |
| 2 | Invalid input |
| 3 | Safety or check failure |
| 4 | Partial operation or recovery required |
| 130 | Cancellation |

`logs --follow`, `run`, `supervise`, and `console --json` use NDJSON. Log records have `event: "log"` and `text`; normal completion has `event: "result"` with the result envelope. Errors use the error envelope. Non-followed `logs` and dry runs are finite.

`--json` works before or after subcommands and suppresses terminal decoration and prompts. Missing input or confirmation returns an error with safe `input` command metadata. `--help --json` includes human help plus structured arguments, options, subcommands, and policies for target cardinality, effects, grouping, and framing. Tolerate additional fields and preserve error codes.

## Consent and previews

`--yes` confirms an authorized operation; it does not bypass preflight checks. On Paper `init`, `start`, `run`, and `restart`, it can also record fresh Minecraft EULA acceptance. Supply it only after explicit consent. CI, JSON, and noninteractive runs cannot obtain fresh consent through a prompt. `--dry-run` never records consent, and neither `install` nor `deploy apply` accepts the EULA.

`doctor --json`, `--dry-run`, and `--yes` remain read-only. Persistent completion setup is a separate explicit `completion install <shell> --yes` operation. `--offline` prevents network artifact retrieval; it does not supply missing cached artifacts or backup prerequisites.

## JSON console sessions

Select one running project with `crafleet -C servers/lobby console --json`. Write one UTF-8 request per stdin line:

```json
{"id":"1","command":"list"}
```

| Event | Payload |
| --- | --- |
| `connected` | Runner PID, Java PID, active installation ID, and input limits. |
| `log` | `text`. |
| `log-reset` | Log rotation notification. |
| `command` | Request `id`, `ok`, and `result` or `error`. |
| `disconnected` | Reason and `serverStopped: false`. |
| `result` | Final result envelope with sent/failed counts and exit code. |

A successful command acknowledgement is `{"sent":true,"execution":"unconfirmed"}`. It confirms the Java stdin write, not game-level execution. Asynchronous logs cannot be attributed to a request.

Requests run in input order. Only `id` and `command` are accepted. IDs are 1–128-character strings and are echoed without deduplication. Choose unique IDs for correlation. Lines are limited to 16,384 bytes; commands must be nonempty, single-line, NUL-free, and at most 8,192 bytes as a JSON-encoded string. Invalid UTF-8, JSON, or oversized lines produce request errors, then processing resumes at the next line. EOF processes a final unterminated line. Any rejected request makes the session exit nonzero.

Slow stdout pauses input and log reads. EOF drains accepted input then detaches; Ctrl-C, a broken pipe, or the original runner ending also detaches. Sessions never stop the server, reconnect, or resend automatically. A command interrupted before acknowledgement may already have reached Java; inspect state before resending.

`serverStopped: false` describes detachment, not current server state: a submitted `stop` command can still stop Java. An output pipe that cannot drain within one second of detachment is closed, so final events may be unavailable.
