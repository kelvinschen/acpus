# Runtime Reference

Detailed runtime behavior for advanced scenarios: worker lifecycle, scheduler,
recovery, fanout pool, diagnostics, segmentation, and run directory layout.

## Worker Lifecycle

- **Background worker**: detached process; stdout/stderr → `{runDir}/worker.log`
- **Foreground worker** (`--wait`): heartbeat every 10s; 250ms sync interval
- **Stale detection**: heartbeat older than 60s
- **Ownership fencing**: PID + generation counter prevents stale writes
- **Crash recovery**: `resume --force` bypasses the active-worker check, then spawns a new worker

## Scheduler Sync Loop

`syncRun()` runs a 6-phase loop per tick:

1. Ensure stage entries exist in run index
2. Reconcile fanout runtime state (stale/crashed item recovery)
3. Reconcile non-fanout stage runtime state
4. Advance deterministic stages (discover, reduce, decisionGate, program gate)
5. Collect ready agent work units
6. Execute: fanout pool or single unit

## Stale Attempt Recovery

When a running attempt has no terminal output and no activity for
`(stage timeout + 60s grace)`:

- If `runtimeRetryOrdinal < 1`: create recovery attempt, reset stage to ready,
  emit `runtime_retry_scheduled`
- If retries exhausted: write synthetic blocked output, emit
  `runtime_retry_exhausted`

Run-index/disk mismatches are auto-corrected (`run_index_output_mismatch`).

## Transient Failure Retry

Agent turns that throw transient errors (429, rate limits, network timeouts,
ECONNRESET, etc.) are automatically retried once (`MAX_RUNTIME_RETRIES = 1`).
Permanent errors (permission denied, auth, schema) fail immediately.

## Fanout Pool

- Concurrency limited by `maxConcurrency` (default 1)
- **Drain mode** (`run --wait` / `resume --wait`): keeps refilling slots until
  nothing is runnable
- **Session deduplication**: no two concurrent units share the same session key
- **Cascade blocking**: when `allowPartial=false`, a blocked item cascade-blocks
  all pending items (`FANOUT_ITEM_CASCADE_BLOCKED`)
- **Fast-stop**: on first lane failure with `allowPartial=false`, queued items
  are terminalized immediately

## Decision Gate Route Pruning

After a decisionGate selects a route:
1. Find all stages whose `dependsOn` includes the decisionGate ID
2. For every dependent **except** the selected route: mark as `skipped` if pending
3. Terminal gate treats `skipped` dependencies as satisfied

Non-gate stages do **not** get this grace — they require `completed` upstream.

## Diagnostic Run

`diagnose` generates a structured analysis using a recovery reviewer role
(prefers `recovery_reviewer`, then validation/review roles). Includes full run
snapshot, stage outputs, runtime diagnostics (35+ error code mappings), and
last 50 events. Changes run status to `diagnosed_blocked`.

## Segmentation

Fanout stages with `effectiveConcurrency > 1` can be split into independent
batch executions. `fanoutSplitPlan()` identifies ancestors, descendants, and
continuation start stage. Resume policy is localized to each segment's item
range.

## ACPX Config Overrides

Agent commands can be overridden without changing specs:

- **Global**: `~/.acpx/config.json`
- **Project**: `{cwd}/.acpxrc.json`

```json
{ "agents": { "claude": { "command": "/usr/local/bin/claude", "args": ["--flag"] } } }
```

## Run Directory

Each run under `.acpus/runs/<id>/`:

| Path | Purpose |
|------|---------|
| `workflow.spec.json` | Original spec |
| `execution-plan.json` | Compiled plan |
| `input.json` | Resolved inputs |
| `run.json` | Authoritative runtime state |
| `outputs/` | Stage output files |
| `attempts/` | Agent attempt records (prompt, raw, parse, output) |
| `prompts/` | Rendered prompt audit trail |
| `sessions/` | Role binding audit trail |
| `acpx-state/` | Run-local ACPX session state |
| `events.ndjson` | Timestamped event log (28 event types) |
| `worker.log` | Background worker stdout/stderr |

## Resume Policy

Per-fanout-stage overrides applied during resume:

| Flag | Format | Constraint |
|------|--------|------------|
| `--allow-partial-fanout` | `stageId ...` | Rejected if any lane uses edit role |
| `--max-fanout-items` | `stageId=count ...` | Cannot exceed compiled cap |
| `--skip-fanout-item` | `stageId=index ...` | Zero-based, must be within range |

Policies merge: skip lists combine, other fields are last-writer-wins.

## Lint Rule Families

| Family | Scope |
|--------|-------|
| `SCHEMA_*` | JSON shape, version, file read, input errors |
| `GRAPH_*` | Root, dependency, cycle, branching, gate constraints |
| `VARIABLE_*` | Prompt placeholder and source errors |
| `ROLE_*` | Unknown role or mode conflict |
| `LIMIT_*` | Stage-level limit validation |
| `DECISION_*` | Decision target/default routing |
| `DISCOVER_*` | Agent discover declaration |
| `FANOUT_*` | Lane selection, cascade, contract mismatch, reconcile |
| `OUTPUT_*` | Parse, schema, repair failures |
| `RUNTIME_*` | Run index, scheduler, session, command errors |
| `RESUME_*` | Resume policy validation |
| `ACPX_*` | Agent runtime startup/session/turn errors |
| `LOOP_*` | Loop exhaustion, body stage failures, output missing |

Key lint rules to remember:
- `GRAPH_BRANCH_REQUIRES_DECISION_GATE` — ordinary stages cannot have multiple dependents
- `GATE_PROGRAM_CONDITION_REQUIRED` — program gate with 2+ dependsOn must declare condition
- `FANOUT_EDIT_RECONCILE_MISSING` — edit fanout needs downstream readOnly reduce
- `FANOUT_ONE_OF_WHEN_REQUIRED` — non-default lanes in oneOf must have `when`
- `VARIABLE_UNDECLARED` / `VARIABLE_UNUSED` — prompt placeholders must be declared
- `ROLE_EDIT_NOT_ALLOWED` — edit mode rejected on gate/discover/decisionGate/reduce
