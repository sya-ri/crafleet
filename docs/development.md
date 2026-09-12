# Development checks

Use the pinned project toolchain from [CONTRIBUTING.md](../CONTRIBUTING.md). The published CLI supports Node.js 24–26; development requires 24.11.1 or later. CI separately tests the packaged runtime on 24.0.0.

## Checks

| Command | Scope |
| --- | --- |
| `pnpm check`, `pnpm typecheck` | Formatting/lint/imports and TypeScript. |
| `pnpm check:architecture` | Package boundaries and bundled dependencies. |
| `pnpm check:release-notes` | Release version, changelog, filename, and title agreement. |
| `pnpm test`, `pnpm test:watch` | Unit tests, once or watched. |
| `pnpm test:integration` | Filesystem and I/O integration tests. |
| `pnpm test:coverage` | Unit/integration tests with coverage gates. |
| `pnpm build`, `pnpm test:package` | Distribution build and isolated tarball installation. |
| `pnpm verify` | All checks above except watch. |
| `pnpm test:e2e` | Real Paper and Velocity; requires fixture setup and Paper consent. |
| `pnpm test:completion` | Real shell completion against the built CLI. |

Integration tests use temporary files, HTTP servers, and subprocesses. Fault injection supplements real server/database tests. Coverage includes unimported production code: core needs 95% lines/90% branches; overall needs 90% lines/85% branches.

On Windows CI, integration files run with `--no-file-parallelism` to avoid starving PowerShell ACL helpers. Tests still exercise concurrent operations internally. See [.github/workflows/ci.yml](../.github/workflows/ci.yml) for the required platform, database, and shell matrix; retain pinned actions, images, and fixtures.

## Real servers

Build the locked fixtures and package:

```sh
node tests/fixtures/build.mjs --with-servers --verify-reproducible
pnpm build
pnpm test:package
```

Read and accept the [Minecraft EULA](https://www.minecraft.net/eula) before setting `CRAFLEET_E2E_EULA=true`. The harness never grants consent; missing consent or Java fails instead of skipping. In a shell with that explicit test consent:

```sh
CRAFLEET_VERSION="$(node -p "require('./packages/cli/package.json').version")"
CRAFLEET_E2E_PACKAGE="artifacts/crafleet-${CRAFLEET_VERSION}.tgz" pnpm test:e2e
```

In PowerShell, set `$env:CRAFLEET_E2E_PACKAGE` to the tarball path and run `pnpm test:e2e`; remove test environment variables afterward. The package is installed outside the repository without workspace links. See the [fixture guide](../tests/fixtures/README.md) for JDK selection, fault controls, and lock updates.

Use isolated projects, ports, homes, and databases. Cleanup must confirm shutdown before removing owned data. Failed runs retain `.test-tmp/real-e2e-*/`; `CRAFLEET_E2E_KEEP=true` retains successful runs too. Upload only redacted `diagnostics/` and coverage, never raw worlds, configuration, databases, or repositories. CI's EULA variable must be set by an administrator who accepted it.

## Database and shell checks

`CRAFLEET_TEST_RESTIC=1` enables tests using the pinned official restic binary. CI's disposable MySQL/MariaDB jobs run [backup-database-service.test.ts](../tests/integration/backup-database-service.test.ts).

With Docker available, run the PostgreSQL service suite for each supported major:

```sh
CRAFLEET_TEST_POSTGRES_MAJOR=17 pnpm exec vitest run --project integration tests/integration/backup-postgres-service.test.ts
CRAFLEET_TEST_POSTGRES_MAJOR=18 pnpm exec vitest run --project integration tests/integration/backup-postgres-service.test.ts
```

In PowerShell, set `$env:CRAFLEET_TEST_POSTGRES_MAJOR` before each run. Fixtures use pinned images and private networks; Docker is a test transport, while production calls official clients. Never point these tests at application databases.

After `pnpm build`, `pnpm test:completion` checks installed shells. Select a subset with `node tests/support/test-shell-completion.mjs bash zsh fish`. Unix tests require Python 3 and use disposable pseudo-terminals; PowerShell uses its native completion engine. Zsh uses `compinit -i -D` to exclude insecure inherited directories without prompting. These tests launch no Minecraft server.

## Distribution assets

Only `packages/cli` is published. Build bundles CLI/runner dependencies, generates schemas and notices, and copies the root README, deprecation guide, file guide, and demo. Tracked documentation mirrors support npm's repository-relative links; commit them after rebuilding. New README links outside those mirrors must use repository URLs.

`test:package` produces `artifacts/crafleet-<version>.tgz`, installs it in a fresh directory, and checks direct execution and npm-exec, required assets, and absence of private/runtime dependencies.

Generate the terminal demo with `python scripts/generate-readme-demo.py` using Pillow in an isolated tooling environment. Review the transcript when CLI output or demo versions change. Keep the raw GitHub asset and package copy identical, and check GitHub/npm rendering after release.
