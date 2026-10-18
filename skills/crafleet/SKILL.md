---
name: crafleet
description: "Operate Paper and Velocity projects managed by Crafleet: setup, artifacts, files, backups, and recovery. Use for crafleet.yaml or crafleet-workspace.yaml; not for unmanaged servers or OS service setup."
license: MIT
---

# Crafleet

Run the CLI on the server host. Locate `crafleet.yaml` or `crafleet-workspace.yaml` and select the authorized projects explicitly with `-C`, `--filter`, or `-r`.

## Working model

- Declarations, the lock, and saved `files/` content describe the desired installation.
- `install` and artifact changes prepare **pending**; they do not replace running JARs.
- `start`, `run`, and `restart` can apply pending after checks and an update backup when configured. Omitting `backup.repository` skips automatic backups; configured backup failures block deployment. `--active` uses the deployed installation.
- `stop` persists stopped intent. `supervise` respects that intent and maintenance; its own shutdown preserves intent for the next host start.
- Untracking can run live. Tracking, capture, resolution and migration need `--force` while running; reads can miss unsaved data or cross-file consistency. Check legacy migration before using `files` on a `config/` project.
- Running `deploy apply --force` supports structured text settings only with unchanged JARs/launch settings. It retains setting preimages instead of a cold backup and never stops or reloads Java. Disk deployment does not confirm runtime activation. See the recovery reference before use.

## Load only the relevant reference

| Task | Reference |
| --- | --- |
| Declarations, sources, files, secrets, or backup selection | [Project files](references/project-files.md) |
| Choose commands and inspect outcomes | [Operations](references/operations.md) |
| Consent, downtime, deployment, restore, pruning, or recovery | [Safety and recovery](references/safety-and-recovery.md) |

Use installed `--help --json` when versions differ. Inspect `status` and `validate`; use JSON results for automation and supported dry runs for previews. Interactive `doctor` may offer shell completion setup; `doctor --json` is read-only.

A direct request authorizes the specified operation, including its stated downtime or restoration. Ask only for consequential actions outside that scope. Never infer fresh Minecraft EULA acceptance or add `--yes` merely to suppress an unknown prompt.

Use Crafleet commands for locks, journals, active/pending state, JARs, and backup metadata. SSH connections, Java installation, OS services, and Git operations are separate tasks.

Report the selected projects, relevant process/active/pending outcome, snapshot IDs, and unresolved errors. Keep error codes and recovery hints; do not report an intermediate command or dry run as completion.
