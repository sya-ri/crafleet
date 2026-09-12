# Contributing to Crafleet

Use the [README](README.md) for server administration. This guide covers development; [testing](docs/development.md) and [releasing](docs/releasing.md) have task-specific procedures.

## Get started

Use the project-local versions pinned in `mise.toml`, `.node-version`, and `package.json`, then run:

```sh
pnpm install --frozen-lockfile
pnpm verify
```

`verify` checks formatting, lint, types, architecture, release notes, unit/integration coverage, the build, and an isolated package installation. Real server, database-service, and shell tests are separate; see [test commands](docs/development.md#checks).

## Code organization

| Package | Responsibility |
| --- | --- |
| `@crafleet/core` | Domain rules, schemas, use cases, and I/O contracts. |
| `@crafleet/adapters` | Filesystems, providers, processes, formats, databases, and restic. |
| `crafleet` | CLI parsing, presentation, composition, and runner entry point. |

CLI may depend on core and adapters; adapters may depend on core. Core has no direct filesystem, network, environment, or console access. Cross-package imports use public entry points. `check:architecture` enforces these boundaries in source and bundles.

ArkType definitions generate the shipped JSON schemas. Keep syntax definitions in one place, separate from normalization, filesystem checks, and cross-field rules.

## Style and dependencies

Use strict TypeScript and Biome's four-space formatting. `pnpm check:fix` applies safe fixes. Formatting is scoped to development files; preserve managed server files and verbatim test fixtures.

Pin external dependencies to exact stable versions and internal dependencies to `workspace:*`. Before adding one, check official documentation, current npm metadata, runtime/peer compatibility, license, and maintenance. Keep frozen installs and review install scripts. Registry credentials stay outside Git.

Write documentation and comments in English; preserve intentional Unicode fixtures. Follow recent prefixed commit messages, such as `docs: simplify the setup guide`.

## Documentation and comments

Write for the reader's next decision:

- **README:** product overview, first use, and links to task guides.
- **Operator guides:** commands, prerequisites, outcomes, and relevant recovery steps.
- **Developer guides:** architecture and procedures; link to tests instead of listing their assertions.
- **Agent skill:** non-obvious decision rules and task-specific references, loaded only as needed.
- **Changelog and release notes:** concise history and release-specific upgrade guidance, respectively.
- **Code comments:** explain why, caller obligations, or an invariant the code cannot express. Omit narration of obvious steps.

Keep each detailed explanation in one canonical location. Edit root documents and rebuild their tracked package mirrors; do not edit generated copies independently. Preserve licenses, source attribution, lint directives, and comments used as fixture data.

Add tests for behavior changes and reproductions for bug fixes. Documentation-only changes need link/example checks and affected packaging checks; broader CI remains required for merging.
