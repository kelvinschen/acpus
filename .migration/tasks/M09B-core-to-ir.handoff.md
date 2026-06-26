# M09B Handoff — IR Ownership in `acpus-ir`

Status: Completed on 2026-06-26.

## Completed Work

- Replaced the provisional `acpus-ir` model with the real compiled IR contract: `AcpusIr`, node/branch types, agent specs, node key templates, output merge, expressions, and schedule summary types.
- Moved IR digest, generic JSON digest, node definition hashes, workflow-aware node hashes, schedule construction, and node path string helpers into `acpus-ir`.
- Kept `acpus-core` as a compatibility facade by re-exporting the moved IR and hash API.
- Removed core-owned `hash` and `schedule` modules.
- Added direct `acpus-ir` dependencies to `acpus-core`, `acpus-compiler`, and `acpus-runtime`.
- Updated runtime IR type/hash imports to use `acpus-ir` directly while leaving compiler/eval APIs on `acpus-core`.
- Added `acpus-ir` tests for stable IR digest, serde roundtrip, node path strings, schedule summary shape, node hash identity exclusion, and workflow-context-sensitive hashing.

## Validation Summary

- `cargo test -p acpus-ir` passed.
- `cargo test -p acpus-compiler` passed, including compiler golden snapshots.
- `cargo test -p acpus-runtime` passed.
- `cargo test --workspace` passed.
- `cargo fmt --all -- --check` passed.
- `cargo tree -p acpus-ir` did not include `acpus-core` or `acpus-runtime`.

## Gaps

- `acpus-runtime-api` still carries its own generated contract mirror of IR types; contract unification belongs with later runtime API adoption work.
- `acpus-core` still owns compiler lowering and expression evaluation, so it remains the compatibility bridge for compile-time behavior.
- The moved IR hash implementation still depends on `cel` to detect workflow references in expressions; this preserves existing behavior but makes `acpus-ir` more than pure data.

## Suggested Next Step

Proceed to M09C by extracting expression evaluation/rendering and CEL helper ownership into `acpus-expr`, with `acpus-core` re-exporting the old API.

## Suggested Skills

- `codebase-design` is useful for deciding how much CEL behavior belongs in `acpus-expr` versus compiler validation.
