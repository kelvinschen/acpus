# M07 Handoff — Supervisor Client Boundary

Status: Completed on 2026-06-26.

## Completed Work

- Implemented `acpus-supervisor::SupervisorClient` as a typed async HTTP client backed by `reqwest`.
- Added typed methods for health, run listing, run state, IR loading, signal, replay, and fork.
- Added `SupervisorClientError` with transport, JSON, and HTTP status/body variants.
- Routed request and response payloads through `acpus-runtime-api` types where the endpoint contract is stable.
- Kept Axum server routes, CLI behavior, and TUI client unchanged.

## Validation Summary

- `cargo test -p acpus-supervisor` passed.
- `cargo check --workspace` passed.
- `cargo fmt --all -- --check` passed.
- `just ci` passed after M07.

## Gaps

- `fork` still returns `serde_json::Value` because that endpoint has mixed dry-run/apply response shapes.
- `signal` intentionally takes a `NodeKey` and returns `NodeExecutionState` to match the current server route, `/runs/{runId}/signal?key=...`; this differs from the initial task sketch but avoids inventing a contract that the existing server does not expose.
- Server route ownership is still in the existing runtime/supervisor surface and should move during M10C.
- CLI and TUI clients have not been switched to this Rust client.

## Suggested Next Step

Proceed to M08 by building the reusable `acpus-testkit` harness for temp workspaces, fixture loading, JSON writers, and command-helper skeletons.

## Suggested Skills

- `codebase-design` remains useful for keeping testkit as a deep test-only helper rather than leaking test API into production crates.
