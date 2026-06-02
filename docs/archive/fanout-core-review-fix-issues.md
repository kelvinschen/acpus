# Fanout Core Review Fix Issues

> Roadmap: local issue breakdown for the next repair pass after adversarial loop-review run `2026-06-02T05-35-54-661Z-a81463a5`. This is not current implementation truth.

## Breakdown

1. **Fix Fanout Core blocked status and aggregate diagnostics**
   - **Type**: AFK
   - **Blocked by**: None - can start immediately
   - **User stories covered**: Fanout Core contract, error-code correctness, aggregate output correctness

2. **Fix top-level fanout stale retry and partial resume recovery**
   - **Type**: AFK
   - **Blocked by**: None - can start immediately
   - **User stories covered**: recoverable fanout execution, resume policy, stale recovery

3. **Tighten scheduler dependency and runnable-unit validation**
   - **Type**: AFK
   - **Blocked by**: None - can start immediately
   - **User stories covered**: execution-plan authority, scheduler correctness, event diagnostics

4. **Fix Loop Round context and Loop Body fanout cascade behavior**
   - **Type**: AFK
   - **Blocked by**: Issue 1
   - **User stories covered**: Workflow-Level Bounded Loop, Loop Body fanout, round-boundary continuation

5. **Convert variable-resolution failures into blocked workflow outputs**
   - **Type**: AFK
   - **Blocked by**: None - can start immediately
   - **User stories covered**: runtime diagnostics, prompt rendering, recoverable workflow blocking

6. **Re-run loop-review convergence and archive final findings**
   - **Type**: AFK
   - **Blocked by**: Issues 1, 2, 3, 4, 5
   - **User stories covered**: adversarial review validation, regression confidence

## Closure Evidence

Status: solved for the repair pass tracked by this document.

- Specs updated: `specs/runtime-orchestrator-spec.md`, `specs/error-codes-spec.md`, `specs/workflow-spec.md`.
- Core/runtime coverage added: `test/unit/fanout-core.test.ts`, `test/unit/runtime-stability.test.ts`, `test/e2e/fake/stage-kinds.test.ts`.
- Regression passed: `npm run typecheck`, `npm test`, `npm run build`, and validation for `workflows/examples/loop-review-convergence.workflow.spec.json` plus `workflows/examples/bugfix-loop.workflow.spec.json`.
- Adversarial loop-review completed: run `2026-06-02T07-15-45-385Z-cc970f0c`, terminal status `completed`.
- Remaining P0/P1 findings from the final review were resolved and archived in `docs/archive/fanout-core-review-follow-up-resolution-2026-06-02.md`; they are not unresolved TODOs for this repair pass.

## Issue 1: Fix Fanout Core blocked status and aggregate diagnostics

## What to build

Make Fanout Core preserve specific blocked causes and derive statuses defensively across item, lane, group, and stage aggregates. The fix should keep Fanout Core pure in-memory and avoid moving adapter-owned execution concerns into the core.

## Acceptance criteria

- [x] Blocked or failed items without lane groups preserve their explicit `blockedReason` or `errorCode`; fallback uses `FANOUT_ITEM_BLOCKED`, not `FANOUT_LANE_SELECTION_FAILED` or `MISSING_FANOUT_ITEM_OUTPUT` unless the output artifact is genuinely missing.
- [x] Cascade-blocked items retain `FANOUT_ITEM_CASCADE_BLOCKED` through item output and stage aggregate.
- [x] `fanoutGroupStatus` and `fanoutItemStatus` handle `skipped` defensively and prioritize `failed` over `blocked` when mixed lane statuses include infrastructure failure.
- [x] Stage aggregate summaries reflect the actual stage status instead of always saying "completed".
- [x] Stage aggregate blocked reason either remains the generic `FANOUT_ITEM_BLOCKED` by documented policy or propagates a more specific first blocked item reason consistently; tests lock the chosen behavior.
- [x] Fresh lane results take precedence over stale persisted lane `blockedReason` values when building item output.
- [x] Mismatched lane results are rejected or surfaced through diagnostics rather than silently ignored.
- [x] Focused Fanout Core tests cover cascade blocked output, skipped status derivation, failed-vs-blocked priority, summary wording, blocked reason precedence, and lane result mismatch handling.

## Blocked by

None - can start immediately

## Issue 2: Fix top-level fanout stale retry and partial resume recovery

## What to build

Repair top-level fanout recovery so stale retries are actually schedulable and blocked fanout stages can be re-aggregated when resume policy tightens or enables partial fanout. This slice must preserve existing run-index recovery semantics and must not rerun completed items.

## Acceptance criteria

- [x] When stale fanout retry is scheduled, the affected lane status is reset to `ready` or `pending` along with the item-level status so `collectFanoutUnits` can schedule the retry.
- [x] Runtime retry metadata remains attached to the lane and attempt identity remains deterministic.
- [x] A previously blocked fanout stage can be re-aggregated from existing item outputs when resume policy permits partial fanout.
- [x] Completed item outputs are not rerun during blocked-stage re-aggregation.
- [x] Regression tests prove stale fanout retry starts the retry lane and eventually settles.
- [x] Regression tests prove resume partial re-aggregation can unblock or complete an eligible blocked fanout stage without rerunning completed items.

## Blocked by

None - can start immediately

## Issue 3: Tighten scheduler dependency and runnable-unit validation

## What to build

Make scheduler advancement use compiled execution-plan truth when selecting runnable work, and reduce diagnostic noise from reconciliation. This slice should keep ordinary non-fanout execution serial while ensuring selected work is still valid against the latest run index.

## Acceptance criteria

- [x] Dependency completion checks use compiled `ExecutionPlanStage.dependencies` where scheduler behavior depends on planned graph edges.
- [x] `selectRunnableUnits` validates selected units against the latest run index and avoids returning work for stages that are no longer runnable.
- [x] `selectRunnableUnits` no longer accepts unused parameters or no longer discards them with `void`.
- [x] Stage output reconciliation emits `run_index_output_mismatch` only when the persisted run index and output artifact are materially inconsistent.
- [x] Dead `stageSpec` traversal in agent-result merge is removed.
- [x] Tests cover stale index changes between collection and selection, plan-derived dependency behavior, and gated mismatch event emission.

## Blocked by

None - can start immediately

## Issue 4: Fix Loop Round context and Loop Body fanout cascade behavior

## What to build

Bring Loop Body fanout and Loop Round continuation semantics in line with the runtime spec. The loop should preserve the same `loop.previous` shape across prompts, fanout lane conditions, and `continueWhen`; Loop Body fanout should cascade-block unstarted work when partial fanout is disabled.

## Acceptance criteria

- [x] `continueWhen` receives `loop.previous` in the same `{ output, outputs }` shape used by body agent stages and body fanout local context.
- [x] Conditions that read `loop.previous.output` work after the first completed round.
- [x] Loop Body fanout with `allowPartial: false` stops launching additional queued lane work after a blocking lane result.
- [x] Already-running Loop Body fanout lane work is allowed to settle.
- [x] Unstarted queued Loop Body fanout work is terminalized with `FANOUT_ITEM_CASCADE_BLOCKED`.
- [x] Loop Body fanout aggregate and round state preserve cascade-blocked item details.
- [x] Tests cover `loop.previous.output` in `continueWhen`, loop body fanout cascade blocking, and no extra runtime calls for terminalized queued work.

## Blocked by

- Issue 1: Fix Fanout Core blocked status and aggregate diagnostics

## Issue 5: Convert variable-resolution failures into blocked workflow outputs

## What to build

Ensure variable resolution failures during prompt rendering block the relevant stage or loop body stage with a durable output and runtime diagnostic rather than escaping as an uncaught runtime exception.

## Acceptance criteria

- [x] Missing required variables during ordinary agent stage prompt rendering produce a blocked stage output with a stable blocked reason.
- [x] Missing required variables during Loop Body agent or fanout lane prompt rendering block the corresponding body stage or lane item output without crashing the run.
- [x] The blocked output includes enough diagnostic context to identify the variable name and source path.
- [x] Existing default transforms continue to suppress missing-value failures where intended.
- [x] Tests cover ordinary agent stages, Loop Body agent stages, and Loop Body fanout lane variables.

## Blocked by

None - can start immediately

## Issue 6: Re-run loop-review convergence and archive final findings

## What to build

After fixes land, rerun the adversarial loop-review convergence workflow against the Fanout Core, top-level adapter, and Loop Body adapter changes. Record the terminal result and any remaining findings as an archive artifact for the next cycle.

## Acceptance criteria

- [x] Re-run the loop-review convergence workflow with review items covering Fanout Core, scheduler adapter, and loop adapter.
- [x] The workflow reaches terminal `completed` or a clearly diagnosed `blocked` state unrelated to agent permission prompts.
- [x] Any remaining P0/P1 findings are either fixed or documented as new roadmap issues with rationale.
- [x] The run id, terminal status, convergence summary, and final findings are archived under `docs/archive/`.
- [x] Standard regression commands pass after the repair pass.

## Blocked by

- Issue 1: Fix Fanout Core blocked status and aggregate diagnostics
- Issue 2: Fix top-level fanout stale retry and partial resume recovery
- Issue 3: Tighten scheduler dependency and runnable-unit validation
- Issue 4: Fix Loop Round context and Loop Body fanout cascade behavior
- Issue 5: Convert variable-resolution failures into blocked workflow outputs
