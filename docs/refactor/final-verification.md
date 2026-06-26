# Final Verification

Status: Completed on 2026-06-26. Updated for M15 generated runtime contracts.

## Commit

- Baseline commit hash during verification: `200ea50c400de3579141b6c08328a0e1ccaabf1d`

## Tool Versions

- `rustc 1.96.0 (ac68faa20 2026-05-25)`
- `cargo 1.96.0 (30a34c682 2026-05-25)`
- Rust toolchain: `1.96.0-x86_64-unknown-linux-gnu`
- Node: `v24.15.0`
- pnpm: `9.7.0`
- just: `1.54.0`
- `ts-rs 12.0.1`
- `utoipa 5.5.0`
- `utoipa-axum 0.2.0`
- `openapi-typescript 7.13.0`
- `openapi-fetch 0.17.0`
- Local `cargo-nextest`: not installed during this run; `just test-rs` used its `cargo test --workspace` fallback. GitHub Actions installs `cargo-nextest`.

## `just ci` Summary

`just ci` passed on 2026-06-26 after M15.

Covered gates:

- `cargo fmt --all -- --check`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `just bindings-check`
- `just boundary-check`
- Rust workspace tests via `just test-rs`
- TypeScript typecheck via `pnpm -r typecheck`
- TypeScript tests via `pnpm -r test`
- CLI E2E via `just e2e`

Observed test summary:

- Rust workspace tests passed, including compiler golden tests, runtime/store/supervisor units, mock-agent tests, CLI contract tests, and CLI E2E.
- TUI tests passed: 14 files, 126 tests.
- CLI E2E passed: 3 tests.

## `boundary-check` Summary

`just boundary-check` passed on 2026-06-26.

Enforced boundaries:

- `acpus-spec` does not depend on `acpus-runtime`.
- `acpus-ir` does not depend on `acpus-core` or `acpus-runtime`.
- `acpus-compiler` does not depend on `acpus-runtime`.
- `acpus-runtime` does not depend on `axum`, `reqwest`, `clap`, or `acpus-supervisor`.
- `acpus-store` does not depend on `acpus-runtime` or `acpus-supervisor`.

## Generated Contracts

`git diff --exit-code packages/bindings/src/generated` passed after `just ci`; generated TypeScript bindings and OpenAPI artifacts have no drift.

M15 generation chain:

- `cargo run -p acpus-runtime-api --bin export-ts-bindings` writes `packages/bindings/src/generated/types.ts` from `ts-rs`.
- `cargo run -p acpus-supervisor --bin export-openapi` writes `packages/bindings/src/generated/openapi.json` from `utoipa` / `utoipa-axum`.
- `pnpm --filter @acpus/bindings generate:openapi` writes `packages/bindings/src/generated/openapi.ts` from `openapi-typescript`.
- `packages/bindings/src/supervisor-client.ts` wraps `openapi-fetch` and exposes the shared `RunSupervisorClient`.

## Known Remaining Items

- `acpus-core` remains as a transitional re-export/helper crate for agent overrides and hook configuration APIs still used by runtime/store/supervisor.
- `acpus-runtime/src/interpreter.rs` remains large. M10D added `engine`, `state_machine`, and `effects` boundaries, but did not fully split interpreter internals.
- OpenAPI schema precision for free-form JSON object fields still trails the ts-rs domain contract in a few places. External TypeScript consumers should use the high-level `RunSupervisorClient` and generated domain types rather than depending directly on every OpenAPI operation shape.
- The E2E suite intentionally covers a local program-only workflow path and does not yet exercise the mock-agent protocol end to end.
