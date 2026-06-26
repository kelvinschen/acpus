# M15 Handoff — Generated Runtime Bindings and Supervisor Client

Status: Completed on 2026-06-26.

## Completed Work

- Added `ts-rs` and `utoipa` derives to the Rust-first runtime API DTOs and public IR DTOs.
- Replaced the hand-written `TYPESCRIPT_BINDINGS` body with `typescript_bindings()`, which composes `TS::decl()` output and writes `packages/bindings/src/generated/types.ts`.
- Added supervisor OpenAPI generation with `utoipa` route annotations, a `supervisor_openapi()` export, and `cargo run -p acpus-supervisor --bin export-openapi`.
- Added generated OpenAPI artifacts:
  - `packages/bindings/src/generated/openapi.json`
  - `packages/bindings/src/generated/openapi.ts`
- Added `packages/bindings/src/supervisor-client.ts`, wrapping `openapi-fetch` behind the existing TUI-facing `RunSupervisorClient` surface and exported `ForkRejectedError` / `SupervisorHttpError`.
- Changed `packages/tui/src/acpus.ts` to re-export the shared bindings client/errors while keeping TUI display helpers such as `parseNodeKey`.
- Updated `just bindings` so generation runs in order:
  - runtime API ts-rs bindings
  - supervisor OpenAPI JSON
  - `openapi-typescript`
  - bindings package build
- Added a TUI contract test covering the shared `RunSupervisorClient` method return types.
- Updated `docs/refactor/final-verification.md` and `docs/refactor/migration-matrix.md` for the generated contract pipeline.

## Validation Summary

- `cargo test -p acpus-runtime-api` passed.
- `cargo test -p acpus-ir` passed.
- `cargo test -p acpus-supervisor` passed.
- `pnpm --filter @acpus/bindings typecheck` passed.
- `pnpm --filter @acpus/tui test` passed.
- `just bindings-check` passed.
- `just boundary-check` passed.
- `just ci` passed.
- `git diff --exit-code packages/bindings/src/generated` passed.

## Generation Chain

- `types.ts` is generated from Rust DTOs through `ts-rs`.
- `openapi.json` is generated from supervisor route annotations through `utoipa` / `utoipa-axum`.
- `openapi.ts` is generated from `openapi.json` through `openapi-typescript`.
- `RunSupervisorClient` uses `openapi-fetch` internally but exposes domain-oriented return types from `@acpus/bindings`.

## Gaps

- OpenAPI schema precision for some free-form JSON object fields is still weaker than the ts-rs domain contract. Generated OpenAPI types can show `Record<string, never>` for object-shaped payloads, so external consumers should prefer the high-level `RunSupervisorClient` and generated `types.ts` exports.
- `acpus-core` remains a transitional compatibility crate and is intentionally outside M15.
- Runtime interpreter decomposition remains incomplete; M15 only changed generated contracts and supervisor client ownership.

## Suggested Next Step

Review the generated OpenAPI schema shape before exposing it as a stable public API, especially free-form JSON object payloads such as signal bodies, run input/output, and agent override metadata.
