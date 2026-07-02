# Workflow Compiler Spec

## Purpose

`@acpus/workflow-compiler` prepares TypeScript workflow modules for runtime admission. It runs a static `check` phase, imports workflow modules with a TypeScript-aware loader, compiles exported workflow definitions through `@acpus/core`, performs parser-only task callsite analysis, prepares reusable task module references, validates the resulting IR, and writes preflight artifacts. It does not execute workflows or persist runtime state.

## Requirements

### Public API

- The package MUST expose `compileWorkflowModule(entry, options?)`.
- The package MUST expose `tryCompileWorkflowModule(entry, options?)`.
- The package MUST expose `prepareWorkflow(options)`.
- The package MUST expose `tryPrepareWorkflow(options)`.
- The package MUST expose `writePreflightArtifact(prepared, cwd)`.
- The package MUST expose `WorkflowPreparationError` and public preparation, lock, artifact, and failure types.
- The package MUST NOT expose a binary.

### Module Compilation

- `compileWorkflowModule(entry, options?)` MUST read the workflow source file.
- `compileWorkflowModule(...)` MUST import the module and require the default export to be an Acpus workflow definition.
- `tryCompileWorkflowModule(...)` MUST return a neverthrow `ResultAsync<WorkflowIR, CompileWorkflowModuleError>` for recoverable module compile failures.
- `CompileWorkflowModuleError` MUST be a serializable tagged union covering source read failure, module import failure, invalid default export, workflow build/lowering failure, task analysis failure, and workflow path outside workspace.
- `compileWorkflowModule(...)` MAY remain a throwing compatibility adapter over `tryCompileWorkflowModule(...)`.
- `compileWorkflowModule(...)` MUST lower the workflow definition through `compileWorkflowDefinition(..., { validate: false })`.
- `compileWorkflowModule(...)` MUST attach a `sha256:` `workflowSourceDigest` computed from the workflow source text.
- `compileWorkflowModule(...)` MUST analyze task call sites, attach reusable task module reference metadata to lowered task runs, append `validateWorkflowIR(...)` diagnostics, and return `WorkflowIR`.
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
- Acpus authoring rules MUST statically inspect graph-binding output producers for workflow root returns, composite callbacks, and loop `initial`, and MUST inspect inline task and reusable `task.define(...).exec` return types for non-workflow runtime data.
- Graph-binding output producer source shapes that cannot be statically located MUST produce `OA001` diagnostics. This includes hidden specs, saved step declarations known to be Acpus step declarations, spread-heavy output objects, computed output keys, and non-literal producer callbacks where graph output shape would otherwise be inferred only at runtime. Task `exec` return expressions are ordinary TypeScript function returns and MUST NOT require source-shape visibility when their return type is known.
- Acpus authoring rules MUST ignore unrelated property calls that merely share names such as `.task(...)` or `.loop(...)` unless the receiver is a direct `step("id")` call or is typed as an Acpus `StepDeclaration`.
- Inferred output types containing functions, classes, `Date`, `Map`, `Set`, `symbol`, `bigint`, broad `object`, or other non-workflow data MUST produce `OA002` diagnostics before runtime. Acpus authoring rules MUST NOT reject `any` or `unknown` solely as a safety measure; authors who opt out of TypeScript precision own that tradeoff.
- Explicit opaque `JsonValue` and `JsonObject` output types exported by Acpus packages MUST be accepted as workflow-admissible values.
- Branch-like producers for `if`, `switch`, and `parallel` `race` MUST produce `OA003` diagnostics when branch output key sets differ or matching field types do not converge to a common assignable type that TypeScript has not already rejected.
- Workflow root return branches MUST converge to a stable object shape when multiple root return statements are present.
- Loop `initial` MUST be a statically known object output, loop `initial` and body output types MUST converge, and negative literal `maxIterations` MUST produce `OA004`.
- Full preparation MUST compile through a worker/import path that can load TypeScript workflow modules.
- Check failures MUST be reported as `WorkflowPreparationError` with phase `"check"` and `DiagnosticIR[]`.
- Module import or compile failures MUST be reported as phase `"compile"`.
- IR diagnostics containing any `severity: "error"` MUST be reported as phase `"validate"`.
- `tryPrepareWorkflow(options)` MUST return a neverthrow `ResultAsync<PreparedWorkflow, WorkflowPreparationFailure>` instead of throwing for check, compile, and validate failures.
- `WorkflowPreparationFailure` MUST include a stable `type` tag while preserving the existing `phase` field.
- Compile worker failure payloads MUST be plain JSON objects with `ok: false`, a stable `type`, and a display `message`.
- `prepareWorkflow(options)` MAY remain a throwing compatibility adapter over `tryPrepareWorkflow(options)`.

### Internal Fixture ESLint

- The package MAY expose `./internal/eslint-plugin` for repository-internal fixture review. This subpath is not a product API and MUST NOT be re-exported from the root package entrypoint.
- The internal ESLint plugin MUST provide one `acpus-internal/check` rule that reuses Acpus authoring-rule behavior and reports only Acpus `AL...` and `TB...` diagnostics, not TypeScript `TS...` diagnostics.
- The internal ESLint rule MUST require typed parser services and report a clear configuration diagnostic when those services are unavailable.
- The repository ESLint flat config MUST scope this rule to workflow-compiler fixtures only, MUST NOT add a default lint script or CI gate, and MAY no-op when the built internal plugin subpath is unavailable.
- Task-authoring diagnostics reported through the internal ESLint rule MUST use task-analysis callsite source locations when available.

### Task Analysis And Reusable References

- Task analysis MUST use parser-only static source analysis of the workflow source where source-level task callsite metadata is required.
- Task analysis MUST produce diagnostic-free facts and reusable module reference metadata only.
- Acpus authoring rules MUST own task authoring diagnostic codes, messages, and hints.
- Compile MUST consume task metadata and MUST NOT duplicate lint rule text.
- The analyzer MUST match direct `step("id").task(...)` call sites.
- Reusable tasks MUST support direct default imports, named imports with aliases, barrel re-exports, same-file exported reusable tasks, and bare package specifiers that resolve to ESM modules at runtime.
- Reusable task metadata MUST be derived from `task.define({ inputSchema, exec })`; reusable tasks MUST NOT require or preserve an `outputSchema` field.
- Reusable module metadata MUST identify the source-level specifier, export name, and workflow source referrer needed for runtime import.
- Reusable module metadata MUST record `exportName: "default"` for default imports, the original exported binding name for named imports even when locally aliased, and the exported workflow-module binding name for same-file task exports.
- Same-file reusable task metadata MUST identify the workflow source module and exported task name.
- Imported reusable task metadata MUST keep the workflow import specifier rather than a resolved absolute filesystem path.
- Reusable task modules MUST remain live module references; the compiler MUST NOT generate executable task artifacts from their source or dependencies.
- Package imports and barrel re-exports MUST NOT be rejected solely because they cross package or module boundaries.
- Unsupported source forms such as namespace/property access MUST produce check diagnostics when statically recognizable.
- Task callsites that cannot be joined to lowered task nodes by step id MUST produce check diagnostics rather than module descriptors.
- Inline task source MUST be preserved as a self-contained function source in the serialized IR.
- Inline task source analysis MUST treat task output as TypeScript-inferred from `exec`, not as schema-declared metadata.
- Inline tasks that capture workflow-module scope MUST produce check diagnostics in preflight.
- Direct `compileWorkflowModule(...)` MUST NOT run Acpus authoring rules, but it MUST append validation diagnostics if compiled task runs lack valid inline or reusable execution targets.
- The task authoring diagnostic set MUST keep inline self-containment failures as `TB007` and SHOULD assign current task callsite diagnostics around the live reusable task model.

### Prepared Workflow And Preflight Artifacts

- `prepareWorkflow(options)` MUST return a prepared workflow containing workflow path, `WorkflowIR`, serialized IR JSON, IR digest, source graph digest, optional package lock digest, and lock artifact.
- The IR digest MUST be a `sha256:` digest of stable pretty JSON written as `workflow.ir.json`.
- The source graph digest MUST be derived from workflow source digest and package lock digest when present.
- Package lock digest MAY be computed from `pnpm-lock.yaml`, `package-lock.json`, or `yarn.lock`.
- `writePreflightArtifact(...)` MUST write `.acpus/preflight/<id>/workflow.ir.json`.
- `writePreflightArtifact(...)` MUST write `.acpus/preflight/<id>/lock.json`.
- `writePreflightArtifact(...)` MUST NOT write task code artifacts.
- The lock artifact MUST reference workflow entry, IR digest, source graph digest, and optional package lock digest.

## Verification

- Public API contract and type tests MUST cover exported compiler/preflight functions, error class, and public types.
- Integration tests MUST cover compiling TypeScript workflow modules with reusable module references, inline embedded source, and package-imported reusable tasks.
- Tests MUST cover check failure before compile, including TypeScript diagnostics converted to `DiagnosticIR` and Acpus authoring-rule diagnostics.
- Tests MUST cover output-admissibility diagnostics for non-JSON output values, imported reusable task output types, graph-binding hidden producer source shapes, branch/root convergence, loop consistency, unrelated method-call non-matches, explicit `JsonValue`/`JsonObject` acceptance, and task `exec` hidden return expressions accepted through TypeScript return types.
- Tests MUST cover validation failure after compile.
- Tests MUST cover task analysis facts and metadata for imported reusable tasks, exported same-file reusable tasks, package imports, re-exported reusable tasks, unsupported task callsite forms, and inline tasks that capture workflow-module scope.
- Tests MUST cover stable reusable task reference metadata across compiles.
- Tests MUST cover same-file reusable task references without rerunning workflow build callbacks at task execution time.
- Tests MUST cover preflight artifact writing, lock shape, IR digest, and source graph digest without task code artifact files.
