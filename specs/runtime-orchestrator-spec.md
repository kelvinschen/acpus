# Runtime Orchestrator Specification

## Status

- Current implementation: current
- Source modules: `src/runtime/`, `src/run-index/`, `src/compiler/compile-execution-plan.ts`, `src/compiler/execution-plan.ts`, `src/projections/run-monitor.ts`, `src/tui/`, `src/commands/run.ts`, `src/commands/follow.ts`, `src/commands/monitor.ts`, `src/commands/resume.ts`
- Maintenance trigger: update this spec when changing scheduler behavior, run state, attempt lifecycle, session binding, command program execution, fanout/fanin execution, loop execution, resume, monitor projection, or run directory artifacts

## Purpose

The runtime orchestrator executes compiled workflow plans, persists run-local state, and advances stages through a recoverable scheduler.

## Normative Requirements

- The orchestrator MUST execute `execution-plan.json` directly through the runtime scheduler.
- The orchestrator MUST NOT execute stages through `acpx flow run`.
- Runtime state on disk MUST be authoritative for recovery.
- Run directories MUST contain `workflow.spec.yaml`, `execution-plan.json`, `input.json`, `outputs/`, `attempts/`, `sessions/`, `events.ndjson`, and `run.json`.
- Run preparation MUST resolve input-sourced limits after input defaults and input validation, before writing `execution-plan.json`.
- `execution-plan.json` MUST store resolved numeric limits only.
- `workflow.spec.yaml` run snapshots MUST preserve authored limit bindings.
- Resume MUST reuse the run-local compiled execution plan for limits and MUST NOT recompute input-sourced limits from `workflow.spec.yaml` or `input.json`.
- `run --wait` and `resume --wait` MUST advance until terminal status and enable fanout-stage-local draining.
- `run` without `--wait` and `resume` without `--wait` MUST start a background worker.
- Observation-only surfaces MUST call sync with `startPending: false` and MUST NOT mutate run state.
- A worker MUST be considered active only when its status is `starting` or `running`, its heartbeat is fresh, and its PID is still live on the local host.
- Monitor projections MUST report a non-terminal run with a stale worker as worker `stale`; TUI status display MUST render that condition as `stale` rather than plain `running`.
- Monitor elapsed counters for a non-terminal run with a stale worker MUST stop at the worker `exitedAt` time when present, otherwise at the last `heartbeatAt` time.
- Program command tasks MUST validate cwd safety, timeout bounds, spawn failures, timeout, and bounded-output recording.
- Command non-zero exit codes MUST NOT block; they MUST be represented in `{status,data}` output.
- Spawn, timeout, cwd safety, and bounded-output failures MUST block with `PROGRAM_COMMAND_*` codes.
- Program route stages MUST evaluate rules first-match and block with `ROUTE_UNMATCHED` when no route matches.
- Selected route branches MUST be active; unselected direct downstream route branches MUST be skipped.
- Program gate stages MUST evaluate their condition or default effective-upstream-output check.
- When a program gate has no condition, it MUST pass only when at least one upstream dependency has an output artifact.
- Program gate output MUST wrap effective upstream output as `data`: one effective upstream output passes through directly; multiple effective upstream outputs are keyed by stage ID; skipped route branches without outputs are ignored.
- Program gate condition false MUST produce lifecycle `status: "blocked"` and gate `verdict: "failed"`.
- Gate verdicts `pass` and `pass_with_warnings` MUST complete a run; `blocked`, `failed`, and `unknown` MUST block a run.
- Fanout stages MUST run selected lane work under stage `maxConcurrency`.
- Fanout lanes MUST persist item/lane state as they start and settle.
- Fanout lanes MUST terminalize before fanin runs.
- Monitor fanin Stage Tasks MUST remain `pending` while any fanout item or lane is non-terminal and no fanin attempt exists.
- Monitor fanin Stage Tasks MUST report `running` only after fanin execution is eligible and has started or is ready to start after all lanes terminalize.
- Fanout MUST first build an internal `results` aggregate.
- If partial policy is not satisfied, fanout MUST block and fanin MUST NOT run.
- If partial policy is satisfied or fanout is empty, fanin MUST run.
- A fanout stage final downstream output MUST be the fanin output, not raw `results`.
- Program fanin MUST support only `mergeArrays`.
- Agent fanin prompts MUST receive local `results` as a JSON prompt variable.
- Top-level fanin session key MUST be `fanin:<stageId>`.
- Loop-body fanin session key MUST be `loop:<loopId>:round:<N>:fanin:<bodyStageId>`.
- Resume MAY run missing or blocked fanin when lanes are terminal; resume MUST NOT rerun already completed fanin.
- Loop stages MUST execute bounded rounds and block with `LOOP_EXHAUSTED` when convergence remains true after `maxRounds`.
- Loop body fanout MUST use the same lane expansion, partial policy, and fanin semantics as top-level fanout.
- Runtime prompt rendering failures from required missing variables MUST write durable blocked output with `VARIABLE_RESOLUTION_FAILED`.
- Agent call accounting MUST NOT control scheduler capacity.
- Each Agent Work Unit MUST use one unified Agent Task Retry engine for runtime, stale, and continuation retry reasons.
- Each Agent Work Unit MUST have a fixed total retry budget of 2; max agent calls per work unit is 3.
- Agent Task Retry MUST wait 5 seconds between a failed attempt and the next agent call.
- The compiled execution plan MUST NOT expose Agent Task Retry policy; retry budget is fixed runtime policy.
- Attempt directories MUST be monotonic `attempt-1`, `attempt-2`, and `attempt-3`.
- Initial attempts MUST record `retryBudgetUsed: 0` and `retryBudgetLimit: 2`.
- Retry attempts MUST record retry reason, retry source, retry ordinal, retry budget, prompt policy, and last failure code.
- Stage, fanout item, and fanout lane state MUST persist retry reason when retry state is present.
- `OUTPUT_PARSE_FAILED` and `OUTPUT_SCHEMA_FAILED` MUST schedule a `continuation` retry whenever shared retry budget remains.
- Retry exhaustion MUST block with `AGENT_TASK_RETRY_EXHAUSTED` and preserve retry history plus last failure code in output metadata.
- Scheduler stale recovery exhaustion MUST use `AGENT_TASK_RETRY_EXHAUSTED` as the stage blocked reason and keep the stale runtime code as the attempt/runtime last failure.
- Public run statuses are `pending`, `running`, `completed`, `blocked`, `failed`, and `cancelled`.

## Interfaces and Contracts

Run Monitor View projects current run state from `run.json` and `workflow.spec.yaml`. Top-level fields MUST include `version`, `generatedAt`, `run`, `stages`, `tasks`, and `progress`; terminal runs MUST include `finalOutput` when the gate output artifact exists. The current Run Monitor View version is `acpus.monitor/v1`; task detail view version is `acpus.task-detail/v1`.

Stage Task `kind` MUST include ordinary stages, top-level fanout lanes, top-level fanin tasks, loop body stages, loop body fanout lanes, and loop body fanin tasks. Agent task metadata MUST expose `actorMode`. Program fanin task detail MUST expose status, operation, input summary, output path, and error code when blocked; it has no agent transcript.

Agent Stage Tasks MUST expose retry summary fields: attempt count, current attempt ordinal, last retry reason, retry budget used, retry budget limit, and last failure code. Task Detail View and Run View attempts MUST expose retry metadata from the run index.

Execution event types include run lifecycle, work lifecycle, fanout pool lifecycle, fanin completion, attempt/turn/output lifecycle, agent task retry lifecycle, program stage completion, and loop body program completion.

## Data Model

The runtime data model includes logical run ID, compiled execution plan, stage states, attempts, fanout item/lane state, fanin execution state, loop round/body state, output artifacts, event stream, session bindings, usage accounting, worker metadata, gate verdict, blocked reason, monitor projections, and diagnostics. Agent attempts record `actorMode`; session bindings are stored in `sessions/actor-bindings.json`.

Fanout pool state is derived from fanout item/lane status, attempts, and output artifacts. The run index remains item-centric.

## Runtime Behavior

The scheduler advances deterministic stages, collects ready agent work, runs fanout pools, merges settled results, runs fanin when eligible, and updates run status. Agent stages persist prompts and raw outputs, parse outputs, run Agent Task Retry when eligible, write parsed outputs, and update attempts.

Loop execution is round-based. Each round starts at the loop body root, records body outputs under `outputs/<loopId>/round-<round>/`, and exposes loop-local `{ output, outputs }` views for `loop.current` and `loop.previous`.

Stale recovery uses attempt-scoped activity from `events.ndjson` and blocks with stale-recovery runtime codes only after timeout plus grace.

## Extension Points

Supported extension points are stage runtime policies, resume policy tightening, session key planning, output schema integration, monitor projections, diagnostics projections, program task operations, and program fanin operations.

## Non-Goals

- No direct ACPX flow execution.
- No generated flow-source execution path.
- YAML run snapshots and the current compiled execution-plan shape are the runtime inputs.
- No hidden target-repository dependency resolution assumptions.

## Implementation Map

- Scheduler -> `src/runtime/scheduler.ts`, `src/runtime/sync.ts`
- Run preparation -> `src/runtime/run-workflow.ts`
- Agent/program/loop execution -> `src/runtime/stage-runner.ts`
- Attempts and outputs -> `src/runtime/attempts.ts`, `src/runtime/output-parser.ts`, `src/runtime/agent-task-retry.ts`
- Workers -> `src/runtime/worker.ts`, `src/commands/run-worker.ts`
- Resume -> `src/runtime/resume-policy.ts`
- Monitor projections -> `src/projections/run-monitor.ts`, `src/tui/monitor-data.ts`
- Session bindings -> `src/runtime/session-bindings.ts`
- Run index and paths -> `src/run-index/read-write.ts`, `src/run-index/paths.ts`
