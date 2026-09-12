# Safety and recovery

## Consent

A direct request authorizes the specified operation. Ask only when its consequences are outside the request; existing authorization does not need to be repeated.

Minecraft EULA acceptance is separate. Fresh Paper consent requires the user's explicit agreement in the terminal or authorization to use `--yes` after reading the EULA. That flag on `init`, `start`, `run`, or `restart` can record consent; do not add it as a generic launch confirmation. CI/JSON/noninteractive runs fail without it when fresh consent is needed. Dry runs never record consent; `install` and `deploy apply` cannot accept it. Velocity has no such flow. If declined or uncertain, do not retry with `--yes` or edit the receipt.

## Deployment and downtime

Verify the selected projects, active/pending state, process identity, and required backup availability. Crafleet's deployment order is preflight → graceful stop → verified exit → file recheck → cold backup → placement → launch → readiness.

Never replace running JARs or force-kill after a timeout. Keep ambiguous process state `unknown`; a PID alone is insufficient. Supervision shares the operation lock and respects stopped intent. Use ordinary Crafleet commands to record that intent, not manual state edits. Supervisor shutdown preserves intent; use `stop` for an intentional persistent stop.

A failed operation after maintenance begins leaves Java stopped. After replacement Java has launched, JAR-only rollback can break migrated data; recover a coupled snapshot instead.

## Files and repositories

Review runtime differences before preparing deployment. Register secrets before capture and keep values out of pending metadata, logs, diffs, Git, and answers. Binary data is not redacted. Select intended files instead of broadly tracking plugin directories.

Keep the registered repository path/identity. An absent NAS mount does not authorize creating a repository at the empty mount point or redirecting backups. Verify repository/tool availability before downtime. Preserve old custom JARs when not embedded by `backup.artifacts`; never substitute newer bytes for missing snapshot artifacts.

Restore extracts into a separate empty directory. Before apply, verify the snapshot, project/group identity, mapped roots, selected database IDs, and destinations. Apply makes a pre-restore snapshot, restores active state, clears pending, retains desired declarations/lock, and leaves Java stopped. Use `start --active` only within authorized restart scope.

Pruning previews until `--apply`. A space inspection request does not authorize deletion.

## Databases

Stop all managed group members and external writers. Crafleet cannot guarantee consistency for writers outside its control.

A failed MySQL/MariaDB restore is not automatically replayed or rolled back. Use the pre-restore `backupId` in the journal for deliberate recovery.

PostgreSQL supports same-major 17/18 restoration with official matching clients and verified TLS (`sslCa`) outside loopback. The target must exist and differ from maintenance/template databases. Restore credentials need maintenance access, `CREATEDB`, target-tablespace `CREATE`, and authority to restore owners/grants/settings/extensions. Required roles and extension software must already exist; Crafleet does not grant privileges. Security-labeled databases are unsupported.

PostgreSQL restores and verifies staging before world replacement. It checks names, OIDs, properties, and archive identity, then retains the original database under a connection-disabled name after switching. External sessions/prepared transactions block progress; never force-disconnect them or drop a retained DB to clear an error. A lost rename acknowledgement is reconciled by OID, not by blindly repeating restore. Re-enabling a retained database alone cannot undo world changes. Full prerequisites: [PostgreSQL guide](https://github.com/sya-ri/crafleet/blob/master/docs/postgresql-backup.md).

## Interrupted operations

For `RECOVERY_REQUIRED` or `BUSY`, inspect `doctor --json`, process state, and `recover --dry-run`. Execute the supported recovery within the user's authorization, then recheck validation, status, and relevant application health. `recover --unlock` clears only ended operation owners; it does not terminate Java.

Capture interruption uses `recover`. Migration interruption uses `files migrate --from config` to resume or `--rollback` to reverse. Do not delete journals, locks, or partially applied files. Changed identities or unexplained external edits require investigation before proceeding.

Report created snapshot IDs and any server left stopped, unknown, or needing recovery. A submitted command, queued plan, or spawned process is not proof of completion.
