# Real server fixtures

The locks pin Paper/Velocity downloads and plugin APIs; the builder compiles six fixture JARs without launching servers or accepting the EULA.

```sh
node tests/fixtures/build.mjs --with-servers --verify-reproducible
```

Use the JDK pinned in `mise.toml` and `servers.lock.json`. Selection checks `CRAFLEET_TEST_JAVA_HOME`, `JAVA_HOME`, then `mise where java`, and validates both `java` and `javac`. Output and its JSON manifest live in ignored `artifacts/fixtures/`. `--offline` requires cached bytes matching locked sizes/hashes.

## Plugin contract

| Platform | ID / data directory | JARs |
| --- | --- | --- |
| Bukkit | `CrafleetBukkitFixture` | `bukkit-v1.jar`, `bukkit-v2.jar` |
| Paper | `CrafleetPaperFixture` | `paper-v1.jar`, `paper-v2.jar` |
| Velocity | `crafleetvelocityfixture` | `velocity-v1.jar`, `velocity-v2.jar` |

Revisions have descriptor versions `1.0.0` and `2.0.0`. Under `runtime/plugins/<ID>/`:

| File | Evidence |
| --- | --- |
| `enabled-version.txt` | Version loaded by Java, newline-terminated. |
| `saved-version.txt` | Version saved on graceful shutdown, newline-terminated. |
| `config.yml` | Created only on first startup; preserved afterward. |
| `observed-message.txt` | Configuration message read on enable. |
| `player-state.txt` | Persistent data, initially `fixture-player: original`. |
| `observed-player-state.txt` | Persistent value read on enable. |
| `events.log` | Ordered `enable:<version>` / `disable:<version>` events. |

Use these markers to prove loaded/restored behavior; logs are excluded from normal backups. World restore also compares Paper's changed `world/level.dat` hash before restarting. Flat-world settings come from the pinned 26.2 `classic_flat` preset.

Builds use explicit descriptors, `-proc:none`, sorted uncompressed ZIP entries, fixed timestamps, and no manifest/debug data. Only fixture classes are packaged. Reproducibility mode compares two independent builds by SHA-256.

## Group and fault fixtures

Set `-Dcrafleet.fixture.sharedDirectory=<isolated-directory>` and `-Dcrafleet.fixture.instance=<unique-name>` for shared-writer tests. Each plugin creates `<name>.running` while enabled and removes it on graceful shutdown. Include the shared directory explicitly in backup patterns; a cold group snapshot must contain no running markers.

Only disposable fault tests enable `-Dcrafleet.fixture.allowFaults=true`. Then `stop-delay-ms.txt` delays shutdown up to ten seconds, and `crash.request` halts that JVM with exit code 17. Normal fixtures ignore both.

Repository-loss tests temporarily rename an owned backup repository during shutdown. Write-failure tests deny new entries in a stopped runtime root but leave `plugins/` writable, causing configuration failure after JAR replacement. Restore repository paths and ACLs/modes in `finally`. Windows denies only the root without inheritance or removing permission-management rights; Unix root is rejected because it bypasses this failure.

## Run and inspect

Use the [development guide](../../docs/development.md#real-servers) for package setup, EULA consent, and full-suite commands. For Velocity alone after building:

```sh
pnpm exec vitest run --project e2e tests/e2e/real-server.test.ts -t Velocity
```

Tests use fresh homes, projects, ports, and repositories. Confirm Java shutdown before deleting owned data. Paper needs explicitly supplied `CRAFLEET_E2E_EULA=true`; its first bootstrap may need network access. Register `${secret:TEST_MANAGEMENT_SECRET}` through the fixture environment before capturing generated configuration.

Failed runs retain `.test-tmp/real-e2e-*/`; `CRAFLEET_E2E_KEEP=true` also keeps successes. `diagnostics/` contains command outcomes, a bounded redacted log tail, and shutdown status. Upload that directory, not raw runtime or backup data. `CRAFLEET_E2E_PACKAGE` selects the verified tarball for an isolated installation outside the workspace.

## Updating locks

Update locks deliberately from [official Fill API](https://docs.papermc.io/misc/downloads-service/) STABLE builds. Record version, build, URL, size, and SHA-256; verify downloaded bytes. API artifacts come from the [PaperMC Maven repository](https://repo.papermc.io/repository/maven-public/) with published hashes. Pin Velocity snapshots to their timestamped filenames. See [Paper setup](https://docs.papermc.io/paper/dev/project-setup/) and [Velocity setup](https://docs.papermc.io/velocity/dev/creating-your-first-plugin/) when updating fixture dependencies.
