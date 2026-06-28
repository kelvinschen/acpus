<h1 align="center">Acpus</h1>
<p align="center"><em>Every run is an opus.</em></p>

Acpus is a local durable harness for AI-first workflows. It is being rebuilt on a
new foundation: instead of authoring workflows as YAML specs interpreted at
runtime, you author them as typed **TypeScript** modules that compile to a frozen,
serializable IR which a runtime consumes.

> **Status: foundation rewrite in progress.** This repository currently contains
> the new core (`@acpus/core`) — the authoring and compile layer — plus the new
> `acpus` CLI package with preflight admission and a local durable runtime. The
> TUI is still being rebuilt. The previous YAML Workflow-Spec implementation
> (the full runtime, TUI, CLI, catalog, skill, and site) is preserved, read-only,
> under [`legacy/`](legacy/README.md).

## The new core

`@acpus/core` (`packages/core`) provides:

- TypeScript workflow authoring via `defineWorkflow(...).build(...)`.
- A **Zod 4** schema bridge with Acpus boundary extensions (`z.path`, `z.artifact`, `z.secretRef`), canonicalized to a durable `SchemaIR`.
- An Acpus-owned expression IR (`ExprIR`) with Prisma/Mongo-style `where(...)` filters and named operators — no CEL/JSON Logic as the canonical layer.
- Agent / Task / Signal executable nodes with explicit `run` boundaries and schema contract fields (`inputSchema`, `outputSchema`, `itemOutputSchema`), plus composite nodes (`if`, `switch`, `parallel`, `fanout`, `loop`) and boolean `assert` nodes.
- Trusted local **Task** nodes (replacing program nodes) with an Acpus-owned `$` command wrapper backed by `zx/core`. Security isolation is delegated to the runner/container/profile layer, not per-node syntax.
- Compilation to a frozen `WorkflowIR` (`irVersion: 2`) with structural validation
  and bundled Task assets.

Representative workflow compiler fixtures live in `packages/core/test/fixtures/workflows/`.

## CLI

The `acpus` package exposes both the pre-run gate and the foreground durable runtime:

```sh
pnpm --filter acpus build
pnpm exec acpus run packages/core/test/fixtures/workflows/module.workflow.ts --dry-run
pnpm exec acpus run workflow.ts --input-file input.json
pnpm exec acpus runs
pnpm exec acpus show <run-id>
pnpm exec acpus signal <run-id> <signal-node-id> --input '{"approved":true}'
pnpm exec acpus retry <run-id> --node failing-node
pnpm exec acpus replay <run-id>
pnpm exec acpus fork <run-id> --execute
```

`acpus run <workflow.ts>` typechecks, compiles, validates, writes
`.acpus/preflight/<id>/`, admits immutable IR/input/task bundle metadata into
`.acpus/state/runtime.db`, copies task bundles into `.acpus/runs/<run-id>/`, and
executes the scheduler. Use `--dry-run` to stop after preflight and `--background`
to admit without foreground execution.

## Development

This is a pnpm workspace containing the TypeScript core and the new CLI package.

```sh
pnpm install
pnpm build       # tsgo build of packages/*
pnpm typecheck
pnpm test        # vitest
```

The core package intentionally does not expose a CLI; command-line entry points
live in `packages/acpus`.

## Documentation

Current design truth lives in `specs/`; future plans and known gaps live in `docs/roadmap/`.

- [Specs Index](specs/INDEX.md)
- [Core Workflow Spec](specs/core-workflow-spec.md)
- [Core Expression Spec](specs/core-expression-spec.md)
- [CLI Spec](specs/cli-spec.md)
- [Roadmap Index](docs/roadmap/INDEX.md) · [Core Roadmap](docs/roadmap/core-roadmap.md)

The previous implementation and its documentation are archived under [`legacy/`](legacy/README.md).

## License

MIT
