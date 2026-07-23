# @acpus/workflow-compiler

## 0.2.0

### Minor Changes

- c809bff: Add static Agent ACP config profiles, including model and adapter-specific session options, across authoring, IR, execution, and Agent configuration guidance.

### Patch Changes

- Updated dependencies [c809bff]
  - @acpus/core@0.9.0
  - @acpus/loader@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies [152303a]
  - @acpus/core@0.8.0
  - @acpus/loader@0.1.3

## 0.1.2

### Patch Changes

- 93560c5: Support Node.js 22.18+ within the Node.js 22 line and Node.js 24 or newer. Acpus-triggered SQLite initialization now suppresses only Node.js's SQLite experimental warning, leaving unrelated warnings visible.
- Updated dependencies [93560c5]
  - @acpus/core@0.7.2
  - @acpus/expression@0.1.1
  - @acpus/loader@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [07f4e6b]
  - @acpus/core@0.7.1
  - @acpus/loader@0.1.1

## 0.1.0

### Minor Changes

- e3a75f4: Model every executable scope as one arbitrary WorkflowData output expression in
  IR v5, preserve composite aggregation envelopes, and expose syntax-derived
  output shape across runtime, CLI, and Web inspection.
- cd35e5b: Release the TypeScript-first Acpus package graph with the CLI, authoring
  facades, compiler, durable runtime, task library, and Web inspector aligned on
  the same public dependency contract.
- d92f9f9: Require named durable workflow and composite outputs, reject NodeRef handles and
  explicit any authoring, preserve existing composite result envelopes, and leave
  type-expressible output failures to native TypeScript diagnostics.

### Patch Changes

- 61bbf86: Make authoring diagnostics source-ordered, single-owned, and repair-oriented;
  recognize Acpus types by official declaration provenance; enrich high-confidence
  TypeScript errors; render concise CLI locations; and emit node-id validation once.
- bf959b0: Give Expr authoring failures context-specific repair hints, avoid duplicate
  dynamic Task id diagnostics, distinguish runtime `undefined` from serialized
  closure captures, and document static loop and fanout step identity.
- 108d06e: Align the package graph so runtime consumers resolve an
  `@acpus/expression/ir` entrypoint that exports `isJsonValue`.
- 958779b: Flatten Agent, Task, and Signal workflow authoring specs by moving execution
  fields out of the author-facing `run` wrapper. Keep the frozen WorkflowIR
  `node.run` envelopes unchanged while updating task source analysis, bundled
  examples, and authoring guidance to the single flat syntax.
- 9686cda: Include built loader artifacts in the published package graph.
- 0a842d4: Fix installed workflow typechecking for Acpus authoring facade imports.
- aae74a6: Exclude TypeScript build caches from published tarballs and remove package file
  declarations for README and LICENSE documents that do not exist.
- aae74a6: Remove the unused named `rules` export from the repository-internal ESLint
  plugin subpath while preserving the default plugin export and its
  `acpus-internal/check` rule.
- c5b897b: Move the workspace build to incremental TypeScript 7 project references,
  upgrade the web bundle to Vite 8, and run workflow checks through the pinned
  TypeScript 7 native analysis API.
- 6ef7549: Replace the broad expression helper algebra with `fmap`, `lift2`, `lift3`, `lift`, `template`, and `md`, including expression and bounded block callback authoring checks, runtime guards, and updated Acpus authoring references.
- aae74a6: Remove redundant direct dependencies on `@acpus/tasks`; dynamic authoring facade resolution remains owned by `@acpus/loader`.
- Require Node.js 24.15 or newer so every supported runtime provides the
  unflagged `node:sqlite` API used by durable runs.
- c14e800: Unify expression callbacks behind overloaded `lift`, replacing the separate `fmap`, `lift2`, and `lift3` helpers and their IR operators.
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
- Updated dependencies [85b3b7d]
- Updated dependencies [0a842d4]
- Updated dependencies [aae74a6]
- Updated dependencies [c902db5]
- Updated dependencies [c5b897b]
- Updated dependencies [6ef7549]
- Updated dependencies [3df9b55]
- Updated dependencies
- Updated dependencies [d92f9f9]
- Updated dependencies [c14e800]
  - @acpus/expression@0.1.0
  - @acpus/core@0.7.0
  - @acpus/loader@0.1.0

## 0.1.0-alpha.7

### Patch Changes

- 108d06e: Republish the alpha package graph so runtime consumers resolve an
  `@acpus/expression/ir` entrypoint that exports `isJsonValue`.
- Updated dependencies [108d06e]
  - @acpus/core@0.7.0-alpha.7
  - @acpus/expression@0.1.0-alpha.6
  - @acpus/loader@0.1.0-alpha.7

## 0.1.0-alpha.6

### Patch Changes

- Updated dependencies [c902db5]
  - @acpus/core@0.7.0-alpha.6
  - @acpus/loader@0.1.0-alpha.6

## 0.1.0-alpha.5

### Minor Changes

- e3a75f4: Model every executable scope as one arbitrary WorkflowData output expression in
  IR v5, preserve composite aggregation envelopes, and expose syntax-derived
  output shape across runtime, CLI, and Web inspection.
- d92f9f9: Require named durable workflow and composite outputs, reject NodeRef handles and
  explicit any authoring, preserve existing composite result envelopes, and leave
  type-expressible output failures to native TypeScript diagnostics.

### Patch Changes

- 61bbf86: Make authoring diagnostics source-ordered, single-owned, and repair-oriented;
  recognize Acpus types by official declaration provenance; enrich high-confidence
  TypeScript errors; render concise CLI locations; and emit node-id validation once.
- bf959b0: Give Expr authoring failures context-specific repair hints, avoid duplicate
  dynamic Task id diagnostics, distinguish runtime `undefined` from serialized
  closure captures, and document static loop and fanout step identity.
- 958779b: Flatten Agent, Task, and Signal workflow authoring specs by moving execution
  fields out of the author-facing `run` wrapper. Keep the frozen WorkflowIR
  `node.run` envelopes unchanged while updating task source analysis, bundled
  examples, and authoring guidance to the single flat syntax.
- aae74a6: Exclude TypeScript build caches from published tarballs and remove package file
  declarations for README and LICENSE documents that do not exist.
- aae74a6: Remove the unused named `rules` export from the repository-internal ESLint
  plugin subpath while preserving the default plugin export and its
  `acpus-internal/check` rule.
- c5b897b: Move the workspace build to incremental TypeScript 7 project references,
  upgrade the web bundle to Vite 8, and run workflow checks through the pinned
  TypeScript 7 native analysis API.
- aae74a6: Remove redundant direct dependencies on `@acpus/tasks`; dynamic authoring facade resolution remains owned by `@acpus/loader`.
- c14e800: Unify expression callbacks behind overloaded `lift`, replacing the separate `fmap`, `lift2`, and `lift3` helpers and their IR operators.
- Updated dependencies [e3a75f4]
- Updated dependencies [61bbf86]
- Updated dependencies [c1f09ae]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [958779b]
- Updated dependencies [85b3b7d]
- Updated dependencies [aae74a6]
- Updated dependencies [c5b897b]
- Updated dependencies [3df9b55]
- Updated dependencies [d92f9f9]
- Updated dependencies [c14e800]
  - @acpus/expression@0.1.0-alpha.5
  - @acpus/core@0.7.0-alpha.5
  - @acpus/loader@0.1.0-alpha.5

## 0.1.0-alpha.4

### Patch Changes

- 6ef7549: Replace the broad expression helper algebra with `fmap`, `lift2`, `lift3`, `lift`, `template`, and `md`, including callback authoring checks, runtime guards, and updated Acpus authoring references.
- Updated dependencies [6ef7549]
  - @acpus/expression@0.1.0-alpha.4
  - @acpus/core@0.7.0-alpha.4
  - @acpus/loader@0.1.0-alpha.4
  - @acpus/tasks@0.1.0-alpha.4

## 0.1.0-alpha.3

### Patch Changes

- Updated dependencies [b8fef84]
  - @acpus/expression@0.1.0-alpha.3
  - @acpus/core@0.7.0-alpha.3
  - @acpus/loader@0.1.0-alpha.3
  - @acpus/tasks@0.1.0-alpha.3

## 0.1.0-alpha.2

### Patch Changes

- Fix installed workflow typechecking for Acpus authoring facade imports.
- Updated dependencies
  - @acpus/core@0.7.0-alpha.2
  - @acpus/expression@0.1.0-alpha.2
  - @acpus/loader@0.1.0-alpha.2
  - @acpus/tasks@0.1.0-alpha.2

## 0.1.0-alpha.1

### Patch Changes

- Republish the alpha package graph with built loader artifacts included.
- Updated dependencies
  - @acpus/core@0.7.0-alpha.1
  - @acpus/expression@0.1.0-alpha.1
  - @acpus/loader@0.1.0-alpha.1
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
  - @acpus/loader@0.1.0-alpha.0
  - @acpus/tasks@0.1.0-alpha.0
