# @acpus/expression

## 0.2.0

### Minor Changes

- 625cae9: Restore frozen functions through one serialized-function environment so lift
  callbacks and inline Tasks support compiler-emitted name helpers consistently.
  Expose persisted root-frame failures in inspection summaries and surface direct
  run-level failures in overview Attention and text follow output.

### Patch Changes

- 7e65dee: Make Core boundary failures deterministic and accurately observable:

  - report the zx-rendered command for array and complex Task command interpolation;
  - return `invalid-default` for cyclic or uncloneable Zod defaults instead of
    throwing, while using native structured-clone semantics for shared values;
  - preserve own object-map fields named `__proto__` throughout Core lowering
    instead of treating them as prototype mutation;
  - reject POSIX, Windows drive-relative, rooted, UNC, and device paths wherever
    reusable Task referrers require a portable workspace-relative path;
  - reject unknown workflow reference roots, unknown run metadata fields, and
    malformed values in otherwise allowed frozen-IR fields; and
  - inspect schemas only through the supported Zod 4 `def`, `type`, and
    `description` interfaces.

  Classify structured agent configuration failures by JSON-RPC code rather than
  by the command that emitted them: numeric or string `-32602` remains `config`,
  while every other structured JSON-RPC failure is now `provider_exit`.
  Unstructured rejected configuration commands remain `config`.

  Make reusable Task compilation produce complete IR in one pass:

  - accept source links before Core graph construction instead of publishing
    empty module targets for the compiler to mutate afterward;
  - accept the shared reusable-Task referrer as one path fact instead of an
    input object shaped like the eventual IR descriptor;
  - return typed Core compilation failures for missing or invalid reusable Task
    links, including when ordinary IR validation is disabled;
  - fail malformed Task specs instead of returning an empty inline executable;
  - retain ordinary build/lowering causes in the typed failure while preserving
    the throwing convenience API's original exception identity; and
  - run compiler Task analysis and source-containment checks before invoking the
    workflow build callback. Successful compiled IR and runtime behavior are
    unchanged.

  Make expression graph boundaries total and preserve authored data:

  - return tagged lowering failures for cyclic or uninspectable values instead of
    leaking recursion or Proxy trap exceptions;
  - reject cyclic callback inputs with `ExpressionEvaluationError` and use native
    structured cloning, which preserves shared-reference identity while
    isolating callback mutation;
  - preserve ordinary object fields named `__proto__` during lowering and
    evaluation; and
  - validate missing and non-JSON template values before an adapter formatter can
    handle them.

  Resolve lazy bare imports from overlapping authoring source roots through the
  most specific registered dependency authority, independent of registration
  order, and propagate symlink-loop or I/O failures while canonicalizing an
  authority instead of treating them as a missing path.

  Reject self-consistent but structurally invalid prepared workflow IR before
  Runtime admission or fork mutation. Core validator errors and pre-existing
  error diagnostics now return the typed `invalid-ir` preparation failure;
  warning-only IR remains admissible.

  Preserve an authored Task input field named `__proto__` as ordinary own
  WorkflowData instead of silently installing it as the temporary input object's
  prototype and dropping it before execution.

  Make prepared workflow source identity single-owned:

  - preparation inputs identify a workspace or global catalog but no longer
    repeat the workflow entry;
  - CLI catalog resolution carries that input identity directly instead of
    constructing an entry that its preparation adapter immediately discarded;
  - the compiler derives the portable entry from the workflow path and selected
    source root exactly once;
  - missing global roots, inconsistent workspace roots, and workflow paths
    lexically outside the selected root now fail before check or compilation
    with the typed `source-invalid` failure;
  - existing workflow symlinks that resolve outside the selected source root are
    rejected in the same source phase before source checking or execution;
  - contained workflow names beginning with `..` remain valid unless `..` is an
    actual parent path segment; and
  - CLI and Web workflow-visualization output expose the corresponding `source`
    phase as part of their closed result unions.

  Restrict the followed workflow run NDJSON admission record to the public `RunRecord`
  projection. This removes previously exposed normalized input, Agent overrides,
  hook history, execution state, dynamic details, and internal event/node counts;
  subsequent follow records are unchanged.

- f5ee270: Allow inline and reusable Tasks to receive any durable value directly while
  preserving precise materialized input types. Lower and execute Task input as one
  expression, expose its complete authored shape in workflow visualization, and
  accept interface-shaped durable results from `lift`.

  Advance frozen workflow IR and Runtime storage generations so existing
  generation isolation rejects the previous Task-input representation without a
  compatibility shim.

## 0.1.1

### Patch Changes

- 93560c5: Support Node.js 22.18+ within the Node.js 22 line and Node.js 24 or newer. Acpus-triggered SQLite initialization now suppresses only Node.js's SQLite experimental warning, leaving unrelated warnings visible.

## 0.1.0

### Minor Changes

- e3a75f4: Model every executable scope as one arbitrary WorkflowData output expression in
  IR v5, preserve composite aggregation envelopes, and expose syntax-derived
  output shape across runtime, CLI, and Web inspection.
- b8fef84: Add arithmetic and string join expression helpers, clarify workflow check node count text, and expand the Acpus authoring skill reference.
- c1f09ae: Add strict scalar comparison, numeric comparison, and boolean predicate helpers over the existing expression callback primitives.
- cd35e5b: Release the TypeScript-first Acpus package graph with the CLI, authoring
  facades, compiler, durable runtime, task library, and Web inspector aligned on
  the same public dependency contract.
- 108d06e: Align the package graph so runtime consumers resolve an
  `@acpus/expression/ir` entrypoint that exports `isJsonValue`.
- 6ef7549: Replace the broad expression helper algebra with `fmap`, `lift2`, `lift3`, `lift`, `template`, and `md`, including expression and bounded block callback authoring checks, runtime guards, and updated Acpus authoring references.
- c14e800: Unify expression callbacks behind overloaded `lift`, replacing the separate `fmap`, `lift2`, and `lift3` helpers and their IR operators.

### Patch Changes

- 9686cda: Include built loader artifacts in the published package graph.
- 0a842d4: Fix installed workflow typechecking for Acpus authoring facade imports.
- aae74a6: Exclude TypeScript build caches from published tarballs and remove package file
  declarations for README and LICENSE documents that do not exist.
- c5b897b: Move the workspace build to incremental TypeScript 7 project references,
  upgrade the web bundle to Vite 8, and run workflow checks through the pinned
  TypeScript 7 native analysis API.
- Require Node.js 24.15 or newer so every supported runtime provides the
  unflagged `node:sqlite` API used by durable runs.

## 0.1.0-alpha.6

### Minor Changes

- 108d06e: Republish the alpha package graph so runtime consumers resolve an
  `@acpus/expression/ir` entrypoint that exports `isJsonValue`.

## 0.1.0-alpha.5

### Minor Changes

- e3a75f4: Model every executable scope as one arbitrary WorkflowData output expression in
  IR v5, preserve composite aggregation envelopes, and expose syntax-derived
  output shape across runtime, CLI, and Web inspection.
- c1f09ae: Add strict scalar comparison, numeric comparison, and boolean predicate helpers over the existing expression callback primitives.
- c14e800: Unify expression callbacks behind overloaded `lift`, replacing the separate `fmap`, `lift2`, and `lift3` helpers and their IR operators.

### Patch Changes

- aae74a6: Exclude TypeScript build caches from published tarballs and remove package file
  declarations for README and LICENSE documents that do not exist.
- c5b897b: Move the workspace build to incremental TypeScript 7 project references,
  upgrade the web bundle to Vite 8, and run workflow checks through the pinned
  TypeScript 7 native analysis API.

## 0.1.0-alpha.4

### Minor Changes

- 6ef7549: Replace the broad expression helper algebra with `fmap`, `lift2`, `lift3`, `lift`, `template`, and `md`, including callback authoring checks, runtime guards, and updated Acpus authoring references.

## 0.1.0-alpha.3

### Minor Changes

- b8fef84: Add arithmetic and string join expression helpers, clarify workflow check node count text, and expand the Acpus authoring skill reference.

## 0.1.0-alpha.2

### Patch Changes

- Fix installed workflow typechecking for Acpus authoring facade imports.

## 0.1.0-alpha.1

### Patch Changes

- Republish the alpha package graph with built loader artifacts included.

## 0.1.0-alpha.0

### Minor Changes

- cd35e5b: Prepare the TypeScript-first Acpus alpha release.

  This prerelease publishes the current CLI runtime dependency graph under the
  `alpha` dist-tag while leaving legacy `latest` releases unchanged.
