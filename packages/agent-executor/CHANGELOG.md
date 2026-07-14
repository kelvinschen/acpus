# @acpus/agent-executor

## 0.1.0-alpha.3

### Minor Changes

- c162856: Expose honest Agent telemetry availability, direct fork lineage, compact run-level Agent usage, aggregate repeated targets, and rate-limited non-TTY follow omissions for long-running workflow operation.
- 7f3f186: Unify run inspection behind a compact runtime projection with structural text views, target and raw modes, durable follow updates, shared CLI/Web semantics, live Agent telemetry summaries, and lossless structured acpx failure causes.
- aae74a6: Replace authored duration strings in agent turn requests with validated resolved
  millisecond budgets, including monotonic shared deadlines, safe long-timeout
  scheduling, acpx rounding, and race-safe subprocess cancellation.

### Patch Changes

- aae74a6: Exclude TypeScript build caches from published tarballs and remove package file
  declarations for README and LICENSE documents that do not exist.
- c5b897b: Move the workspace build to incremental TypeScript 7 project references,
  upgrade the web bundle to Vite 8, and run workflow checks through the pinned
  TypeScript 7 native analysis API.

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
