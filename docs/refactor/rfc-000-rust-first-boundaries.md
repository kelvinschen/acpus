# RFC 000: Rust-first Boundaries

Status: Draft baseline for the migration.

## Target Flow

```text
workflow YAML -> acpus-spec -> acpus-compiler -> acpus-ir -> acpus-runtime
-> acpus-store -> acpus-supervisor -> acpus-runtime-api -> TS bindings -> TUI/WebUI
```

## Boundary Intent

- `acpus-spec` owns source-level workflow documents, diagnostics, and source resolution.
- `acpus-compiler` owns lowering from validated workflow documents into stable IR.
- `acpus-ir` owns stable IR data shapes, digests, and schedule-facing summaries.
- `acpus-runtime` owns local execution and interpreter behavior, without HTTP/client/UI concerns.
- `acpus-store` owns durable run persistence, journal, snapshots, and replay inputs.
- `acpus-supervisor` owns HTTP/SSE transport and typed client behavior.
- `acpus-runtime-api` owns the Rust/TS JSON contract source of truth.
- `packages/tui` consumes generated API bindings and keeps display logic only.

## Migration Rule

Keep old `acpus-core` and `acpus-runtime` public surfaces available until the replacement crates own behavior and tests. New crates should start as small seams and gain implementation only when a milestone moves a specific behavior behind that interface.
