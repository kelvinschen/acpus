# Core Roadmap

This roadmap tracks remaining core authoring, compiler, and developer-experience work. Implemented behavior is specified in `specs/`; this file is not product truth.

## Known gaps in the current core

- Workflow modules are user-owned TypeScript scripts and are executed during compile to build the graph. Acpus does not attempt to sandbox user-authored workflow code.
- Task analysis is gated by a TypeScript parser-only static analyzer. It records reusable task references for direct imports, barrel re-exports, exported same-file workflow tasks, and package specifiers.
- `validateWorkflowIR(...)` is structural only; typed semantic validation remains a follow-up.

## Phase 1: harden the Zod bridge

- Support more Zod 4 representable schemas.
- Improve errors for unsupported boundary schemas, with source-path context in `toSchemaIR` errors.
- Decide whether `.refine()` is accepted as runtime-only validation or rejected at boundaries.

## Phase 2: task execution follow-ups

- Extend inline self-containment warnings beyond the current hard free-identifier gate: warn when a Task imports raw `zx`, imports `child_process` directly, or reads `process.env` instead of task-level `env`.

## Phase 3: Runtime follow-ups

Runtime-owned behavior now lives in `specs/runtime-spec.md`. Open runtime gaps discovered during spec/package alignment are tracked in `docs/roadmap/spec-gap-audit.md` and durable-runtime planning stays in `docs/roadmap/durable-runtime-roadmap.md`.

## Phase 4: authoring warnings

- Additional warnings: prefer `ctx.$` over raw `zx`; prefer task-level `env` and `secret(...)` for redaction; prefer returning `ArtifactRef` over long-lived absolute paths.

## Phase 5: runner profiles

Since the core removed per-task permissions, isolation belongs to runner profiles. Candidates: `local-trusted`, `local-restricted`, `docker`, `remote`, `ci`. Example future CLI:

```bash
acpus run workflow.ir.json --runner docker --network none
```

This remains outside core authoring syntax.

## Phase 6: developer experience

- VS Code snippets, a graph visualizer, `acpus wf explain`, `acpus task test`, and diagnostics with source maps.
