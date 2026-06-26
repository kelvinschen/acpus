# Testing Strategy

## Compiler Guardrails

Compiler golden tests in `crates/acpus-compiler/tests/compiler_golden.rs` compile workflow fixtures through the `acpus-compiler` facade. Valid fixtures snapshot diagnostics, IR, and schedule. Invalid fixtures snapshot diagnostics only.

These tests intentionally call the current `acpus-core` compiler through the facade. They should fail if a later move into `acpus-spec`, `acpus-ir`, `acpus-expr`, or `acpus-compiler` changes observable compiler output.

## Fixture Policy

- Keep fixtures small and named after the behavior they protect.
- Put supported behavior under `fixtures/workflows/valid` or `fixtures/workflows/invalid`.
- Put planned-but-unsupported behavior under a `todo` subdirectory so it cannot make required tests red.
- Snapshot changes must be reviewed as behavior changes, not accepted mechanically.

## Verification Flow

```text
cargo fmt --all -- --check
cargo test -p acpus-compiler
cargo test --workspace
just ci
```

The full migration keeps the same direction:

```text
workflow YAML -> acpus-spec -> acpus-compiler -> acpus-ir -> acpus-runtime
-> acpus-store -> acpus-supervisor -> acpus-runtime-api -> TS bindings -> TUI/WebUI
```
