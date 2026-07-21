# Release Acpus

Acpus uses Changesets for npm package releases and deploys the static product
page independently. Both automations run only from `main`.

## Publish packages

Every pull request that changes a published package must include a changeset:

```sh
pnpm changeset
```

Choose the affected packages and the smallest correct semantic-version bump,
then commit the generated `.changeset/*.md` file with the implementation.

After the feature pull request reaches `main`, the `Release packages` workflow:

1. runs the release verification suite;
2. creates or updates the `Version Packages` pull request with package versions,
   changelogs, the lockfile, and the bundled Acpus Skill version;
3. waits for that pull request to be reviewed and merged;
4. publishes the changed packages to npm and creates their Git tags and GitHub
   Releases from the merged version commit.

The `npm` GitHub Environment supplies `NPM_TOKEN`. It must allow deployments
without required-reviewer approval for publishing to be fully automatic.
Repository Actions must allow `GITHUB_TOKEN` to write contents and pull
requests so Changesets can maintain the version pull request and release tags.
GitHub may require a maintainer to approve CI on a pull request created by
`GITHUB_TOKEN`; use a GitHub App installation token if that approval should
also be automated.

Do not edit package versions by hand. Do not rerun a partially failed publish
until the versions that reached npm have been inventoried. npm releases are
fixed forward with a new changeset; they are not rolled back by moving `main`.
Stable automation refuses to run while Changesets prerelease mode is active;
prereleases continue to use the separate alpha workflow.

## Deploy the product page

Any change under `page/` deploys automatically after it reaches `main`. The
`Deploy Pages` workflow uploads the directory as-is and deploys it through the
`github-pages` Environment. A manual dispatch remains available to restore the
current `main` page after an interrupted or failed deployment.

Page-only pull requests do not need a changeset and do not start the package
release workflow.

## Manual recovery

Both workflows retain `workflow_dispatch` as a recovery entry point. Dispatch
them only from `main`; each workflow checks that the checkout matches the event
commit. Prefer fixing the failed workflow or configuration over bypassing its
verification steps.
