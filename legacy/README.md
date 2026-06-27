# legacy/ — Pre-core-rewrite record

This directory is a frozen, read-only record of the Acpus implementation that
predates the TypeScript-first core rewrite. It is preserved for reference only.

It is **not** current implementation truth and is **not** part of the active
build: nothing here is a member of the `packages/*` pnpm workspace, and none of
it is built, typechecked, tested, or published by the repo toolchain.

## Contents

- `packages/` — the previous YAML Workflow-Spec implementation: `@acpus/core`,
  `@acpus/runtime`, `@acpus/tui`, `acpus` (CLI), and `@acpus/mock-agent`.
- `README-product.md`, `README.zh.md`, `CONTEXT.md` — the previous product
  README (EN/ZH) and terminology context for the YAML paradigm. Their relative
  links resolve against the assets in this directory.
- `specs/` — the SPEC files for the YAML Workflow-Spec paradigm.
- `.acpus/` — the catalog playbooks (workflow specs and their scripts).
- `skills/` — the `acpus` skill bundle.
- `prd/` — the original product requirements document.
- `page/` — the previous GitHub Pages site and generated workflow visualizations.
- `docs/` — historical ADRs, archive notes, and the prior roadmap.

## Why it is here

The project's foundation moved from authoring workflows as YAML specs interpreted
at runtime to authoring them as typed TypeScript modules compiled to a frozen,
serializable IR. The new core lives at `packages/core`. The runtime, TUI, and CLI
will be rebuilt on top of the new core; until then, this record captures the prior
design and implementation in full.
