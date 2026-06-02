# Runtime Orchestrator Specification

## Status

- Current implementation: current
- Source modules: `src/runtime/`, `src/run-index/`, `src/acpx/`, `src/compiler/compile-execution-plan.ts`, `src/compiler/execution-plan.ts`, `src/commands/run.ts`, `src/commands/follow.ts`, `src/commands/resume.ts`, `src/commands/diagnose.ts`
- Maintenance trigger: update this spec when changing scheduler behavior, run state, attempt lifecycle, session binding, fanout execution, resume, diagnose, ACPX runtime integration, or run directory artifacts

## Purpose

The runtime orchestrator is the authoritative workflow driver. It executes compiled workflow plans through `acpx/runtime`, persists run-local state, and advances stages with a recoverable step-driven scheduler.

## Normative Requirements

- The orchestrator MUST execute `execution-plan.json` directly through the runtime scheduler.
- The orchestrator MUST NOT execute workflow stages through `acpx flow run`.
- The orchestrator MUST NOT generate or require `workflow.flow.ts` or `materialized.flow.ts` as main-path artifacts.
- Each logical run MUST use an isolated run directory.
- Each logical run MUST use a run-local ACPX session store.
- Runtime state on disk MUST be authoritative for recovery after process interruption.
- `run` MUST prepare the logical run, write runtime artifacts, and advance at least one scheduler tick.
- `run --wait` MUST continue advancing until the run reaches a terminal state.
- `run --wait` MUST enable fanout-stage-local draining for ready fanout stages.
- `run` without `--wait` MUST remain a bounded scheduler advancement and MUST NOT drain an entire fanout stage solely because queued items remain.
- `follow` MUST observe and sync an existing run; it MUST NOT create a new workflow run.
- `resume` MUST continue from persisted `run.json` and `execution-plan.json`.
- `resume --wait` MUST enable the same fanout-stage-local draining behavior as `run --wait`.
- Resume policy flags MUST only tighten fanout handling.
- Resume policy overrides MUST be persisted into `run.json` before advancing the scheduler.
- Resume fanout item filtering MUST NOT remove running fanout items from `run.json`; running items MUST settle before tightening or skip policy can remove them from the active fanout set.
- Resume MUST preserve completed pass or pass-with-warnings gate verdicts when it only resets non-gate stages. A blocked, failed, or unknown gate verdict MAY reset the gate stage for recomputation.
- Blocked fanout stages MUST be re-aggregated from existing item outputs when partial fanout is allowed, without rerunning completed items.
- Blocked or failed non-fanout stages MAY be reset to pending for retry by the next scheduler tick.
- The scheduler MUST treat `agentUsage.actual` and `agentUsage.repairCalls` as usage accounting only; agent call counts MUST NOT control whether ready work can start.
- Program gate stages MUST advance deterministically, and agent gate stages MUST run through the normal agent attempt pipeline.
- Terminal gate dependencies MAY treat skipped upstream decision branches as satisfied; other stage dependencies MUST require completed upstream stages.
- Gate verdicts `pass` and `pass_with_warnings` MUST complete a run, while `blocked`, `failed`, and `unknown` MUST block a run without using runtime `failed`.
- `loop` stages MUST execute as bounded workflow-level stages driven by the runtime scheduler.
- `loop` body agent stages MUST run through the same ACPX runtime attempt and repair pipeline used by other agent work.
- `loop` body attempts MUST use deterministic session keys that include parent loop id, round, body stage id, and fanout item/group/lane identity when applicable.
- `loop` body program stages MUST execute deterministically inside the round.
- `loop` body fanout stages MUST use the same stage-local `limits.maxConcurrency` lane work semantics as top-level fanout stages.
- `loop` body fanout stages MUST select and aggregate lane work before downstream body stages run in the same round.
- `loop` MUST evaluate `continueWhen` after each completed round and MUST complete when the condition is false.
- `loop` body blocked, missing body output, or exhausted outcomes MUST block the stage rather than silently completing.
- `diagnose` MUST prepare read-only diagnostic artifacts and MUST NOT rerun edit work or mutate the saved workflow spec.
- `diagnose --wait` MUST preserve `diagnosed_blocked` while underlying stages remain blocked or failed.

## Interfaces and Contracts

Run directories contain:

- `workflow.spec.json`
- `execution-plan.json`
- `input.json`
- `outputs/`
- `attempts/`
- `acpx-state/`
- `sessions/`
- `events.ndjson`
- `run.json`

Runtime commands are exposed through `run`, `follow`, `resume`, and `diagnose` CLI commands.

Execution event types include:

- `run_prepared`, `run_started`, `run_synced`, and `runtime_fatal` for run lifecycle.
- `work_started` and `work_settled` for ordinary single agent work.
- `fanout_pool_started`, `fanout_pool_item_started`, `fanout_pool_item_settled`, and `fanout_pool_completed` for fanout pool execution.
- `fanout_aggregated`, `fanout_item_recovered`, `fanout_item_runtime_error`, and `run_index_output_mismatch` for fanout aggregation and recovery.
- `attempt_created`, `attempt_started`, `turn_started`, `turn_finished`, `agent_event`, `output_written`, and `repair_started` for attempt, turn, output, and repair lifecycle.
- `runtime_retry_scheduled`, `runtime_retry_started`, and `runtime_retry_exhausted` for transient runtime retry handling.
- `program_stage_completed` for deterministic program stage completion.
- `loop_body_program_stage_completed` for deterministic loop body program stage completion.
- `diagnostic_prepared` for diagnose artifact preparation.

The scheduler MUST NOT emit `scheduler_batch_started` or `scheduler_batch_completed`.

## Data Model

The runtime data model includes a logical run, compiled execution plan, stage states, attempts, fanout item/group/lane attempts, loop round/body attempts, output artifacts, event stream, role/session bindings, ACPX session state, usage accounting, gate verdict, blocked reason, and diagnostics.

Fanout pool state MUST be derived from fanout item/group/lane status, attempts, and output artifacts. The run index MUST remain item-centric with nested lane group and lane records, and MUST NOT persist a separate pool object.

Terminal workflow outcomes are represented in the run index. Output-contract failures block attempts, stages, and runs; infrastructure or unrecoverable runtime errors fail attempts, stages, or runs.

Loop stage state MUST persist parent loop metadata in `run.json`, including `maxRounds`, `currentRound` when known, `bodyOutputStageId`, and an ordered `rounds[]` history. Each round record MUST include round number, status, timestamps, output path when available, body output stage id, body output, per-body-stage outputs, and per-body-stage status details. Body fanout stage details MUST preserve nested fanout item/group/lane state.

## Runtime Behavior

The scheduler determines ready stages from persisted state and dependency completion. Agent stages start ACPX runtime turns, persist prompts and raw outputs, parse outputs, optionally perform one schema-aware repair turn, write parsed outputs, and update stage/run status.

Fanout executes independent selected lane work under the fanout stage `maxConcurrency` limit. A fanout stage with no declared `maxConcurrency` executes serially. Item failures are localized and represented as item-level results when possible. Aggregation occurs before downstream stages run.

For each candidate fanout item, the scheduler MUST independently expand every lane group. `all` groups MAY produce zero lane work units. `oneOf` groups MUST block the item with `FANOUT_LANE_SELECTION_FAILED` when multiple lanes match or no lane matches and no default exists. If no lane work unit is produced across all groups, the item MUST be marked skipped with `NO_MATCHING_LANES`.

Skipped fanout items MUST be excluded from partial-policy completion ratio calculations and MUST be reported separately. Partial lane results MAY enter the aggregate only when stage-level fanout partial policy allows them; partial item outputs MUST include metadata naming blocked or failed lanes.

When fanout draining is enabled, the scheduler MUST run at most one ready fanout stage at a time, keep up to the stage `maxConcurrency` active across all item/group/lane work units, merge each lane result into `run.json` immediately when it settles, and then refill from that same stage when queued work and policy allow.

When fanout draining is not enabled, the scheduler MAY start up to the stage `maxConcurrency` fanout lane work units in one bounded advancement, but MUST return after those active units settle rather than refilling the pool.

When a fanout item blocks or fails and partial fanout is not allowed, the scheduler MUST stop launching additional items for that fanout stage, MUST allow already running items to settle, MUST terminalize queued items as blocked with `FANOUT_ITEM_CASCADE_BLOCKED`, and MUST aggregate the fanout stage as blocked.

Loop execution is round-based. Each round starts at the loop body root, advances eligible body stages by dependency completion, and records body stage outputs under `outputs/<loopId>/round-<round>/<bodyStageId>.json`. Agent body stages use parent-loop stage state but distinct attempt item ids. Fanout body stages write lane outputs under the round directory and aggregate item and stage outputs before downstream body stages run. Loop body fanout concurrency is controlled only by the fanout stage `limits.maxConcurrency`; the loop controls round sequencing and MUST NOT introduce a separate concurrency pool. The loop writes an aggregate parent output to `outputs/<loopId>.json` containing status, round count, current/previous body output, round history, and blocked reason when applicable.

If a body stage blocks, the loop stage MUST block with `LOOP_BODY_STAGE_BLOCKED`. If the declared body output is missing after a round, the loop stage MUST block with `LOOP_BODY_OUTPUT_MISSING`. If `continueWhen` remains true after the final allowed round, the loop stage MUST block with `LOOP_EXHAUSTED`.

Gate execution is terminal. Program gates evaluate their condition or default upstream-exists check and write a gate output without an agent turn. Agent gates use the gate output contract. The scheduler promotes the gate output verdict into `run.json.gateVerdict` and derives the terminal run status from it.

Observation-only surfaces, including `follow`, report snapshots, report serving, and diagnose wait polling, MUST call `syncRun` with `startPending: false`. `syncRun` with `startPending: false` MUST be read-only: it MUST return the persisted `run.json` state as-is, MUST NOT start pending work, MUST NOT reconcile stale running attempts, MUST NOT aggregate fanout outputs, MUST NOT write `run.json`, and MUST NOT append `run_synced` events.

Run and resume advancement paths MAY perform scheduler stale recovery for running agent attempts that have no terminal output. Stale recovery MUST use attempt-scoped activity from `events.ndjson` as a heartbeat. The scheduler MUST consider only activity events for the same `attemptId`, including `attempt_started`, `turn_started`, `agent_event`, `turn_finished`, and `runtime_retry_started`. When no heartbeat exists for an attempt, the scheduler MUST fall back to the stage or fanout item `startedAt` timestamp.

Stale recovery MUST NOT trigger until the latest same-attempt heartbeat or fallback start timestamp is older than the effective stage timeout plus a 60 second grace interval. Scheduler stale recovery MUST be distinct from true agent runtime failures: fanout item stale recovery MUST use `FANOUT_ITEM_STALE_RECOVERY`, ordinary stage stale recovery MUST use `AGENT_STAGE_STALE_RECOVERY`, and runtime throws or failed turns MUST continue to use their runtime failure codes. Stale recovery MAY schedule the existing single runtime retry before writing a terminal blocked recovery output. When that stale retry is exhausted, both fanout item and ordinary stage paths MUST append `runtime_retry_exhausted`.

## Extension Points

Supported extension points are stage runtime policies, resume policy tightening, role/session key planning, output contract integration, and report projections. Extensions MUST preserve durable run-index recovery semantics.

## Non-Goals

- No direct ACPX flow execution.
- No generated flow-source compatibility path.
- No forward-compatibility shims for the old flow compiler/runtime model.
- No hidden target-repository dependency resolution assumptions.
- No semantic output repair beyond explicitly approved output-contract behavior.

## Implementation Map

- ACPX runtime integration -> `src/runtime/agent-runtime.ts`, `src/runtime/acpx-config.ts`
- Scheduler -> `src/runtime/scheduler.ts`, `src/runtime/run-workflow.ts`, `src/runtime/stage-runner.ts`
- Attempts and outputs -> `src/runtime/attempts.ts`, `src/runtime/output-parser.ts`, `src/runtime/repair.ts`
- `loop` runtime execution -> `src/runtime/stage-runner.ts`
- Resume and diagnose -> `src/runtime/resume-policy.ts`, `src/runtime/diagnose-run.ts`, `src/commands/resume.ts`, `src/commands/diagnose.ts`
- Session bindings -> `src/runtime/session-bindings.ts`
- Run index and paths -> `src/run-index/read-write.ts`, `src/run-index/paths.ts`, `src/run-index/locator.ts`
- Synchronization -> `src/runtime/sync.ts`
- Execution-plan compilation -> `src/compiler/compile-execution-plan.ts`, `src/compiler/execution-plan.ts`
