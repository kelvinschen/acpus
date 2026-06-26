# M00 Handoff — Preflight Baseline

Status: Completed on 2026-06-26.

## Completed Work

- Ran the M00 preflight commands on branch `next/rust-port` at commit `200ea50`.
- Recorded tool versions and baseline command outcomes in `docs/refactor/baseline.md`.
- Did not modify Rust or TypeScript business code.
- Marked `.migration/tasks/M00-preflight-baseline.md` as completed.

## Validation Summary

- Passed: `cargo fmt --all -- --check`
- Passed: `cargo clippy --workspace --all-targets -- -D warnings`
- Failed baseline: `cargo test --workspace`
- Passed: `pnpm install --frozen-lockfile`
- Passed: `pnpm typecheck`
- Failed baseline: `pnpm test`

## Gaps

- During M00, `cargo test --workspace` failed in `crates/acpus-mock-agent/tests/protocol.rs::cancels_active_streaming_prompt` because the test unwrapped an `Os { code: 2, kind: NotFound, message: "No such file or directory" }` at line 49.
- During M02, this was traced to a stale local test binary that pointed at a different checkout path. `cargo clean -p acpus-mock-agent` cleared the issue, and `cargo test --workspace` passed without source changes.
- The migration task pack is currently uncommitted and appears as newly added files in `git status --short`.

## Suggested Next Step

Proceed to M01 tooling foundation. Treat the mock-agent protocol integration failure as baseline debt unless M01 or a later task explicitly owns test harness/tooling fixes.

## Suggested Skills

- `codebase-design` for keeping future crate seams small and deep.
- `handoff` when summarizing milestone state for another session.
