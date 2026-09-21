# Development checks

Use the pinned project toolchain from [CONTRIBUTING.md](../CONTRIBUTING.md). The published CLI supports Node.js 24–26; development requires 24.11.1 or later. CI separately tests the packaged runtime on 24.0.0.

## Checks

| Command | Scope |
| --- | --- |
| `pnpm check`, `pnpm typecheck` | Formatting/lint/imports and TypeScript. |
| `pnpm format:java`, `pnpm check:java` | Format authored Java or verify formatting and Checkstyle rules. |
| `pnpm build:addons`, `pnpm test:addons` | Build every official addon or run each addon's real-server verification. |
| `pnpm check:architecture` | Package boundaries and bundled dependencies. |
| `pnpm check:release-notes` | Release version, changelog, filename, and title agreement. |
| `pnpm test`, `pnpm test:watch` | Unit tests, once or watched. |
| `pnpm bench:config` | Generated large-YAML secret-handling benchmarks. |
| `pnpm bench:config-io` | Managed-file scans and binary hashing with generated temporary files. |
| `pnpm test:integration` | Filesystem and I/O integration tests. |
| `pnpm test:coverage` | Unit/integration tests with coverage gates. |
| `pnpm build`, `pnpm test:package` | Distribution build and isolated tarball installation. |
| `pnpm verify` | All checks above except watch. |
| `pnpm test:e2e` | Real Paper and Velocity; requires fixture setup and Paper consent. |
| `pnpm test:completion` | Real shell completion against the built CLI. |

Integration tests use temporary files, HTTP servers, and subprocesses. Fault injection supplements real server/database tests. Coverage includes unimported production code: core needs 95% lines/90% branches; overall needs 90% lines/85% branches.

## Configuration benchmarks

`pnpm bench:config` measures validation, secret injection, and tokenization with generated 12,000-entry YAML files, including the phase ordering used when applying multiple files. Fixtures contain no server data. These measure in-memory configuration work, not disk I/O, backups, or Java startup; normal tests have no timing thresholds.

`pnpm bench:config-io` measures `NodeConfigManager.diff()` against generated base/runtime trees with a registered fixture secret: 64 small YAML files, four 12,000-entry YAML files, and 16 binary files of 8 MiB each. File inspection and retained-object verification overlap at most four reads per operation; YAML parsing still runs on the main thread. Results retain path order, and failures drain active reads before returning. Writes and journal commits remain sequential. The benchmark prints the peak RSS of the benchmark worker, including fixture setup and all cases, and removes its temporary files afterward. Filesystem caching and storage speed affect these results; they do not measure full server startup.

Managed-file inspection also reuses successful validation when both merge sides are identical and when public text needs no secret substitution. Changed bytes, paths, formats, secret values, or protected token locations still require their existing checks. The standalone format merger continues to validate identical documents.

Save a baseline before changing the implementation, then compare on the same machine and toolchain:

```sh
pnpm bench:config --outputJson .test-tmp/config-before.json
pnpm bench:config --outputJson .test-tmp/config-after.json --compare .test-tmp/config-before.json
pnpm bench:config-io --outputJson .test-tmp/config-io-before.json
pnpm bench:config-io --outputJson .test-tmp/config-io-after.json --compare .test-tmp/config-io-before.json
```

## Continuous integration

CI runs on pull requests, pushes to `master` or `v*` tags, and manual dispatches. Quality checks and coverage gates run on Node.js 24.11.1; every supported development Node version runs unit/integration tests, build, and package verification.

Integration tests run independently of real server E2E. Windows splits files across two runners (`--shard=1/2` and `--shard=2/2`), with `--no-file-parallelism` inside each shard to avoid starving PowerShell ACL helpers. Tests still exercise concurrent operations internally. Linux and macOS each run the full integration suite. `All supported environments` requires every shard and the platform, database, and shell checks in [.github/workflows/ci.yml](../.github/workflows/ci.yml).

The fixture download cache (`artifacts/fixtures/cache`) is keyed by OS, architecture, and both fixture locks. Restored downloads are checked against locked hashes and sizes; missing artifacts are downloaded, and plugins are rebuilt with reproducibility checks every run. Generated manifests, compiled plugins, and mutable test data are not cached. Keep actions, images, and fixtures pinned.

### SonarQube Cloud

The optional `SonarQube Cloud` job analyzes TypeScript/JavaScript source and build scripts after the compatibility jobs succeed. It reuses the baseline verification's `coverage/lcov.info`; tests and existing coverage gates remain unchanged. It reports separately from `All supported environments` and does not wait for or enforce a Sonar quality gate.

To enable it:

1. Create a SonarQube Cloud organization and choose **Get SonarQube for OSS** for public open-source projects. Create a project bound to this GitHub repository. Set its main branch to `master` and select CI-based analysis; disable automatic analysis if it was enabled.
2. Add a GitHub Actions repository secret named `SONAR_TOKEN` with permission to analyze that project. Never commit the token or put it in workflow arguments.
3. Set repository variables `SONAR_ORGANIZATION` and `SONAR_PROJECT_KEY` to the exact keys shown in the project. Leave `SONAR_REGION` unset for EU; set it to `us` for the US region.
4. Run the verification workflow on `master`, then open or update a same-repository PR. Review the Cloud report and confirm that source files, PR changes and coverage were imported before making its check required.

Missing project variables, tag builds and fork PRs skip the Sonar job. Forks still run normal verification without receiving the Sonar token. This setup does not use `pull_request_target` or execute fork code in a privileged follow-up workflow. Once enabled, missing/invalid credentials or scanner failures fail the separate Sonar job visibly.

The project retains TypeScript 7 and the existing `tsconfig.json`. The scanner uses its own TypeScript parser; verify the first real scan before treating compatibility as established. No analysis-only compiler options or blanket issue exclusions are added in advance. See the official [GitHub Actions setup](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/ci-based-analysis/github-actions-for-sonarcloud/) and [TypeScript coverage guide](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/test-coverage/javascript-typescript-test-coverage/).

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

## Addon development

The [shared addon development guide](../addons/README.md) covers Java formatting/lint, project configuration, deterministic builds, and runtime verification. `pnpm build:addons` discovers all addon projects and builds their configured Java targets with the pinned JDK 25.0.3. Build addons before installation tests or the CLI, which embeds their checksums. The `Addons` CI job uses the same common entry points. The [console guide](../addons/console/README.md) documents its transport, Paper/Velocity behavior, and compatibility matrix.
