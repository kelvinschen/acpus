# M10C Handoff — Supervisor Server Extraction

Status: Completed on 2026-06-26.

## Completed Work

- Moved the Axum supervisor server/routes from `acpus-runtime` to `acpus-supervisor/src/server.rs`.
- Moved the existing reqwest supervisor client into `acpus-supervisor/src/client.rs`.
- Updated `acpus-supervisor/src/lib.rs` to export `Supervisor`, `SupervisorHandle`, `SupervisorMetadata`, `SupervisorClient`, and `SupervisorClientError`.
- Removed `crates/acpus-runtime/src/supervisor.rs` and removed the runtime public re-export of supervisor server types.
- Removed `axum` and `reqwest` from `acpus-runtime` dependencies.
- Added `acpus-supervisor` as the CLI dependency for supervisor server/metadata types.
- Kept endpoint paths and route behavior unchanged; the moved route tests continue to exercise the same API surface.

## Validation Summary

- `cargo test -p acpus-supervisor` passed.
- `cargo test -p acpus-runtime` passed.
- `cargo test -p acpus-cli` passed.
- `cargo tree -p acpus-runtime --edges normal | grep -E 'axum|reqwest' && exit 1 || true` passed.
- `cargo test --workspace` passed.
- `cargo fmt --all -- --check` passed.

## Gaps

- The moved server code is still a single large module rather than split into `routes.rs`, `server.rs`, and smaller handler modules.
- The API tests remain as `server::tests` in `acpus-supervisor`; they were not converted into the requested `tests/api_runs.rs` and `tests/api_errors.rs` integration-test files.
- CLI still has its own richer HTTP wrapper for run-control flows because `acpus-supervisor::SupervisorClient` does not yet cover every CLI endpoint/header/error-mode need.
- `acpus-supervisor` still directly calls compile/runtime functions instead of going through a formal runtime service trait.
- There was no existing HTTP SSE transport in the moved module; no `sse.rs` was created.

## Suggested Next Step

Proceed to M10D and extract runtime engine/state-machine boundaries. Avoid splitting the supervisor server further until the runtime service interface is clearer; otherwise route code will keep importing many individual runtime functions.

## Suggested Skills

- `codebase-design` is useful for choosing the service interface between supervisor transport and runtime execution semantics.
