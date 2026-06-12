# Changesets

This repository uses Changesets to manage package versions and npm releases.

Run `pnpm changeset` in feature PRs that affect published packages. Merging
changesets to `main` creates or updates a version PR. Merging that version PR
publishes the bumped public packages.
