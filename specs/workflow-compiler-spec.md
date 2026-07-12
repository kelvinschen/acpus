# Workflow Compiler Spec

## Purpose

`@acpus/workflow-compiler` prepares TypeScript workflow modules for runtime admission and static visualization. It runs a static `check` phase, imports workflow modules through `@acpus/loader`, compiles exported workflow definitions through `@acpus/core`, performs parser-only task callsite analysis, prepares reusable task module references, validates the resulting IR, and returns frozen workflow data in memory. It does not execute workflows or persist runtime state.

## Requirements

### Public API

- The package MUST expose `prepareWorkflow(options)`.
- The package MUST expose `tryPrepareWorkflow(options)`.
- The package MUST expose `WorkflowPreparationError` and public preparation, lock, and failure types.
- The package MUST NOT expose a public preflight artifact writer.
- The package MUST NOT expose a binary.

### Internal Module Compilation

- The preparation compile worker MUST read and import the workflow source file and require its default export to be an Acpus workflow definition.
- Recoverable internal module compilation failures MUST use a serializable tagged union covering source read failure, module import failure, invalid default export, workflow build/lowering failure, task analysis failure, and workflow path outside workspace.
- Internal module compilation MUST lower the workflow definition through `compileWorkflowDefinition(..., { validate: false })`.
- Internal module compilation MUST return a `sha256:` source digest alongside the compiled IR, computed from the workflow source text without embedding it in `WorkflowIR`.
- Internal module compilation MUST analyze task call sites, attach reusable task module reference metadata to lowered task runs, append `validateWorkflowIR(...)` diagnostics, and return `WorkflowIR`.
- Scope-ref legality diagnostics MUST come from `validateWorkflowIR(...)` so module compilation, `workflow check`, preparation, and runtime admission share the same backstop for malformed or hand-authored IR.
- Internal module compilation MUST NOT run the preparation check phase itself.

### Static Check And Worker Import

- `prepareWorkflow(options)` MUST run `check`, then `compile`, then `validate`.
- The check phase MUST aggregate stable TypeScript compiler diagnostics and Acpus authoring-rule diagnostics as `DiagnosticIR`.
- TypeScript diagnostics MUST use existing `DiagnosticIR` fields with `code: "TS####"`, flattened `message`, and `source` file, line, and column when available.
- The TypeScript check MUST use the repository-pinned TypeScript 7 native compiler and MUST NOT retain a TypeScript 6, `@typescript/native-preview`, or fallback backend.
- TypeScript 7 programmatic access MUST be isolated behind the package-internal workflow-analysis implementation boundary. Native API, project, snapshot, program, checker, AST, symbol, type, and node-handle values MAY be shared only among that boundary's check and task-analysis implementation files and MUST NOT appear in the package entrypoint, public types, domain results, IR, events, or worker JSON.
- The TypeScript 7 native API version MUST be pinned exactly. Every snapshot MUST be disposed and every short-lived API instance MUST be closed on both success and failure.
- Normal TypeScript 7 native shutdown MUST close the service input and await clean process exit before releasing the API; successful workflow checks MUST NOT emit native shutdown noise on process stderr.
- The TypeScript check MUST use a scratch tsconfig with NodeNext module resolution and no emit.
- The TypeScript check MUST keep the scratch tsconfig self-contained to the
  workflow entry and its import graph; it MUST NOT inherit host `tsconfig.json`
  `files`, `include`, or project references.
- The TypeScript check MUST resolve supported official authoring facade
  specifiers `acpus/core`, `acpus/expression`, and `acpus/tasks/git` from
  Acpus-owned packages, without requiring the workflow workspace to install
  Acpus dependencies.
- The TypeScript check MUST get supported official authoring facade paths from
  `@acpus/loader`.
- In workspace development, official `acpus/*` facade specifiers SHOULD resolve
  to live package source through the `development` condition.
- Published installs MUST rely on normal package resolution for non-Acpus
  dependencies.
- The check phase MUST run only the TypeScript compiler and Acpus-owned checks; it MUST NOT load user or editor lint configuration or third-party rule presets.
- Public TypeScript types MUST own every authoring constraint expressible by the type system. Acpus AST authoring rules MUST NOT duplicate those constraints or remap native TypeScript diagnostics to Acpus codes.
- The check phase MUST report one `AL007` error for every TypeScript `AnyKeyword` in the workflow entry source file, including annotations, assertions, arrays, generic arguments/defaults, return types, `keyof any`, rest parameters, and nested inline Task or expression callback bodies.
- `AL007` MUST use message `Explicit 'any' is not allowed in Acpus workflow authoring.` and hint `Use a precise type, or use unknown and narrow it before crossing an Acpus boundary.`
- `AL007` MUST NOT scan imported helper modules, read lint configuration, support suppression/configuration/autofix, or invoke ESLint.
- Acpus authoring rules MUST reject `Expr` values in JavaScript truthiness positions, logical operators, TypeScript-accepted equality operators, untagged template interpolation containing `Expr`, string-typed node ids derived from Expr values, invalid callback source forms, invalid task authoring shapes, and task callsites that cannot be joined to task metadata.
- Expr condition hints MUST distinguish graph `if` control from ternary value computation. Negation and boolean logical hints MUST name `not`, `and`, or `or`; non-boolean logical fallback hints MUST name unary or binary `lift`; equality hints MUST name `eq` or `ne` according to the authored operator.
- `AL005` MUST explain that loop and fanout instance paths derive distinct runtime `nodeKey` values from one static step id. An Expr-derived template string used directly as a step id MUST produce `AL005` without a duplicate untagged-template `AL004` or non-literal-id `TB004`; other untagged templates and non-literal Task ids MUST retain their owning diagnostics.
- Expr array properties and methods, relational operators, direct non-string node ids, callback output types, and other type-expressible failures MUST be left to TypeScript diagnostics.
- Acpus authoring rules MUST inspect only `lift` calls imported from the supported `acpus/expression` facade, including named aliases, namespace property access, and string-literal namespace element access; transparent parentheses, type assertions, non-null assertions, and `satisfies` expressions around those callees or namespace receivers MUST NOT bypass inspection, while imports from internal implementation packages and shadowed bindings MUST NOT be treated as facade calls.
- For legal two-, three-, and four-argument `lift` calls, Acpus authoring rules MUST locate the final argument as the callback and MUST reject callbacks with fewer parameters than preceding dependencies; a named object is one structured dependency and therefore has one destructured callback parameter. Excess callback parameters remain owned by TypeScript.
- Acpus authoring rules MUST accept expression-body and block-body arrows, including nested block-body arrows, and MUST reject spread call arguments, callable references, normal or generator functions, callback arity that TypeScript permits but the serialized operator cannot execute, default/rest/computed bindings, `this`, non-arrow nested functions, and references to workflow/module lexical bindings outside callback parameters, local declarations, and nested callback parameters.
- Missing or non-callable callbacks, excess callback parameters, async callbacks, and non-`WorkflowData` callback returns MUST be reported only by TypeScript.
- Acpus authoring rules MUST allow ordinary synchronous JavaScript syntax inside expression callbacks when it does not introduce external lexical captures, including ordinary methods, nested arrows, local declarations, control flow, runtime globals such as `Math`, `JSON`, `Date`, and `undefined`, assignments, `new`, and dynamic imports. TypeScript owns callback return-type admissibility, including rejection of durable `undefined` outputs.
- Expression callback capture checks and inline task self-contained checks MUST share runtime-global detection, including rejection of workflow/module bindings that shadow globals such as `Math`, `JSON`, and `Date`.
- Acpus authoring rules MUST ignore unrelated property calls that merely share names such as `.task(...)` or `.loop(...)` unless the receiver is a direct `step("id")` call or is typed as an Acpus `StepDeclaration`.
- Graph output aliases, spreads, computed keys, callback variables, and heterogeneous branch or root returns MUST NOT be rejected solely because of source shape.
- The complete Acpus authoring diagnostic set MUST be contiguous and limited to the following current codes:

| Code | Meaning |
| --- | --- |
| `AL001` | Expr used as a JavaScript condition or with `!` |
| `AL002` | Expr used with `&&` or `||` |
| `AL003` | TypeScript-accepted Expr equality |
| `AL004` | Expr interpolated into an untagged template literal |
| `AL005` | String-typed node id derived from Expr |
| `AL006` | Expression callback source, parameter, or capture is not serializable |
| `AL007` | Explicit TypeScript `any` in the workflow entry source |
| `TB001` | Reusable task is not exported as a loadable module value |
| `TB002` | Reusable task reference or export is not a `task.define(...)` token |
| `TB003` | Inline task captures an external binding |
| `TB004` | Task callsite cannot be joined uniquely to metadata |

- Full preparation MUST compile through a worker/import path that loads
  TypeScript workflow modules and supported official `acpus/*` authoring
  facade specifiers through `@acpus/loader`.
- Repository source-mode worker bootstrap MAY use a development TypeScript
  loader only to execute the compiler's own `.ts` worker file; it MUST NOT
  encode workflow module or reusable task module loading policy.
- Check failures MUST be reported as `WorkflowPreparationError` with phase `"check"` and `DiagnosticIR[]`.
- Native TypeScript service, protocol, project, or source-invariant failures during check MUST produce a `WF002` check diagnostic and MUST NOT silently fall back to another compiler backend.
- Workflow check infrastructure diagnostics MUST use `WF001` for an unreadable workflow source and `WF002` for an unavailable or failed TypeScript 7 native analysis service.
- Module import or compile failures MUST be reported as phase `"compile"`.
- IR diagnostics containing any `severity: "error"` MUST be reported as phase `"validate"`.
- `tryPrepareWorkflow(options)` MUST return a neverthrow `ResultAsync<PreparedWorkflow, WorkflowPreparationFailure>` instead of throwing for check, compile, and validate failures.
- `WorkflowPreparationFailure` MUST include a stable `type` tag while preserving the existing `phase` field.
- Compile worker failure payloads MUST be plain JSON objects with `ok: false`, a stable `type`, and a display `message`.
- `prepareWorkflow(options)` MUST return the successful
  `tryPrepareWorkflow(options)` value or throw `WorkflowPreparationError`
  carrying the preparation failure.

### Task Analysis And Reusable References

- Task analysis MUST use parser-only static source analysis of the workflow source where source-level task callsite metadata is required.
- Parser-only task analysis MUST use an isolated TypeScript 7 project with dependency and library resolution disabled; it MUST NOT retain or expose native AST state after analysis completes.
- Task analysis MUST produce diagnostic-free facts and reusable module reference metadata only.
- Acpus authoring rules MUST own task authoring diagnostic codes, messages, and hints.
- Internal module compilation MUST consume task metadata; authoring diagnostics remain owned by the check rules.
- The analyzer MUST match direct flat inline `step("id").task({ input, exec, ... })` and reusable `step("id").task({ task, input, ... })` call sites.
- Reusable tasks MUST support direct default imports, named imports with aliases, barrel re-exports, same-file exported reusable tasks, and bare package specifiers that resolve to ESM modules at runtime.
- Reusable tasks MAY be imported from the supported official `acpus/tasks/git`
  facade subpath without a workflow-local Acpus installation.
- Reusable task metadata MUST be derived from `task.define({ inputSchema, exec })`; `inputSchema` MUST remain a config-time TypeScript type witness and MUST NOT be retained in reusable execution metadata. Reusable tasks MUST NOT require or preserve an `outputSchema` field.
- Reusable module metadata MUST identify the source-level specifier, export name, and workflow source referrer needed for runtime import.
- Reusable module metadata MUST record `exportName: "default"` for default imports, the original exported binding name for named imports even when locally aliased, and the exported workflow-module binding name for same-file task exports.
- Same-file reusable task metadata MUST identify the workflow source module and exported task name.
- Imported reusable task metadata MUST keep the workflow import specifier rather than a resolved absolute filesystem path.
- Reusable task modules MUST remain live module references; the compiler MUST NOT generate executable task artifacts from their source or dependencies.
- Package imports and barrel re-exports MUST NOT be rejected solely because they cross package or module boundaries.
- Unsupported source forms such as namespace/property access MUST produce check diagnostics when statically recognizable.
- Task callsites that cannot be joined to lowered task nodes by step id MUST produce check diagnostics rather than module descriptors.
- Inline task source MUST be preserved as a self-contained function source in the serialized IR.
- Inline task source analysis MUST read the Task step's top-level `exec` and treat its output as TypeScript-inferred, not as schema-declared metadata.
- Inline tasks that capture workflow-module scope MUST produce check diagnostics during preparation.
- Internal module compilation MUST append validation diagnostics if compiled task runs lack valid inline or reusable execution targets.
- The task authoring diagnostic set MUST use `TB001` through `TB004` exactly as defined by the current authoring diagnostic table.

### Prepared Workflow Data

- `prepareWorkflow(options)` MUST return a prepared workflow containing workflow path, `WorkflowIR`, serialized IR JSON, IR digest, source graph digest, optional package lock digest, and lock metadata.
- The IR digest MUST be a `sha256:` digest of stable pretty JSON written as `workflow.ir.json`.
- The source graph digest MUST be derived from workflow source digest and package lock digest when present.
- Package lock digest MAY be computed from `pnpm-lock.yaml`, `package-lock.json`, or `yarn.lock`.
- The lock metadata MUST use kind `acpus_workflow_preparation_lock`.
- The lock metadata MUST reference workflow entry, workflow source digest, IR digest, source graph digest, and optional package lock digest.
- Preparation lock metadata MUST be deterministic for identical workflow source, IR, and package lock inputs; it MUST NOT contain a generation timestamp.
- Workflow preparation MUST NOT write `.acpus/.local/preflight/**` artifacts.

## Verification

- Public API contract and type tests MUST cover exported preparation functions, error class, and public types.
- Integration tests MUST cover compiling TypeScript workflow modules with reusable module references, inline embedded source, and package-imported reusable tasks.
- Tests MUST cover check failure before compile, including TypeScript diagnostics converted to `DiagnosticIR` and Acpus authoring-rule diagnostics.
- Tests MUST cover TypeScript 7 native lifecycle cleanup, diagnostic-chain flattening, source locations, default-library globals, source overlays, repeated and concurrent checks, and `WF002` infrastructure failures.
- Tests MUST cover accepted unary, binary, ternary, and named-object `lift` callbacks with expression and block bodies, aliases, namespaces, globals, and ordinary methods, plus rejected captures, spread arguments, callable references, insufficient callback parameters, invalid bindings, and function expressions.
- Type tests MUST cover durable workflow, Task, and composite outputs, heterogeneous branch/root unions, loop consistency, `JsonValue`/`JsonObject`, and `unknown`/`any` rejection.
- Authoring-rule tests MUST cover only source-level invariants, MUST assert the
  exact contiguous `AL001`-`AL007` and `TB001`-`TB004` sets, and MUST verify
  that type-owned diagnostics are not emitted as Acpus authoring diagnostics.
- Tests MUST cover validation failure after compile.
- Tests MUST cover task analysis facts and metadata for imported reusable tasks, exported same-file reusable tasks, package imports, re-exported reusable tasks, unsupported task callsite forms, and inline tasks that capture workflow-module scope.
- Tests MUST cover stable reusable task reference metadata across compiles.
- Tests MUST cover same-file reusable task references without rerunning workflow build callbacks at task execution time.
- Tests MUST cover in-memory prepared workflow data, lock shape, IR digest, and source graph digest without task code artifact files.
