# @acpus/web

## 0.1.0-alpha.6

### Minor Changes

- e3a75f4: Model every executable scope as one arbitrary WorkflowData output expression in
  IR v5, preserve composite aggregation envelopes, and expose syntax-derived
  output shape across runtime, CLI, and Web inspection.
- 7f3f186: Unify run inspection behind a compact runtime projection with structural text views, target and raw modes, durable follow updates, shared CLI/Web semantics, live Agent telemetry summaries, and lossless structured acpx failure causes.

### Patch Changes

- aae74a6: Exclude TypeScript build caches from published tarballs and remove package file
  declarations for README and LICENSE documents that do not exist.
- c5b897b: Move the workspace build to incremental TypeScript 7 project references,
  upgrade the web bundle to Vite 8, and run workflow checks through the pinned
  TypeScript 7 native analysis API.
- aae74a6: Share Inspector primitives across live and static graphs, prevent stale close
  timers from dismissing new targets, restore the static no-input state layout,
  and keep the Vite API proxy from intercepting the client API module.
- Updated dependencies [e3a75f4]
- Updated dependencies [61bbf86]
- Updated dependencies [bf959b0]
- Updated dependencies [c1f09ae]
- Updated dependencies [aae74a6]
- Updated dependencies [c162856]
- Updated dependencies [7f3f186]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [958779b]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [c5b897b]
- Updated dependencies [aae74a6]
- Updated dependencies [3df9b55]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [d92f9f9]
- Updated dependencies [c14e800]
- Updated dependencies [aae74a6]
  - @acpus/expression@0.1.0-alpha.5
  - @acpus/core@0.7.0-alpha.5
  - @acpus/runtime@0.9.0-alpha.5
  - @acpus/workflow-compiler@0.1.0-alpha.5

## 0.1.0-alpha.5

### Patch Changes

- Updated dependencies [6ef7549]
  - @acpus/expression@0.1.0-alpha.4
  - @acpus/workflow-compiler@0.1.0-alpha.4
  - @acpus/core@0.7.0-alpha.4
  - @acpus/runtime@0.9.0-alpha.4

## 0.1.0-alpha.4

### Patch Changes

- Updated dependencies [b8fef84]
  - @acpus/expression@0.1.0-alpha.3
  - @acpus/core@0.7.0-alpha.3
  - @acpus/runtime@0.9.0-alpha.3
  - @acpus/workflow-compiler@0.1.0-alpha.3

## 0.1.0-alpha.3

### Patch Changes

- Make WebUI shutdown idempotent under repeated Ctrl-C signals.

## 0.1.0-alpha.2

### Patch Changes

- Fix installed workflow typechecking for Acpus authoring facade imports.
- Updated dependencies
  - @acpus/core@0.7.0-alpha.2
  - @acpus/expression@0.1.0-alpha.2
  - @acpus/runtime@0.9.0-alpha.2
  - @acpus/workflow-compiler@0.1.0-alpha.2

## 0.1.0-alpha.1

### Patch Changes

- Republish the alpha package graph with built loader artifacts included.
- Updated dependencies
  - @acpus/core@0.7.0-alpha.1
  - @acpus/expression@0.1.0-alpha.1
  - @acpus/runtime@0.9.0-alpha.1
  - @acpus/workflow-compiler@0.1.0-alpha.1

## 0.1.0-alpha.0

### Minor Changes

- cd35e5b: Prepare the TypeScript-first Acpus alpha release.

  This prerelease publishes the current CLI runtime dependency graph under the
  `alpha` dist-tag while leaving legacy `latest` releases unchanged.

### Patch Changes

- Updated dependencies [cd35e5b]
  - @acpus/core@0.7.0-alpha.0
  - @acpus/expression@0.1.0-alpha.0
  - @acpus/runtime@0.9.0-alpha.0
  - @acpus/workflow-compiler@0.1.0-alpha.0
