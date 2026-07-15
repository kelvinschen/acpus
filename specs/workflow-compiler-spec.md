# Workflow Compiler Spec

## Purpose

`@acpus/workflow-compiler` prepares TypeScript workflow modules for runtime admission and static visualization. It delegates module loading to the [Loader](loader-spec.md), workflow lowering and IR validation to [Core](core-spec.md), and expression semantics to [Expression](expression-spec.md); it owns static authoring checks, task callsite analysis, reusable task references, and in-memory prepared workflow data.

## Requirements

### Public API

- The package MUST expose `prepareWorkflow(options)`.
- The package MUST expose `tryPrepareWorkflow(options)`.
- The package MUST expose `extractWorkflowMetadata(source, fileName)` as a `ResultAsync<WorkflowMetadata, WorkflowMetadataError>` static-analysis API.
- The package MUST expose `WorkflowPreparationError` and public preparation, lock, and failure types.
- The package MUST NOT expose a public preflight artifact writer.
- The package MUST NOT expose a binary.

### Static Workflow Metadata

- `extractWorkflowMetadata` MUST use the repository-pinned TypeScript compiler API and MUST NOT import or execute the analyzed module.
- Metadata extraction MUST accept `defineWorkflow` named imports and aliases, plus namespace imports, from `acpus/core` and `@acpus/core`.
- Metadata extraction MUST locate a direct default export of `defineWorkflow(...).build(...)` or a default export that refers to one unambiguous top-level `const` initialized with that expression. A module MUST have exactly one default export.
- Metadata extraction MUST require the workflow config to be an object literal and the final `name` value, after evaluating properties in source order, to be a direct string literal or no-substitution template literal.
- A spread, nonliteral `name`, or statically unknown computed property after the last known literal MUST make the name non-static; a later direct literal `name` MUST establish the final static value.
- Syntax errors, missing default exports, ambiguous or unsupported workflow expressions, non-static names, and TypeScript analysis failures MUST return stable tagged metadata errors.
- Metadata results and failures MUST NOT expose native TypeScript project, AST, symbol, type, or node objects.

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
- The TypeScript check MUST use the sole repository-pinned [TypeScript implementation](build-toolchain-spec.md).
- TypeScript 7 programmatic access MUST be isolated behind the package-internal workflow-analysis implementation boundary. Native API, project, snapshot, program, checker, AST, symbol, type, and node-handle values MAY be shared only among that boundary's check and task-analysis implementation files and MUST NOT appear in the package entrypoint, public types, domain results, IR, events, or worker JSON.
- The TypeScript 7 native API version MUST be pinned exactly.
- Every native analysis snapshot MUST be disposed on success and failure.
- Every short-lived native API instance MUST be closed on success and failure.
- Normal TypeScript 7 native shutdown MUST close the service input and await clean process exit before releasing the API; successful workflow checks MUST NOT emit native shutdown noise on process stderr.
- The TypeScript check MUST use a scratch tsconfig with NodeNext module resolution and no emit.
- The TypeScript check MUST keep the scratch tsconfig self-contained to the workflow entry and its import graph; it MUST NOT inherit host `tsconfig.json` `files`, `include`, or project references.
- The TypeScript check MUST obtain supported official facade paths and the workspace-source flag from the [Loader](loader-spec.md).
- When the Loader reports workspace-source facade targets, the TypeScript check MUST enable the `development` condition needed to consume them.
- Published installs MUST rely on normal package resolution for non-Acpus dependencies.
- The check phase MUST run only the TypeScript compiler and Acpus-owned checks; it MUST NOT load user or editor lint configuration or third-party rule presets.
- Public TypeScript types MUST own every authoring constraint expressible by the type system; the check phase retains their native `TS####` diagnostic, may add one high-confidence repair hint, and emits no duplicate AL diagnostic for the same source range.
- An unresolved direct `lift(...)` call MUST retain `TS2304` with a hint to import `lift` from `acpus/expression`. `TS7006` diagnostics on that call's direct arrow-callback parameters MUST be suppressed as causal fallout only for the legal two-to-four total argument forms whose callback parameter count equals the dependency count; invalid arity, callback-count mismatches, and `TS7006` elsewhere MUST remain unchanged.
- An unsupported Expr operator or control form accepted by TypeScript MUST produce its owning Acpus diagnostic.
- The check phase MUST report one `AL007` error for every TypeScript `AnyKeyword` in the workflow entry source file, including annotations, assertions, arrays, generic arguments/defaults, return types, `keyof any`, rest parameters, and nested inline Task or expression callback bodies.
- `AL007` MUST use message `Explicit 'any' is not allowed in Acpus workflow authoring.` and hint `Use a precise type, or use unknown and narrow it before crossing an Acpus boundary.`
- `AL007` MUST NOT scan imported helper modules, read lint configuration, support suppression/configuration/autofix, or invoke ESLint.
- Acpus authoring rules MUST reject `Expr` values in JavaScript truthiness positions, JavaScript `switch`, `!`, `&&`, `||`, `??`, TypeScript-accepted equality and relational operators, untagged template interpolation containing `Expr`, string-typed node ids derived from Expr values, invalid callback source forms, invalid task authoring shapes, and task callsites that cannot be joined to task metadata.
- Expr repair hints MUST map graph control to graph `if`/`switch`, boolean and comparison expressions to their named helpers, and general value computation to `lift`.
- `AL005` MUST explain static step ids versus dynamic `nodeKey` only inside loop or fanout callbacks; elsewhere it asks for a compile-time literal id.
- An Expr-derived template used directly as a step id MUST produce only `AL005`; other untagged templates and non-literal Task ids retain their owning diagnostics.
- Expr array properties and methods, direct non-string node ids, callback output types, and other type-expressible failures MUST remain native TypeScript diagnostics, with an Acpus hint only when declaration provenance and AST/type context identify one unambiguous repair. Returning a top-level `Expr` from a workflow or composite callback MUST remain valid and MUST NOT receive a named-field diagnostic.
- TypeScript hint enrichment MUST cover Expr arithmetic through `lift`, equality and relational operators through their predicate helpers, JavaScript switch through graph switch, NodeRef property access through `.output`, Expr array operations through `lift`, heterogeneous branch fields through `lift` narrowing, NodeRef graph callback outputs through returning `.output`, and non-WorkflowData `lift` or Task callback outputs through JSON-compatible data guidance. An ordinary TypeScript diagnostic with the same code MUST remain unchanged when those predicates do not hold.
- A heterogeneous-branch `TS2339` hint MUST require an official Expr payload union where the requested field exists on some object variants but not all. A `TS2339` on an officially branded poisoned NodeRef producer output MUST instead direct the author to fix the producer first; a valid `NodeRef<unknown>` output MUST NOT receive that hint. Other Expr property failures MUST NOT receive either hint.
- A loop-transition `TS2322` MAY add a state-widening hint only on the transition callback's own mismatch span when resolved loop provenance and types identify a mismatching initial literal, `null`, or empty-array `never` value. Official Expr payloads MUST participate in that type comparison; traversal MUST be bounded and omit the hint when it cannot reach a high-confidence result. An unrelated `TS2322`, including one inside the same callback body, MUST remain unchanged.
- Expr, NodeRef, StepFactory, StepDeclaration, and `task.define` identity MUST be established from resolved declaration provenance under the realpath-aware official core or expression package root supplied by `@acpus/loader`. A structural `__ir` property, an alias name, a same-name user type, or an unrelated `step`/`.task` member MUST NOT establish Acpus identity. Supported facade aliases, namespaces, and shadowed-binding behavior MUST remain symbol-aware.
- Acpus authoring rules MUST inspect only `lift` calls imported from the supported `acpus/expression` facade, including named aliases, namespace property access, and string-literal namespace element access; transparent parentheses, type assertions, non-null assertions, and `satisfies` expressions around those callees or namespace receivers MUST NOT bypass inspection, while imports from internal implementation packages and shadowed bindings MUST NOT be treated as facade calls.
- For legal two-, three-, and four-argument `lift` calls, Acpus authoring rules MUST locate the final argument as the callback and MUST report both the explicit dependency count and declared callback parameter count when they differ; a named object is one structured dependency and therefore has one destructured callback parameter.
- Acpus authoring rules MUST accept expression-body and block-body arrows, including nested block-body arrows, and MUST reject spread call arguments, callable references, normal or generator functions, callback arity that TypeScript permits but the serialized operator cannot execute, default/rest/computed bindings, `this`, non-arrow nested functions, and references to workflow/module lexical bindings outside callback parameters, local declarations, and nested callback parameters.
- Missing or non-callable callbacks, unsupported call arity, async callbacks, and non-`WorkflowData` callback returns MUST be reported only by TypeScript.
- Acpus authoring rules MUST allow ordinary synchronous JavaScript syntax inside expression callbacks when it does not introduce external lexical captures, including ordinary methods, nested arrows, local declarations, control flow, runtime globals such as `Math`, `JSON`, `Date`, and `undefined`, assignments, `new`, and dynamic imports. TypeScript owns callback return-type admissibility, including rejection of durable `undefined` outputs.
- Expression callback capture checks and inline task self-contained checks MUST share runtime-global detection, including rejection of workflow/module bindings that shadow globals such as `Math`, `JSON`, and `Date`.
- Acpus authoring rules MUST ignore unrelated property calls that merely share names such as `.task(...)` or `.loop(...)`; a direct call MUST resolve from the official StepFactory and a saved receiver MUST resolve to the official StepDeclaration.
- Graph output aliases, spreads, computed keys, callback variables, and heterogeneous branch or root returns MUST NOT be rejected solely because of source shape.
- The complete Acpus authoring diagnostic set MUST be contiguous and limited to the following current codes:

| Code | Meaning |
| --- | --- |
| `AL001` | Expr used as JavaScript condition/switch control or with `!` |
| `AL002` | Expr used with `&&`, `||`, or `??` |
| `AL003` | TypeScript-accepted Expr equality or relational operator |
| `AL004` | Expr interpolated into an untagged template literal |
| `AL005` | String-typed node id derived from Expr |
| `AL006` | Expression callback source, parameter, or capture is not serializable |
| `AL007` | Explicit TypeScript `any` in the workflow entry source |
| `TB001` | Reusable task is not exported as a loadable module value |
| `TB002` | Reusable task reference or export is not a `task.define(...)` token |
| `TB003` | Inline task captures an external binding |
| `TB004` | Task callsite cannot be joined uniquely to metadata |

- Diagnostic origin, source offsets, ownership, and original sequence MUST remain package-private candidate metadata and MUST NOT be added to `DiagnosticIR`, preparation JSON, worker JSON, or CLI JSON.
- Diagnostic normalization MUST order config, program, global, and syntactic TypeScript categories first; then entry-file semantic TypeScript and AL/TB diagnostics by source position; then imported semantic diagnostics by lexical file name and source position. A raw non-empty TypeScript span that contains another same-file diagnostic MUST follow the contained diagnostic, while a standalone raw diagnostic MUST retain normal source order.
- Exact deduplication MUST compare all user-visible diagnostic fields: code, severity, message, path, source file/line/column, and hint. Diagnostics at different source locations MUST NOT be merged, and ordering or cascade classification MUST NOT depend on diagnostic message text, `never`, `CheckedBuildFn`, or another internal type name.

- Full preparation MUST compile through a worker/import path that loads TypeScript workflow modules and supported official `acpus/*` authoring facade specifiers through `@acpus/loader`.
- Repository source-mode worker bootstrap MAY use a development TypeScript loader only to execute the compiler's own `.ts` worker file; it MUST NOT encode workflow module or reusable task module loading policy.
- Check failures MUST be reported as `WorkflowPreparationError` with phase `"check"` and `DiagnosticIR[]`.
- Native TypeScript service, protocol, project, or source-invariant failures during check MUST produce a `WF002` check diagnostic and MUST NOT silently fall back to another compiler backend.
- Workflow check infrastructure diagnostics MUST use `WF001` for an unreadable workflow source and `WF002` for an unavailable or failed TypeScript 7 native analysis service.
- Module import or compile failures MUST be reported as phase `"compile"`.
- IR diagnostics containing any `severity: "error"` MUST be reported as phase `"validate"`.
- `tryPrepareWorkflow(options)` MUST return a neverthrow `ResultAsync<PreparedWorkflow, WorkflowPreparationFailure>` instead of throwing for check, compile, and validate failures.
- `WorkflowPreparationFailure` MUST include a stable `type` tag while preserving the existing `phase` field.
- Compile worker failure payloads MUST be plain JSON objects with `ok: false`, a stable `type`, and a display `message`.
- `prepareWorkflow(options)` MUST return the successful `tryPrepareWorkflow(options)` value or throw `WorkflowPreparationError` carrying the preparation failure.

### Task Analysis And Reusable References

- Task analysis MUST use parser-only static source analysis of the workflow source where source-level task callsite metadata is required.
- Parser-only task analysis MUST use an isolated TypeScript 7 project with dependency and library resolution disabled; it MUST NOT retain or expose native AST state after analysis completes.
- Task analysis MUST produce diagnostic-free facts and reusable module reference metadata only.
- Acpus authoring rules MUST own task authoring diagnostic codes, messages, and hints.
- Internal module compilation MUST consume task metadata; authoring diagnostics remain owned by the check rules.
- The analyzer MUST match direct flat inline `step("id").task({ input, exec, ... })` and reusable `step("id").task({ task, input, ... })` call sites.
- Reusable tasks MUST support direct default imports, named imports with aliases, barrel re-exports, same-file exported reusable tasks, and bare package specifiers that resolve to ESM modules at runtime.
- Reusable task analysis MUST consume the [Core-owned Task token contract](core-spec.md#task-authoring-and-runtime-context-types) and retain only compiler-owned module-reference metadata.
- Reusable module metadata MUST identify the source-level specifier, export name, and workflow source referrer needed for runtime import.
- Reusable module metadata MUST record `exportName: "default"` for default imports, the original exported binding name for named imports even when locally aliased, and the exported workflow-module binding name for same-file task exports.
- Same-file reusable task metadata MUST identify the workflow source module and exported task name.
- Imported reusable task metadata MUST keep the workflow import specifier rather than a resolved absolute filesystem path.
- Reusable task modules MUST remain live module references; the compiler MUST NOT generate executable task artifacts from their source or dependencies.
- Package imports and barrel re-exports MUST NOT be rejected solely because they cross package or module boundaries.
- Unsupported source forms such as namespace/property access MUST produce check diagnostics when statically recognizable.
- Task callsites that cannot be joined to lowered task nodes by step id MUST produce check diagnostics rather than module descriptors.
- Inline task source MUST be preserved as a self-contained function source in the serialized IR.
- Inline tasks that capture workflow-module scope MUST produce check diagnostics during preparation.
- Reusable Task reference classification MUST resolve the nearest visible value declaration. A non-exported or nested official `task.define(...)` value MUST produce `TB001`; an ordinary local value, shadowed fake `task.define`, or non-Task token MUST produce `TB002`.
- Inline Task capture analysis MUST emit one diagnostic per Task with sorted unique names, the earliest offending source identifier, and a hint to pass values through top-level `input`.
- Duplicate Task ids MUST retain the first and repeated callsite positions internally. `TB004` MUST point at the repeated declaration and include the first declaration's line and column in its hint without extending `DiagnosticIR`.
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

- Contract and integration tests cover metadata extraction, phase ordering, prepared workflow data, deterministic locks/digests, and tagged failures.
- Authoring-rule tests cover diagnostic ownership, declaration provenance, callback serialization, `any` rejection, stable ordering, and metadata boundaries.
- Task-analysis tests cover inline capture, reusable references, stable module metadata, unsupported callsites, and validation backstops.
