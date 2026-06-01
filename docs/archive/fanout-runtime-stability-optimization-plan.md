# ACPX Orchestrator Fanout Runtime Stability Optimization Plan

> Historical archive: this document is preserved for context and is not current implementation truth.

## Summary

This plan targets the high-concurrency fanout failure observed in the Trae ACP probe:

- `scheduler_batch_started` selected 20 fanout items.
- Only 4 items reached `attempt_started`.
- The CLI surfaced `Lock file is already being held`.
- `run.json` stayed stale with all 20 items marked `running`.
- A few item outputs were still written afterwards, producing an index/output split.

The primary fix is to make fanout item execution item-fault-tolerant and to remove high-frequency event writes from the shared run directory lock path. An item failure must become an item-level blocked/failed result, not a scheduler-level crash or permanent running state.

## Background and Context

This plan follows a sequence of workflow capability validations for `acpx-workflow-orchestrator`.

The broader validation goal was to determine whether ACPX workflows can safely drive agentic TypeScript refactors across one or more cards. Earlier single-card and multi-card workflows exposed runtime reliability issues around fanout execution, output parsing, repair context, and run reporting. After the runtime-driven workflow refactor, a dedicated high-fanout probe was created to isolate whether the remaining `AGENT_TURN_CANCELLED` and hanging run behavior came from:

- Trae ACP itself.
- Model/backend rate limits.
- ACPX orchestrator fanout scheduling and state management.

The high-fanout probe intentionally used low-cost tasks instead of real card refactors. Each fanout item only read a tiny input file and emitted a small `workflow-output` JSON block. This removed Druid render, TypeScript compilation, browser load, and source editing from the equation, leaving agent process concurrency and orchestrator runtime behavior as the main variables.

Evidence was collected under:

- Probe workspace: `/tmp/acpx-trae-concurrency-probe-20260530_150249`
- Notes: `/tmp/acpx-workflow-validation-notes-20260530/trae-high-concurrency-validation-notes.md`
- Skill project: `/data00/home/chenqiren.kyran/kprojects/kelvinschen-skills`

## What Happened

### Direct Trae ACP Probe

The direct ACP probe bypassed orchestrator workflow scheduling and called `acpx/dist/runtime.js` directly with `traecli acp serve`.

Results:

- 5 concurrent Trae turns: 5 completed.
- 20 concurrent Trae turns: 19 completed, 1 connection closed.
- 50 concurrent Trae turns: 20 completed, 30 failed due to model/backend 429 rate limit.

The direct probe did not reproduce the same `AGENT_TURN_CANCELLED` pattern seen in orchestrator fanout. This means Trae ACP can handle some concurrency, while very high concurrency hits backend limits. It does not by itself explain why orchestrator selected 20 fanout items but only started 4.

### Orchestrator Fanout Probe

The orchestrator probe used a workflow with:

- `maxFanoutItems=20`
- `maxConcurrency=20`
- one `trae/edit` fanout stage
- one read-only reduce stage after fanout

Observed behavior:

- `scheduler_batch_started` selected all 20 fanout items.
- Only 4 items reached `attempt_started`.
- 3 item outputs were `AGENT_TURN_CANCELLED`.
- 1 item output completed successfully.
- 16 items had prompt/attempt directories but no item output.
- `run.json` remained stale: all 20 items were still marked `running`, and `agentUsage.actual` stayed `0`.
- The CLI output contained `RUNTIME_COMMAND_ERROR` with `Lock file is already being held`.
- The run never naturally reached a terminal state and had to be stopped manually to preserve evidence.

This created a split-brain run state:

- `run.json` said the fanout was still running.
- `events.ndjson` and item output files showed some items had already reached terminal local states.
- No fanout aggregate output was produced.
- No reduce stage ran.

## Root Cause Analysis

The main failure chain is in orchestrator runtime, not in the workflow spec.

`scheduler.ts` marks the selected fanout items running, emits `scheduler_batch_started`, then executes the whole selected batch with a naked `Promise.all(selected.map(runAgentWork))`. The code only merges item results into `run.json` after every selected item resolves.

At the same time, every item calls `appendEvent` for `attempt_started`, and agent streaming events continue to call `appendEvent`. Both `appendEvent` and `writeRunIndex` lock the same run directory with `proper-lockfile` using only `retries: 3`.

Under 20 concurrent fanout items, this causes event-write lock contention:

- Some items acquire the lock and append `attempt_started`.
- Other items fail with `Lock file is already being held`.
- The failed append rejects that item's `runAgentWork`.
- The first rejected item rejects the entire `Promise.all`.
- Scheduler skips result merging, fanout aggregation, deterministic follow-up stages, and final run index update.

A pure local lock contention probe reproduced the same shape: 20 concurrent calls using the same `proper-lockfile.lock(dir, { retries: 3 })` pattern produced 4 successful appends and 16 `Lock file is already being held` failures. This matches the orchestrator probe, where only 4 items reached `attempt_started`.

`AGENT_TURN_CANCELLED` is therefore best understood as a secondary symptom in this case. Once the scheduler batch fails and runtime disposal/session lifecycle handling begins, some already-started agent turns can finish as cancelled. The cancellation is important to diagnose, but the first trigger for this run was the shared runDir lock contention and all-or-nothing fanout batch handling.

## Why This Matters

This failure mode makes high-fanout workflows unreliable even when each item is cheap and independent.

For real card refactor workflows, the blast radius is worse:

- A single transient event append lock failure can poison the entire fanout batch.
- Completed item work can be lost from the run index even if output files exist.
- The CLI can return a fatal runtime error while background agent turns continue writing artifacts.
- `report` and `diagnose` see a stale run and cannot reliably explain what actually happened.
- Follow-up `resume` may rerun or skip work incorrectly because the durable index is not aligned with item outputs.

The desired runtime behavior is different: fanout should behave like a set of independent item attempts. One item can fail, be cancelled, hit model limits, or produce invalid output, but that failure must be localized and reflected in the final fanout aggregate/report.

## Key Changes

### Event and Run Index Writes

- Split event writes from the run directory lock used by `run.json`.
- Keep `writeRunIndex` protected by an atomic `run.json` write, but do not share that lock with `events.ndjson` streaming events.
- Implement one of these event write strategies, in this priority order:
  1. Process-local serialized event writer queue per run.
  2. Event-file-specific lock with longer retry/backoff.
  3. Per-item event shard files with report-time merge.
- Enrich lock failures with `operation`, `targetPath`, `logicalRunId`, `stageId`, `itemId`, and `attemptId`.

### Fanout Batch Execution

- Replace naked `Promise.all(selected.map(runAgentWork))` with per-item error isolation.
- Use `Promise.allSettled` or explicit per-item `try/catch`.
- Convert thrown item errors into item-level results with `status: "blocked"` or `status: "failed"` and a stable error code such as `FANOUT_ITEM_RUNTIME_ERROR`.
- Always merge settled item results into `run.json`, even when other items fail.
- Emit `scheduler_batch_completed` after all selected items settle or are converted to item-level failures.

### Attempt and Item Lifecycle

- Persist attempt running state before the agent turn starts.
- Track fanout item lifecycle with enough detail to diagnose:
  - `selected`
  - `attempt_created`
  - `attempt_started`
  - `turn_started`
  - `turn_finished`
  - `output_written`
  - `merged`
- Ensure output-file existence and run-index state cannot permanently diverge.
- Add sync/recovery behavior for:
  - selected item with no `attempt_started`
  - attempt started with no terminal output
  - output file exists but item is still `running` in `run.json`

### Cancelled Turn Diagnostics

- Preserve raw ACP cancellation details in `AGENT_TURN_CANCELLED` outputs.
- Include at minimum:
  - `stopReason`
  - `requestId`
  - `sessionKey`
  - agent name
  - role mode
  - whether runtime dispose/close/cancel was invoked
  - raw text preview
- Treat cancellation as item-level blocked unless the whole run was explicitly cancelled.

### CLI Failure Handling

- When the CLI catches a runtime fatal error and a run id is known, write a terminal run status instead of leaving the run permanently `running`.
- Close runtime handles before returning CLI fatal output.
- Add a final event describing the fatal path, including the same enriched error metadata.

### Report and Diagnose

- Detect and report stale index states where output files exist for items still marked `running`.
- Diagnose lock contention separately from agent failures.
- Make report output include per-item runtime error codes and item output paths.
- Ensure `resume` or `sync` can recover from existing item outputs without rerunning successful work.

## Public Interfaces and Types

- Extend fanout item run index entries with optional diagnostics:
  - `attemptId`
  - `startedAt`
  - `completedAt`
  - `errorCode`
  - `errorMessage`
- Extend attempt entries with optional runtime metadata:
  - `sessionKey`
  - `requestId`
  - `stopReason`
  - `runtimeErrorCode`
- Add stable internal error codes:
  - `EVENT_APPEND_LOCK_TIMEOUT`
  - `RUN_INDEX_LOCK_TIMEOUT`
  - `FANOUT_ITEM_RUNTIME_ERROR`
  - `FANOUT_ITEM_UNSTARTED_TIMEOUT`
  - `RUN_INDEX_OUTPUT_MISMATCH`

Existing workflow spec syntax should remain compatible. This is a runtime behavior and diagnostics change, not a workflow authoring API migration.

## Test Plan

### Unit Tests

- Concurrent `appendEvent` with 20 and 50 events should not leak `Lock file is already being held` to the scheduler.
- A fanout batch with one item throwing should still merge all other item results.
- An output file that exists while the item is still `running` in `run.json` should be detected and recoverable.
- `AGENT_TURN_CANCELLED` output should include request/session/stop reason diagnostics.

### Integration Tests

- Re-run the lightweight Trae fanout probe with 20 items and `maxConcurrency=20`.
- Expected result: terminal run status, no CLI-level `RUNTIME_COMMAND_ERROR`, no permanent `running` fanout.
- Run a 50-item probe. Model/backend 429 failures are acceptable only as item-level failures; scheduler must still terminate and report them.
- Verify `completedItems + blockedItems + failedItems` matches fanout item count and output artifacts.

### Regression Scenarios

- Single-card workflow still validates, previews, runs, and reports.
- Multi-card edit fanout followed by read-only reduce still validates and reaches a terminal status.
- A manually killed agent process produces diagnosable item-level failure, not stale run-level `running`.
- `report --json --detailed` and `diagnose` clearly identify lock contention and index/output mismatch.

## Assumptions

- This plan fixes orchestrator runtime behavior first; it does not change Trae ACP or model service rate limits.
- High fanout may still produce item failures under backend 429, but those failures must be localized and reportable.
- Default workflow spec behavior remains unchanged.
- Concurrency defaults can be revisited after runtime stability is fixed and validated.
