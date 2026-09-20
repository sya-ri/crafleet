# Releasing Crafleet

Release only the tarball verified by `release:prepare`; never publish `packages/cli` directly. Publishing requires explicit authorization.

## Prepare a version

1. Keep unreleased user-visible changes under `Unreleased` in `CHANGELOG.md`. Before release, create `## <version> - YYYY-MM-DD` and `docs/releases/v<version>.md` starting with `# Crafleet <version>`.
2. Use the changelog for concise history and release notes for the release's overview, upgrade steps, and compatibility changes. Keep version-specific facts tied to that release.
3. Commit a clean, signed release on `master`, push it, and wait for the full required CI matrix.
4. Run `pnpm release:prepare`, create the exact `v<version>` tag at that commit, then run `pnpm release:check`.

The helpers require the pinned release signer, inclusion in `origin/master`, matching package/changelog/notes/tag versions, and a receipt matching the commit and tarball size/hash. Changing the authorized signer requires updating `.github/keys/release-signing-key.asc` and both fingerprint checks together.

## Trusted publishing

With repository protection and npm trust configured, push the immutable version tag. CI runs the required matrix, creates the GitHub release from its tracked notes, publishes and verifies the matching console addon JARs and checksums, then publishes the verified tarball with npm provenance. It requires a protected version tag and the `npm` environment; workflow dispatch does not publish.

The initial package publication used authenticated local publishing to establish ownership before trusted publishing was configured. For an explicitly authorized local release, authenticate with `npm login --auth-type=web --registry=https://registry.npmjs.org/`, verify the account with `npm whoami`, publish the verified tag and run `scripts/release-addons.mjs` with `GITHUB_REF_NAME=v<version>` and `GITHUB_REPOSITORY=sya-ri/crafleet` before `pnpm release:publish`. The addon helper verifies that the public assets match the checksums embedded in the CLI; it never replaces existing assets. Local provenance is disabled.

### Repository-owner setup

The version-controlled rulesets require signed master commits and prevent force pushes/deletion; release tags cannot be moved or deleted. The `npm` environment is restricted to version tags and requires the release owner's review.

When initially configuring these protections, apply the reviewed files:

```sh
gh api --method POST repos/sya-ri/crafleet/rulesets --input .github/rulesets/master.json
gh api --method POST repos/sya-ri/crafleet/rulesets --input .github/rulesets/release-tags.json
gh api --method PUT repos/sya-ri/crafleet/environments/npm --input .github/environments/npm.json
gh api --method POST repos/sya-ri/crafleet/environments/npm/deployment-branch-policies --field name='v*' --field type=tag
```

After the initial npm and GitHub release exists, configure trust as the package owner. Inspect existing settings before reapplying setup:

```sh
npm trust github crafleet --file ci.yml --repo sya-ri/crafleet --env npm --allow-publish --yes
npm trust list crafleet
gh variable set CRAFLEET_NPM_TRUSTED_PUBLISHING --repo sya-ri/crafleet --body true
```

Set the variable only after the trust relationship and protections are active. Keep registry tokens out of Git and GitHub; CI uses trusted publishing.

## Interrupted publication

Query npm for the exact version before retrying. A missing terminal response does not prove failure.

- **Version exists:** publication is complete. The GitHub addon assets must already be public and verified before npm publication. Inspect them if a later step failed; never replace their bytes.
- **Version absent after local interruption:** inspect `artifacts/.release-publish.lock` and confirm no npm/Node publisher still owns the operation. Then remove only that stale lock and its matching staged `.release-*.tgz`, run `release:check`, and retry.
- **Version absent after CI failure:** fix the cause without moving the tag. Recheck npm before rerunning the failed workflow.
