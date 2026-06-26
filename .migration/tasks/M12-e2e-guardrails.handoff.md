# M12 Handoff — E2E Guardrails

Status: Completed on 2026-06-26.

## Completed Work

- Added `fixtures/workflows/e2e/basic-run.workflow.yaml`, a local program-only workflow that captures JSON output.
- Added `crates/acpus-cli/tests/e2e.rs` with three E2E guardrails:
  - `basic_run_reaches_terminal_completed`
  - `cli_to_supervisor_lists_run_as_runtime_api_json`
  - `replay_uses_frozen_ir_after_yaml_changes`
- Added `just e2e`, currently running `cargo test -p acpus-cli --test e2e`.
- E2E tests use `acpus-testkit` temp workspaces and fixture loading.
- E2E tests isolate `HOME`, use the CLI to start the supervisor on dynamic ports, parse JSON through `acpus-runtime-api`, and clean up spawned supervisor processes.

## Validation Summary

- `just e2e` passed.
- `cargo test --workspace` passed.
- `pnpm --filter @acpus/tui test` passed.
- `cargo fmt --all -- --check` passed.

## Gaps

- The E2E set intentionally uses a program-only workflow, not the mock-agent binary. This avoids external agents but does not exercise mock-agent protocol in E2E.
- `just ci` does not yet include `just e2e`; M14 is still expected to wire final CI hardening.
- No TUI smoke E2E was added; existing TUI contract/integration tests remain separate.

## Suggested Next Step

Proceed to M13 and enforce crate-boundary checks now that store, supervisor, CLI contracts, and E2E guardrails exist.

## Suggested Skills

- `codebase-design` is useful for deciding which boundary checks should be hard failures versus transitional allowlists.
