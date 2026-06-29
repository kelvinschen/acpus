# Workflow Compiler Spec

## Purpose

`@acpus/workflow-compiler` prepares TypeScript workflow modules for runtime admission. It typechecks workflow source, imports workflow modules with a TypeScript-aware loader, compiles exported workflow definitions through `@acpus/core`, performs parser-only task provenance analysis, bundles task assets, validates the resulting IR, and writes preflight artifacts. It does not execute workflows or persist runtime state.

## Requirements

### Public API

- The package MUST expose `compileWorkflowModule(entry, options?)`.
- The package MUST expose `prepareWorkflow(options)`.
- The package MUST expose `writePreflightArtifact(prepared, cwd)`.
- The package MUST expose `WorkflowPreparationError` and public preparation, lock, artifact, and failure types.
- The package MUST NOT expose a binary.

### Module Compilation

- `compileWorkflowModule(entry, options?)` MUST read the workflow source file.
- `compileWorkflowModule(...)` MUST import the module and require the default export to be an Acpus workflow definition.
- `compileWorkflowModule(...)` MUST lower the workflow definition through `compileWorkflowDefinition(..., { validate: false })`.
- `compileWorkflowModule(...)` MUST attach a `sha256:` `workflowSourceDigest` computed from the workflow source text.
- `compileWorkflowModule(...)` MUST analyze task call sites, bundle task assets, synchronize task run digests with bundled task digests, append `validateWorkflowIR(...)` diagnostics, and return `WorkflowIR`.
- `compileWorkflowModule(...)` MUST NOT perform workflow TypeScript typecheck itself; full preparation owns typecheck.

### Typecheck And Worker Import

- `prepareWorkflow(options)` MUST typecheck the workflow module before compile.
- Typecheck MUST use a scratch tsconfig with NodeNext module resolution and no emit.
- In workspace development, typecheck MUST use the `development` condition and map `@acpus/core` and `@acpus/core/*` to live core source.
- Published installs MUST rely on normal package resolution.
- Full preparation MUST compile through a worker/import path that can load TypeScript workflow modules.
- Typecheck failures MUST be reported as `WorkflowPreparationError` with phase `"typecheck"`.
- Module import or compile failures MUST be reported as phase `"compile"`.
- IR diagnostics containing any `severity: "error"` MUST be reported as phase `"validate"`.

### Task Provenance And Bundling

- Task provenance MUST use parser-only static source analysis of the workflow source.
- The analyzer MUST match direct `step("id").task(...)` call sites.
- Reusable tasks MUST resolve from relative direct imports of task modules.
- A resolved reusable task module export MUST be a `task.define(...)` declaration.
- Reusable tasks routed through re-export/barrel modules, workflow-local reusable task values, and non-task module exports MUST produce diagnostics rather than admissible task bundles.
- Inline task source MUST be bundled as a self-contained function.
- Inline tasks that capture workflow-module scope MUST produce diagnostics.
- Task bundling MUST emit ESM source for Node runtime execution.
- Reusable task bundling MUST include local modules and JavaScript npm dependencies reachable from the task module.
- Node built-ins MUST remain runtime externals.
- Task bundles MUST include `source`, `digest`, runtime metadata, and source-file metadata when statically resolved.
- Task run digests MUST match the corresponding bundle digest after bundling.
- Bundling failures MUST produce task-bundle diagnostics with stable `TB...` diagnostic codes.

### Prepared Workflow And Preflight Artifacts

- `prepareWorkflow(options)` MUST return a prepared workflow containing workflow path, `WorkflowIR`, serialized IR JSON, IR digest, source graph digest, optional package lock digest, and lock artifact.
- The IR digest MUST be a `sha256:` digest of stable pretty JSON written as `workflow.ir.json`.
- The source graph digest MUST include workflow source digest, package lock digest when present, and sorted task bundle digests.
- Package lock digest MAY be computed from `pnpm-lock.yaml`, `package-lock.json`, or `yarn.lock`.
- `writePreflightArtifact(...)` MUST write `.acpus/preflight/<id>/workflow.ir.json`.
- `writePreflightArtifact(...)` MUST write `.acpus/preflight/<id>/lock.json`.
- `writePreflightArtifact(...)` MUST write each bundled task source under `.acpus/preflight/<id>/task-bundles/<bundle-id>.mjs`.
- The lock artifact MUST reference workflow entry, IR digest, source graph digest, optional package lock digest, and task bundle paths/digests.

## Verification

- Public API contract and type tests MUST cover exported compiler/preflight functions, error class, and public types.
- Integration tests MUST cover compiling TypeScript workflow modules with reusable, inline, and third-party task bundles.
- Tests MUST cover typecheck failure before compile.
- Tests MUST cover validation failure after compile.
- Tests MUST cover static provenance rejection for workflow-local reusable tasks, re-exported reusable tasks, non-task module exports, and inline tasks that capture workflow-module scope.
- Tests MUST cover stable reusable task provenance across compiles.
- Tests MUST cover preflight artifact writing, lock shape, IR digest, source graph digest, and task bundle artifact files.
