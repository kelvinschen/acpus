# M02 Handoff — Crate Scaffolding

Status: Completed on 2026-06-26.

## Completed Work

- Added eight Rust-first workspace crates:
  - `crates/acpus-spec`
  - `crates/acpus-ir`
  - `crates/acpus-expr`
  - `crates/acpus-compiler`
  - `crates/acpus-runtime-api`
  - `crates/acpus-store`
  - `crates/acpus-supervisor`
  - `crates/acpus-testkit`
- Updated root `Cargo.toml` workspace members and workspace path dependencies for the new crates.
- Added minimal compiling interfaces:
  - `acpus-spec`: diagnostics, workflow document, source resolver trait, YAML parse entry.
  - `acpus-ir`: IR/node structs, node kind enum, SHA-256 IR digest helper.
  - `acpus-expr`: `EvalScope` and basic template rendering boundary.
  - `acpus-compiler`: compatibility facade over `acpus-core` compiler functions plus `compile_snapshot`.
  - `acpus-runtime-api`: initial JSON contract types for run/node/supervisor/API errors.
  - `acpus-store`: `RunStore` trait and in-memory adapter.
  - `acpus-supervisor`: typed `SupervisorClient` shell with no HTTP implementation yet.
  - `acpus-testkit`: `TestWorkspace` temp workspace helper.
- Updated `Cargo.lock` as a necessary side effect of adding workspace crates and resolving their dependencies.
- Did not move existing `acpus-core`, runtime, store, supervisor, interpreter, CLI, or TUI implementation code.

## Validation Summary

- Passed: `cargo metadata --format-version=1 >/dev/null`
- Passed: `cargo fmt --all -- --check`
- Passed: `cargo check --workspace`
- Passed after clearing stale local artifacts: `cargo test --workspace`
- Passed: `just ci`

## Local Environment Note

The M00/M01 Rust test failure was traced to a stale `target/debug/deps/protocol-*` binary that had `CARGO_BIN_EXE_acpus-mock-agent` hardcoded to another checkout path:

```text
/data00/home/chenqiren.kyran/kprojects/acpus_next_rust/target/debug/acpus-mock-agent
```

Running `cargo clean -p acpus-mock-agent` removed the stale artifact. `cargo test --workspace` and `just ci` then passed without source changes.

## Gaps

- New crates are intentionally skeletal. They define seams and minimal types but do not yet own migrated behavior.
- `acpus-compiler` still delegates to `acpus-core`.
- `acpus-store` only has an in-memory adapter; durable journal/snapshot work remains for M06/M10B.
- `acpus-supervisor` has no transport implementation yet; HTTP/SSE extraction remains for M07/M10C.
- Runtime and CLI still use old direct `acpus-core` and runtime contracts.

## Suggested Next Step

Proceed to M03 docs, fixtures, and compiler golden tests. Use `acpus-compiler::compile_snapshot` as the initial facade for golden coverage instead of moving compiler internals.

## Suggested Skills

- `codebase-design` for keeping new crate interfaces small while migrating behavior behind them.
- `handoff` for continuing milestone-level state capture.
