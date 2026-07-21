# Changesets

This repository uses Changesets to manage package versions and npm releases.

Run `pnpm changeset` in every feature PR that affects a published package and
commit the generated Markdown file. Merging changesets to `main` creates or
updates the automated `Version Packages` PR. Review and merge that PR to
publish the bumped packages, Git tags, and GitHub Releases.

Changes under `page/` deploy independently to GitHub Pages after they reach
`main`; they do not require a changeset. See [the release guide](../docs/releasing.md)
for the full workflow and recovery rules.
