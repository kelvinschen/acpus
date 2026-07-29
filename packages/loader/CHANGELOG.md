# @acpus/loader

## 0.2.1

### Patch Changes

- Updated dependencies [117b4f1]
  - @acpus/core@0.10.1
  - @acpus/tasks@0.1.6

## 0.2.0

### Minor Changes

- d6ebc84: Move durable runtime state into private per-workspace shards under the Acpus
  home, archive incompatible or partial storage generations before rebuilding,
  preserve global-catalog source references for execution, and centralize
  verified artifact reads in Runtime. Add `runs prune` with fixed confirmed
  selection cutoffs and relocate CLI-owned cache, snapshot, import, and
  report-draft data out of workspace runtime storage. Keep frozen catalog
  sources separate from the workspace dependency authority during preparation
  and reusable Task execution, and isolate daemon fallback endpoints and
  temporary directories per Acpus home. Show the current workspace shard path
  in Doctor text and JSON output without initializing it, highlighting the text
  form on color-capable terminals.

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

- Updated dependencies [7e65dee]
- Updated dependencies [efbb24c]
- Updated dependencies [f5ee270]
- Updated dependencies [be0e46a]
- Updated dependencies [625cae9]
  - @acpus/core@0.10.0
  - @acpus/expression@0.2.0
  - @acpus/tasks@0.1.5

## 0.1.4

### Patch Changes

- Updated dependencies [c809bff]
  - @acpus/core@0.9.0
  - @acpus/tasks@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies [152303a]
  - @acpus/core@0.8.0
  - @acpus/tasks@0.1.3

## 0.1.2

### Patch Changes

- 93560c5: Support Node.js 22.18+ within the Node.js 22 line and Node.js 24 or newer. Acpus-triggered SQLite initialization now suppresses only Node.js's SQLite experimental warning, leaving unrelated warnings visible.
- Updated dependencies [93560c5]
  - @acpus/core@0.7.2
  - @acpus/expression@0.1.1
  - @acpus/tasks@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [07f4e6b]
  - @acpus/core@0.7.1
  - @acpus/tasks@0.1.1

## 0.1.0

### Minor Changes

- cd35e5b: Release the TypeScript-first Acpus package graph with the CLI, authoring
  facades, compiler, durable runtime, task library, and Web inspector aligned on
  the same public dependency contract.
- 85b3b7d: Make the running CLI's resolved authoring packages the single declaration
  authority, expose their absolute paths through Doctor, version bundled and
  installed Acpus skills with the CLI, and verify the complete packed-install
  authoring environment.

### Patch Changes

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
- Updated dependencies [61bbf86]
- Updated dependencies [b8fef84]
- Updated dependencies [c1f09ae]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [cd35e5b]
- Updated dependencies [108d06e]
- Updated dependencies [958779b]
- Updated dependencies [9686cda]
- Updated dependencies [0a842d4]
- Updated dependencies [aae74a6]
- Updated dependencies [c902db5]
- Updated dependencies [aae74a6]
- Updated dependencies [c5b897b]
- Updated dependencies [6ef7549]
- Updated dependencies [3df9b55]
- Updated dependencies
- Updated dependencies [d92f9f9]
- Updated dependencies [c14e800]
  - @acpus/expression@0.1.0
  - @acpus/core@0.7.0
  - @acpus/tasks@0.1.0

## 0.1.0-alpha.7

### Patch Changes

- 108d06e: Republish the alpha package graph so runtime consumers resolve an
  `@acpus/expression/ir` entrypoint that exports `isJsonValue`.
- Updated dependencies [108d06e]
  - @acpus/core@0.7.0-alpha.7
  - @acpus/expression@0.1.0-alpha.6
  - @acpus/tasks@0.1.0-alpha.7

## 0.1.0-alpha.6

### Patch Changes

- Updated dependencies [c902db5]
  - @acpus/core@0.7.0-alpha.6
  - @acpus/tasks@0.1.0-alpha.6

## 0.1.0-alpha.5

### Minor Changes

- 85b3b7d: Make the running CLI's resolved authoring packages the single declaration
  authority, expose their absolute paths through Doctor, version bundled and
  installed Acpus skills with the CLI, and verify the complete packed-install
  authoring environment.

### Patch Changes

- aae74a6: Exclude TypeScript build caches from published tarballs and remove package file
  declarations for README and LICENSE documents that do not exist.
- c5b897b: Move the workspace build to incremental TypeScript 7 project references,
  upgrade the web bundle to Vite 8, and run workflow checks through the pinned
  TypeScript 7 native analysis API.
- Updated dependencies [e3a75f4]
- Updated dependencies [61bbf86]
- Updated dependencies [c1f09ae]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [958779b]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [c5b897b]
- Updated dependencies [3df9b55]
- Updated dependencies [d92f9f9]
- Updated dependencies [c14e800]
  - @acpus/expression@0.1.0-alpha.5
  - @acpus/core@0.7.0-alpha.5
  - @acpus/tasks@0.1.0-alpha.5

## 0.1.0-alpha.4

### Patch Changes

- Updated dependencies [6ef7549]
  - @acpus/expression@0.1.0-alpha.4
  - @acpus/core@0.7.0-alpha.4
  - @acpus/tasks@0.1.0-alpha.4

## 0.1.0-alpha.3

### Patch Changes

- Updated dependencies [b8fef84]
  - @acpus/expression@0.1.0-alpha.3
  - @acpus/core@0.7.0-alpha.3
  - @acpus/tasks@0.1.0-alpha.3

## 0.1.0-alpha.2

### Patch Changes

- Fix installed workflow typechecking for Acpus authoring facade imports.
- Updated dependencies
  - @acpus/core@0.7.0-alpha.2
  - @acpus/expression@0.1.0-alpha.2
  - @acpus/tasks@0.1.0-alpha.2

## 0.1.0-alpha.1

### Patch Changes

- Republish the alpha package graph with built loader artifacts included.
- Updated dependencies
  - @acpus/core@0.7.0-alpha.1
  - @acpus/expression@0.1.0-alpha.1
  - @acpus/tasks@0.1.0-alpha.1

## 0.1.0-alpha.0

### Minor Changes

- cd35e5b: Prepare the TypeScript-first Acpus alpha release.

  This prerelease publishes the current CLI runtime dependency graph under the
  `alpha` dist-tag while leaving legacy `latest` releases unchanged.

### Patch Changes

- Updated dependencies [cd35e5b]
  - @acpus/core@0.7.0-alpha.0
  - @acpus/expression@0.1.0-alpha.0
  - @acpus/tasks@0.1.0-alpha.0
