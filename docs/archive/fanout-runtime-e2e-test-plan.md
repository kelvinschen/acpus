# ACPX Orchestrator Fanout Runtime E2E Test Plan

> Historical archive: this document is preserved for context and is not current implementation truth.

## Summary

This test plan validates the completed fanout runtime stability optimization end to end. It covers the path from source validation and build, through CLI-driven fake workflows, lightweight real Trae ACP fanout probes, report/diagnose/resume behavior, and finally the card-refactor workflow scenario that originally exposed the runtime issues.

The primary acceptance goal is that high-concurrency fanout no longer fails at the scheduler level with `Lock file is already being held`, no longer leaves `run.json` permanently stale in `running`, and converts per-item failures into reportable fanout item results.

## Test Environment

- Skill project: `/data00/home/chenqiren.kyran/kprojects/kelvinschen-skills`
- Skill project: `/home/chenqiren.kyran/kprojects/acpx-workflow-orchestrator`
- Skill wrapper: `/home/chenqiren.kyran/kprojects/acpx-workflow-orchestrator/skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator`
- Real card worktree for workflow validation: `/data00/home/chenqiren.kyran/projects/tt_search_monorepo_worktrees/feat_type_fix_workflow`
- Runtime evidence root: `/tmp/acpx-fanout-runtime-e2e-<timestamp>/`

Before running real workflow scenarios, record both worktrees:

```bash
git -C /data00/home/chenqiren.kyran/kprojects/kelvinschen-skills status --short
git -C /data00/home/chenqiren.kyran/projects/tt_search_monorepo_worktrees/feat_type_fix_workflow status --short
```

Do not clean the skill project while optimization changes are under review. For card workflow scenarios, clean only the target card worktree paths specified by the scenario.

## Phase 1: Source, Build, and Existing Automated Tests

Run from the skill package directory:

```bash
cd /home/chenqiren.kyran/kprojects/acpx-workflow-orchestrator
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:e2e:fake
npm run build
```

Acceptance:

- All commands exit 0.
- `test/unit/runtime-stability.test.ts` passes, including:
  - 50 concurrent event appends do not leak lock contention.
  - one thrown fanout item becomes item-level blocked.
  - stale `running` item with existing output is recovered.
  - cancelled turn diagnostics are persisted.
  - detailed report surfaces fanout item runtime errors.
- Build produces current `dist/cli.mjs` and report web assets.

If this phase fails, stop real-agent testing and record the failing command, stderr/stdout, and changed files.

## Phase 2: CLI Smoke Tests with Built Runtime

Use a fresh temp directory:

```bash
E2E_ROOT=/tmp/acpx-fanout-runtime-e2e-$(date +%Y%m%d_%H%M%S)
mkdir -p "$E2E_ROOT"
cd "$E2E_ROOT"
ORCH=/home/chenqiren.kyran/kprojects/acpx-workflow-orchestrator/skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator
```

Create or copy a small workflow spec that uses fake/read-only roles only if the test harness supports fake runtime through Vitest. For CLI-only smoke, use existing example specs and validate/preview:

```bash
$ORCH validate --spec /home/chenqiren.kyran/kprojects/acpx-workflow-orchestrator/workflows/examples/edit-fanout-reconcile.workflow.spec.json --json > "$E2E_ROOT/validate-edit-fanout.json"
$ORCH preview --spec /home/chenqiren.kyran/kprojects/acpx-workflow-orchestrator/workflows/examples/edit-fanout-reconcile.workflow.spec.json --json > "$E2E_ROOT/preview-edit-fanout.json"
```

Acceptance:

- `validate` has no errors.
- `preview` shows edit fanout followed by read-only reconcile/reduce.
- Warnings such as edit fanout high risk are acceptable only if the preview also shows disjoint fanout and a reconcile stage.

## Phase 3: Synthetic Lock and Fanout Runtime Probe

Run a CLI-driven probe that uses real orchestrator runtime and real event persistence but keeps agent work cheap. The workflow should:

- define 20 fanout items;
- use one `trae/edit` role or the lightest available ACP agent role;
- set `maxFanoutItems=20`, `maxConcurrency=20`, `maxAgents=20`;
- make each item read `inputs/item-XX.txt`;
- require each item to emit one small `workflow-output` block;
- perform no source edits.

Record:

```bash
$ORCH validate --spec "$E2E_ROOT/trae-fanout-probe.workflow.spec.json" --json > "$E2E_ROOT/probe-validate.json"
$ORCH preview --spec "$E2E_ROOT/trae-fanout-probe.workflow.spec.json" --json > "$E2E_ROOT/probe-preview.json"
$ORCH run --spec "$E2E_ROOT/trae-fanout-probe.workflow.spec.json" --yes --wait --json > "$E2E_ROOT/probe-run.json"
```

After the run:

```bash
RUN_ID=$(node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(r.logicalRunId || "")' "$E2E_ROOT/probe-run.json")
$ORCH report --run "$RUN_ID" --json --detailed > "$E2E_ROOT/probe-report.json"
$ORCH report --run "$RUN_ID" --html --output "$E2E_ROOT/probe-report.html"
cp -R ".acpx-workflow-orchestrator/runs/$RUN_ID" "$E2E_ROOT/run-$RUN_ID"
```

Acceptance:

- CLI run reaches terminal status without manual interruption.
- `probe-run.json` does not contain `RUNTIME_COMMAND_ERROR`.
- `events.ndjson` does not contain leaked `Lock file is already being held`.
- `scheduler_batch_completed` exists.
- `fanout_aggregated` exists, unless the workflow terminates earlier with a clear terminal failed/blocked state.
- `run.json` fanout counters match item states:
  - `completedItems + blockedItems + failedItems == totalItems`, or the equivalent status accounting supported by the current schema.
- Output/index consistency holds:
  - every terminal fanout item has an output path or an explicit item-level runtime error.
  - no item remains `running` after terminal run status.
- If model/backend 429 occurs, it appears as item-level blocked/failed diagnostics, not scheduler-level fatal failure.

## Phase 4: Stress Probe with Backend Limits

Repeat the synthetic probe with 50 items and `maxConcurrency=50`.

Acceptance:

- Backend/model 429 failures are allowed.
- Scheduler must still reach terminal status.
- Report must list per-item failures with stable error codes or runtime diagnostics.
- No permanent stale `running` state.
- No CLI-level `Lock file is already being held`.

If the agent backend rate limit prevents meaningful completion, lower concurrency to 20 while keeping 50 total items and verify batching still terminates correctly.

## Phase 5: Diagnose and Resume Behavior

Create or reuse a run with one item-level runtime failure. Then run:

```bash
$ORCH diagnose "$RUN_ID" --wait --json > "$E2E_ROOT/diagnose.json"
$ORCH report --run "$RUN_ID" --json --detailed > "$E2E_ROOT/report-after-diagnose.json"
```

If the run remains resumable, run:

```bash
$ORCH resume "$RUN_ID" --wait --json > "$E2E_ROOT/resume.json"
$ORCH report --run "$RUN_ID" --json --detailed > "$E2E_ROOT/report-after-resume.json"
```

Acceptance:

- Diagnose identifies item-level failure causes, not only generic run failure.
- Diagnose identifies index/output mismatch if one is intentionally injected.
- Resume does not rerun successful fanout items unless explicitly required by policy.
- Resume preserves existing item outputs and reaches a terminal state or reports why it cannot.

## Phase 6: Report HTML and Browser Rendering

For every terminal probe run:

```bash
$ORCH report --run "$RUN_ID" --html --output "$E2E_ROOT/report.html"
npm run test:report:browser
```

Acceptance:

- HTML report is generated.
- Browser report test passes.
- Report UI shows fanout item statuses, blocked reasons, runtime diagnostics, and output paths.
- Report does not mislead by showing a run-level `running` state when all item outputs are terminal.

## Phase 7: Real Card Workflow Regression

Use the card worktree only after phases 1-6 pass.

Target workflow scenario:

- single-card runtime workflow for `packages/tt-search/business/Lego/67-zhaopin`;
- then multi-card fanout workflow for:
  - `packages/tt-search/business/Lego/67-audio`
  - `packages/tt-search/business/Lego/67-audiobook`
  - `packages/tt-search/business/Lego/67-book`
  - `packages/tt-search/business/Lego/67-comic`
  - `packages/tt-search/business/Lego/67-download`

Before each real card run:

```bash
cd /data00/home/chenqiren.kyran/projects/tt_search_monorepo_worktrees/feat_type_fix_workflow
git status --short > "$E2E_ROOT/card-status-before.txt"
```

Clean only paths needed by the scenario, and record the command used. Do not remove unrelated user changes.

Run each workflow through saved workflow execution:

```bash
$ORCH validate --spec <workflow-spec> --json > "$E2E_ROOT/card-validate.json"
$ORCH preview --spec <workflow-spec> --json > "$E2E_ROOT/card-preview.json"
$ORCH save <workflow-name> --spec <workflow-spec> --overwrite > "$E2E_ROOT/card-save.txt"
$ORCH run --workflow <workflow-name> --yes --wait --input-json <input-json> --json > "$E2E_ROOT/card-run.json"
```

Collect:

```bash
$ORCH report --run "$RUN_ID" --json --detailed > "$E2E_ROOT/card-report.json"
$ORCH report --run "$RUN_ID" --html --output "$E2E_ROOT/card-report.html"
find .acpx-workflow-orchestrator/runs/"$RUN_ID" -maxdepth 3 -type f > "$E2E_ROOT/card-run-files.txt"
git status --short > "$E2E_ROOT/card-status-after.txt"
```

Acceptance:

- The workflow naturally reaches a terminal state.
- No manual intervention is required during `run --wait`.
- No scheduler-level lock error occurs.
- Fanout item failures, if any, are localized and visible in report.
- Single-card run still records baseline, modified render, compile checks, and diff artifacts.
- Multi-card run records each card verdict and does not leave partial running item states.

## Final Evidence Package

At the end, produce:

- `run-notes.md`
- all validate/preview/run/report/diagnose/resume JSON outputs
- generated HTML reports
- copied run directories
- `git status --short` snapshots before and after real card runs
- a summary table:

| Scenario | Run ID | Status | Items | Lock Error | Stale Running | Item Failures | Report OK |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 20-item probe | | | | | | | |
| 50-item probe | | | | | | | |
| diagnose/resume | | | | | | | |
| 67-zhaopin | | | | | | | |
| 5-card fanout | | | | | | | |

## Hard Failure Criteria

Any of the following fails the optimization:

- CLI returns `RUNTIME_COMMAND_ERROR` caused by event/run-index lock contention.
- A terminal run still has fanout items marked `running`.
- Item outputs exist but report/run index cannot explain them.
- A single fanout item exception aborts the entire scheduler batch.
- `diagnose` cannot distinguish item-level runtime failure from run-level scheduler failure.
- `report --json --detailed` omits fanout item runtime diagnostics.

## Assumptions

- Model/backend 429 is acceptable only when represented as item-level failure.
- Real card refactor workflows may fail business validation, but runtime must still terminate and report clearly.
- This plan validates runtime stability, not semantic correctness of every card refactor.
- Existing uncommitted optimization changes in the skill project are intentional and should not be cleaned before this validation.
