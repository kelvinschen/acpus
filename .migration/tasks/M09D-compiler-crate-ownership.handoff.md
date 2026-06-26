# M09D Handoff — Compiler Crate Ownership

Status: Completed on 2026-06-26.

## Completed Work

- Moved source-to-IR compile/lint/path APIs, include expansion, validation, lowering, schema DSL validation, and duration parsing into `acpus-compiler`.
- Added compiler-owned `CompileOptions`, `CompileResult`, `LintResult`, and `CompileOutput`.
- Removed compiler/schema/duration/compile-result ownership from `acpus-core`; core now re-exports compiler APIs as a compatibility facade.
- Copied the small agent metadata refresh helper into compiler lowering so `acpus-compiler` no longer depends on `acpus-core`.
- Preserved old public import paths through `acpus_core::*` re-exports.
- Kept runtime interpreter logic unchanged.

## Validation Summary

- `cargo test -p acpus-compiler` passed, including compiler golden snapshots.
- `cargo test -p acpus-core` passed.
- `cargo test --workspace` passed.
- `cargo fmt --all -- --check` passed.
- `cargo tree -p acpus-compiler` did not include `acpus-core`.
- `cargo insta test -p acpus-compiler` could not run because the local `cargo-insta` subcommand is not installed.

## Gaps

- `acpus-core` still owns agent override and hook utilities; those remain compatibility/runtime-adjacent surfaces for later cleanup.
- Target files `include.rs`, `validate.rs`, `lower.rs`, and `catalog.rs` were not split out yet; the moved compiler implementation currently lives mainly in `compile.rs`, with `schema.rs` and `duration.rs` separated.
- Runtime and CLI still import compiler APIs through `acpus-core` in places; compatibility is intentional until the later thin-boundary milestones.

## Suggested Next Step

Proceed to M10A by adopting `acpus-runtime-api` types in runtime-facing contracts without changing runtime behavior.

## Suggested Skills

- `codebase-design` is useful for deciding which runtime API mirrors should become source-of-truth types and which should remain adapters.
