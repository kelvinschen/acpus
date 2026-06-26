# M05 Handoff — TUI Generated Contract Adoption

Status: Completed on 2026-06-26.

## Completed Work

- Updated `packages/tui/src/acpus.ts` so runtime/domain types are imported and re-exported from `@acpus/bindings`.
- Kept TUI-owned behavior in place:
  - `parseNodeKey`
  - `RunSupervisorClient`
  - HTTP error/client helpers
  - view-model and rendering code
- Added `@acpus/bindings` as a TUI workspace dependency.
- Added `packages/tui/test/contract/generated-bindings.test.ts`, proving generated `AcpusIr`, `RunState`, and `NodeExecutionState` flow into `buildRenderTree` and `countByState`.
- Extended the M04 runtime-api/generated contract with `ForkPlan` and `NodeDynamicContext`, and kept `RunState.output` typed as `JsonObject` to match current TUI expectations.
- Regenerated `packages/bindings/src/generated/types.ts`.

## Validation Summary

- Passed: `just bindings`
- Passed: `pnpm --filter @acpus/tui typecheck`
- Passed: `pnpm --filter @acpus/tui test`
- Passed: `pnpm -r typecheck`
- Passed: `just ci`

## Gaps

- `@acpus/bindings` is still generated from transitional Rust-owned TypeScript text, not derive-based Rust type generation.
- Runtime and supervisor still serialize their local types rather than using `acpus-runtime-api` directly; M10A/M10C own that adoption.
- `packages/tui/src/acpus.ts` remains the TUI client module. It no longer owns domain type truth, but still exposes compatibility re-exports for existing TUI imports.

## Suggested Next Step

Proceed to M06 store journal. Keep the new `acpus-store` trait focused on durable storage semantics and avoid moving runtime interpreter logic.

## Suggested Skills

- `codebase-design` for keeping the TUI/client seam separate from generated domain contracts.
- `handoff` for preserving transitional codegen and compatibility notes.
