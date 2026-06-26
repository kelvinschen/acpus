# M03 Handoff — Docs, Fixtures, Compiler Golden Tests

Status: Completed on 2026-06-26.

## Completed Work

- Added refactor docs:
  - `docs/refactor/rfc-000-rust-first-boundaries.md`
  - `docs/refactor/migration-matrix.md`
  - `docs/refactor/testing-strategy.md`
- Added workflow fixtures under `fixtures/workflows`:
  - valid: `basic-agent`, `program-json-output`, `include-basic`, `retry-policy`
  - invalid: `missing-version`, `duplicate-step-id`, `invalid-cel`, `bad-include`
  - include support file: `valid/include-basic.child.yaml`
- Added `insta` as the `acpus-compiler` dev snapshot dependency.
- Added `crates/acpus-compiler/tests/compiler_golden.rs`.
- Generated JSON snapshots under `crates/acpus-compiler/tests/snapshots`.
- Re-exported `CompileOptions` and `CompileResult` from `acpus-compiler` so facade tests and later callers do not need to reach around the facade for common compiler types.

## Validation Summary

- Passed: `INSTA_UPDATE=always cargo test -p acpus-compiler --test compiler_golden`
- Environment note: `cargo insta review || true` reported `error: no such command: insta`; no `cargo-insta` CLI is installed locally.
- Passed: `cargo test -p acpus-compiler --test compiler_golden`
- Passed: `cargo fmt --all -- --check`
- Passed: `cargo test -p acpus-compiler`
- Passed: `cargo test --workspace`

## Gaps

- The snapshots currently guard the old compiler behavior through the `acpus-compiler` facade; ownership still lives in `acpus-core`.
- Fixture coverage is intentionally minimal. Later milestones should add targeted fixtures when migrating source resolver, expression validation, IR hashing, and lowering internals.
- `cargo-insta` is not installed locally, so snapshot review used the generated `.snap` files directly rather than the interactive review CLI.

## Suggested Next Step

Proceed to M04 runtime API and TS bindings. Keep generated contract work additive and avoid changing TUI consumption until M05.

## Suggested Skills

- `codebase-design` for keeping the compiler facade as the test surface while moving internals later.
- `handoff` for preserving snapshot and fixture review state.
