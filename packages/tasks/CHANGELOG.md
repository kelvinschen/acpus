# @acpus/tasks

## 0.1.8

### Patch Changes

- Updated dependencies [261912e]
  - @acpus/core@0.12.0

## 0.1.7

### Patch Changes

- Updated dependencies [898831e]
  - @acpus/core@0.11.0

## 0.1.6

### Patch Changes

- Updated dependencies [117b4f1]
  - @acpus/core@0.10.1

## 0.1.5

### Patch Changes

- Updated dependencies [7e65dee]
- Updated dependencies [efbb24c]
- Updated dependencies [f5ee270]
- Updated dependencies [be0e46a]
  - @acpus/core@0.10.0

## 0.1.4

### Patch Changes

- Updated dependencies [c809bff]
  - @acpus/core@0.9.0

## 0.1.3

### Patch Changes

- Updated dependencies [152303a]
  - @acpus/core@0.8.0

## 0.1.2

### Patch Changes

- 93560c5: Support Node.js 22.18+ within the Node.js 22 line and Node.js 24 or newer. Acpus-triggered SQLite initialization now suppresses only Node.js's SQLite experimental warning, leaving unrelated warnings visible.
- Updated dependencies [93560c5]
  - @acpus/core@0.7.2

## 0.1.1

### Patch Changes

- Updated dependencies [07f4e6b]
  - @acpus/core@0.7.1

## 0.1.0

### Minor Changes

- cd35e5b: Release the TypeScript-first Acpus package graph with the CLI, authoring
  facades, compiler, durable runtime, task library, and Web inspector aligned on
  the same public dependency contract.
- aae74a6: Remove the redundant package-root entrypoint while preserving the supported
  `@acpus/tasks/git` task API.

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
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [cd35e5b]
- Updated dependencies [108d06e]
- Updated dependencies [958779b]
- Updated dependencies [9686cda]
- Updated dependencies [0a842d4]
- Updated dependencies [aae74a6]
- Updated dependencies [c902db5]
- Updated dependencies [c5b897b]
- Updated dependencies [3df9b55]
- Updated dependencies
- Updated dependencies [d92f9f9]
  - @acpus/core@0.7.0

## 0.1.0-alpha.7

### Patch Changes

- 108d06e: Republish the alpha package graph so runtime consumers resolve an
  `@acpus/expression/ir` entrypoint that exports `isJsonValue`.
- Updated dependencies [108d06e]
  - @acpus/core@0.7.0-alpha.7

## 0.1.0-alpha.6

### Patch Changes

- Updated dependencies [c902db5]
  - @acpus/core@0.7.0-alpha.6

## 0.1.0-alpha.5

### Minor Changes

- aae74a6: Remove the redundant package-root entrypoint while preserving the supported
  `@acpus/tasks/git` task API.

### Patch Changes

- aae74a6: Exclude TypeScript build caches from published tarballs and remove package file
  declarations for README and LICENSE documents that do not exist.
- c5b897b: Move the workspace build to incremental TypeScript 7 project references,
  upgrade the web bundle to Vite 8, and run workflow checks through the pinned
  TypeScript 7 native analysis API.
- Updated dependencies [e3a75f4]
- Updated dependencies [61bbf86]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [958779b]
- Updated dependencies [aae74a6]
- Updated dependencies [c5b897b]
- Updated dependencies [3df9b55]
- Updated dependencies [d92f9f9]
  - @acpus/core@0.7.0-alpha.5

## 0.1.0-alpha.4

### Patch Changes

- @acpus/core@0.7.0-alpha.4

## 0.1.0-alpha.3

### Patch Changes

- @acpus/core@0.7.0-alpha.3

## 0.1.0-alpha.2

### Patch Changes

- Fix installed workflow typechecking for Acpus authoring facade imports.
- Updated dependencies
  - @acpus/core@0.7.0-alpha.2

## 0.1.0-alpha.1

### Patch Changes

- Republish the alpha package graph with built loader artifacts included.
- Updated dependencies
  - @acpus/core@0.7.0-alpha.1

## 0.1.0-alpha.0

### Minor Changes

- cd35e5b: Prepare the TypeScript-first Acpus alpha release.

  This prerelease publishes the current CLI runtime dependency graph under the
  `alpha` dist-tag while leaving legacy `latest` releases unchanged.

### Patch Changes

- Updated dependencies [cd35e5b]
  - @acpus/core@0.7.0-alpha.0
