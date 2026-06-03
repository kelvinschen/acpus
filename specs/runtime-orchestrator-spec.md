# Runtime Orchestrator Specification

## Status

- Current implementation: current
- Source modules: `src/runtime/`, `src/run-index/`, `src/acpx/`, `src/compiler/compile-execution-plan.ts`, `src/compiler/execution-plan.ts`, `src/projections/run-monitor.ts`, `src/commands/run.ts`, `src/commands/follow.ts`, `src/commands/monitor.ts`, `src/commands/resume.ts`, `src/commands/diagnose.ts`
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
- `run` without `--wait` MUST start a background worker and return without blocking on workflow completion.
- `run --wait` MUST execute the workflow in the foreground until terminal status.
- `follow` MUST observe and sync an existing run; it MUST NOT create a new workflow run.
- `monitor` MUST observe and sync an existing run; it MUST NOT create a new workflow run, start pending work, or mutate workflow execution.
- `resume --force` MUST bypass the active-worker check to restart a stale or dead worker for a non-terminal run from persisted `run.json` and `execution-plan.json`.
- `resume` (without `--force`) MUST be limited to blocked, failed, or diagnosed-blocked run recovery.
- `resume` without `--wait` MUST start a background worker and return without blocking on workflow completion.
- `resume --wait` MUST enable the same fanout-stage-local draining behavior as `run --wait`.
- `resume` MUST reject runs with an active non-stale worker.
- Resume `--max-fanout-items` and `--skip-fanout-item` policy flags MUST tighten fanout handling. Resume `--allow-partial-fanout` MAY allow partial results only for read-only fanout stages.
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
- Reusable fanout semantics MUST be centralized in a pure in-memory Fanout Core used by both top-level fanout and Loop Body fanout adapters.
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

Runtime commands are exposed through `run`, `follow`, `monitor`, `resume`, and `diagnose` CLI commands.

Run Monitor View projects the current run, stage summaries, known Stage Tasks, worker summary, and aggregate task progress from `run.json` plus `workflow.spec.json`. Its top-level fields MUST include `version`, `generatedAt`, `run`, `stages`, `tasks`, and `progress`. Stage Task `kind` MUST be one of `stage`, `fanoutLane`, `loopStage`, or `loopFanoutLane`; `execution` MUST be `agent` or `deterministic`. Stage summaries MUST expose `taskCounts`. Progress MUST include `knownTasks` and `completedTasks`.

Agent-backed ordinary stages and deterministic ordinary program stages MUST each project one Stage Task. Fanout stages MUST project lane Stage Tasks and MUST NOT project a separate aggregate task. Loop stages MUST project body-stage and body-fanout-lane Stage Tasks, including deterministic body stages, and MUST NOT project a separate outer-loop task. Task Detail View projects bounded detail for one selected Stage Task from `run.json`, attempt previews when present, and the selected output artifact path when present. Its top-level fields MUST include `version`, `generatedAt`, `run`, `task`, optional prompt/raw/output previews, optional outcome summary, and bounded activity. Deterministic Task Detail Views MUST support zero attempts.

Run Monitor View MAY include derived `elapsedMs` or `durationMs` values for runs, stages, and tasks. These values MUST be derived from existing timestamp fields and MUST NOT be persisted as separate run-index duration fields. Deterministic program stages and deterministic loop body stages MUST record `startedAt` and `completedAt` in their existing stage timestamp fields when they complete.

The monitor TUI MUST render from polled Run Monitor View snapshots and MUST load Task Detail View lazily for the currently selected Stage Task. Polling and detail loads MUST ignore stale asynchronous results when a newer request has been issued. The TUI MUST render three stable panels: Stage List, Stage Info, and Task Detail, using a fixed 2:5:3 width ratio across the available terminal columns. The Stage List panel MUST show the current running stage, falling back to a blocked/failed stage and then the selected stage when no stage is running, and MUST show a finished/total stage count. The Stage Info panel MUST include the selected stage summary and its Stage Task list, and task labels SHOULD use the available horizontal space before truncating. The current focus panel MUST be marked with a distinct indicator; the selected row in the focused list panel MUST be marked with a selection arrow; unfocused panels MUST NOT show selection markers. Completed stage and task rows MUST use a check mark; running rows SHOULD use a dot indicator. The initial TUI snapshot SHOULD select the active stage by default; after the user moves stage selection, subsequent refreshes MUST preserve that user selection except for clamping to available stages. When the selected stage changes, selected task state and task detail MUST be cleared. Run Monitor View and the monitor TUI MUST NOT read `events.ndjson`; bounded event-tail reads are reserved for diagnostics projections.

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

The runtime data model includes a logical run, compiled execution plan, stage states, attempts, Agent Work Units, fanout item/group/lane attempts, loop round/body attempts, output artifacts, event stream, role/session bindings, ACPX session state, usage accounting, worker metadata, gate verdict, blocked reason, monitor projections, and diagnostics.

Fanout pool state MUST be derived from fanout item/group/lane status, attempts, and output artifacts. The run index MUST remain item-centric with nested lane group and lane records, and MUST NOT persist a separate pool object.

Terminal workflow outcomes are represented in the run index. Output-contract failures block attempts, stages, and runs; infrastructure or unrecoverable runtime errors fail attempts, stages, or runs.

Loop stage state MUST persist parent loop metadata in `run.json`, including `maxRounds`, `currentRound` when known, `bodyOutputStageId`, and an ordered `rounds[]` history. Each round record MUST include round number, status, timestamps, output path when available, body output stage id, body output, per-body-stage outputs, and per-body-stage status details. Body fanout stage details MUST preserve nested fanout item/group/lane state.

Worker metadata MUST be persisted in `run.json.worker` with `pid`, `generation`, `status`, `startedAt`, `heartbeatAt`, and optional `exitedAt` and `exitCode`. A worker heartbeat older than 60 seconds is stale. Workers SHOULD update heartbeat every 10 seconds. A run MUST NOT have more than one active non-stale worker. Worker ownership MUST be fenced by both `pid` and `generation`; a worker that no longer owns the current `pid` and `generation` MUST stop advancing the run.

## Runtime Behavior

The scheduler determines ready stages from persisted state and dependency completion. Agent stages start ACPX runtime turns, persist prompts and raw outputs, parse outputs, optionally perform one schema-aware repair turn, write parsed outputs, and update stage/run status.

Fanout executes independent selected lane work under the fanout stage `maxConcurrency` limit. A fanout stage with no declared `maxConcurrency` executes serially. Item failures are localized and represented as item-level results when possible. Aggregation occurs before downstream stages run.

Fanout Core MUST own reusable fanout semantics over compiled fanout plan data, including item and lane expansion, Lane Group selection, skipped and blocked item semantics, partial-policy evaluation, item aggregate output construction, stage aggregate output construction, blocked lane diagnostics, cascade-block terminalization, and fanout summary counts. Fanout Core MUST be pure in-memory and MUST NOT own `maxConcurrency`, scheduler pool behavior, loop round sequencing, output path layout, artifact writes, run-index writes, event emission, runtime lifecycle, or retry and stale-recovery policy. Fanout Core MUST block aggregation with `FANOUT_LANE_RESULT_MISMATCH` when an adapter supplies a lane result that does not match the item, group, or lane being aggregated.

For each candidate fanout item, the scheduler MUST independently expand every lane group. `all` groups MAY produce zero lane work units. `oneOf` groups MUST block the item with `FANOUT_LANE_SELECTION_FAILED` when multiple lanes match or no lane matches and no default exists. If no lane work unit is produced across all groups, the item MUST be marked skipped with `NO_MATCHING_LANES`.

Skipped fanout items MUST be excluded from partial-policy completion ratio calculations and MUST be reported separately. Partial lane results MAY enter the aggregate only when stage-level fanout partial policy allows them; partial item outputs MUST include metadata naming blocked or failed lanes. Blocked fanout stage aggregates MUST preserve the first deterministic specific item blocked reason when available and MUST use `FANOUT_ITEM_BLOCKED` only as a fallback.

When fanout draining is enabled, the scheduler MUST run at most one ready fanout stage at a time, keep up to the stage `maxConcurrency` active across all item/group/lane work units, merge each lane result into `run.json` immediately when it settles, and then refill from that same stage when queued work and policy allow.

When fanout draining is not enabled, the scheduler MAY start up to the stage `maxConcurrency` fanout lane work units in one bounded advancement, but MUST return after those active units settle rather than refilling the pool.

When a fanout item blocks or fails and partial fanout is not allowed, the scheduler MUST stop launching additional items for that fanout stage, MUST allow already running items to settle, MUST terminalize queued items as blocked with `FANOUT_ITEM_CASCADE_BLOCKED`, and MUST aggregate the fanout stage as blocked.

When resume policy changes a previously blocked top-level fanout stage, the scheduler MAY re-aggregate existing terminal item outputs under the updated policy. This re-aggregation MUST NOT rerun completed item work and MUST NOT repeatedly re-aggregate a terminal blocked stage when the persisted fanout state already reflects the resume policy.

Loop execution is round-based. Each round starts at the loop body root, advances eligible body stages by dependency completion, and records body stage outputs under `outputs/<loopId>/round-<round>/<bodyStageId>.json`. Agent body stages use parent-loop stage state but distinct attempt item ids. Fanout body stages write lane outputs under `outputs/<loopId>/round-<round>/<bodyStageId>/<itemId>/<groupId>/<laneId>.json`, write item aggregates under `outputs/<loopId>/round-<round>/<bodyStageId>/<itemId>.json`, and aggregate item and stage outputs before downstream body stages run. Loop body fanout concurrency is controlled only by the fanout stage `limits.maxConcurrency`; the loop controls round sequencing and MUST NOT introduce a separate concurrency pool. Loop-local expressions MUST expose `loop.current` and `loop.previous` as `{ output, outputs }` views; round records MAY persist additional stage metadata but MUST NOT replace the expression shape. The loop writes an aggregate parent output to `outputs/<loopId>.json` containing status, round count, current/previous body output, round history, and blocked reason when applicable.

Fanout aggregation MUST treat partial item outputs as completed for `minCompletedRatio` when `allowPartial` is true. Partial item outputs MUST still count against `maxBlockedItems`, so `maxBlockedItems` remains the explicit cap on tolerated partial or blocked items.

If a body stage blocks, the loop stage MUST block with `LOOP_BODY_STAGE_BLOCKED`. If the declared body output is missing after a round, the loop stage MUST block with `LOOP_BODY_OUTPUT_MISSING`. If `continueWhen` remains true after the final allowed round, the loop stage MUST block with `LOOP_EXHAUSTED`.

Runtime prompt rendering failures caused by missing required variables MUST write a durable blocked output with `VARIABLE_RESOLUTION_FAILED` for ordinary agent stages, loop body agent stages, and loop body fanout lanes. Variables with explicit default transforms MUST continue to use the transformed default value instead of blocking.

Gate execution is terminal. Program gates evaluate their condition or default upstream-exists check and write a gate output without an agent turn. Agent gates use the gate output contract. The scheduler promotes the gate output verdict into `run.json.gateVerdict` and derives the terminal run status from it.

Loop body fanout execution MUST persist round/body-stage/fanout lane state into `run.json` at start and settle boundaries so monitor projections can show loop Stage Tasks while the loop is still running. Loop realtime persistence MUST NOT write raw agent event streams into `run.json`.

Observation-only surfaces, including `follow`, `monitor`, and diagnose wait polling, MUST call `syncRun` with `startPending: false`. `syncRun` with `startPending: false` MUST be read-only: it MUST return the persisted `run.json` state as-is, MUST NOT start pending work, MUST NOT reconcile stale running attempts, MUST NOT aggregate fanout outputs, MUST NOT write `run.json`, and MUST NOT append `run_synced` events.

Run and resume advancement paths MAY perform scheduler stale recovery for running agent attempts that have no terminal output. Stale recovery MUST use attempt-scoped activity from `events.ndjson` as a heartbeat. The scheduler MUST consider only activity events for the same `attemptId`, including `attempt_started`, `turn_started`, `agent_event`, `turn_finished`, and `runtime_retry_started`. When no heartbeat exists for an attempt, the scheduler MUST fall back to the stage or fanout item `startedAt` timestamp.

Stale recovery MUST NOT trigger until the latest same-attempt heartbeat or fallback start timestamp is older than the effective stage timeout plus a 60 second grace interval. Scheduler stale recovery MUST be distinct from true agent runtime failures: fanout item stale recovery MUST use `FANOUT_ITEM_STALE_RECOVERY`, ordinary stage stale recovery MUST use `AGENT_STAGE_STALE_RECOVERY`, and runtime throws or failed turns MUST continue to use their runtime failure codes. Stale recovery MAY schedule the existing single runtime retry before writing a terminal blocked recovery output. When that stale retry is exhausted, both fanout item and ordinary stage paths MUST append `runtime_retry_exhausted`.

## Extension Points

Supported extension points are stage runtime policies, resume policy tightening, role/session key planning, output contract integration, monitor projections, and diagnostics projections. Extensions MUST preserve durable run-index recovery semantics.

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
- Workers -> `src/runtime/worker.ts`, `src/commands/run-worker.ts`
- Resume and diagnose -> `src/runtime/resume-policy.ts`, `src/runtime/diagnose-run.ts`, `src/commands/resume.ts`, `src/commands/diagnose.ts`
- Monitor projections -> `src/projections/run-monitor.ts`, `src/commands/monitor.ts`
- Session bindings -> `src/runtime/session-bindings.ts`
- Run index and paths -> `src/run-index/read-write.ts`, `src/run-index/paths.ts`, `src/run-index/locator.ts`
- Synchronization -> `src/runtime/sync.ts`
- Execution-plan compilation -> `src/compiler/compile-execution-plan.ts`, `src/compiler/execution-plan.ts`
