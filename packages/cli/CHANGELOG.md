# acpus

## 0.6.0-alpha.5

### Patch Changes

- 6ef7549: Add expression `transform(value, fn)` for small runtime JSON transforms, with workflow authoring checks, runtime guards, and Acpus authoring references.
- Updated dependencies [6ef7549]
  - @acpus/expression@0.1.0-alpha.4
  - @acpus/workflow-compiler@0.1.0-alpha.4
  - @acpus/core@0.7.0-alpha.4
  - @acpus/runtime@0.9.0-alpha.4
  - @acpus/web@0.1.0-alpha.5
  - @acpus/tasks@0.1.0-alpha.4

## 0.6.0-alpha.4

### Minor Changes

- b8fef84: Add arithmetic and string join expression helpers, clarify workflow check node count text, and expand the Acpus authoring skill reference.

### Patch Changes

- Updated dependencies [b8fef84]
  - @acpus/expression@0.1.0-alpha.3
  - @acpus/core@0.7.0-alpha.3
  - @acpus/runtime@0.9.0-alpha.3
  - @acpus/web@0.1.0-alpha.4
  - @acpus/workflow-compiler@0.1.0-alpha.3
  - @acpus/tasks@0.1.0-alpha.3

## 0.6.0-alpha.3

### Patch Changes

- Make WebUI shutdown idempotent under repeated Ctrl-C signals.
- Updated dependencies
  - @acpus/web@0.1.0-alpha.3

## 0.6.0-alpha.2

### Patch Changes

- Fix installed workflow typechecking for Acpus authoring facade imports.
- Updated dependencies
  - @acpus/core@0.7.0-alpha.2
  - @acpus/expression@0.1.0-alpha.2
  - @acpus/runtime@0.9.0-alpha.2
  - @acpus/tasks@0.1.0-alpha.2
  - @acpus/web@0.1.0-alpha.2
  - @acpus/workflow-compiler@0.1.0-alpha.2

## 0.6.0-alpha.1

### Patch Changes

- Republish the alpha package graph with built loader artifacts included.
- Updated dependencies
  - @acpus/core@0.7.0-alpha.1
  - @acpus/expression@0.1.0-alpha.1
  - @acpus/runtime@0.9.0-alpha.1
  - @acpus/tasks@0.1.0-alpha.1
  - @acpus/web@0.1.0-alpha.1
  - @acpus/workflow-compiler@0.1.0-alpha.1

## 0.6.0-alpha.0

### Minor Changes

- cd35e5b: Prepare the TypeScript-first Acpus alpha release.

  This prerelease publishes the current CLI runtime dependency graph under the
  `alpha` dist-tag while leaving legacy `latest` releases unchanged.

### Patch Changes

- Updated dependencies [cd35e5b]
  - @acpus/core@0.7.0-alpha.0
  - @acpus/expression@0.1.0-alpha.0
  - @acpus/runtime@0.9.0-alpha.0
  - @acpus/tasks@0.1.0-alpha.0
  - @acpus/web@0.1.0-alpha.0
  - @acpus/workflow-compiler@0.1.0-alpha.0
