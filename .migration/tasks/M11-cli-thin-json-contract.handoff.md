# M11 Handoff — CLI JSON Contract Tests

Status: Completed on 2026-06-26.

## Completed Work

- Added black-box CLI integration tests under `crates/acpus-cli/tests/`:
  - `workflows_command.rs`
  - `runs_command.rs`
  - `json_contract.rs`
- Covered `acpus workflows list --json` against an isolated project catalog.
- Covered `acpus workflows lint <fixture> --json` and verified diagnostics are emitted as JSON on failure.
- Covered `acpus runs list --json` and deserialized output as `Vec<acpus_runtime_api::RunSummary>`.
- Covered `acpus workflows run <fixture> --background --json` followed by `acpus runs show <id> --json`, deserializing both through `acpus_runtime_api::RunState`.
- Covered invalid command behavior: non-zero exit, empty stdout, stderr populated by clap.
- Isolated black-box tests with temporary workspaces and separate `HOME` values to avoid project/global catalog overlap.
- Added supervisor cleanup for tests that start the workspace supervisor.

## Validation Summary

- `cargo test -p acpus-cli` passed.
- `cargo test --workspace` passed.
- `cargo fmt --all -- --check` passed.

## Gaps

- `crates/acpus-cli/src/main.rs` is still a large binary file; command modules, `output.rs`, and `tui_launcher.rs` have not yet been extracted.
- CLI still has a richer local `RunSupervisorClient` wrapper instead of using only `acpus-supervisor::SupervisorClient`.
- JSON output is now covered by black-box tests for key workflows/runs paths, but not every command/subcommand has a contract test.
- Human output and JSON output formatting are still colocated in `main.rs`.

## Suggested Next Step

Proceed to M12 for end-to-end guardrails. If CLI maintainability becomes a blocker before M12, split `main.rs` mechanically in a separate M11B without changing command behavior.

## Suggested Skills

- `codebase-design` is useful for extracting command modules around stable parse/dispatch/output interfaces instead of moving functions by topic alone.
