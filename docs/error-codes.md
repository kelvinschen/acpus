# Error Codes

Acpus errors are designed for Main Agent repair loops. Each error carries a structured payload:

```json
{
  "code": "VARIABLE_UNDECLARED",
  "severity": "error",
  "path": "/stages/0/prompt",
  "message": "Prompt references ${task}, but no variable named task is declared.",
  "suggestions": ["Add a variable named task to /stages/0/variables."]
}
```

## Severity Levels

- **warning** -- The spec is runnable, but preview and diagnostics surfaces must expose the risk.
- **error** -- The spec is rejected until corrected.
- **fatal** -- Tooling or runtime could not safely continue.

## Code Families

Code families are stable. Rename them only with deliberate intent and coordinated migration.

| Family | Scope |
|---|---|
| `SCHEMA_*` | JSON shape, version, file read, declared input, or runtime input errors. |
| `GRAPH_*` | Root, dependency, cycle, branching, deprecated summarize, or terminal gate errors. |
| `VARIABLE_*` | Prompt placeholder and variable source errors. |
| `ROLE_*` | Unknown role or role/mode conflict. |
| `LIMIT_*` | Global hard limit or stage-limit errors. |
| `DECISION_*` | Invalid decision target or default routing. |
| `DISCOVER_*` | Invalid agent discover declaration. |
| `FANOUT_*` | Edit fanout risk or missing reconcile stage. |
| `OUTPUT_*` | Runtime output parse, schema, ambiguity, or repair errors. |
| `RUNTIME_*` | Logical run index, scheduler, session, or command errors. |
| `RESUME_*` | Resume policy errors. |
| `ACPX_*` | Upstream `acpx/runtime` startup, session, or turn errors. |
| `INTERNAL_*` | Unexpected compiler or runtime invariant failure. |

## Output Contract Codes

These codes are emitted by the runtime output parser when an agent response fails to satisfy its stage's output contract.

- **OUTPUT_PARSE_FAILED** -- No balanced JSON object could be parsed from the agent response.
- **OUTPUT_SCHEMA_FAILED** -- A balanced JSON object was found, but it did not satisfy the stage-specific Zod-backed output contract.
- **OUTPUT_REPAIR_FAILED** -- The single allowed schema-aware repair turn did not produce a valid balanced JSON object.

Output contract failures map to blocked state at the attempt, stage, or run level -- not failed. The `failed` state is reserved for compiler errors, scheduler failures, ACPX (upstream) runtime errors, or other unrecoverable conditions.

## Runtime Run-Level Codes

These codes appear in diagnostics when the scheduler or persistence layer encounters a problem during a run.

- **EVENT_APPEND_LOCK_TIMEOUT** -- Event append persistence could not acquire the event write lock before timeout.
- **RUN_INDEX_LOCK_TIMEOUT** -- Run-index persistence could not acquire the `run.json` write lock before timeout.
- **FANOUT_ITEM_UNSTARTED_TIMEOUT** -- A fanout item remained unstarted after the scheduler determined it could not safely continue that item.
- **FANOUT_ITEM_BLOCKED** -- Fanout aggregation blocked because one or more active items did not complete and partial fanout was not permitted by policy.
- **MISSING_FANOUT_ITEM_OUTPUT** -- A terminal fanout item did not have a readable output artifact when the scheduler aggregated results.
- **FANOUT_STAGE_STUCK_PENDING_BATCH** -- A fanout stage had queued item state that could not progress to terminal item results.
- **RUN_INDEX_OUTPUT_MISMATCH** -- Persisted run-index state and output artifacts disagree about a stage or item result.
- **AGENT_RUNTIME_ERROR** -- A non-fanout agent runtime turn failed after one transient retry. This covers backend, process, or transport failures -- not output contract failures.
- **FANOUT_ITEM_RUNTIME_ERROR** -- A fanout item runtime turn failed after one transient retry, or stale recovery exhausted retries for that item.
- **FANOUT_ITEM_CASCADE_BLOCKED** -- A queued fanout item was not launched because an earlier item blocked or failed while partial fanout was disabled. The scheduler lets already-running items settle, then marks the fanout stage as blocked.
- **GATE_CONDITION_FAILED** -- A program gate condition evaluated to false.
- **GATE_VERDICT_BLOCKED** -- The terminal gate returned `verdict: "blocked"`.
- **GATE_VERDICT_FAILED** -- The terminal gate returned `verdict: "failed"`. The run records a blocked workflow outcome; the runtime `failed` state remains reserved for infrastructure failures.
- **GATE_VERDICT_UNKNOWN** -- The terminal gate returned `verdict: "unknown"`. Inspect the gate output and upstream fanout item outputs before treating the workflow as verified.

## Command and Turn Diagnostics

- **RUNTIME_COMMAND_ERROR** -- A CLI command caught an unrecoverable runtime error and returned a fatal structured error.
- **AGENT_TURN_FAILED** -- An ACPX (upstream) turn ended as failed or did not produce a usable runtime result.
- **AGENT_TURN_CANCELLED** -- An ACPX (upstream) turn ended as cancelled; the cancellation is preserved for diagnostics.
