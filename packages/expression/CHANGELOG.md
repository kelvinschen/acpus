# @acpus/expression

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
