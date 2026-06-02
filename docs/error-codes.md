# Error Codes

`acpx-workflow-orchestrator` errors are designed for Main Agent repair loops. JSON output
uses:

```json
{
  "code": "VARIABLE_UNDECLARED",
  "severity": "error",
  "path": "/stages/0/prompt",
  "message": "Prompt references ${task}, but no variable named task is declared.",
  "suggestions": ["Add a variable named task to /stages/0/variables."]
}
```

Severities:

- `warning`: spec is runnable, but preview and diagnostics surfaces must expose the risk.
- `error`: spec is rejected until corrected.
- `fatal`: tooling/runtime could not safely continue.

Code families are stable and should not be renamed casually:

- `SCHEMA_*`: JSON shape, version, file read, declared input, or runtime input
  errors.
- `GRAPH_*`: root, dependency, cycle, branching, deprecated summarize, or terminal gate errors.
- `VARIABLE_*`: prompt placeholder and variable source errors.
- `ROLE_*`: unknown role or role/mode conflict.
- `LIMIT_*`: global hard limit or stage-limit errors.
- `DECISION_*`: invalid decision target/default routing.
- `DISCOVER_*`: invalid agent discover declaration.
- `FANOUT_*`: edit fanout risk or missing reconcile stage.
- `OUTPUT_*`: runtime output parse, schema, ambiguity, or repair errors.
- `RUNTIME_*`: logical run index, scheduler, session, or command errors.
- `RESUME_*`: resume policy errors.
- `ACPX_*`: `acpx/runtime` startup, session, or turn errors.
- `INTERNAL_*`: unexpected compiler/runtime invariant failure.

Output contract codes emitted by the runtime parser:

- `OUTPUT_PARSE_FAILED`: no balanced JSON object could be parsed from an agent
  response.
- `OUTPUT_SCHEMA_FAILED`: a balanced JSON object was found, but the last
  parseable object did not satisfy the stage-specific Zod-backed output
  contract.
- `OUTPUT_REPAIR_FAILED`: the one allowed schema-aware repair turn did not
  produce a valid balanced JSON object.

Output contract failures map to blocked attempt/stage/run state, not failed.
`failed` is reserved for compiler, scheduler, ACPX runtime, or other
unrecoverable runtime errors.

Runtime run-level codes emitted in diagnostics:

- `EVENT_APPEND_LOCK_TIMEOUT`: event append persistence could not acquire the
  event write lock before timeout.
- `RUN_INDEX_LOCK_TIMEOUT`: run-index persistence could not acquire the
  `run.json` write lock before timeout.
- `FANOUT_ITEM_UNSTARTED_TIMEOUT`: a fanout item remained unstarted after the
  scheduler determined it could not safely continue that item.
- `FANOUT_ITEM_BLOCKED`: fanout aggregation blocked because one or more active
  items did not complete and partial fanout was not allowed by policy.
- `MISSING_FANOUT_ITEM_OUTPUT`: a terminal fanout item did not have a readable
  output artifact when the scheduler aggregated fanout results.
- `FANOUT_STAGE_STUCK_PENDING_BATCH`: a fanout stage had queued item state
  that could not progress to terminal item results.
- `RUN_INDEX_OUTPUT_MISMATCH`: persisted run-index state and output artifacts
  disagree about a stage or item result.
- `AGENT_RUNTIME_ERROR`: a non-fanout agent runtime turn failed after one
  transient retry. This covers backend/process/transport failures, not output
  contract failures.
- `FANOUT_ITEM_RUNTIME_ERROR`: a fanout item runtime turn failed after one
  transient retry, or stale recovery exhausted its retry for that item.
- `FANOUT_ITEM_CASCADE_BLOCKED`: a queued fanout item was not launched because
  an earlier item blocked or failed while partial fanout was disabled. The
  scheduler lets already-running items settle, then aggregates the fanout stage
  as blocked.
- `GATE_CONDITION_FAILED`: a program gate condition evaluated false.
- `GATE_VERDICT_BLOCKED`: the terminal gate returned `verdict: "blocked"`.
- `GATE_VERDICT_FAILED`: the terminal gate returned `verdict: "failed"`. The
  run records a blocked workflow outcome; runtime `failed` remains reserved for
  infrastructure failures.
- `GATE_VERDICT_UNKNOWN`: the terminal gate returned `verdict: "unknown"`.
  Inspect the gate output and any upstream fanout item outputs before treating
  the workflow as verified.
Command and turn diagnostics:

- `RUNTIME_COMMAND_ERROR`: a CLI command caught an unrecoverable runtime command
  error and returned a fatal structured error.
- `AGENT_TURN_FAILED`: an ACPX turn ended as failed or did not produce a usable
  runtime result.
- `AGENT_TURN_CANCELLED`: an ACPX turn ended as cancelled and the cancellation
  is preserved for diagnostics.
