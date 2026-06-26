# M16 Handoff — CLI UX Help and Diagnostics

Status: Completed on 2026-06-26.

## Completed Work

- Expanded Rust CLI help metadata for public `workflows/wf`, `runs`, and `hooks` commands.
- Added examples for high-complexity commands:
  - `workflows run`
  - `runs fork`
  - `runs signal`
  - `runs visualize`
  - `hooks validate`
- Made the `wf` alias visible in top-level help while keeping `supervisor` hidden.
- Added actionable `Hint:` text to human-facing diagnostics for conflicting submission flags, invalid `--poll`, invalid `--serve`, object payload/input errors, and workflow lookup failures.
- Added help contract tests using substring assertions instead of snapshots.
- Updated migration docs and final verification notes for the M16 CLI UX guardrail.

## Validation Summary

- `cargo test -p acpus-cli` passed.
- `just ci` passed.

## Compatibility Notes

- Exit codes are unchanged.
- JSON error envelope shape is unchanged.
- No interactive wizard, new public command, or new alias was added.
- `--input` and `--payload` now accept inline YAML objects in addition to inline JSON objects and JSON/YAML files. Existing accepted inputs and output shapes are unchanged.

## Gaps

- Help tests intentionally lock key substrings rather than full rendered help pages, so line wrapping and formatting are not snapshot-tested.
- `crates/acpus-cli/src/main.rs` remains a large file; M16 avoided broad command-module extraction.

## Suggested Next Step

If CLI maintainability becomes the next bottleneck, split `main.rs` into command/help/output modules mechanically while keeping the M16 help contract tests green.
