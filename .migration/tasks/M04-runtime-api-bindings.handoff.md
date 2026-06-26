# M04 Handoff — Runtime API and TypeScript Bindings

Status: Completed on 2026-06-26.

## Completed Work

- Expanded `crates/acpus-runtime-api` into the initial Rust-owned JSON contract.
- Added contract types for:
  - JSON aliases: `JsonObject`, `Timestamp`, `RunId`, `NodeKey`, `NodeId`, `ArtifactRef`
  - runtime state: `RunStatus`, `NodeState`, `RunState`, `RunSummary`, `NodeExecutionState`
  - telemetry and artifact-facing fields used by current supervisor/TUI JSON
  - requests/results: `SignalRequest`, `RetryRequest`, `ReplayRequest`, `ForkRequest`, `ReplayResult`, `RunCleanResult`
  - errors/events: `ApiErrorCode`, `ApiErrorBody`, `RunEvent`
  - IR contract: `AcpusIr`, `IrNode`, `IrNodeKind`, `IrBranch`, `NodeKeyTemplate`
- Added serialization tests for important JSON compatibility strings and camelCase fields.
- Added `crates/acpus-runtime-api/src/bin/export-ts-bindings.rs`.
- Added transitional Rust-owned TS contract text in `crates/acpus-runtime-api/src/typescript.rs`.
- Generated `packages/bindings/src/generated/types.ts`.
- Added `@acpus/bindings` package with build/typecheck scripts and `src/index.ts`.
- Added `just bindings` and `just bindings-check`.
- Updated `acpus-store` to use the expanded `RunState.run_id` contract field.
- Updated `pnpm-lock.yaml` as a necessary side effect of adding the workspace package.

## Validation Summary

- Passed: `cargo run -p acpus-runtime-api --bin export-ts-bindings`
- Passed: `pnpm install`
- Passed: `pnpm --filter @acpus/bindings build`
- Passed: `pnpm --filter @acpus/bindings typecheck`
- Passed: `cargo test -p acpus-runtime-api`
- Passed: `just ci`

## Gaps

- TS generation is transitional: the Rust crate owns the TypeScript contract string and exporter, but this is not yet derive/codegen from Rust type definitions.
- `@acpus/bindings` is not consumed by TUI yet; M05 owns that adoption.
- Runtime and supervisor still use their existing local Rust types. M10A/M10C should replace those with `acpus-runtime-api` types when the contract has enough coverage.
- `just bindings-check` uses `git diff --exit-code packages/bindings/src/generated`; it will be most useful once generated files are tracked in git.

## Suggested Next Step

Proceed to M05 and make the TUI consume generated domain types from `@acpus/bindings` without changing its rendering behavior.

## Suggested Skills

- `codebase-design` for keeping `acpus-runtime-api` as the contract seam rather than a runtime implementation module.
- `handoff` for preserving transitional codegen caveats.
