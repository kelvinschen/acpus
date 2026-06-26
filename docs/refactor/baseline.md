# Refactor Baseline — M00

Date: 2026-06-26
Branch: `next/rust-port`
Commit: `200ea50`

## Workspace State

`git status --short` reported the migration task pack as newly added:

```text
A  .migration/CODEX_MASTER_PROMPT.md
A  .migration/README.md
A  .migration/tasks/M00-preflight-baseline.md
A  .migration/tasks/M01-tooling-foundation.md
A  .migration/tasks/M02-crate-scaffolding.md
A  .migration/tasks/M03-docs-fixtures-compiler-golden.md
A  .migration/tasks/M04-runtime-api-bindings.md
A  .migration/tasks/M05-tui-generated-contract.md
A  .migration/tasks/M06-store-journal.md
A  .migration/tasks/M07-supervisor-client-boundary.md
A  .migration/tasks/M08-testkit-integration-harness.md
A  .migration/tasks/M09A-core-to-spec.md
A  .migration/tasks/M09B-core-to-ir.md
A  .migration/tasks/M09C-core-to-expr.md
A  .migration/tasks/M09D-compiler-crate-ownership.md
A  .migration/tasks/M10A-runtime-api-adoption.md
A  .migration/tasks/M10B-runtime-store-extraction.md
A  .migration/tasks/M10C-supervisor-server-extraction.md
A  .migration/tasks/M10D-runtime-engine-state-machine.md
A  .migration/tasks/M11-cli-thin-json-contract.md
A  .migration/tasks/M12-e2e-guardrails.md
A  .migration/tasks/M13-remove-shims-enforce-boundaries.md
A  .migration/tasks/M14-final-ci-hardening.md
```

No Rust or TypeScript business code was modified during M00.

## Tool Versions

- `rustc --version`: `rustc 1.96.0 (ac68faa20 2026-05-25)`
- `cargo --version`: `cargo 1.96.0 (30a34c682 2026-05-25)`
- `node --version`: `v24.15.0`
- `pnpm --version`: `9.7.0`

## Baseline Commands

| Command | Status | Notes |
|---|---:|---|
| `cargo fmt --all -- --check` | Pass | No formatting drift. |
| `cargo clippy --workspace --all-targets -- -D warnings` | Pass | Workspace clippy completed cleanly. |
| `cargo test --workspace` | Fail | `crates/acpus-mock-agent/tests/protocol.rs::cancels_active_streaming_prompt` panicked at line 49 while unwrapping `Os { code: 2, kind: NotFound, message: "No such file or directory" }`. |
| `pnpm install --frozen-lockfile` | Pass | Lockfile was up to date; Node emitted a `DEP0169` warning for `url.parse()`. |
| `pnpm typecheck` | Pass | `pnpm --filter @acpus/tui typecheck` completed cleanly. |
| `pnpm test` | Fail | Fails during the `cargo test --workspace` phase on the same mock-agent protocol test before Vitest runs. |

## Known Baseline Gap

The baseline is not fully green because `acpus-mock-agent` has one failing integration test:

```text
test cancels_active_streaming_prompt ... FAILED
thread 'cancels_active_streaming_prompt' panicked at crates/acpus-mock-agent/tests/protocol.rs:49:10:
called `Result::unwrap()` on an `Err` value: Os { code: 2, kind: NotFound, message: "No such file or directory" }
```

M00 records this as pre-existing baseline state and does not change source code to address it.

## Follow-up Resolution

During M02, the failure was traced to a stale test binary in `target/debug/deps` that had been compiled with `CARGO_BIN_EXE_acpus-mock-agent` pointing at a different checkout:

```text
/data00/home/chenqiren.kyran/kprojects/acpus_next_rust/target/debug/acpus-mock-agent
```

After `cargo clean -p acpus-mock-agent`, `cargo test --workspace` passed without source changes. Treat the M00 failure as local target-cache pollution rather than product or test-code debt.
