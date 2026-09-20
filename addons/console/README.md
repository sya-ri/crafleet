# Crafleet console addon

The console addon provides server command and argument completion. Command history works in the CLI without an addon. Paper and Velocity implementations, their shared transport, and build/test scripts live in this directory.

## Installation

Attaching `crafleet console` to a running, supported server offers:

```text
Enable tab completion?
The console addon takes effect after the next server restart.

  Install addon
> Not now
  Don't ask again for this server
```

`Not now` is the default and saves nothing. The last choice saves dismissal in the current user's Crafleet home, keyed by the canonical project path (case-insensitive on Windows). It does not modify project YAML or affect other servers. `console --ask-addon` ignores that dismissal once. Esc/Ctrl-C cancels attachment. Installation prepares pending changes; it never restarts the server.

Installed/pending addons, unsupported or locally unresolved server versions, CI, `--yes`, `--dry-run`, non-TTY input/output, and JSON mode never trigger automatic installation questions. `--ask-addon --yes` is an argument error. Preference-read failures suppress automatic questions; preference-save or installation failures are reported without disabling normal console input. Cancellation still aborts. There is no addon advertisement or repeated invitation inside the console.

| Command | Behavior |
| --- | --- |
| `crafleet addons` / `addons list` | Read-only bundled catalog and local declarations, active/pending versions, connection and available update. No provider requests. |
| `crafleet addons info console` | Features, exact catalogued versions, target eligibility, verification status and usage. |
| `crafleet addons add console` | Check the next server installation; acquire and verify the official platform JAR; declare and prepare it. |
| `crafleet addons update [console]` | Prepare the bundled catalog version for installed official addons. Never downgrade newer official versions. |
| `crafleet addons remove console` | Remove the declaration and prepare removal. Keep plugin data and command history. |

Lists and catalog information work outside a project. Changes require a project. `-C`, `--recursive`, and `--filter` use normal Crafleet selection. Unknown names report available IDs; missing required names report usage. Explicit changes do not ask for additional confirmation or change invitation preferences.

Changes use existing plugin locks, caches, manifest transactions and pending installations. Compatibility and installation use the same resolved next server version/build, preferring a matching lock. Apply at the next `start`/`restart`, or use `deploy apply` while stopped. Active and pending addon versions are shown separately. `add` completes incomplete preparation, but preserves an existing official version and suggests `update` when appropriate. Repeated add/update/remove operations are successful no-ops when already satisfied. An unrelated plugin occupying the platform ID is a conflict, never overwritten or removed.

Bulk changes skip unsupported servers and commit eligible changes together. Acquisition, checksum and conflict failures abort the transaction. Exit code is 0 on success, including partial skips and no-ops; 2 when every explicitly requested target is unsupported or uninstalled; other failures follow normal Crafleet codes. An unnamed update with no installed addons succeeds without changes.

`--dry-run` does not write declarations, locks, cache or pending state, and reports unresolved information. `--offline` requires the necessary cached resolution and JARs. `--json` returns target outcomes/reasons, before/after versions, pending IDs and a summary, with no prompts/progress. `--yes` does not bypass compatibility checks.

## Support

| Platform | Minimum | Addon bytecode | Boundary |
| --- | --- | --- | --- |
| Paper | 1.8.8, including public builds 443, 444, 445 | Java 8 | Public `Server.getCommandMap()` and `CommandMap.tabComplete`, scheduled on the main thread. |
| Velocity | 3.4.0-SNAPSHOT build 507; 3.4.0 stable | Java 17 | Public `CommandManager.offerBrigadierSuggestions`; build 506 is unsupported. |

The server's Java requirement still applies independently. The finite version catalog is in `packages/core/src/domain/addons.ts`; inspect the full version list with `addons info console`. Future upstream versions need a catalog update. Builds within a catalogued version are installable even when untested, and their verification status is reported. Earlier/uncatalogued versions are skipped during manual installation and never offered automatically.

Paper completions are obtained from its public command map. Candidates contributed solely by console-specific events are outside the compatibility promise. Root commands, arguments, plugin completers and Brigadier ranges are tested against actual server JARs where available. The pinned runtime matrix is in `servers.lock.json`; each successful test writes evidence to `artifacts/console/runtime-verification.json`. Do not label additional versions/builds as verified based only on bytecode compilation.

## Console editing and history

Up/Down recalls this server's commands; returning to the newest position restores the draft. Recall never executes commands. Nonempty submissions are stored in `.crafleet/console-history.json`, up to 1,000 entries, with consecutive duplicates collapsed. A dedicated mutex and atomic replacement protect concurrent writers. Save failures leave the current session and command sending functional. These are local runtime files, outside version control.

Tab inserts a single candidate, or displays multiple candidates with the selection in brackets. Tab/Shift-Tab and Up/Down cycle; Enter accepts without sending; Esc dismisses. Cursor and replacement ranges are UTF-16 offsets and retain text after the cursor. Editing, cancelling, detaching or timing out discards late replies. PageUp/PageDown and mouse-wheel log scrolling, Ctrl-C detachment and concurrent clients remain available.

## Development and protocol

Use the repository's pinned JDK 25.0.3 to build with `--release 8` (Paper) and `--release 17` (Velocity):

```sh
pnpm build:addons
node addons/console/build.mjs --offline --verify-reproducible
```

Compile-time API dependencies are pinned by URL, size and SHA-256 in `dependencies.lock.json`. No dependencies are shaded into the addon. Clean deterministic builds produce two JARs, `SHA256SUMS` and `manifest.json` in `artifacts/console`. The CLI build embeds the platform checksums from that manifest. Build the addons before running installation tests or packaging the CLI. The release workflow verifies the signed release, publishes and verifies the exact GitHub JAR assets, then publishes npm.

The runner opens a separate ephemeral IPv4 loopback listener. It passes `CRAFLEET_CONSOLE_PORT` and a distinct `CRAFLEET_CONSOLE_TOKEN` only to the server child. The addon connects outbound, authenticates, and reconnects after connection loss. This credential permits completion only; it cannot send commands or stop the runner.

Frames are newline-terminated UTF-8, with tab-separated fields. Input/candidate text is Base64; offsets count UTF-16 code units. Protocol v1:

```text
HELLO  1  token  addon-version  paper|velocity
READY  1
COMPLETE  request-uuid  cursor  base64-line
RESULT  request-uuid  start:end:base64-candidate ...
ERROR  request-uuid
CANCEL  request-uuid
```

The runner bounds frames, request concurrency, text length and candidate count. Requests time out after 1.5 seconds; aborts send cancellation. Response IDs isolate concurrent consoles/scripts. Disconnection rejects outstanding requests and leaves normal runner commands available. The CLI controller exposes `capabilities()` and `completeCommand({ line, cursor }, signal)` separately from command execution.

To run the complete pinned runtime matrix, set `CRAFLEET_JAVA8`, `CRAFLEET_JAVA17`, `CRAFLEET_JAVA21` and `CRAFLEET_JAVA25` to their Java homes. Only after accepting the Minecraft EULA, set `CRAFLEET_E2E_EULA=true`, then run:

```sh
node addons/console/test-servers.mjs
```

`CRAFLEET_ADDON_TARGET` optionally selects a substring such as `paper-1.8.8` or `velocity`. All runs use temporary worlds, isolated ports and loopback listeners. They test loading, authenticated connection, completion without execution, cursor ranges, reconnect and ordinary commands. Diagnostics are retained under `.test-tmp/console-*`. Paper 443's removed legacy S3 download is supplied from Mojang's current official URL and verified against the SHA-256 embedded in Paperclip.
