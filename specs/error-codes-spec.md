# Error Codes Specification

## Status

- Current implementation: current
- Source modules: `src/errors.ts`, `src/schema/`, `src/compiler/`, `src/contracts/`, `src/runtime/`, `src/reports/`, `src/commands/`
- Maintenance trigger: update this spec when changing error shape, severity semantics, code families, stable runtime codes, output-contract codes, repair suggestions, or report diagnostics

## Purpose

Error codes provide a stable repair-oriented surface for Main Agent loops, CLI users, reports, and diagnostics. They identify validation, compiler, runtime, output-contract, resume, ACPX, and internal failures.

## Normative Requirements

- Structured errors MUST include `code`, `severity`, `path`, `message`, and `suggestions` when emitted through the repair-oriented JSON surface.
- Severity `warning` MUST mean the spec is runnable, but preview/report surfaces should expose the risk.
- Severity `error` MUST mean the spec is rejected until corrected.
- Severity `fatal` MUST mean tooling or runtime could not safely continue.
- Error code families MUST remain stable and MUST NOT be renamed casually.
- Output contract failures MUST map to blocked attempt/stage/run state, not failed infrastructure state.
- Runtime `failed` MUST remain reserved for compiler, scheduler, ACPX runtime, or other unrecoverable runtime errors.
- Reports MUST surface run-level runtime diagnostic codes when present.

## Interfaces and Contracts

Repair-oriented JSON output uses this shape:

```json
{
  "code": "VARIABLE_UNDECLARED",
  "severity": "error",
  "path": "/stages/0/prompt",
  "message": "Prompt references ${task}, but no variable named task is declared.",
  "suggestions": ["Add a variable named task to /stages/0/variables."]
}
```

Stable code families:

- `SCHEMA_*`: JSON shape, version, file read, declared input, or runtime input errors.
- `GRAPH_*`: root, dependency, cycle, branching, deprecated summarize, or terminal gate errors.
- `VARIABLE_*`: prompt placeholder and variable source errors.
- `ROLE_*`: unknown role or role/mode conflict.
- `LIMIT_*`: stage-limit validation errors.
- `DECISION_*`: invalid decision target/default routing.
- `DISCOVER_*`: invalid agent discover declaration.
- `FANOUT_*`: edit fanout risk or missing reconcile stage.
- `OUTPUT_*`: runtime output parse, schema, ambiguity, or repair errors.
- `RUNTIME_*`: logical run index, scheduler, session, or command errors.
- `RESUME_*`: resume policy errors.
- `ACPX_*`: `acpx/runtime` startup, session, or turn errors.
- `INTERNAL_*`: unexpected compiler/runtime invariant failure.

Stable output contract codes:

- `OUTPUT_PARSE_FAILED`
- `OUTPUT_SCHEMA_FAILED`
- `OUTPUT_REPAIR_FAILED`

Stable runtime run-level codes:

- `EVENT_APPEND_LOCK_TIMEOUT`
- `RUN_INDEX_LOCK_TIMEOUT`
- `FANOUT_ITEM_UNSTARTED_TIMEOUT`
- `FANOUT_ITEM_BLOCKED`
- `FANOUT_ITEM_CASCADE_BLOCKED`
- `FANOUT_LANE_SELECTION_FAILED`
- `NO_MATCHING_LANES`
- `MISSING_FANOUT_ITEM_OUTPUT`
- `FANOUT_STAGE_STUCK_PENDING_BATCH`
- `RUN_INDEX_OUTPUT_MISMATCH`
- `AGENT_RUNTIME_ERROR`
- `AGENT_STAGE_STALE_RECOVERY`
- `FANOUT_ITEM_RUNTIME_ERROR`
- `FANOUT_ITEM_STALE_RECOVERY`
- `GATE_CONDITION_FAILED`
- `GATE_VERDICT_BLOCKED`
- `GATE_VERDICT_FAILED`
- `GATE_VERDICT_UNKNOWN`

Stable command and turn diagnostics:

- `RUNTIME_COMMAND_ERROR`
- `AGENT_TURN_FAILED`
- `AGENT_TURN_CANCELLED`

## Data Model

Error data includes stable code, severity, JSON Pointer path, human-readable message, repair suggestions, run-level blocked reason, attempt diagnostics, output parser diagnostics, runtime diagnostics, persistence diagnostics, command diagnostics, turn diagnostics, and report diagnostic projection.

## Runtime Behavior

Validation and compiler errors reject invalid specs before execution. Output parser errors block the affected attempt/stage/run and remain repair-oriented. ACPX runtime errors receive the runtime retry behavior defined by the runtime SPEC. `AGENT_RUNTIME_ERROR` and `FANOUT_ITEM_RUNTIME_ERROR` MUST represent true agent runtime throw/failure paths, not scheduler stale recovery. `AGENT_STAGE_STALE_RECOVERY` and `FANOUT_ITEM_STALE_RECOVERY` MUST mark scheduler stale recovery after a running attempt has no terminal output and no same-attempt heartbeat for the effective stage timeout plus grace interval. Runtime diagnostic error codes SHOULD match the terminal blocked reason for runtime and stale-recovery output artifacts. Persistence lock timeouts and run-index/output mismatches are surfaced as stable runtime diagnostics. `FANOUT_ITEM_BLOCKED` marks fanout aggregation blocked because one or more active items did not complete. `FANOUT_LANE_SELECTION_FAILED` marks a `oneOf` lane group selection error for an item. `NO_MATCHING_LANES` marks a skipped item that produced no lane work units across all lane groups. `MISSING_FANOUT_ITEM_OUTPUT` marks a terminal fanout item or lane whose expected output artifact could not be read during aggregation. `FANOUT_ITEM_CASCADE_BLOCKED` marks queued fanout work that was not launched after an `allowPartial: false` item failure. Gate verdict codes convert terminal gate outputs into run-level blocked outcomes when the gate returns blocked, failed, or unknown verdicts. `GATE_CONDITION_FAILED` blocks a run when a program gate condition evaluates false.

## Extension Points

New error codes MAY be added under an existing family when the family semantics match. New families require updating this SPEC and developer documentation. New stable report diagnostics MUST be documented here.

## Non-Goals

- Error codes are not a substitute for full logs or attempt artifacts.
- Error code names are not localized.
- Runtime `failed` is not used for agent output contract failures.

## Implementation Map

- Error model and helpers -> `src/errors.ts`
- Schema/input errors -> `src/schema/`
- Compiler/lint errors -> `src/compiler/`
- Output contract diagnostics -> `src/contracts/`, `src/runtime/output-parser.ts`, `src/runtime/repair.ts`
- Runtime diagnostics -> `src/runtime/`
- Run-index and persistence diagnostics -> `src/run-index/read-write.ts`
- Report diagnostics -> `src/projections/run-report.ts`, `src/projections/run-view.ts`, `src/reports/`
- Command JSON surfaces -> `src/commands/`
