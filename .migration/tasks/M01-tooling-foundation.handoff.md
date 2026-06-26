# M01 Handoff — Tooling Foundation

Status: Completed on 2026-06-26.

## Completed Work

- Pinned `rust-toolchain.toml` to Rust `1.96.0` and added `rust-src`.
- Added `nextest.toml` with default and CI profiles.
- Added a repo-level `justfile` with unified entries for fmt, clippy, Rust tests, TS tests, typecheck, CI, and clean.
- Updated root `package.json` scripts so `ci`, `test`, `typecheck`, and `clean` go through `just` while preserving existing `acpus`, `acpus:release`, and `build` scripts.
- Added `.github/workflows/ci.yml` that installs Rust tools, pnpm, Node 22, dependencies, then runs `just ci`.
- Installed `just v1.54.0` locally under the user's Cargo bin to run M01 validation.

## Validation Summary

- Passed: `just fmt-check`
- Passed: `just clippy`
- Failed with known baseline failure: `just test-rs`
- Passed: `pnpm install --frozen-lockfile`
- Passed: `just typecheck`
- Passed: `just test-ts`

## Gaps

- During M01, `just test-rs` still failed in `crates/acpus-mock-agent/tests/protocol.rs::cancels_active_streaming_prompt` with `Os { code: 2, kind: NotFound, message: "No such file or directory" }`, matching the M00 baseline.
- During M02, this was traced to stale local target artifacts from another checkout. `cargo clean -p acpus-mock-agent` cleared the issue, and `cargo test --workspace` passed without source changes.
- `cargo-nextest` is not installed locally, so `just test-rs` used the intended fallback path: `cargo test --workspace`.

## Suggested Next Step

Proceed to M02 crate scaffolding. Keep new crates empty or minimal and do not pull future package boundaries into existing runtime/compiler code yet.

## Suggested Skills

- `codebase-design` for choosing crate-level seams that stay small and do real work later.
- `handoff` for preserving milestone-specific validation state.
