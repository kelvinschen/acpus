# End-to-End Validation 2026-05-30

This note records the business-repo validation pass for `acpx-workflow-orchestrator`
against:

- Business worktree:
  `/data00/home/chenqiren.kyran/projects/tt_search_monorepo_worktrees/feat_type_fix_workflow`
- Skill package:
  `/home/chenqiren.kyran/kprojects/acpx-workflow-orchestrator`

The validation combined saved workflows, historical run replay, raw agent output
replay, and new real ACP runs with Trae and Aiden. `pi` is installed on PATH, but
the business `.acpxrc.json` does not define a `pi` ACP agent and `pi --help`
does not expose an ACP server command comparable to `traecli acp serve` or
`aiden acp`; it remains an unavailable ACP backend for this orchestrator pass.

## Coverage

- CLI surface: `validate`, `preview`, `run --workflow --yes --wait`, `follow`,
  `diagnose --wait`, `report --json --detailed`, `save`, `list`, and `show`
  were covered by source-CLI smoke commands or business run replay.
- Runtime stages: `fanout`, `reduce`, and `summarize` were covered with real
  Trae/Aiden runs. Fake-runtime E2E now additionally covers `agentTask`, agent
  `discover`, program `reduce`, agent `decisionGate` route skipping, and
  `fixLoop`.
- Reports: markdown/JSON/detailed report projections and browser report tests
  were exercised by automated tests; detailed report was additionally used on
  business runs.

## Business Run Evidence

| Run | Workflow | Result | Evidence |
| --- | --- | --- | --- |
| `2026-05-30T10-07-55-704Z-15da2a61` | `card-runtime-smoke-multi` | Replayed to `blocked` with `blockedReason=FINAL_VERDICT_UNKNOWN` | All stages were completed, but the summarizer returned `finalVerdict: "unknown"`. Report now emits `runtime-FINAL_VERDICT_UNKNOWN-run-all`. |
| `2026-05-30T14-49-11-324Z-f67a6cf7` | `lego-core-20-fanout-code-review` | Replayed from stale `running` to `blocked` with `blockedReason=LIMIT_AGENT_BUDGET_EXHAUSTED` | Fanout had completed, but reduce was still pending after `agentUsage.actual` reached `limits.maxAgents` (`22/22`). Report now emits a run-level budget diagnostic. |
| `2026-05-30T15-01-06-064Z-355b273b` | `lego-core-20-fanout-code-review-seed-budget` | Raw output replay only | Previous `input` and `audio` attempts contained markdown fences inside JSON strings. The updated parser now parses both raw outputs with `candidateCount=1`. |
| `2026-05-30T15-59-38-863Z-b6508aa6` | `card-runtime-smoke-single` | New real run reached terminal `blocked`; `diagnose --wait` now preserves `diagnosed_blocked` | The old workflow only passed fanout aggregate text to reduce, so Aiden correctly could not infer item verdicts. Diagnose generated `diagnostic-1` and then `diagnostic-2`. |
| `2026-05-30T16-00-48-602Z-06b4107f` | `card-runtime-smoke-multi-structured` | New real run `completed`, `finalVerdict=success_with_warnings` | Trae fanout over five Lego cards and Aiden reduce/summarize completed. One real P1 card typing finding was reported for `67-audiobook`. |

## Optimizations Made

### Run-level final verdict diagnostics

Problem: a terminal summarizer could return `finalVerdict: "unknown"` and make
the run `blocked` without a run-level blocked reason. Reports only showed a
blocked status.

Change:

- Added stable runtime codes:
  - `FINAL_VERDICT_BLOCKED`
  - `FINAL_VERDICT_FAILED`
  - `FINAL_VERDICT_UNKNOWN`
- `updateRunStatus` records the matching run-level `blockedReason`.
- detailed reports emit run-level diagnostics for these codes.
- markdown and HTML report surfaces include the run-level blocked reason.

### Agent budget terminalization

Problem: a run could remain `running` when ready agent work existed but
`agentUsage.actual` had already reached `limits.maxAgents`. The historical
`lego-core-20-fanout-code-review` run exposed this after fanout and repair turns
consumed the full budget before reduce/summarize.

Change:

- Added `LIMIT_AGENT_BUDGET_EXHAUSTED`.
- If scheduler sees ready work but no remaining agent calls, it marks the ready
  stage as blocked and terminalizes the run.
- detailed reports emit a run-level budget diagnostic.

### Resume policy persistence

Problem: `resume` parsed and validated fanout policy flags, but did not persist
them into the run snapshot. As a result, flags such as `--allow-partial-fanout`,
`--max-fanout-items`, and `--skip-fanout-item` could not affect the next
scheduler tick.

Change:

- `resume` merges validated policy into `run.json`.
- blocked/failed stages are reset into resumable states.
- fanout collection and aggregation apply persisted resume policy without
  rerunning completed item outputs.

### Nested markdown fence parsing

Problem: agent outputs that ended with a valid `workflow-output` JSON fence but
included strings containing markdown fences such as ```` ```typescript ```` were
truncated by the non-greedy fence regex. This produced `OUTPUT_PARSE_FAILED`
with `candidateCount=0`.

Change:

- Runtime and generated helper parsers now close fenced candidates only on a
  line containing a standalone closing fence.
- Regression coverage parses a `workflow-output` whose JSON string contains a
  nested fenced code block.

### Diagnose status preservation

Problem: `diagnose --wait` prepared diagnostic artifacts, then observation-only
sync recalculated status back from `diagnosed_blocked` to `blocked`.

Change:

- `updateRunStatus` preserves `diagnosed_blocked` while underlying stages remain
  blocked or failed.

### CLI lifecycle regression coverage

Problem: source review found the public CLI lifecycle commands were mostly
validated manually, with automated coverage concentrated on report rendering and
runtime internals.

Change:

- Added `test/integration/cli-lifecycle.test.ts`.
- The test exercises `validate`, `preview`, `save`, `list`, `show`, `generate`,
  `run --workflow --yes --wait`, `follow`, `diagnose --wait`, `report --json
  --detailed`, and `resume --wait` against a deterministic no-agent workflow.

### Stage-kind runtime regression coverage

Problem: stage-kind coverage had gaps around agent discovery, program reduce,
agent decision routing, and fixLoop attempt identity.

Change:

- Added `test/e2e/fake/stage-kinds.test.ts`.
- Agent decision outputs now call the same downstream route-skip logic as
  program decisions, so unselected dependents are marked `skipped`.
- FixLoop validator/fixer turns now use separate attempt ordinals. This avoids
  overwriting `quality_loop:attempt-1` when round 1 requires both validation and
  fixing.

## Verification Commands

From `skills/acpx-workflow-orchestrator`:

```bash
npm run typecheck
npm run test:unit
npx vitest run test/integration/cli-lifecycle.test.ts
npx vitest run test/e2e/fake/stage-kinds.test.ts
npm test
npm run test:report:browser
```

Business replay used the source CLI to avoid stale `dist/cli.mjs` while changes
were under development:

```bash
node_modules/.bin/tsx src/cli.ts follow 2026-05-30T10-07-55-704Z-15da2a61 --json
node_modules/.bin/tsx src/cli.ts follow 2026-05-30T14-49-11-324Z-f67a6cf7 --json
node_modules/.bin/tsx src/cli.ts run --workflow card-runtime-smoke-single --yes --wait --json
node_modules/.bin/tsx src/cli.ts run --workflow card-runtime-smoke-multi-structured --yes --wait --json
node_modules/.bin/tsx src/cli.ts diagnose 2026-05-30T15-59-38-863Z-b6508aa6 --wait --json
```

## Remaining Notes

- Very high real Trae fanout can still hit backend 429 or ACP disconnects. The
  orchestrator expectation is item-level blocked diagnostics and terminal run
  state, not guaranteed model success.
- Old aggregate-only workflows can still block because reduce/summarize cannot
  infer item verdicts from aggregate text. The structured workflow variant is
  the validated pattern.
- `pi` needs an ACP-compatible server command and `.acpxrc.json` entry before it
  can participate in orchestrator runtime validation.
