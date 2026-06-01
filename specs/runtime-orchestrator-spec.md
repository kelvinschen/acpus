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
- `follow` MUST observe and sync an existing run; it MUST NOT create a new workflow run.
- `resume` MUST continue from persisted `run.json` and `execution-plan.json`.
- Resume policy flags MUST only tighten fanout handling.
- Resume policy overrides MUST be persisted into `run.json` before advancing the scheduler.
- Blocked fanout stages MUST be re-aggregated from existing item outputs when partial fanout is allowed, without rerunning completed items.
- Blocked or failed non-fanout stages MAY be reset to pending for retry by the next scheduler tick.
- The scheduler MUST terminalize ready agent work as blocked when `agentUsage.actual` has reached `limits.maxAgents`.
- `fixLoop` stages MUST run validator and fixer turns through the same ACPX runtime attempt pipeline used by other agent work.
- `fixLoop` validator attempts MUST use the validator role/session key, and fixer attempts MUST use the fixer role/session key.
- `fixLoop` MUST stop when validation passes, when validator output is unknown, or when `maxRounds` is exhausted.
- `fixLoop` unknown or exhausted outcomes MUST block the stage rather than silently completing.
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

## Data Model

The runtime data model includes a logical run, compiled execution plan, stage states, attempts, fanout item attempts, fix-loop validator/fixer attempts, output artifacts, event stream, role/session bindings, ACPX session state, usage accounting, final verdict, blocked reason, and diagnostics.

Terminal workflow outcomes are represented in the run index. Output-contract failures block attempts, stages, and runs; infrastructure or unrecoverable runtime errors fail attempts, stages, or runs.

## Runtime Behavior

The scheduler determines ready stages from persisted state and dependency completion. Agent stages start ACPX runtime turns, persist prompts and raw outputs, parse outputs, optionally perform one schema-aware repair turn, write parsed outputs, and update stage/run status.

Fanout executes independent item work under concurrency limits. Item failures are localized and represented as item-level results when possible. Aggregation occurs before downstream stages run.

Fix-loop execution is round-based. Each round starts with a validator attempt using the validation output contract. A fix-triggering validator result starts a fixer attempt using the implementation output contract when another round is available. Passing validation completes the stage. Unknown validation or exhausted rounds block the stage.

Observation-only surfaces, including `follow` and report serving, sync existing artifacts with `startPending: false` semantics and do not launch new workflow work unless the command is explicitly a run/resume path.

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
- `fixLoop` runtime execution -> `src/runtime/stage-runner.ts`
- Resume and diagnose -> `src/runtime/resume-policy.ts`, `src/runtime/diagnose-run.ts`, `src/commands/resume.ts`, `src/commands/diagnose.ts`
- Session bindings -> `src/runtime/session-bindings.ts`
- Run index and paths -> `src/run-index/read-write.ts`, `src/run-index/paths.ts`, `src/run-index/locator.ts`
- Synchronization -> `src/runtime/sync.ts`
- Execution-plan compilation -> `src/compiler/compile-execution-plan.ts`, `src/compiler/execution-plan.ts`
