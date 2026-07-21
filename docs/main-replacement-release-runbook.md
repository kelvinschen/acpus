# Replace `main` and Publish Acpus 0.6

This runbook promotes the TypeScript-first Acpus line to stable by replacing
the Git tree at `main`. It does **not** merge, rebase, or cherry-pick the old
`main` history into `next/acpus_ts_workflow`.

The release is intentionally split into four independently gated operations:

1. prepare and review one stable release commit;
2. preserve the old `main`, then replace it with the audited commit;
3. publish the npm package graph from that exact commit;
4. deploy Pages only after npm verification succeeds.

Stopping between operations is safe. Publishing to npm is the point after
which rollback becomes a package-registry incident and must be handled by a
fix-forward release or a deliberate dist-tag change.

## Release identity

The planned stable graph is:

| Package | Stable version |
| --- | --- |
| `acpus` | `0.6.0` |
| `@acpus/core` | `0.7.0` |
| `@acpus/runtime` | `0.9.0` |
| `@acpus/agent-executor` | `0.1.0` |
| `@acpus/expression` | `0.1.0` |
| `@acpus/loader` | `0.1.0` |
| `@acpus/tasks` | `0.1.0` |
| `@acpus/web` | `0.1.0` |
| `@acpus/workflow-compiler` | `0.1.0` |

The supported runtime is Node.js `>=24.15.0`.

At the time this runbook was written, the old remote `main` was:

```text
404ae9755d69632235a321d76ae21e1e77e9d299
```

Treat that value as an expectation, not as permission to overwrite a different
remote tip.

## Roles and remote prerequisites

Assign one release operator and one reviewer. The reviewer approves both the
release-preparation PR and the protected `npm` environment deployment.

Before preparing the release, verify these settings in GitHub and npm:

- A GitHub environment named `npm` exists, requires a reviewer, and only allows
  deployments from `main`.
- `NPM_TOKEN` can publish all nine packages, or npm Trusted Publishing is
  configured for `.github/workflows/publish.yml` and the `npm` environment.
- GitHub Actions may write repository contents so Changesets can push tags and
  create GitHub releases.
- The release operator can temporarily perform one force push to `main`.
- The current `main` branch rules and required checks have been recorded so
  they can be restored immediately after replacement.
- No alpha or stable publish workflow is running.

Do not begin the cutover if any prerequisite is unknown.

## Phase 1: prepare the stable release commit

Release preparation happens in a branch based on the latest
`next/acpus_ts_workflow`. Its PR targets `next/acpus_ts_workflow`, never the old
`main`.

If the branch is still in Changesets prerelease mode, complete the stable
transition once:

```sh
pnpm changeset pre exit
pnpm version-packages
```

Review the resulting versions, changelogs, `pnpm-lock.yaml`, and bundled Acpus
Skill version. There must be no `.changeset/pre.json` and no pending Changeset
Markdown files. Confirm that every exact version in the release identity table
is still absent from npm; an existing version is immutable and is an abort
condition, not something to overwrite.

Run the local gates on Node.js 24.15 or newer:

```sh
pnpm install --frozen-lockfile
pnpm build:clean
pnpm typecheck
pnpm check:build-toolchain
pnpm check:dead-code
pnpm check:dependencies
pnpm check:dependencies:strict
pnpm check:docs
pnpm check:release
pnpm check:security
pnpm test
pnpm test:dist
git diff --check
git diff --exit-code -- packages/web/src/server/static-viz-assets.generated.ts
```

Open the release-preparation PR against `next/acpus_ts_workflow`. Require both
Node jobs to pass. After the PR lands, wait for the push-triggered CI run on the
resulting `next/acpus_ts_workflow` tip and record its full 40-character SHA as
`release_sha`.

Do not add code or documentation commits after recording `release_sha`. Any
change creates a new candidate and requires the complete gate again.

## Phase 2: freeze and preserve the old `main`

Start from a clean local checkout and fetch the two remote branches:

```sh
git fetch --prune origin
expected_old_main_sha=404ae9755d69632235a321d76ae21e1e77e9d299
remote_main_sha="$(git rev-parse refs/remotes/origin/main)"
release_sha="$(git rev-parse refs/remotes/origin/next/acpus_ts_workflow)"
test "$remote_main_sha" = "$expected_old_main_sha"
test -n "$release_sha"
```

Confirm that the recorded successful CI run belongs to `release_sha`. Then
create two recovery refs before changing `main`:

```sh
git push origin "$expected_old_main_sha:refs/heads/archive/main-before-acpus-next"
git tag -a main-before-acpus-next-2026-07-21 "$expected_old_main_sha" -m "Archive main before the TypeScript-first Acpus release"
git push origin refs/tags/main-before-acpus-next-2026-07-21
```

Verify both refs on GitHub. If either name already exists, inspect it instead of
overwriting it.

## Phase 3: replace `main`

Temporarily allow the release operator to force-push `main`. Keep every other
branch protection rule in place where GitHub permits it.

Run one lease-protected replacement:

```sh
git push origin "$release_sha:refs/heads/main" --force-with-lease="refs/heads/main:$expected_old_main_sha"
```

The lease makes the operation fail if `main` moved after the earlier check. Do
not retry with plain `--force`. Investigate the new remote tip and restart the
freeze phase.

Verify the result:

```sh
new_main_sha="$(git ls-remote origin refs/heads/main | cut -f1)"
test "$new_main_sha" = "$release_sha"
```

Immediately restore branch protection and disable force pushes. At this point
the repository has switched generations, but npm and Pages have not changed.

## Phase 4: publish the stable package graph

In GitHub Actions, open **Publish stable to npm**, choose `main`, and supply the
exact `release_sha`. The workflow checks that both its checkout and
`origin/main` equal that SHA, reruns the full release gates, and then waits for
approval on the `npm` environment.

Before approving, inspect the workflow summary and confirm:

- `check:release` reports nine stable public packages;
- the build, typecheck, dependency and security checks, documentation links, tests, packed
  distributions, and generated assets are green;
- the workflow is running from `release_sha`;
- no other npm publish is active.

Approve the environment deployment once. Do not rerun a failed publish blindly;
first determine which package versions reached npm.

## Phase 5: registry and installation verification

Verify all stable versions and dist-tags:

```sh
npm view acpus@0.6.0 version dist.integrity --json
npm view @acpus/core@0.7.0 version dist.integrity --json
npm view @acpus/runtime@0.9.0 version dist.integrity --json
npm view @acpus/agent-executor@0.1.0 version dist.integrity --json
npm view @acpus/expression@0.1.0 version dist.integrity --json
npm view @acpus/loader@0.1.0 version dist.integrity --json
npm view @acpus/tasks@0.1.0 version dist.integrity --json
npm view @acpus/web@0.1.0 version dist.integrity --json
npm view @acpus/workflow-compiler@0.1.0 version dist.integrity --json
for package_name in acpus @acpus/core @acpus/runtime @acpus/agent-executor @acpus/expression @acpus/loader @acpus/tasks @acpus/web @acpus/workflow-compiler; do
  npm view "$package_name" dist-tags --json
done
```

Each package's `latest` tag must point to the stable version in the table. Check
the npm provenance statement and the matching GitHub release/tag for every
package.

Perform a clean consumer smoke test outside the repository:

```sh
smoke_dir="$(mktemp -d)"
cd "$smoke_dir"
npm init -y
npm install acpus@0.6.0
npx acpus --version
npx acpus doctor --json | jq '{schemaVersion, ok, phase, message, checks: [.checks[] | {area, status}]}'
```

Also check and visualize one representative TypeScript workflow, then admit a
disposable run if the required ACP agent is available. Remove `smoke_dir` after
the evidence has been saved.

## Phase 6: deploy Pages and announce

Only after registry and consumer verification passes, run **Deploy Pages** with
the same `release_sha`. Verify the public site, README logo, installation
command, migration guide, and local documentation links.

The release announcement must call out:

- the TypeScript-first authoring model;
- the Node.js 24.15 minimum;
- the absence of compatibility shims for previous YAML workflows;
- the migration guide;
- the stable package versions.

## Abort and rollback

Abort before replacing `main` if CI is incomplete, release state is not clean,
remote configuration is unverified, or either recorded SHA changes.

If replacement succeeded but npm publishing has not started, restore the old
tree with the reverse lease:

```sh
current_main_sha="$(git ls-remote origin refs/heads/main | cut -f1)"
test "$current_main_sha" = "$release_sha"
git push origin "$expected_old_main_sha:refs/heads/main" --force-with-lease="refs/heads/main:$release_sha"
```

If any stable package reached npm, restoring Git does not roll back the release.
Do not unpublish. Stop Pages deployment and announcements, inventory the exact
published set, and publish a coherent fix-forward patch. Moving `latest` back
is an incident decision that must be reviewed across the complete dependency
graph; never change one package's dist-tag in isolation.

Record the final `main` SHA, workflow run URLs, npm versions and dist-tags,
provenance evidence, smoke-test result, Pages deployment, and any accepted
exceptions in the release record.
