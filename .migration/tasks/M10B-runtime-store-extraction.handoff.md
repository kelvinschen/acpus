# M10B Handoff — Runtime Store Extraction

Status: Completed on 2026-06-26.

## Completed Work

- Moved the existing durable `.acpus/state` filesystem store implementation from `acpus-runtime` into `acpus-store` as `FsRunStore`.
- Moved persisted runtime DTOs such as `RunState`, `RunSummary`, `NodeExecutionState`, checkpoint, clean-run, lineage, submission, telemetry, and hook journal records into `acpus-store`.
- Kept runtime source compatibility by re-exporting `acpus_store::FsRunStore` as `acpus_runtime::RunStore`.
- Deleted the old `crates/acpus-runtime/src/store.rs` and `crates/acpus-runtime/src/types.rs` modules after runtime compiled against `acpus-store`.
- Kept the existing state layout intact: `run.json`, `ir.json`, `input.json`, `nodes/*.json`, `node-index.jsonl`, `checkpoints.index.json`, `hook-config.json`, `hook-journal.jsonl`, and artifact directories remain in the same locations.
- Renamed the earlier append-only M06 store abstractions to avoid collision with the filesystem store: `RunStore` became `RunEventStore`, and `FsRunStore` became `JsonlRunEventStore`.
- Added private artifact/storage-key helpers inside `acpus-store` for persistence internals without exporting those helpers as public API.

## Validation Summary

- `cargo test -p acpus-store` passed.
- `cargo test -p acpus-runtime` passed.
- `cargo test --workspace` passed.
- `cargo fmt --all -- --check` passed.

## Gaps

- Runtime still depends on a concrete filesystem store alias instead of a generic `RunStore` trait or `Arc<dyn RunStore>` seam.
- `Supervisor` and artifact serving still access filesystem paths through `FsRunStore::state_dir` and `FsRunStore::run_dir`; this keeps behavior stable but leaves some filesystem knowledge above the store layer.
- Runtime artifact URI/path helpers remain in `acpus-runtime` for serving and agent execution, while private duplicated helpers exist in `acpus-store` for persistence copy/rewrite logic.
- Store errors remain mostly `anyhow` for the filesystem store; only the append-only event journal has a typed `StoreError`.

## Suggested Next Step

Proceed to M10C and extract the supervisor server boundary. Keep the current concrete `RunStore` alias until supervisor filesystem coupling is reduced; introducing a trait before that would require exposing path-oriented methods on the trait and would not meaningfully deepen the interface.

## Suggested Skills

- `codebase-design` is useful for deciding whether M10C should first separate HTTP handlers from process/runtime orchestration before attempting a trait-based store seam.
