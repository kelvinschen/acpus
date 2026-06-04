# Error Codes Specification

## Status

- Current implementation: current
- Source modules: `src/errors.ts`, `src/schema/`, `src/compiler/`, `src/contracts/`, `src/runtime/`, `src/projections/run-diagnostics.ts`, `src/commands/`
- Maintenance trigger: update this spec when changing error shape, severity semantics, code families, stable runtime codes, output schema codes, command diagnostics, or diagnostics projections

## Purpose

Error codes provide a stable machine-readable surface for Main Agent loops, CLI users, and diagnostics.

## Normative Requirements

- Structured validation errors MUST include `code`, `severity`, `path`, `message`, and suggestions when emitted through JSON command surfaces.
- Severity `error` MUST mean the workflow is rejected until corrected.
- Runtime output parse/schema failures MUST use Agent Task Retry and MUST block with `AGENT_TASK_RETRY_EXHAUSTED` when retry budget is exhausted.
- Scheduler stale recovery exhaustion MUST use `AGENT_TASK_RETRY_EXHAUSTED` as the blocked reason; `AGENT_STAGE_STALE_RECOVERY` and `FANOUT_ITEM_STALE_RECOVERY` identify stale attempt failures.
- Runtime `failed` MUST remain reserved for infrastructure or unrecoverable runtime failures.
- Diagnostics projections MUST recognize stable runtime blocked reasons listed here.
- New stable codes MUST be documented in this SPEC in the same change that introduces them.

## Interfaces and Contracts

Stable code families:

- `SCHEMA_*`: schema version, YAML format, YAML parse, or file read errors.
- `INPUT_*`: workflow input schema DSL, default, unknown input, missing required input, or runtime input schema errors.
- `GRAPH_*`: root, dependency, cycle, unsupported branch shape, or terminal gate errors.
- `VARIABLE_*`: prompt placeholder and variable source errors.
- `ACTOR_*`: invalid actor declarations or actor mode conflicts.
- `LIMIT_*`: stage-limit validation errors.
- `ROUTE_*`: invalid route targets, route/downstream mismatch, or unmatched runtime routing.
- `FANOUT_*`: fanout shape, lane selection, item output, partial policy, or fanin requirement errors.
- `PROGRAM_*`: program task operation, command safety/runtime, or program fanin input errors.
- `OUTPUT_*`: schema DSL, parse, or schema errors.
- `LOOP_*`: loop body output or loop execution errors.
- `RUNTIME_*`: logical run index, scheduler, session, or persistence errors.
- `RESUME_*`: resume policy errors.
- `ACPX_*`: agent runtime startup, session, or turn errors.
- `INTERNAL_*`: unexpected compiler/runtime invariant failures.

Stable output codes:

- `OUTPUT_SCHEMA_DSL_INVALID`
- `OUTPUT_PARSE_FAILED`
- `OUTPUT_SCHEMA_FAILED`

Stable schema/runtime loading codes:

- `SCHEMA_FORMAT_UNSUPPORTED`
- `SCHEMA_YAML_INVALID`

Stable input codes:

- `INPUT_SCHEMA_DSL_INVALID`
- `INPUT_DEFAULT_SCHEMA_INVALID`
- `INPUT_REQUIRED`
- `INPUT_UNKNOWN`
- `INPUT_SCHEMA_INVALID`

`INPUT_REQUIRED` MUST also cover missing input-sourced limit paths when the binding has no default. `INPUT_SCHEMA_INVALID` MUST also cover invalid limit source roots/paths and source values that do not resolve to positive integer numbers.

Stable route codes:

- `ROUTE_ROUTES_MISMATCH`
- `ROUTE_TARGET_UNKNOWN`
- `ROUTE_UNMATCHED`

Stable program codes:

- `PROGRAM_TASK_OPERATION_UNKNOWN`
- `PROGRAM_COMMAND_CWD_INVALID`
- `PROGRAM_COMMAND_TIMEOUT`
- `PROGRAM_COMMAND_SPAWN_FAILED`
- `PROGRAM_COMMAND_SAFETY_VIOLATION`
- `PROGRAM_FANIN_INPUT_INVALID`

Stable fanout/loop codes:

- `FANOUT_FANIN_REQUIRED`
- `FANOUT_ITEM_BLOCKED`
- `FANOUT_ITEM_CASCADE_BLOCKED`
- `FANOUT_LANE_RESULT_MISMATCH`
- `NO_SELECTED_LANES`
- `MISSING_FANOUT_ITEM_OUTPUT`
- `FANOUT_STAGE_STUCK_PENDING_BATCH`
- `FANOUT_ITEM_RUNTIME_ERROR`
- `FANOUT_ITEM_STALE_RECOVERY`
- `LOOP_EXHAUSTED`
- `LOOP_BODY_STAGE_BLOCKED`
- `LOOP_BODY_STAGE_FAILED`
- `LOOP_BODY_OUTPUT_MISSING`
- `LOOP_BODY_OUTPUT_ROUTE_INVALID`

Stable agent/gate/runtime codes:

- `VARIABLE_UNDECLARED`
- `VARIABLE_RESOLUTION_FAILED`
- `VARIABLE_RESERVED`
- `ROUTE_AGENT_ACTOR_REQUIRED`
- `GATE_AGENT_ACTOR_REQUIRED`
- `ACTOR_MODE_CONFLICT`
- `AGENT_RUNTIME_ERROR`
- `AGENT_TURN_FAILED`
- `AGENT_TURN_CANCELLED`
- `AGENT_TASK_RETRY_EXHAUSTED`
- `AGENT_STAGE_STALE_RECOVERY`
- `GATE_CONDITION_FAILED`
- `GATE_VERDICT_BLOCKED`
- `GATE_VERDICT_FAILED`
- `GATE_VERDICT_UNKNOWN`
- `EVENT_APPEND_LOCK_TIMEOUT`
- `RUN_INDEX_LOCK_TIMEOUT`
- `RUN_INDEX_OUTPUT_MISMATCH`

## Data Model

Error data includes stable code, severity, JSON Pointer path, human-readable message, suggestions, run-level blocked reason, attempt diagnostics, output parser diagnostics, runtime diagnostics, persistence diagnostics, command diagnostics, turn diagnostics, and diagnostics projections.

## Runtime Behavior

Validation and compiler errors reject invalid specs before execution. Runtime blocked codes are persisted into `run.json` and output artifacts. Command non-zero exit codes are data and MUST NOT use `PROGRAM_COMMAND_*`; command safety, spawn, timeout, and bounded-output failures MUST use `PROGRAM_COMMAND_*`.

## Extension Points

New codes MAY be added under existing families when semantics match. New families require this SPEC update and tests.

## Non-Goals

- Error codes are not a substitute for full logs or attempt artifacts.
- Error code names are not localized.
- Removed workflow constructs do not require reverse-compatibility rejection tests.

## Implementation Map

- Error model and helpers -> `src/errors.ts`
- Schema/input errors -> `src/schema/`
- Compiler/lint errors -> `src/compiler/`
- Output diagnostics -> `src/contracts/`, `src/runtime/output-parser.ts`, `src/runtime/agent-task-retry.ts`
- Runtime diagnostics -> `src/runtime/`, `src/run-index/read-write.ts`
- Diagnostics projection -> `src/projections/run-diagnostics.ts`
- Command JSON surfaces -> `src/commands/`
