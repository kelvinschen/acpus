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

- `warning`: spec is runnable, but the preview/report must surface the risk.
- `error`: spec is rejected until corrected.
- `fatal`: tooling/runtime could not safely continue.

Code families are stable and should not be renamed casually:

- `SCHEMA_*`: JSON shape, version, file read, declared input, or runtime input
  errors.
- `GRAPH_*`: root, dependency, cycle, branching, or summarize-terminal errors.
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

Runtime run-level codes emitted in reports:

- `EVENT_APPEND_LOCK_TIMEOUT`: event append persistence could not acquire the
  event write lock before timeout.
- `RUN_INDEX_LOCK_TIMEOUT`: run-index persistence could not acquire the
  `run.json` write lock before timeout.
- `FANOUT_ITEM_UNSTARTED_TIMEOUT`: a fanout item remained unstarted after the
  scheduler determined it could not safely continue that item.
- `FANOUT_STAGE_STUCK_PENDING_BATCH`: a fanout stage had pending batch state
  that could not progress to terminal item results.
- `RUN_INDEX_OUTPUT_MISMATCH`: persisted run-index state and output artifacts
  disagree about a stage or item result.
- `AGENT_RUNTIME_ERROR`: a non-fanout agent runtime turn failed after one
  transient retry. This covers backend/process/transport failures, not output
  contract failures.
- `FANOUT_ITEM_RUNTIME_ERROR`: a fanout item runtime turn failed after one
  transient retry, or stale recovery exhausted its retry for that item.
- `FINAL_VERDICT_BLOCKED`: the terminal summarizer completed but explicitly
  returned `finalVerdict: "blocked"`, so the run is blocked at run level even
  if author stages are otherwise terminal.
- `FINAL_VERDICT_FAILED`: the terminal summarizer completed but explicitly
  returned `finalVerdict: "failed"`. The run records a blocked workflow outcome;
  runtime `failed` remains reserved for infrastructure failures.
- `FINAL_VERDICT_UNKNOWN`: the terminal summarizer completed but could not
  determine a pass/fail outcome. Inspect the summarizer output and any upstream
  fanout item outputs before treating the workflow as verified.
- `LIMIT_AGENT_BUDGET_EXHAUSTED`: a run had ready agent work but
  `agentUsage.actual` had already reached `limits.maxAgents`. The scheduler
  terminalizes the ready stage as blocked instead of leaving the run in
  `running`.

Command and turn diagnostics:

- `RUNTIME_COMMAND_ERROR`: a CLI command caught an unrecoverable runtime command
  error and returned a fatal structured error.
- `AGENT_TURN_FAILED`: an ACPX turn ended as failed or did not produce a usable
  runtime result.
- `AGENT_TURN_CANCELLED`: an ACPX turn ended as cancelled and the cancellation
  is preserved for diagnostics.
