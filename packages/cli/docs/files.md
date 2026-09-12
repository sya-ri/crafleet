# Managed files and secrets

`files/` stores saved configuration, worlds, plugin data, and binary assets at the same relative paths as `runtime/`. JARs remain managed by artifact commands. Use `install` to prepare saved changes, then a managed start/restart or stopped `deploy apply` to deploy them.

## Migrate legacy projects

Upgrade every CLI and long-running supervisor before migration, then stop the server:

```sh
crafleet stop
crafleet files migrate --from config --dry-run
crafleet files migrate --from config
```

Migration moves `config/` to `files/` and converts `config.files` to `files.patterns`, preserving bytes, secret references, observations, and active/pending identities. Runtime and artifact resolutions stay unchanged. An existing destination or mixed declarations blocks migration. See [DEPRECATION.md](../DEPRECATION.md) for the removal schedule.

## Select and capture files

Register secrets before capture. Tracking, untracking, capture, and resolution require a stopped server; they do not stop Java automatically. Other applications must also stop writing selected data.

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

Omitted `patterns` keeps standard configuration candidates; an explicit list replaces them, and `[]` disables new-file discovery. Rules are runtime-relative, case-sensitive, and include hidden files. They support `*`, `**`, `?`, character classes, and `!` exclusions; the last match wins. Use `/` separators without the `runtime/` prefix. Absolute paths, parent traversal, regex, braces, and extglobs are unsupported. JARs and symlink targets are excluded; narrow roots keep discovery within its bounds.

```sh
crafleet files list --candidates
crafleet files capture --initial --include 'plugins/MyPlugin/progress/**/*.yml' --keep-missing
crafleet files diff
crafleet install --frozen-lockfile
```

| Selection | Effect |
| --- | --- |
| `files list` | Show managed files. |
| `files list --candidates` | List new candidates without tracking or printing contents. |
| `capture <paths...>` | Capture exact runtime-relative paths and begin tracking them. |
| `capture` without paths | Capture managed files only. |
| `--initial` | Include new candidates; standard ban lists also need `--include-bans`. |
| Repeated `--include <glob>` | Limit managed and new paths. Explicit `files.patterns` still bounds discovery; without it, includes can discover beyond standard defaults. |
| `--keep-missing` | Retain saved files missing from runtime; otherwise deletions participate in comparison. |
| `untrack <paths...>` | Remove saved files and observations, retaining runtime files. |

Excluding a discovery pattern does not untrack a saved file. Capture compares saved, previously observed, and current runtime content; conflicts or concurrent changes abort the complete capture. Inspect conflicts before choosing `files resolve <path> --use base` or `--use runtime`. Run `install` after capture or saved-file edits. Deployment rechecks runtime and refuses unreviewed changes.

## Secrets and formats

Before capturing a credential, register its exact value through a private file or environment variable:

```yaml
secrets:
    PAPER_MANAGEMENT_SECRET:
        file: /private/paper-management-secret
    DATABASE_PASSWORD:
        env: MINECRAFT_DB_PASSWORD
```

Paper's generated `management-server-secret` is one such value. Captured text uses `${secret:NAME}`; Crafleet resolves it on deployment. It does not load `.env` files. Known unregistered server secrets are rejected, but plugin secrets still require review. Runtime and restored data can contain plaintext; binary contents are opaque and are not redacted.

YAML, JSON, properties, and TOML use semantic merging with a 4 MiB structured-text limit. Unchanged text retains formatting; comments in modified TOML are not preserved. Managed files are not passed through a source formatter.

Binary diffs report hashes and saved/previous/runtime sizes with a byte delta. Equal sizes can have different hashes. Divergent edits conflict as whole files. Private immutable objects live in `.crafleet/file-objects/`; do not edit, delete, or commit them. Format 3 backups embed required active objects and comparison baselines independently of `backup.artifacts`; restoration verifies and repopulates the store. Formats 1 and 2 remain readable.

## Recovery

After interrupted capture, preview `recover --dry-run`, then run `recover`. Interrupted migration instead resumes with `files migrate --from config`, or reverses with `--rollback`; both support `--dry-run`. Completed migration is idempotent.

If the CLI was forcibly terminated, use `recover --unlock --dry-run` before `recover --unlock`, then resume migration if applicable. Unlock clears operation/file locks only when every recorded owner has exited. Unknown process state, unsafe paths, or external edits block recovery. Keep journals and lock directories intact.

For coupled world/database restoration, use [snapshot recovery](https://github.com/sya-ri/crafleet/blob/master/docs/backups.md#restore-a-snapshot).
