# @acpus/core

## 0.10.1

### Patch Changes

- 117b4f1: Render compact TypeScript-like Agent result shapes instead of JSON Schema,
  with bounded output recovery. Preserve advisory numeric constraints and Zod 4
  default-factory and numeric-enum semantics when lowering graph-boundary
  schemas.

## 0.10.0

### Minor Changes

- f5ee270: Allow inline and reusable Tasks to receive any durable value directly while
  preserving precise materialized input types. Lower and execute Task input as one
  expression, expose its complete authored shape in workflow visualization, and
  accept interface-shaped durable results from `lift`.

  Advance frozen workflow IR and Runtime storage generations so existing
  generation isolation rejects the previous Task-input representation without a
  compatibility shim.

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

- efbb24c: Accept workflow sources outside the workspace and from standard input without
  writing generated source into the project. Capture their static local module
  closure as a content-addressed bundle, persist it during Runtime admission, and
  restore reusable Tasks from the durable snapshot while retaining the workspace
  as the command and package-dependency authority.
- be0e46a: Keep task command output captured by default and signal timed-out command trees without Node.js shell deprecation warnings.
- Updated dependencies [7e65dee]
- Updated dependencies [f5ee270]
- Updated dependencies [625cae9]
  - @acpus/expression@0.2.0

## 0.9.0

### Minor Changes

- c809bff: Add static Agent ACP config profiles, including model and adapter-specific session options, across authoring, IR, execution, and Agent configuration guidance.

## 0.8.0

### Minor Changes

- 152303a: Parse schema-backed Agent results from terminal Tagged JSON frames advertised by a concise mandatory output contract, retain one bounded local JSON repair pass, and render complete nullable/default/description metadata in output JSON Schema prompts. `AgentOutputProcessing` now reports `outcome`, failure `phase`, parsing mode, and projection changes instead of the previous recovery/conformance fields.

## 0.7.2

### Patch Changes

- 93560c5: Support Node.js 22.18+ within the Node.js 22 line and Node.js 24 or newer. Acpus-triggered SQLite initialization now suppresses only Node.js's SQLite experimental warning, leaving unrelated warnings visible.
- Updated dependencies [93560c5]
  - @acpus/expression@0.1.1

## 0.7.1

### Patch Changes

- 07f4e6b: Remove stale rewrite-roadmap links from the published package documentation.

## 0.7.0

### Minor Changes

- e3a75f4: Model every executable scope as one arbitrary WorkflowData output expression in
  IR v5, preserve composite aggregation envelopes, and expose syntax-derived
  output shape across runtime, CLI, and Web inspection.
- aae74a6: Expose typed duration parsing from `@acpus/core/ir` and reject duration literals whose resolved milliseconds are outside JavaScript's safe integer range.
- aae74a6: Expose exhaustive structural WorkflowIR traversal helpers from `@acpus/core/ir`, including stable pre-order visits and outermost-first child-scope ancestry.
- cd35e5b: Release the TypeScript-first Acpus package graph with the CLI, authoring
  facades, compiler, durable runtime, task library, and Web inspector aligned on
  the same public dependency contract.
- 958779b: Flatten Agent, Task, and Signal workflow authoring specs by moving execution
  fields out of the author-facing `run` wrapper. Keep the frozen WorkflowIR
  `node.run` envelopes unchanged while updating task source analysis, bundled
  examples, and authoring guidance to the single flat syntax.
- c902db5: Allow non-empty homogeneous Zod tuples at graph boundaries by lowering them to
  arrays while preserving native TypeScript tuple inference.
- 3df9b55: Allow optional runtime expressions to configure Parallel and Fanout concurrency,
  and treat missing or zero limits as no authored local cap while keeping quorum
  counts and invalid concurrency values strict.
- d92f9f9: Require named durable workflow and composite outputs, reject NodeRef handles and
  explicit any authoring, preserve existing composite result envelopes, and leave
  type-expressible output failures to native TypeScript diagnostics.

### Patch Changes

- 61bbf86: Make authoring diagnostics source-ordered, single-owned, and repair-oriented;
  recognize Acpus types by official declaration provenance; enrich high-confidence
  TypeScript errors; render concise CLI locations; and emit node-id validation once.
- 108d06e: Align the package graph so runtime consumers resolve an
  `@acpus/expression/ir` entrypoint that exports `isJsonValue`.
- 9686cda: Include built loader artifacts in the published package graph.
- 0a842d4: Fix installed workflow typechecking for Acpus authoring facade imports.
- aae74a6: Exclude TypeScript build caches from published tarballs and remove package file
  declarations for README and LICENSE documents that do not exist.
- c5b897b: Move the workspace build to incremental TypeScript 7 project references,
  upgrade the web bundle to Vite 8, and run workflow checks through the pinned
  TypeScript 7 native analysis API.
- Require Node.js 24.15 or newer so every supported runtime provides the
  unflagged `node:sqlite` API used by durable runs.
- Updated dependencies [e3a75f4]
- Updated dependencies [b8fef84]
- Updated dependencies [c1f09ae]
- Updated dependencies [cd35e5b]
- Updated dependencies [108d06e]
- Updated dependencies [9686cda]
- Updated dependencies [0a842d4]
- Updated dependencies [aae74a6]
- Updated dependencies [c5b897b]
- Updated dependencies [6ef7549]
- Updated dependencies
- Updated dependencies [c14e800]
  - @acpus/expression@0.1.0

## 0.7.0-alpha.7

### Patch Changes

- 108d06e: Republish the alpha package graph so runtime consumers resolve an
  `@acpus/expression/ir` entrypoint that exports `isJsonValue`.
- Updated dependencies [108d06e]
  - @acpus/expression@0.1.0-alpha.6

## 0.7.0-alpha.6

### Minor Changes

- c902db5: Allow non-empty homogeneous Zod tuples at graph boundaries by lowering them to
  arrays while preserving native TypeScript tuple inference.

## 0.7.0-alpha.5

### Minor Changes

- e3a75f4: Model every executable scope as one arbitrary WorkflowData output expression in
  IR v5, preserve composite aggregation envelopes, and expose syntax-derived
  output shape across runtime, CLI, and Web inspection.
- aae74a6: Expose typed duration parsing from `@acpus/core/ir` and reject duration literals whose resolved milliseconds are outside JavaScript's safe integer range.
- aae74a6: Expose exhaustive structural WorkflowIR traversal helpers from `@acpus/core/ir`, including stable pre-order visits and outermost-first child-scope ancestry.
- 958779b: Flatten Agent, Task, and Signal workflow authoring specs by moving execution
  fields out of the author-facing `run` wrapper. Keep the frozen WorkflowIR
  `node.run` envelopes unchanged while updating task source analysis, bundled
  examples, and authoring guidance to the single flat syntax.
- 3df9b55: Allow optional runtime expressions to configure Parallel and Fanout concurrency,
  and treat missing or zero limits as no authored local cap while keeping quorum
  counts and invalid concurrency values strict.
- d92f9f9: Require named durable workflow and composite outputs, reject NodeRef handles and
  explicit any authoring, preserve existing composite result envelopes, and leave
  type-expressible output failures to native TypeScript diagnostics.

### Patch Changes

- 61bbf86: Make authoring diagnostics source-ordered, single-owned, and repair-oriented;
  recognize Acpus types by official declaration provenance; enrich high-confidence
  TypeScript errors; render concise CLI locations; and emit node-id validation once.
- aae74a6: Exclude TypeScript build caches from published tarballs and remove package file
  declarations for README and LICENSE documents that do not exist.
- c5b897b: Move the workspace build to incremental TypeScript 7 project references,
  upgrade the web bundle to Vite 8, and run workflow checks through the pinned
  TypeScript 7 native analysis API.
- Updated dependencies [e3a75f4]
- Updated dependencies [c1f09ae]
- Updated dependencies [aae74a6]
- Updated dependencies [c5b897b]
- Updated dependencies [c14e800]
  - @acpus/expression@0.1.0-alpha.5

## 0.7.0-alpha.4

### Patch Changes

- Updated dependencies [6ef7549]
  - @acpus/expression@0.1.0-alpha.4

## 0.7.0-alpha.3

### Patch Changes

- Updated dependencies [b8fef84]
  - @acpus/expression@0.1.0-alpha.3

## 0.7.0-alpha.2

### Patch Changes

- Fix installed workflow typechecking for Acpus authoring facade imports.
- Updated dependencies
  - @acpus/expression@0.1.0-alpha.2

## 0.7.0-alpha.1

### Patch Changes

- Republish the alpha package graph with built loader artifacts included.
- Updated dependencies
  - @acpus/expression@0.1.0-alpha.1

## 0.7.0-alpha.0

### Minor Changes

- cd35e5b: Prepare the TypeScript-first Acpus alpha release.

  This prerelease publishes the current CLI runtime dependency graph under the
  `alpha` dist-tag while leaving legacy `latest` releases unchanged.

### Patch Changes

- Updated dependencies [cd35e5b]
  - @acpus/expression@0.1.0-alpha.0
