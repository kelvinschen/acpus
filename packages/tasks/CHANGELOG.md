# @acpus/tasks

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
