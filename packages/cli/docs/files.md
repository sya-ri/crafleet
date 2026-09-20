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

Paper management-server credentials are handled automatically. Register other secrets before capture. Tracking, untracking, capture, and resolution require a stopped server; they do not stop Java automatically. Other applications must also stop writing selected data.

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

## Local configuration from examples

Keep shared defaults in a tracked example and edit a Git-ignored local file:

```yaml
files:
    defaults:
        plugins/MyPlugin/hosts.yml: files/plugins/MyPlugin/hosts.example.yml
```

Keys are runtime-relative destinations; Crafleet saves the generated file under `files/`. Values are project-relative example paths with the same structured format (YAML, JSON, TOML, or properties). Add only the generated path, such as `/files/plugins/MyPlugin/hosts.yml`, to `.gitignore`. Keep the example and declaration committed. Declared examples are source inputs and are excluded from deployment and capture.

Run `crafleet install --dry-run` to preview, then `crafleet install` to create missing local files and prepare deployment. Edit `files/plugins/MyPlugin/hosts.yml` for local hostnames. Each install compares the previous example, your local file, and the current example: untouched values follow new defaults, local edits win, and arrays are single values. Unedited removed keys disappear; local additions, deletions, and changed values survive conflicting default changes. An existing file without comparison history is kept intact on its first install, which records the example for subsequent comparisons.

Install does not change runtime. Apply the pending installation with the existing stopped `crafleet deploy apply`, `crafleet start`, or `crafleet restart` flow. Comparison history is local to `.crafleet/file-defaults.json`; keep it with the project and do not commit it. Generated files and history share the installation transaction: after interruption, preview `crafleet recover --dry-run`, then run `crafleet recover` before retrying install. Preview writes neither local files nor history. Existing format and secret-reference rules also apply to examples.

## Secrets and formats

Crafleet automatically manages Paper's `management-server-secret`. Before starting Paper 1.21.9 or newer, it generates a cryptographically random 40-character alphanumeric value when the property is absent or blank, stores it in the owner-only `.crafleet/secrets/management-server.txt`, and writes it to runtime. Existing valid runtime values are adopted without rotation. This does not enable the management API.

Capture replaces this property with `${secret:crafleet.management-server}` in saved files and metadata. Deployments resolve that built-in reference automatically; no `secrets` entry or setup script is required. Inspection and dry-run commands never create the private file. Existing explicit file/environment references continue to work and take precedence.

Keep the private store with the project and do not commit it. If runtime unexpectedly differs from a stored key, Crafleet refuses to overwrite either value; inspect the change locally. A restored runtime containing the same key is reusable, and a new host can adopt the valid key from restored runtime. Restoring a different historical key requires reconciling the private store. Other server and plugin credentials still require registration before capture:

```yaml
secrets:
    DATABASE_PASSWORD:
        env: MINECRAFT_DB_PASSWORD
```

Captured text uses `${secret:NAME}`; Crafleet resolves it on deployment. It does not load `.env` files. Other known unregistered server secrets are rejected, but plugin secrets still require review. Runtime and restored data can contain plaintext; binary contents are opaque and are not redacted.

YAML, JSON, properties, and TOML use semantic merging with a 4 MiB structured-text limit. Unchanged text retains formatting; comments in modified TOML are not preserved. Managed files are not passed through a source formatter.

Binary diffs report hashes and saved/previous/runtime sizes with a byte delta. Equal sizes can have different hashes. Divergent edits conflict as whole files. Private immutable objects live in `.crafleet/file-objects/`; do not edit, delete, or commit them. Format 3 backups embed required active objects and comparison baselines independently of `backup.artifacts`; restoration verifies and repopulates the store. Formats 1 and 2 remain readable.

## Recovery

After interrupted capture, preview `recover --dry-run`, then run `recover`. Interrupted migration instead resumes with `files migrate --from config`, or reverses with `--rollback`; both support `--dry-run`. Completed migration is idempotent.

If the CLI was forcibly terminated, use `recover --unlock --dry-run` before `recover --unlock`, then resume migration if applicable. Unlock clears operation/file locks only when every recorded owner has exited. Unknown process state, unsafe paths, or external edits block recovery. Keep journals and lock directories intact.

For coupled world/database restoration, use [snapshot recovery](https://github.com/sya-ri/crafleet/blob/master/docs/backups.md#restore-a-snapshot).
