# @acpus/core

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
