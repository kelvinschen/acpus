# M10A Handoff — Runtime API Adoption

Status: Completed on 2026-06-26.

## Completed Work

- Added `acpus-runtime-api` dependency on `acpus-ir` and re-exported canonical IR contract types from `acpus-ir`.
- Removed the duplicate IR type definitions from `acpus-runtime-api`.
- Added `RunStatus::is_terminal` to `acpus-runtime-api`.
- Switched `acpus-runtime` to use `acpus-runtime-api::{NodeState, RunStatus}` through its public runtime exports.
- Regenerated TypeScript bindings and confirmed generated binding files are clean after generation.
- Kept JSON field names and runtime behavior unchanged.

## Validation Summary

- `just bindings` passed.
- `cargo test -p acpus-runtime-api` passed.
- `cargo test -p acpus-runtime` passed.
- `cargo test -p acpus-supervisor` passed.
- `cargo test -p acpus-cli` passed.
- `pnpm --filter @acpus/bindings typecheck` passed.
- `pnpm --filter @acpus/tui typecheck` passed.
- `pnpm --filter @acpus/tui test` passed.
- `cargo fmt --all -- --check` passed.
- `git diff --exit-code -- packages/bindings/src/generated` passed after regeneration.

## Gaps

- `RunState`, `RunSummary`, `NodeExecutionState`, agent telemetry structs, clean-run result structs, and replay/fork payload mirrors are not fully aliased to `acpus-runtime-api` yet.
- Runtime `RunState` still uses runtime/core-owned agent override warning types, while `acpus-runtime-api` currently models those public fields as JSON values.
- Runtime `NodeExecutionState` still stores `dynamic_context` and `input` as untyped `serde_json::Value`, while the API crate has more typed/different mirrors.
- The TUI no longer hand-writes statuses because it consumes generated bindings, but the Rust-side public contract still has additional consolidation work.

## Suggested Next Step

Proceed to M10B, and fold the remaining public contract consolidation into the store extraction only where it does not obscure the store boundary. If the type changes grow, split them into a follow-up M10A2 before M10B.

## Suggested Skills

- `codebase-design` is useful for separating runtime-owned persisted state from public API response DTOs.
