# M09A Handoff — Source Concepts in Spec

Status: Completed on 2026-06-26.

## Completed Work

- Moved source-level diagnostics, source digest, include resolver types, filesystem workflow source resolver, and YAML parser validation into `acpus-spec`.
- Added `acpus-core` dependency on `acpus-spec` and re-exported the moved API from `acpus_core` for compatibility.
- Removed the old `acpus-core` source resolver module and the duplicate core-owned diagnostic definitions.
- Left compiler lowering behavior unchanged; compiler still validates through its current path while using the re-exported source digest.
- Added `acpus-spec` tests for minimal parsing, missing version, missing workflow steps, stable source digest, and relative include resolution.

## Validation Summary

- `cargo test -p acpus-spec` passed.
- `cargo test -p acpus-core` passed.
- `cargo test -p acpus-compiler` passed, including compiler golden snapshots.
- `cargo test --workspace` passed.
- `cargo fmt --all -- --check` passed.
- `cargo tree -p acpus-spec` did not include `acpus-core`.

## Gaps

- Compiler parsing/lowering has not yet been rewired to consume `acpus-spec::WorkflowDocument`; that belongs with later compiler ownership milestones.
- `acpus-spec::parse_workflow_yaml` performs only source/spec-shape validation and intentionally does not duplicate full compiler validation.
- `acpus-core` still owns IR and lowering types until M09B/M09D.

## Suggested Next Step

Proceed to M09B by moving IR data structures and hashing ownership into `acpus-ir`, while preserving `acpus_core` re-exports.

## Suggested Skills

- `codebase-design` remains useful for keeping the IR crate data-only and avoiding compiler/runtime dependencies.
