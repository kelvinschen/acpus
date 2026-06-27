# Core Roadmap

This roadmap starts from the current `@acpus/core` authoring and compile layer (Zod 4 schema bridge, Acpus Expr IR, zx/core-backed Task wrapper, compile to `WorkflowIR`, structural validation). Implemented behavior is specified in `specs/`; this file tracks only unfinished work and known gaps.

## Known gaps in the current core

- The compiler dynamically imports workflow modules as trusted local code. This is acceptable for core development but is not a deterministic compile environment for untrusted catalogs. A `C001` diagnostic flags this today.
- Inline Task source is captured with `Function#toString()` as a placeholder, not real AST extraction or bundling.
- `validateWorkflowIR(...)` is structural only; it is not yet a typed semantic validator.

## Phase 1: harden the Zod bridge

- Support more Zod 4 representable schemas.
- Improve errors for unsupported boundary schemas, with source-path context in `toSchemaIR` errors.
- Decide whether `.refine()` is accepted as runtime-only validation or rejected at boundaries.
- Add coverage for optional/default/nullable, nested objects, records, unions, Acpus metadata extensions, and rejected features (transforms/custom/date/map/set/etc.).

## Phase 2: Task bundling

Replace the `Function#toString()` placeholder with production bundling.

- AST extraction for inline `task(async ctx => ...)` and external `task.define(...).run(...)`.
- Local import-graph bundling, source maps, and a digest over the final bundle.
- Frozen task bundle assets in the IR lock.
- Closure-capture diagnostics — hard errors when a Task captures workflow `Expr`, `step`, or graph builder state, or uses non-deterministic top-level values; warnings when a Task imports raw `zx`, imports `child_process` directly, or reads `process.env` instead of task-level `env`.

## Phase 3: Task runtime executor

- Evaluate Task input `ExprIR`, parse with the Zod schema when available, load the bundle by digest, construct `TaskContext`, and create the Acpus `$` wrapper.
- Collect command spans, capture stdout/stderr, implement the artifact API, validate returned output, and persist `output.json`.
- Classify failures: throw, timeout, subprocess_exit, output_schema, artifact, internal.
- No per-task permission enforcement in the core.

## Phase 4: Expr evaluator

- Implement a runtime evaluator for `ExprIR` (the full operator set, including where-lowered calls).
- Add type-aware validation: guard `when` must be boolean, fanout `over` should be array-like, loop `until` must be boolean.

## Phase 5: Agent and Signal executors

- Agent executor: evaluate inputs, render prompt templates, run the selected agent definition, parse/validate output, record transcript/artifacts, retry on output parse/schema failures.
- Signal executor: evaluate inputs, render prompt, enter awaiting state, validate payload, resume the graph.

## Phase 6: runtime persistence

- Durable run directory layout: frozen IR snapshot, frozen task bundles, input snapshot, node state, artifacts, command spans, logs, event timeline.
- Support pause/resume, retry node, replay, and fork.

## Phase 7: lint plugin

- Error rules: no `Expr` in JS `if`/`while`/ternary; no JS logical/comparison operators over `Expr`; no runtime array `.map()`; no dynamic node id from `Expr`; no untagged template containing `Expr`; no Task closure capture of workflow values.
- Warnings: prefer `ctx.$` over raw `zx`; prefer task-level `env` and `secret(...)` for redaction; prefer returning `ArtifactRef` over long-lived absolute paths.

## Phase 8: runner profiles

Since the core removed per-task permissions, isolation belongs to runner profiles. Candidates: `local-trusted`, `local-restricted`, `docker`, `remote`, `ci`. Example future CLI:

```bash
acpus run workflow.ir.json --runner docker --network none
```

This remains outside core authoring syntax.

## Phase 9: developer experience

- VS Code snippets, a graph visualizer, `acpus wf explain`, `acpus task test`, diagnostics with source maps, and a migration helper from the previous API.
