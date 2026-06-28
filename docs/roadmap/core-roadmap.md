# Core Roadmap

This roadmap starts from the current `@acpus/core` authoring and compile layer plus the `acpus run --dry-run` pre-run gate. Implemented behavior is specified in `specs/`; this file tracks only unfinished work and known gaps.

## Known gaps in the current core

- Workflow modules are user-owned TypeScript scripts and are executed during compile to build the graph. Acpus does not attempt to sandbox user-authored workflow code.
- Task provenance is gated by a TypeScript parser-only static analyzer. It resolves reusable tasks through direct relative imports only; barrel/re-export indirection is rejected rather than followed.
- `validateWorkflowIR(...)` is structural only; it is not yet a typed semantic validator.
- The CLI only supports `run --dry-run`; real runtime execution is not implemented.

## Phase 1: harden the Zod bridge

- Support more Zod 4 representable schemas.
- Improve errors for unsupported boundary schemas, with source-path context in `toSchemaIR` errors.
- Decide whether `.refine()` is accepted as runtime-only validation or rejected at boundaries.

## Phase 2: Task bundling follow-ups

- Attach source-location (`line`/`column`) context to provenance diagnostics (TB004–TB007).
- Add source maps for bundled Task assets.
- Extend inline self-containment warnings beyond the current hard free-identifier gate: warn when a Task imports raw `zx`, imports `child_process` directly, or reads `process.env` instead of task-level `env`.

## Phase 3: Runtime scheduler and Task executor

- Extend `acpus run` beyond `--dry-run` once scheduler state exists.
- Evaluate Task input `ExprIR`, parse with the Zod schema when available, load the bundle by digest, construct `TaskContext`, and create the Acpus `$` wrapper.
- Collect command spans, capture stdout/stderr, implement the artifact API, validate returned output, and persist `output.json`.
- Classify failures: throw, timeout, subprocess_exit, output_schema, artifact, internal.
- No per-task permission enforcement in the core.

## Phase 4: Expr evaluator

- Implement a runtime evaluator for `ExprIR` (the full operator set, including where-lowered calls).
- Add type-aware validation: assert authoring `condition` must be boolean, fanout `over` should be array-like, loop stop condition must be boolean.

## Phase 5: Agent and Signal executors

- Agent executor: evaluate refs in `run.prompt`, `run.cwd`, `run.env`, and `run.session`, render prompt templates, run the selected agent definition, parse/validate output, record transcript/artifacts, retry on output parse/schema failures.
- Signal executor: evaluate refs in `run.prompt`, render prompt, enter awaiting state, validate payload, resume the graph.

## Phase 6: runtime persistence

- Durable run directory layout: frozen IR snapshot, frozen task bundles, input snapshot, node state, artifacts, command spans, logs, event timeline.
- Support pause/resume, retry node, replay, and fork.

## Phase 7: lint plugin

- Error rules: no `Expr` in JS `if`/`while`/ternary; no JS logical/comparison operators over `Expr`; no runtime array `.map()`; no dynamic node id from `Expr`; no untagged template containing `Expr`. These are editor-time mirrors; Task closure capture is already a compile-time gate (TB007).
- Warnings: prefer `ctx.$` over raw `zx`; prefer task-level `env` and `secret(...)` for redaction; prefer returning `ArtifactRef` over long-lived absolute paths.

## Phase 8: runner profiles

Since the core removed per-task permissions, isolation belongs to runner profiles. Candidates: `local-trusted`, `local-restricted`, `docker`, `remote`, `ci`. Example future CLI:

```bash
acpus run workflow.ir.json --runner docker --network none
```

This remains outside core authoring syntax.

## Phase 9: developer experience

- VS Code snippets, a graph visualizer, `acpus wf explain`, `acpus task test`, and diagnostics with source maps.
