<h1 align="center">Acpus</h1>
<p align="center"><em>Every run is an opus.</em></p>

Acpus is a local durable harness for AI-first workflows. It is being rebuilt on a
new foundation: instead of authoring workflows as YAML specs interpreted at
runtime, you author them as typed **TypeScript** modules that compile to a frozen,
serializable IR which a runtime consumes.

> **Status: foundation rewrite in progress.** This repository currently contains
> the new TypeScript workflow core (`@acpus/core`), workflow compiler, durable
> runtime, and `acpus workflow` CLI surface. The previous YAML Workflow-Spec
> implementation (the full runtime, TUI, CLI, catalog, skill, and site) is
> preserved, read-only, under [`legacy/`](legacy/README.md).

## The new core

`@acpus/core` (`packages/core`) provides:

- TypeScript workflow authoring via `defineWorkflow(...).build(...)`.
- The native **Zod 4** `z` interface, with supported workflow boundary schemas canonicalized to a durable `SchemaIR`.
- Integration with `@acpus/expression`, the Acpus-owned expression language package for `ExprIR`, `TemplateIR`, predicate helpers, overloaded `lift`, `template`, and `md`.
- Flat Agent / Task / Signal authoring specs that lower into explicit frozen-IR execution envelopes, durable workflow input and Agent/Signal output schemas, and config-time reusable Task input inference, plus composite nodes (`if`, `switch`, `parallel`, `fanout`, `loop`) and boolean `assert` nodes.
- Trusted local **Task** nodes (replacing program nodes) with an Acpus-owned `$` command wrapper backed by `zx/core`. Security isolation is delegated to the runner/container/profile layer, not per-node syntax.
- Compilation to a frozen `WorkflowIR` (`irVersion: 5`) with structural validation
  and live reusable Task references.

Representative workflow compiler fixtures live in `packages/workflow-compiler/test/fixtures/workflows/`.

## CLI

The new `acpus` package exposes workflow check/run commands:

```sh
pnpm --filter acpus build
pnpm exec acpus workflow check packages/workflow-compiler/test/fixtures/workflows/basic/valid.workflow.ts
pnpm exec acpus workflow run packages/workflow-compiler/test/fixtures/workflows/basic/valid.workflow.ts --input '{"ready":true}'
```

`acpus workflow check <workflow.ts>` typechecks, compiles, and validates
without admitting runtime state. `acpus workflow run <workflow.ts>` admits a
durable run under
`.acpus/.local/state/runtime.db` and `.acpus/.local/runs/<run-id>/`.

## Development

This is a pnpm workspace containing the TypeScript core and the new CLI package.

```sh
pnpm install
pnpm build       # tsc build of packages/*
pnpm typecheck
pnpm test        # vitest (suites pass with no tests yet)
```

The core package intentionally does not expose a CLI; command-line entry points
live in `packages/cli`.

## Documentation

Current design truth lives in `specs/`; future plans and known gaps live in `docs/roadmap/`.

- [Specs Index](specs/INDEX.md)
- [Core Spec](specs/core-spec.md)
- [Expression Spec](specs/expression-spec.md)
- [CLI Spec](specs/cli-spec.md)
- [Roadmap Index](docs/roadmap/INDEX.md) · [Core Roadmap](docs/roadmap/core-roadmap.md)

The previous implementation and its documentation are archived under [`legacy/`](legacy/README.md).

## License

MIT
