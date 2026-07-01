# Workflow Compiler Spec

## Purpose

`@acpus/workflow-compiler` prepares TypeScript workflow modules for runtime admission. It runs a static `check` phase, imports workflow modules with a TypeScript-aware loader, compiles exported workflow definitions through `@acpus/core`, performs parser-only task analysis, bundles task assets, validates the resulting IR, and writes preflight artifacts. It does not execute workflows or persist runtime state.

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
- `compileWorkflowModule(...)` MUST analyze task call sites, consume task bundle metadata, bundle task assets, synchronize task run digests with bundled task digests, append `validateWorkflowIR(...)` diagnostics, and return `WorkflowIR`.
- `compileWorkflowModule(...)` MUST NOT run the preflight check phase itself.

### Static Check And Worker Import

- `prepareWorkflow(options)` MUST run `check`, then `compile`, then `validate`.
- The check phase MUST aggregate stable TypeScript compiler diagnostics and Acpus authoring-rule diagnostics as `DiagnosticIR`.
- TypeScript diagnostics MUST use existing `DiagnosticIR` fields with `code: "TS####"`, flattened `message`, and `source` file, line, and column when available.
- The TypeScript check MUST use stable `typescript`, not `@typescript/native-preview`.
- The TypeScript check MUST use a scratch tsconfig with NodeNext module resolution and no emit.
- In workspace development, the TypeScript check MUST use the `development` condition and map `@acpus/core` and `@acpus/core/*` to live core source.
- Published installs MUST rely on normal package resolution.
- Acpus authoring rules MUST run only Acpus-owned checks and MUST NOT load user ESLint config, editor config, or broad third-party presets.
- Acpus authoring rules MUST reject `Expr` values in JavaScript truthiness positions, logical/comparison operators over `Expr`, untagged template interpolation containing `Expr`, JavaScript array methods over Expr accessors, Expr-derived node ids, invalid task authoring shapes, and task callsites that cannot be joined to task metadata.
- Full preparation MUST compile through a worker/import path that can load TypeScript workflow modules.
- Check failures MUST be reported as `WorkflowPreparationError` with phase `"check"` and `DiagnosticIR[]`.
- Module import or compile failures MUST be reported as phase `"compile"`.
- IR diagnostics containing any `severity: "error"` MUST be reported as phase `"validate"`.

### Internal Fixture ESLint

- The package MAY expose `./internal/eslint-plugin` for repository-internal fixture review. This subpath is not a product API and MUST NOT be re-exported from the root package entrypoint.
- The internal ESLint plugin MUST provide one `acpus-internal/check` rule that reuses Acpus authoring-rule behavior and reports only Acpus `AL...` and `TB...` diagnostics, not TypeScript `TS...` diagnostics.
- The internal ESLint rule MUST require typed parser services and report a clear configuration diagnostic when those services are unavailable.
- The repository ESLint flat config MUST scope this rule to workflow-compiler fixtures only, MUST NOT add a default lint script or CI gate, and MAY no-op when the built internal plugin subpath is unavailable.
- Task-authoring diagnostics reported through the internal ESLint rule MUST use task-analysis callsite source locations when available.

### Task Analysis And Bundling

- Task analysis MUST use parser-only static source analysis of the workflow source and directly imported task modules when export validation is required.
- Task analysis MUST produce diagnostic-free facts and bundle metadata only.
- Acpus authoring rules MUST own task authoring diagnostic codes, messages, and hints.
- Compile and bundling MUST consume task metadata and MUST NOT duplicate lint rule text.
- The analyzer MUST match direct `step("id").task(...)` call sites.
- Reusable tasks MUST resolve from either relative direct imports of task modules or exported top-level reusable tasks declared in the workflow module.
- Imported reusable tasks MUST use relative direct imports of task modules.
- Exported top-level reusable tasks declared in the workflow module MUST be valid when passed to `run.task`.
- Same-file reusable task metadata MUST identify the workflow source file and exported task name.
- A resolved reusable task module export MUST be a `task.define(...)` declaration.
- Reusable tasks routed through re-export/barrel modules, nested or non-exported workflow-local task values, and non-task exports MUST produce check diagnostics rather than admissible task bundles in preflight.
- Inline task source MUST be bundled as a self-contained function.
- Inline tasks that capture workflow-module scope MUST produce check diagnostics in preflight.
- Task bundling MUST emit ESM source for Node runtime execution.
- Reusable task bundling MUST include local modules and JavaScript npm dependencies reachable from the task module or same-file workflow-module task export.
- Same-file reusable task bundling MUST import the exported task token from the workflow module and re-export `token.fn`; it MUST NOT attempt dependency-closure extraction.
- Importing a same-file task bundle MAY evaluate workflow module top-level code; importing the workflow module MUST NOT execute the workflow build callback.
- Node built-ins MUST remain runtime externals.
- Task bundles MUST include `source`, `digest`, runtime metadata, and source-file metadata when statically resolved.
- Task run digests MUST match the corresponding bundle digest after bundling.
- Bundling failures MUST produce task-bundle diagnostics with stable `TB...` diagnostic codes.
- Direct `compileWorkflowModule(...)` MUST NOT run Acpus authoring rules, but it MUST emit a task-bundle safety diagnostic if task metadata is unavailable or inconsistent for a lowered task bundle.

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
- Tests MUST cover check failure before compile, including TypeScript diagnostics converted to `DiagnosticIR` and Acpus authoring-rule diagnostics.
- Tests MUST cover validation failure after compile.
- Tests MUST cover task analysis facts and metadata for imported reusable tasks, exported same-file reusable tasks, unexported/nested workflow-local reusable tasks, re-exported reusable tasks, non-task module exports, and inline tasks that capture workflow-module scope.
- Tests MUST cover stable reusable task metadata across compiles.
- Tests MUST cover same-file reusable task bundling and runtime execution through the prepared workflow path.
- Tests MUST cover preflight artifact writing, lock shape, IR digest, source graph digest, and task bundle artifact files.
