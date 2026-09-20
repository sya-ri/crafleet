# Official addon development

All addon projects share the build, Java quality checks, runtime-test entry point, and `Addons` CI job. Addon implementations and platform API locks live in their own directories; see [console](console/README.md) for the completion protocol and supported server versions.

## Commands

Use the repository's pinned toolchain, including JDK 25.0.3:

```sh
pnpm format:java
pnpm check:java
pnpm build:addons
node addons/build.mjs --offline --verify-reproducible
node tests/support/test-addon-tooling.mjs
```

`pnpm format`, `pnpm check:fix`, and `pnpm check` also include authored Java in every addon and the server fixture plugins. Java formatting uses [google-java-format](https://github.com/google/google-java-format) in AOSP mode (four spaces); [Checkstyle](https://checkstyle.org/) enforces braces, one statement per line, separate variable declarations, explicit imports, and basic correctness checks. `check:fix` formats Java and then reports remaining lint violations for manual fixes.

The exact tool versions, official download URLs, sizes, and SHA-256 hashes are in `scripts/java-tools.lock.json`; lint rules are in `scripts/checkstyle.xml`. The first run downloads the tools into ignored `.tools/java/`. Every invocation verifies their bytes before execution. Use `node scripts/java-quality.mjs check --offline` or `format --offline` to require already cached tools. Tool selection follows `CRAFLEET_TEST_JAVA_HOME`, `JAVA_HOME`, then `mise where java`; the server's Java requirement is independent.

## Project layout

Each direct child directory of `addons/` is a project with:

- `addon.json`: build targets, their Java `release`, and compile-time dependency names.
- `dependencies.lock.json`: dependency URLs, sizes, and SHA-256 hashes.
- `common/`: optional Java sources shared by the project's targets.
- `<target>/`: target-specific Java sources.
- `resources/<target>/`: optional files copied into that target's JAR. JSON/YAML descriptors replace `@VERSION@` with the CLI version and normalize line endings; other resources retain their bytes.
- `test-servers.mjs`: the project's server compatibility and behavior tests.

Use the `dev.s7a.crafleet.<addon>` Java package namespace and matching source directories. Keep platform descriptors' entrypoint class names in sync with that namespace.

`addons/build.mjs` discovers projects through `addons/projects.mjs`. It compiles each target using `--release`, packages only the project's classes/resources and license, and writes `crafleet-<addon>-<target>.jar`, `SHA256SUMS`, and `manifest.json` under `artifacts/<addon>/`. Compile-time dependencies are not shaded. The CLI embeds the relevant artifact hashes when it builds, so rebuild it after changing an addon. `--verify-reproducible` compares every project's JAR hashes with a second clean, offline build.

Add a project by creating this layout; no console-specific build script or CI job is needed. Register its user-facing identity, compatibility, and release assets in the CLI catalog/release integration as part of adding the feature.

## Runtime verification and CI

After building, set the Java homes required by the projects' runtime matrices (`CRAFLEET_JAVA8`, `CRAFLEET_JAVA17`, `CRAFLEET_JAVA21`, and `CRAFLEET_JAVA25` for console). Only after accepting the [Minecraft EULA](https://www.minecraft.net/eula), set `CRAFLEET_E2E_EULA=true` for Paper tests, then run:

```sh
pnpm test:addons
```

`addons/test-servers.mjs` discovers the same projects and runs each project's tests, stopping on failure. Arguments such as `--prepare` are forwarded to each test script. Tests use disposable servers and report their verification evidence in `artifacts/<addon>/runtime-verification.json`; diagnostics use `.test-tmp/addon-*/addon-*.log`.

The `Addons` CI job runs the shared Java check, tooling regression tests, deterministic build, and runtime-test entry points. Its result is required by `All supported environments`; the artifacts include every addon's verification evidence and diagnostics. Feature-specific assertions and server matrices remain with each addon. The tooling tests use temporary projects and the Java tools cached by `check:java`; they verify multiple-project discovery, bytecode targets, resource handling, and failure behavior without launching Minecraft.
