# PostgreSQL backup and recovery

Crafleet supports PostgreSQL 17 and 18 within the same major version. Install the official `pg_dump`, `pg_restore`, and `psql` clients for that server major on the Crafleet host. `command`, `restoreCommand`, and `queryCommand` optionally select those executable paths. Crafleet does not install PostgreSQL, create roles, grant administrative privileges, or depend on Docker.

## Configuration

```yaml
backup:
    repository: main
    files:
        - runtime/**
        - "!**/*.[jJ][aA][rR]"
    databases:
        - id: application
          kind: postgres
          host: 127.0.0.1
          port: 5432
          database: game_data
          user: snapshot_reader
          password:
              env: GAME_BACKUP_PASSWORD
          restore:
              user: recovery_operator
              password:
                  file: /private/game-recovery-password
              maintenanceDatabase: postgres
```

Use existing `backup setup` to register the repository. The password fields are secret references, never literal passwords. Private temporary password files are removed after each client call. Ambient `PG*` configuration is cleared; credentials and raw client output are omitted from error messages. Outside loopback, configure `sslCa` with a regular CA certificate file; connections use `verify-full` TLS with hostname verification. Hostnames and IPv4/IPv6 addresses are accepted; connection strings and socket paths are not.

Backup credentials need connection and read access to everything in the dump. The optional `restore` credentials need access to the maintenance database, `CREATEDB`, `CREATE` on the target tablespace (including `pg_default`), and permission to act as the target owner (`SET ROLE`), or superuser privileges. They must also be able to restore all object owners, grants, extensions, tablespaces, and database/role defaults. Missing capabilities fail before switching the original database; Crafleet never grants them automatically. Without `restore`, the backup credentials are used and `postgres` is the maintenance database. The target must already exist, permit connections, and differ from maintenance and template databases. Databases with security labels are rejected because their labels require a separate recovery strategy.

The target's owner, locale/encoding, tablespace, effective connection/create/temporary grants and grantors, connection limit, comment, and database/role settings are retained. Object owners and permissions come from the dump. Required roles and extension software must already exist on the server. The restore into a fresh staging database uses `--exit-on-error` and a single transaction, so missing dependencies fail before the world is replaced. Major-version upgrades are outside this contract.

## Backup and replacement

```sh
crafleet backup create
crafleet backup restore <snapshot-id> --to /restore/game
crafleet backup apply /restore/game --database application --dry-run
crafleet backup apply /restore/game --database application
```

Shared writers must belong to the same `backup.group`, and all members must be selected. Stop unmanaged writers too. `backup create` stores a custom archive, reads every archive data block with `pg_restore`, and records its hash and source major beside the world and active installation.

`backup apply` first verifies the extraction and exact active artifacts, stops the recovery unit, and takes a pre-restore snapshot. PostgreSQL restoration then proceeds as follows:

1. Record the original database name, OID, properties, archive hash, and unique staging/retained names in the existing restore journal.
2. Create and restore a new staging database, verify ownership and grants, block its new connections, and confirm it has no remaining sessions.
3. Apply the snapshot's world and active artifacts while Java remains stopped.
4. Block new connections to the original database and check both databases for sessions and prepared transactions. Existing connections are never forcibly terminated.
5. From the maintenance database, atomically rename the original to `crafleet_retained_<operation>` and the staging database to the original name. The retained original remains connection-disabled and is never automatically deleted.
6. Commit active filesystem state, restore the replacement's connection policy, and retain the completed journal under `.crafleet/restore-completed/<installation-id>.json`.

Extra tables from the current database are absent from the replacement because it began as a fresh database. YAML declarations and pending versions do not determine the restored artifacts. Java never starts automatically; inspect the result, then explicitly use `crafleet start --active`.

## Interrupted recovery

```sh
crafleet recover --dry-run
crafleet recover
```

Keep all writers stopped. Do not remove journals or rename databases manually to clear an error. The journal tracks `planned`, `created`, `restoring`, `ready`, `blocked`, `switched`, and `complete`. Recovery checks database names, OIDs, properties, and archive identity before continuing. A lost acknowledgement after the rename is recognized from the recorded OIDs instead of restoring the database again. Repeating an interrupted archive restore is limited to the verified staging database.

If external sessions or prepared transactions remain, new connections stay blocked and recovery waits for the operator to resolve them. No session is killed by Crafleet. If a staging create committed before its identifying comment could be written, Crafleet refuses to reuse or delete that unrecorded database; inspect its identity before choosing a recovery strategy. Changed names, OIDs, grants, or mismatched extraction records also require investigation.

For a rollback after new Java has run, use the recorded pre-restore snapshot to recover database, world, and active artifacts together. Re-enabling the retained database alone does not restore application consistency. Retained databases consume space until an operator explicitly decides to remove them. Crafleet adds no automatic cleanup or scheduled backup policy.
