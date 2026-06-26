# M10D Handoff — Runtime Engine and State Machine

Status: Completed on 2026-06-26.

## Completed Work

- Added pure event-folding APIs in `acpus-runtime/src/state_machine.rs`:
  - `StateError`
  - `apply_event`
  - `derive_state`
- Added state-machine tests for:
  - completed node advancing a run to completed
  - failed node marking a run failed
  - cancelled summary preserving terminal cancellation
  - paused node deriving paused run state
  - missing initial run event validation
- Added `acpus-runtime/src/effects.rs` with explicit effect/request/outcome data types and runner traits:
  - `RuntimeEffect`
  - `AgentRunner`
  - `ProgramRunner`
  - `Clock` / `SystemClock`
  - `IdGenerator`
- Added `acpus-runtime/src/engine.rs` with `RuntimeEngine` as the new orchestration boundary around the existing `execute_ir` path.
- Exported the new engine/effects APIs from `acpus-runtime`.
- Kept interpreter scheduling and execution behavior unchanged.

## Validation Summary

- `cargo test -p acpus-runtime` passed.
- `cargo test -p acpus-runtime --tests` passed.
- `cargo test --workspace` passed.
- `cargo fmt --all -- --check` passed.

## Gaps

- `interpreter.rs` is still the large execution implementation; it has not yet been split into `agent`, `program`, `composite`, and `control` submodules.
- `RuntimeEffect` is not yet wired into interpreter planning/execution; it is a boundary vocabulary for the next migration slice.
- `AgentRunner` and `ProgramRunner` are not yet used by production execution, so agent/program effects are not fully mockable.
- `RuntimeEngine` currently delegates to `execute_ir`; it does not yet implement event append, effect planning, or effect execution loops itself.
- The pure event-folding state machine uses the public `acpus-runtime-api::RunEvent` stream, while the current durable filesystem runtime still uses direct state-file mutation.

## Suggested Next Step

Proceed to M11 only if the immediate goal is CLI boundary cleanup. If runtime decomposition remains the priority, add a follow-up M10D2 before M11 to mechanically split `interpreter.rs` into `interpreter/mod.rs`, `agent.rs`, `program.rs`, `signal.rs`, and `composite.rs` without changing behavior.

## Suggested Skills

- `codebase-design` is useful for deciding whether the next runtime slice should deepen the engine/effect interface or first mechanically split interpreter modules.
