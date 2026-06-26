# M06 Handoff — Store Journal and Snapshot Trait

Status: Completed on 2026-06-26.

## Completed Work

- Replaced the placeholder `acpus-store` API with the M06 `RunStore` trait:
  - `append_event`
  - `load_events`
  - `save_snapshot`
  - `load_snapshot`
- Added `FsRunStore` using the target layout:
  - `.acpus/state/runs/<run-id>/events.jsonl`
  - `.acpus/state/runs/<run-id>/snapshot.json`
- Implemented append-only JSONL event writes.
- Implemented missing event journal as an empty event list.
- Implemented corrupt event reporting with line number.
- Implemented snapshot writes via temp file plus rename.
- Added run id validation to avoid path traversal in `acpus-store`.
- Added the required unit tests:
  - `append_and_load_events`
  - `save_and_load_snapshot`
  - `missing_events_returns_empty`
  - `corrupt_event_reports_line_number`
  - `snapshot_write_is_atomic_enough`

## Validation Summary

- Passed: `cargo test -p acpus-store`
- Passed: `cargo fmt --all -- --check`
- Passed: `cargo check --workspace`
- Passed: `just ci`

## Gaps

- Runtime still uses `crates/acpus-runtime/src/store.rs`; no production path was switched in this milestone.
- `FsRunStore` currently persists only event journal and snapshot. IR, input, artifacts, checkpoints, and richer node indexes remain in runtime store until M10B.
- Snapshot atomicity is tmp-plus-rename, not fsync-backed durability.

## Suggested Next Step

Proceed to M07 supervisor client/API boundary. Keep it typed and additive; do not move Axum server routes until M10C.

## Suggested Skills

- `codebase-design` for keeping store as a durable persistence seam instead of a runtime execution module.
- `handoff` for carrying forward the runtime-not-yet-switched gap.
