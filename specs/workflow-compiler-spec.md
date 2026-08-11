# Workflow Compiler Spec

## Purpose

`@acpus/workflow-compiler` prepares TypeScript workflow modules for runtime admission and static visualization. It delegates module loading to the [Loader](loader-spec.md), workflow lowering and IR validation to [Core](core-spec.md), and expression semantics to [Expression](expression-spec.md); it owns static authoring checks, task callsite analysis, reusable task references, and in-memory prepared workflow data.

## Requirements

### Public API

- The package MUST expose `prepareWorkflow(options)`.
- The package MUST expose `tryPrepareWorkflow(options)`.
- The package MUST expose `extractWorkflowMetadata(source, fileName)` as a `ResultAsync<WorkflowMetadata, WorkflowMetadataError>` static-analysis API.
- The package MUST expose `WorkflowPreparationError` and public preparation, lock, and failure types.
- The package MUST expose the canonical Core `Sha256Digest` type alongside `WorkflowSourceFile`, `WorkflowSourceInput`, `WorkflowSourceRef`, and `WorkflowSourceBundle`.
- The package MUST expose `CompileWorkerFailure` and `PackageLockFailure` as public failure types without exposing the worker process entrypoint.
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
- Before importing the workflow module, internal module compilation MUST verify its physical source-root containment and compare the digest of its entry source text with the digest produced by the check phase.
- When those digests differ, internal module compilation MUST return a serializable `workflow-source-changed` failure without importing the workflow module.
- After importing and verifying the workflow definition, internal module compilation MUST analyze Task call sites before invoking the workflow build callback.
- An otherwise successful internal module compilation MUST read the entry source text again before returning and MUST return `workflow-source-changed` when its digest no longer matches the checked digest.
- The compile-worker source-generation fence applies to the frozen workflow entry text; snapshot preparation separately freezes and verifies the supported local static module graph before invoking the worker.
- Recoverable internal module compilation failures MUST use a serializable tagged union covering source read failure, source-generation change, module import failure, invalid default export, workflow build/lowering failure, task analysis failure, and workflow path outside its source root.
- Internal module compilation MUST convert reusable-Task source facts into one immutable Core link plan and lower through `tryCompileWorkflowDefinition(...)`.
- Task-analysis and source-containment failures MUST therefore take precedence over failures thrown by the workflow build callback.
- Internal module compilation MUST return the checked `sha256:` source digest alongside the compiled IR without embedding it in `WorkflowIR`.
- Core MUST construct complete reusable Task targets and append `validateWorkflowIR(...)` diagnostics exactly once before internal module compilation returns `WorkflowIR`.
- Internal module compilation MUST NOT traverse or mutate a Core-produced `WorkflowIR` to attach source metadata or validation diagnostics.
- Scope-ref legality diagnostics MUST come from `validateWorkflowIR(...)` so module compilation, `workflow check`, preparation, and runtime admission share the same backstop for malformed or hand-authored IR.
- Internal module compilation MUST NOT run the preparation check phase itself.

### Static Check And Worker Import

- `prepareWorkflow(options)` MUST run `check`, then `compile`, then `validate`.
- The check phase MUST aggregate stable TypeScript compiler diagnostics and Acpus authoring-rule diagnostics as `DiagnosticIR`.
- The check phase MUST compute a `sha256:` digest from the same workflow entry source text supplied to the TypeScript check, and preparation MUST pass that digest to the compile worker.
- TypeScript diagnostics MUST use existing `DiagnosticIR` fields with `code: "TS####"`, flattened `message`, and `source` file, line, and column when available.
- The TypeScript check MUST use the sole repository-pinned [TypeScript implementation](build-toolchain-spec.md).
- TypeScript 7 programmatic access MUST be isolated behind the package-internal workflow-analysis implementation boundary. Native API, project, snapshot, program, checker, AST, symbol, type, and node-handle values MAY be shared only among that boundary's check and task-analysis implementation files and MUST NOT appear in the package entrypoint, public types, domain results, IR, events, or worker JSON.
- The TypeScript 7 native API version MUST be pinned exactly.
- Every native analysis snapshot MUST be disposed on success and failure.
- Every short-lived native API instance MUST be closed on success and failure.
- Normal TypeScript 7 native shutdown MUST close the service input and await clean process exit before releasing the API; successful workflow checks MUST NOT emit native shutdown noise on process stderr.
- The TypeScript check MUST use a scratch tsconfig with NodeNext module resolution and no emit.
- The TypeScript check MUST keep the scratch tsconfig self-contained to the workflow entry and its import graph; it MUST NOT inherit host `tsconfig.json` `files`, `include`, or project references.
- For an entry outside the workspace, TypeScript dependency resolution MUST use `workspaceDir/node_modules` as the fallback authority without creating a `node_modules` entry beside the caller's source.
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
- An `AL006` external-binding hint MUST tell authors to pass runtime values as explicit dependencies and apply helpers outside `lift` instead of passing them as dependencies.
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
- The check phase MUST emit `SC001` as a non-blocking warning at each statically recognizable module load outside the tracked source graph, including nonliteral dynamic imports, relative `require`, `createRequire`, absolute or `file:` loads, local modules represented only by declarations, and static local imports that resolve to an unsupported source format.
- `require` and `createRequire` warning recognition MUST follow binding provenance. An aliased `createRequire` imported from `node:module` or `module` MUST be recognized, while a user-defined binding that merely has either name MUST NOT be treated as a runtime loader.
- A local declaration file reached by a static edge MUST remain in the checked source graph and snapshot bundle as TypeScript checking support while retaining its `SC001` warning. A statically resolved unsupported local source file MUST produce `SC001` without being traversed or added to the source graph.
- Successful preparation MUST merge non-blocking check diagnostics into the returned `WorkflowIR.diagnostics` without duplicating an identical compiler diagnostic.

- Full preparation MUST compile through a worker/import path that loads TypeScript workflow modules and supported official `acpus/*` authoring facade specifiers through `@acpus/loader`.
- The internal `compileWorkflow(...)` boundary MUST return `ResultAsync<CompiledWorkflowModule, CompileWorkerFailure>` for recoverable worker, protocol, and module failures.
- The compile worker MUST require the checked source digest as an input and MUST retain `workflow-source-changed` as a compile-phase failure.
- The compile worker wire envelope MUST be exactly `{ schemaVersion: 1, ok: true, result }` or `{ schemaVersion: 1, ok: false, error }`.
- The compile worker parent MUST validate the envelope version, discriminant, top-level result shape, source digest format and equality with the checked digest, error tag, and process-exit consistency before consuming it.
- The compile worker parent MUST reject a success result when Core validation reports that its serialized `WorkflowIR.diagnostics` subtree is malformed.
- The compile worker parent MUST reject a success result when any Core `validateWorkflowIR(...)` finding is absent from its serialized `WorkflowIR.diagnostics`.
- Worker spawn, unsuccessful exit without a result, result read, invalid JSON, invalid result, and worker-system failures MUST retain distinct stable failure tags.
- A nonzero worker exit MAY become `worker-exit-failed` after result reading only when the result path is absent by `ENOENT` or `ENOTDIR`; permission, I/O, directory, and all other read errors MUST remain `worker-result-read-failed` with their path and error code.
- Compiler worker stdout and stderr retained in operational failures MUST be bounded tails.
- Repository source-mode worker bootstrap MAY use a development TypeScript loader only to execute the compiler's own `.ts` worker file; it MUST NOT encode workflow module or reusable task module loading policy.
- Check failures MUST be reported as `WorkflowPreparationError` with phase `"check"` and `DiagnosticIR[]`.
- Native TypeScript service, protocol, project, or source-invariant failures during check MUST produce a `WF002` check diagnostic and MUST NOT silently fall back to another compiler backend.
- Workflow check infrastructure diagnostics MUST use `WF001` for an unreadable workflow source and `WF002` for an unavailable or failed TypeScript 7 native analysis service.
- Module import or compile failures MUST be reported as phase `"compile"`.
- IR diagnostics containing any `severity: "error"` MUST be reported as phase `"validate"`.
- `tryPrepareWorkflow(options)` MUST return a neverthrow `ResultAsync<PreparedWorkflow, WorkflowPreparationFailure>` instead of throwing for check, compile, package-lock read, and validate failures.
- `WorkflowPreparationFailure` MUST include a stable `type` tag while preserving the existing `phase` field.
- A compile-phase `WorkflowPreparationFailure` MUST retain its typed `CompileWorkerFailure`.
- A package-lock read failure MUST use type `package-lock-read-failed` and phase `lock`.
- Compile worker failure payloads MUST be plain JSON objects and MUST NOT serialize neverthrow values.
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
- Reusable module metadata MUST identify the source-level specifier and export name; the compiler MUST combine those facts with one source-root-relative workflow referrer in the Core link plan needed for runtime import.
- Reusable module metadata MUST record `exportName: "default"` for default imports, the original exported binding name for named imports even when locally aliased, and the exported workflow-module binding name for same-file task exports.
- Same-file reusable task metadata MUST identify the workflow source module and exported task name.
- Imported reusable task metadata MUST keep the workflow import specifier rather than a resolved absolute filesystem path.
- Workspace reusable task modules MUST remain live module references.
- Snapshot preparation MUST include a reusable task module reached through a supported local static import and its supported local static dependencies in the source bundle.
- Bare-package reusable tasks and dependencies MUST remain environment-provided references and MUST NOT be included in a source bundle.
- Package imports and barrel re-exports MUST NOT be rejected solely because they cross package or module boundaries.
- Unsupported source forms such as namespace/property access MUST produce check diagnostics when statically recognizable.
- Task callsites that cannot be joined to lowered task nodes by step id MUST produce check diagnostics rather than module descriptors.
- Inline task source MUST be preserved as a self-contained function source in the serialized IR.
- Inline tasks that capture workflow-module scope MUST produce check diagnostics during preparation.
- Reusable Task reference classification MUST resolve the nearest visible value declaration. A non-exported or nested official `task.define(...)` value MUST produce `TB001`; an ordinary local value, shadowed fake `task.define`, or non-Task token MUST produce `TB002`.
- Inline Task capture analysis MUST emit one diagnostic per Task with sorted unique names and the earliest offending source identifier.
- A `TB003` hint MUST direct captured data through Task input and helper logic inside `exec` or a reusable Task.
- Duplicate Task ids MUST retain the first and repeated callsite positions internally. `TB004` MUST point at the repeated declaration and include the first declaration's line and column in its hint without extending `DiagnosticIR`.
- Internal module compilation MUST fail as workflow lowering when an actually declared reusable Task cannot be joined to a complete source link; it MUST NOT return a `WorkflowIR` containing an empty execution target.
- The task authoring diagnostic set MUST use `TB001` through `TB004` exactly as defined by the current authoring diagnostic table.

### Prepared Workflow Data

- `WorkflowPreparationOptions` MUST use the following closed input shape.

```ts
type WorkflowPreparationOptions = {
  workspaceDir: string;
  source:
    | { kind: "path"; entry: string }
    | { kind: "files"; entry: string; files: readonly WorkflowSourceFile[] };
};
```

- A path entry MAY be absolute or relative to `workspaceDir`.
- An existing path physically contained by `workspaceDir` MUST produce a live workspace source.
- A path outside `workspaceDir` MUST produce a captured snapshot source.
- `workspaceDir` MUST remain the workflow cwd and bare-package dependency authority for both source kinds.
- A files-input path MUST be a non-empty portable POSIX relative path with no absolute prefix, drive prefix, NUL, backslash, empty segment, `.` segment, or `..` segment.
- Files input MUST reject duplicate paths, file/directory-prefix collisions, and NFC-plus-case-fold-equivalent segment collisions.
- A files-input entry MUST identify exactly one supplied file.
- Preparation MUST retain every supplied files-input file in the canonical bundle and source-graph digest, including a file not reached from the entry.

- `WorkflowSourceRef` and `WorkflowSourceBundle` MUST use these closed shapes.

```ts
type WorkflowSourceRef =
  | { kind: "workspace"; entry: string }
  | { kind: "snapshot"; entry: string; digest: Sha256Digest };

type WorkflowSourceBundle = {
  kind: "acpus_workflow_source_bundle";
  version: 1;
  files: readonly { path: string; content: string }[];
};
```

- Snapshot path discovery MUST follow static relative imports and re-exports, literal relative `import()`, local `#imports`, reusable Task modules, and their supported local TypeScript dependencies, including declaration files used for checking.
- Snapshot path discovery MUST stop at bare packages, official Acpus facades, `node:`, and `data:` dependencies.
- Snapshot path discovery MUST warn and stop at a static local edge whose resolved implementation is not a supported TypeScript source file.
- Snapshot path discovery MUST include each nearest `package.json` that affects a captured module's NodeNext semantics.
- Snapshot projection MUST use the captured TypeScript files' common ancestor as its canonical root. When a captured source actually uses a local `#imports` target, projection MUST instead retain that target's package-root-relative layout; otherwise an affecting ancestor manifest above the canonical root MUST be projected as root `package.json` so unrelated physical parent segments do not enter source identity.
- Relative static imports MAY cross entry-parent directories; preparation MUST derive one internal common ancestor and project only captured files beneath it.
- Snapshot path capture MUST reject symlinks, hard links, special files, non-UTF-8 content, path collisions, and a file that changes between TypeScript discovery and stable capture. Valid UTF-8 content, including an initial byte-order mark, MUST be preserved exactly.
- Preparation MUST rerun authoritative check and compilation from a private materialization of the captured bundle.
- A supported local module discovered only after materialization, or a previously discovered module that disappears, MUST fail with type `source-changed` and phase `source`.
- A snapshot source reference, source bundle, preparation lock, and source-graph digest payload MUST NOT encode the original external physical root or the physical common-ancestor path.
- Compiler scratch and private materialization paths, including their `file:` URL forms, MUST NOT appear in a public prepared result, diagnostic, or typed preparation failure.
- A snapshot IR value that retains the private materialization path MUST fail with type `source-invalid` and phase `source` before preparation returns either a prepared workflow or a validation failure.

- Bundle files MUST be sorted by locale-independent path code-unit order.
- Source-file content digests and `sourceGraphDigest` MUST use the canonical [Core content identity](core-spec.md#content-identity) contract.
- The source-graph inventory MUST contain the path-sorted prepared files and MUST contain no absolute paths, mtimes, modes, source roots, or package-lock data.
- A snapshot source digest MUST equal its prepared `sourceGraphDigest`.
- A workspace source graph MUST use paths relative to `workspaceDir` and the same digest payload without returning a bundle. A supported local static source or affecting nearest package manifest outside `workspaceDir` MUST remain live and use a leading `../` path; a path on a different volume that cannot be represented relative to `workspaceDir` MUST fail with type `source-invalid` and phase `source`.
- `PreparedWorkflow` MUST be a closed union in which workspace sources have no `sourceBundle` and snapshot sources require the matching inline `sourceBundle`.
- The IR digest MUST be a `sha256:` digest of stable pretty JSON written as `workflow.ir.json`.
- Package lock digest MAY be computed from `pnpm-lock.yaml`, `package-lock.json`, or `yarn.lock`.
- Package lock digest MUST remain optional environment metadata and MUST NOT affect source-graph or source-reference identity.
- Package lock discovery MUST continue to the next candidate only when the current path fails with `ENOENT` or `ENOTDIR`.
- An unreadable package lock, directory in place of a lockfile, or symlink-resolution failure MUST return `PackageLockFailure` rather than being treated as absence.
- Lock metadata MUST use kind `acpus_workflow_preparation_lock`, version `2`, and workflow fields `{ source, entryDigest }`.
- Lock metadata MUST reference the IR digest, source graph digest, and optional package lock digest.
- Preparation lock metadata MUST be deterministic for identical workflow source, IR, and package lock inputs; it MUST NOT contain a generation timestamp.
- Workflow preparation scratch data MUST use a private system temporary directory.
- Workflow preparation MUST remove its scratch data after success or failure.
- Workflow preparation MUST NOT create an Acpus runtime shard.

## Verification

- Unit, type-contract, and integration tests cover compile-worker protocol validation, metadata extraction, path/files inputs, portable path rejection, hard-link and invalid-UTF-8 rejection, BOM preservation, sparse static closure capture, declaration support, loader-binding provenance, unsupported static targets, external dependency authority, `SC001`, source-generation fencing, location-independent canonical bundles and digests, live sources outside the workspace, lock v2, scratch cleanup and path redaction, and tagged failures.
- Authoring-rule tests cover diagnostic ownership, declaration provenance, callback serialization, `any` rejection, stable ordering, and metadata boundaries.
- Task-analysis tests cover inline capture, reusable references, stable module metadata, unsupported callsites, and validation backstops.
