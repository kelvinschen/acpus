# M14 Handoff — Final CI Hardening

Status: Completed on 2026-06-26.

## Completed Work

- Updated `just ci` to run:
  - `fmt-check`
  - `clippy`
  - `bindings-check`
  - `boundary-check`
  - `test-rs`
  - `typecheck`
  - `test-ts`
  - `e2e`
- Updated `.github/workflows/ci.yml` to use the pinned Rust toolchain, install `just` and `cargo-nextest`, install pnpm dependencies with a frozen lockfile, run `cargo fetch --locked`, and execute `just ci`.
- Added package script aliases for bindings, bindings check, E2E, and clippy.
- Marked the migration matrix overall status as completed.
- Added `docs/refactor/final-verification.md`.

## Validation Summary

- `just ci` passed.
- `git diff --exit-code packages/bindings/src/generated` passed.

## Gaps

- Local `cargo-nextest` was not installed, so the local `just ci` run used `cargo test --workspace`; GitHub Actions installs `cargo-nextest`.
- `acpus-core` remains as a transitional compatibility crate for agent override and hook APIs.
- Runtime interpreter decomposition is started but not complete; `interpreter.rs` is still large.
- Mock-agent protocol is covered by unit/protocol tests, but the M12 E2E path uses a program-only workflow.

## Suggested Next Step

Review the accumulated migration diff as one coherent branch, then decide whether to split the work into milestone commits or land it as a single Rust-first migration PR.
