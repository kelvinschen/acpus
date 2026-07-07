# Acpus Skill Benchmark Results

This log records Skill maintenance evaluations scored with `references/benchmark.md`.

## Round 1 - Baseline

Date: 2026-07-07

### Release Review With Human Approval

- Agent: Herschel
- Prompt direction: release review / human-in-the-loop workflow with Task, Signal, composite, and `pi` Agent.
- Workflow file: `/tmp/acpus-skill-bench-agent-a/release-human-loop.workflow.ts`
- Agent-containing workflow runs: 0
- Commands: `pnpm exec acpus --version`; three `workflows check` attempts.
- Check attempts: 3
- Check result: failed before workflow validation because the scratch workflow was outside the workspace or lacked a valid pnpm package root.
- Run result: not attempted.
- Tool-call count: 12 assistant-level calls.
- Context-window notes: read relevant Skill docs and examples, then extra package/composite context to debug setup.
- Score: 43
- Observed failures: unsupported `--version`; workflow outside workspace; `/tmp` pnpm package setup friction.
- Skill changes proposed: replace `--version`; document workspace-contained scratch paths; add temp workflow recipe.

### Goal-Driven Subagents

- Agent: Goodall
- Prompt direction: goal-driven/subagent workflow with Task, Signal, `parallel` plus nested composite, and `pi` Agent.
- Workflow file: `/tmp/acpus-skill-bench-agent-b/goal-driven-subagents.workflow.ts`
- Agent-containing workflow runs: 1
- Commands: `pnpm exec acpus --version`; three `workflows check` attempts; one background `workflows run`; `runs inspect`; `runs signal`.
- Check attempts: 3
- Check result: passed with 0 diagnostics after temp workspace setup.
- Run result: terminal failed after valid signal because the `pi` agent returned `ready=false` and `riskCount=5`, causing the workflow's assert to fail as designed.
- Tool-call count: 18 assistant-level calls, 30 individual tool invocations.
- Context-window notes: setup debugging dominated context more than authoring.
- Score: 76
- Observed failures: unsupported `--version`; outside-workspace path; temp package setup; run failure was expected workflow behavior, not an Acpus defect.
- Skill changes proposed: workspace scratch recipe; composite examples; signal inspect/payload guidance.

### Worktree Tournament

- Agent: Copernicus
- Prompt direction: worktree/candidate tournament workflow with Task, Signal, fanout, and `pi` Agent.
- Workflow file: `/tmp/acpus-skill-bench-agent-c/worktree-tournament.workflow.ts`
- Agent-containing workflow runs: 1
- Commands: `pnpm exec acpus --version`; three `workflows check` attempts; one background `workflows run`; two `runs inspect` calls.
- Check attempts: 3
- Check result: passed with 0 diagnostics after temp workspace setup.
- Run result: non-terminal running at `judge_solution` when reported; no signal reached.
- Tool-call count: 16 assistant-level calls, 28 individual tool invocations.
- Context-window notes: setup debugging dominated context more than authoring.
- Score: 72
- Observed failures: unsupported `--version`; outside-workspace path; temp package setup; background agent run can remain active without a signal target.
- Skill changes proposed: workspace scratch recipe; fanout + signal + agent example; inspect before signaling.

### Round Summary

- Average score: 63.7
- Agent-containing workflow runs used: 2
- Stable misses: command-surface recall, scratch workspace setup, complex composite examples.
- Changes applied after round: `SKILL.md` and `cli-operations.md` now use `--help`/`doctor`; `cli-operations.md`, `troubleshooting.md`, and `benchmark.md` document workspace-contained scratch workflows; `assets/examples/composite-review.workflow.ts` adds a checked complex composite workflow; `authoring-typescript-workflows.md` points to copyable composite patterns.

## Round 2 - After Workspace And Composite Guidance

Date: 2026-07-07

### Release Readiness

- Agent: Newton
- Prompt direction: release readiness workflow with Task context, `parallel` review lanes, one `pi` Agent, and one Signal approval.
- Workflow file: `.acpus/tmp/acpus-skill-bench/r2-agent-d/release-readiness.workflow.ts`
- Agent-containing workflow runs: 1
- Commands: `pnpm exec acpus --help`; one `workflows check`; one background `workflows run`; `runs inspect`; `runs signal`.
- Check attempts: 1
- Check result: passed with 0 diagnostics.
- Run result: terminal failed by design after a valid denial payload and `ready=false`, `riskCount=4`; downstream assert rejected release readiness.
- Tool-call count: 20 top-level calls.
- Context-window notes: no setup debugging; polling dominated runtime cost.
- Score: 96
- Observed failures: one transient local CLI dist/module issue during inspect; expected assert failure after denial.
- Skill changes proposed: document background signal loop and denial-payload semantics.

### Goal-Driven Audit

- Agent: Volta
- Prompt direction: goal-driven implementation audit with Task setup, `parallel` lanes, `loop`, Signal gate, and one `pi` Agent.
- Workflow file: `.acpus/tmp/acpus-skill-bench/r2-agent-e/goal-driven-audit.workflow.ts`
- Agent-containing workflow runs: 1
- Commands: `pnpm exec acpus --help`; two `workflows check` attempts; one `workflows run`; inspect/signal; read-only SQLite queries when local CLI inspect failed.
- Check attempts: 2
- Check result: passed with 0 diagnostics after replacing native `.length` on an expression array.
- Run result: signal accepted; final Agent node remained running when reported. Later parent inspection worked after repairing workspace links, confirming the run was still active at `final_agent_audit`.
- Tool-call count: 38 individual tool invocations.
- Context-window notes: extra calls came from diagnosing local module resolution.
- Score: 85
- Observed failures: expression arrays do not expose native `.length`; local workspace links/build outputs can break `pnpm exec acpus`.
- Skill changes proposed: document `len(input.items)` and local dist/link recovery.

### Candidate Solution Filter

- Agent: Boole
- Prompt direction: candidate filtering workflow with Task candidate prep, fanout scoring, parallel summarize/judge, one `pi` Agent, and Signal approval.
- Workflow file: `.acpus/tmp/acpus-skill-bench/r2-agent-f/candidate-filter.workflow.ts`
- Agent-containing workflow runs: 1
- Commands: `pnpm exec acpus --help`; one `workflows check`; one background `workflows run`; inspect; signal.
- Check attempts: 1
- Check result: passed with 0 diagnostics.
- Run result: completed in 48s after dynamic signal target `approval~b32edf90122f` accepted a valid approval payload.
- Tool-call count: 15 assistant calls.
- Context-window notes: no setup debugging; modest polling cost.
- Score: 98
- Observed failures: Agent latency and output quality remain runtime variables.
- Skill changes proposed: candidate-tournament example and signal polling note.

### Round Summary

- Average score: 93.0
- Cumulative agent-containing workflow runs used: 5
- Stable improvements: command recall, workspace scratch setup, first-check pass rate, dynamic signal handling.
- Remaining misses: native expression-array properties, local source-checkout build/link recovery, signal workflow polling guidance.
- Changes applied after round: `expressions-and-schemas.md` and `authoring-typescript-workflows.md` now document `len(input.items)`; `cli-operations.md` documents background signal workflow operation; `troubleshooting.md` documents source-checkout module/dist recovery.
- Plateau judgment: scores reached a stable high range. Further gains likely need more example variants rather than fixing a broad Skill failure.

## Round 3 - Boundary Expansion Loops 6-8

Date: 2026-07-07

### Loop 6 - Deep Agent Nesting Check

- Agent: Plato
- Prompt direction: check-only workflow with `fanout -> parallel -> switch -> loop -> agent`, declared `reviewer: { use: "pi" }`, and reachable Signal.
- Workflow file: `.acpus/tmp/acpus-skill-bench/r3-loop6/deep-agent.workflow.ts`
- Loop type: `agent-check`
- Agent-containing workflow runs: 0
- Commands: `pnpm exec acpus --help`; one `workflows check`.
- Check attempts: 1
- Check result: passed with 0 diagnostics, 12 nodes.
- Run result: not run by design.
- Tool-call count: 6 top-level assistant calls, 10 underlying operations.
- Workflow Agent tool-call count: 0
- Score: 100
- Observed failures: none.
- Skill changes proposed: clarify check-only Agent scenarios and `workflows check` not invoking `acpx`.

### Loop 7 - Agentless Nested Runtime

- Agent: Halley
- Prompt direction: no-Agent workflow with `fanout -> parallel -> switch -> loop`, Signal approval, background run, signal, terminal inspect.
- Workflow file: `.acpus/tmp/acpus-skill-bench/r3-loop7/agentless-nested.workflow.ts`
- Loop type: `agentless-run`
- Agent-containing workflow runs: 0
- Commands: `pnpm exec acpus --help`; one `workflows check`; one background `workflows run`; inspect; signal; terminal inspect.
- Check attempts: 1
- Check result: passed with 0 diagnostics.
- Run result: completed after signal. Output included `approved: true`, `firstRoute: "ship"`, `firstSummary: "alpha ship round 1 score 71"`.
- Signal target: `human_approval~6f971f990f57`
- Tool-call count: 22 low-level evaluator tool invocations.
- Workflow Agent tool-call count: 0
- Score: 100
- Observed failures: none.
- Skill changes proposed: add an agentless nested runtime example, a `switch` snippet, and a clearer tool-call-count definition.

### Loop 8 - Expression Collection Stress Check

- Agent: Aquinas
- Prompt direction: check-only workflow with `filter`, `map`, `every`, `some`, `len`, `head`, `get`, `coalesce`, `where` operators, `template`, `md`, composite, Signal, and declared `reviewer: { use: "pi" }`.
- Workflow file: `.acpus/tmp/acpus-skill-bench/r3-loop8/workflow.ts`
- Loop type: `agent-check`
- Agent-containing workflow runs: 0
- Commands: `pnpm exec acpus --help`; one `workflows check`.
- Check attempts: 1
- Check result: passed with 0 diagnostics, 11 nodes.
- Run result: not run by design.
- Tool-call count: 16 evaluator tool invocations.
- Workflow Agent tool-call count: 0
- Score: 98
- Observed failures: none; minor efficiency cost from targeted API lookups.
- Skill changes proposed: document `every`, `some`, `get`, and `where` operator keys.

### Round Summary

- Round average score: 99.3
- Recorded optimize loops complete: 8 of 20
- Cumulative agent-containing workflow runs used: 5
- Remaining Agent workflow executions available under strict `<10` cap: 4
- Changes applied after round: `cli-operations.md` clarifies check-only Agent validation; `benchmark.md` defines tool-call count fields and check-only Agent execution count; `expressions-and-schemas.md` documents `where` operators; `authoring-typescript-workflows.md` adds `switch` and collection helper snippets; `assets/examples/agentless-nested.workflow.ts` adds a checked no-Agent nested runtime example.

## Round 4 - Recovery, Signal, And Race Boundaries

Date: 2026-07-07

### Loop 9 - Nested Signal Payload Validation

- Agent: Harvey
- Prompt direction: no-Agent workflow with nested `fanout -> parallel -> switch -> signal`, invalid payload attempt, corrected payload, terminal inspect.
- Workflow file: `.acpus/tmp/acpus-skill-bench/r4-loop9/nested-signal-validation.workflow.ts`
- Loop type: `agentless-run`
- Agent-containing workflow runs: 0
- Commands: `pnpm exec acpus --help`; one `workflows check`; one background `workflows run`; inspect; invalid `runs signal`; valid `runs signal`; terminal inspect.
- Check attempts: 1
- Check result: passed with 0 diagnostics.
- Run result: completed after valid signal. Output included `firstApproved: true`, `firstApprover: "Nina"`, `firstRoute: "release"`.
- Invalid payload result: rejected with `RUN_NOT_CONTROLLABLE`; schema path reported `$.approver.team expected one of "ops", "qa"`; wait stayed awaiting.
- Signal target: `case_lanes[case-rel-9]/lane_parallel.gate/route_case.case_0/nested_human_gate~15d8bf4972ea`
- Tool-call count: 22 individual developer tool invocations.
- Workflow Agent tool-call count: 0
- Score: 98
- Observed failures: invalid signal diagnostics reported the first nested schema mismatch, not all mismatches.
- Skill changes proposed: document invalid payload non-consumption and dynamic signal target preference.

### Loop 10 - Retry Vs Fork Static Drill

- Agent: Lorentz
- Prompt direction: answer a realistic recovery question after source edit: retry or fork, and how to inspect a target.
- Notes file: `.acpus/tmp/acpus-skill-bench/r4-loop10/static-drill-report.md`
- Loop type: `static-drill`
- Agent-containing workflow runs: 0
- Commands: `pnpm exec acpus --help`; `acpus doctor`; `runs list`; `runs inspect`.
- Result: recommended `runs fork <run-id> --workflow workflow.ts` because retry reuses the frozen admitted workflow; explained inspect-first target selection.
- Legacy commands avoided: `runs show`, `runs replay`, `fork --from`.
- Tool-call count: 11 underlying developer tool invocations.
- Workflow Agent tool-call count: 0
- Score: 94
- Observed failures: none; minor score loss from using a concrete existing failed target in a generic answer.
- Skill changes proposed: keep retry/fork guidance prominent.

### Loop 11 - Parallel Race Envelope Check

- Agent: Descartes
- Prompt direction: check-only workflow with declared `pilot: { use: "pi" }`, Agent branch, `parallel({ strategy: "race" })`, downstream `race.output.winner` and `race.output.result`, nested composite, and Signal.
- Workflow file: `.acpus/tmp/acpus-skill-bench/r4-loop11/race-agent-signal.workflow.ts`
- Loop type: `agent-check`
- Agent-containing workflow runs: 0
- Commands: `pnpm exec acpus --help`; one `workflows check`.
- Check attempts: 1
- Check result: passed with 0 diagnostics, 7 nodes.
- Run result: not run by design.
- Tool-call count: 21 individual tool invocations, 9 assistant tool-call messages.
- Workflow Agent tool-call count: 0
- Score: 98
- Observed failures: none.
- Skill changes proposed: add a `parallel` race output snippet and repeat that check-only Agent nodes do not start execution.

### Round Summary

- Round average score: 96.7
- Recorded optimize loops complete: 11 of 20
- Cumulative agent-containing workflow runs used: 5
- Remaining Agent workflow executions available under strict `<10` cap: 4
- Changes applied after round: `runtime-recovery.md` and `troubleshooting.md` document invalid schema-backed signal payload behavior and dynamic target preference; `authoring-typescript-workflows.md` documents `parallel` race output shape.

## Round 5 - Quorum, Nullable, And Hooks Boundaries

Date: 2026-07-07

### Loop 12 - Quorum Fanout Runtime Shape

- Agent: Lagrange
- Prompt direction: no-Agent workflow proving `fanout({ strategy: "quorum", count: 2 })` output is an accepted item array, with Task proof, Signal, and terminal inspect.
- Workflow file: `.acpus/tmp/acpus-skill-bench/r5-loop12/quorum-agentless.workflow.ts`
- Loop type: `agentless-run`
- Agent-containing workflow runs: 0
- Commands: `pnpm exec acpus --help`; one `workflows check`; one background `workflows run`; inspect; signal; terminal inspect.
- Check attempts: 1
- Check result: passed with 0 diagnostics.
- Run result: completed after signal. Runtime canceled the third fanout lane after quorum, as expected.
- Output proof: `isArray: true`, `acceptedCount: 2`, `envelopeKeys: []`, `noEnvelopeKeys: true`.
- Signal target: `human_approval~6f971f990f57`
- Tool-call count: 12 outward tool calls, 22 underlying developer invocations.
- Workflow Agent tool-call count: 0
- Score: 100
- Observed failures: none.
- Skill changes proposed: document quorum output has no `.accepted`, `.result`, or `.winner` envelope and add an agentless quorum example.

### Loop 13 - Nullable And Optional Boundary Check

- Agent: Sartre
- Prompt direction: check-only workflow with declared `reviewer: { use: "pi" }`, Agent in fanout, Signal in `if`, nullable/optional fields, `head`, `get`, `coalesce`, and branch-compatible outputs.
- Workflow file: `.acpus/tmp/acpus-skill-bench/r5-loop13/nullable-agent-signal.workflow.ts`
- Loop type: `agent-check`
- Agent-containing workflow runs: 0
- Commands: `pnpm exec acpus --help`; one `workflows check`; `git status --short`.
- Check attempts: 1
- Check result: passed with 0 diagnostics, 7 nodes.
- Run result: not run by design.
- Tool-call count: 9 assistant tool messages, 16 underlying developer tool invocations.
- Workflow Agent tool-call count: 0
- Score: 100
- Observed failures: none.
- Skill changes proposed: clarify that `workflows check --input` still does not execute Task, Signal, or Agent nodes.

### Loop 14 - Hooks JSON Static Drill

- Agent: Mencius
- Prompt direction: add a hook for failed Agent nodes, validate scratch hook JSON safely, avoid legacy `hooks.yaml`.
- Files: `.acpus/tmp/acpus-skill-bench/r5-loop14/hooks.json`, fake global `.acpus/hooks.json`, and `validate-hooks.ts`.
- Loop type: `static-drill`
- Agent-containing workflow runs: 0
- Commands: `pnpm exec acpus --help`; hooks help commands; runtime validator script; `HOME=<scratch> pnpm exec acpus hooks validate --global`; `HOME=<scratch> pnpm exec acpus hooks list --global`.
- Validation result: runtime validator passed; CLI validation passed with `OK (1 hooks)`; list showed `node.failed`, id `record-agent-node-failure`, match `kind=agent`.
- Tool-call count: 10 wrapper-level calls, 15 shell commands, 3 scratch file patches.
- Workflow Agent tool-call count: 0
- Score: 96
- Observed failures: CLI has no arbitrary `--path` for hook validation; fake `HOME` workaround is safe.
- Skill changes proposed: document fake-`HOME` scratch validation and anchored regex matches such as `^agent$`.

### Round Summary

- Round average score: 98.7
- Recorded optimize loops complete: 14 of 20
- Cumulative agent-containing workflow runs used: 5
- Remaining Agent workflow executions available under strict `<10` cap: 4
- Changes applied after round: `assets/examples/quorum-agentless.workflow.ts` adds a checked quorum runtime example; `authoring-typescript-workflows.md` documents quorum fanout output shape; `cli-operations.md` clarifies check does not execute Task, Signal, or Agent nodes and terminal inspect includes output; `hooks-json.md` documents anchored match regexes and scratch global validation with `HOME`.

## Round 6 - Task Reuse, Loop Exhaustion, And Agent Overrides

Date: 2026-07-07

### Loop 15 - Reusable Task And Inline Capture Check

- Agent: Hooke
- Prompt direction: check-only workflow with same-file exported `task.define`, inline Task using `run.input`, declared `reviewer: { use: "pi" }`, Signal, and composite.
- Workflow file: `.acpus/tmp/acpus-skill-bench/r6-loop15/agent-check.workflow.ts`
- Loop type: `agent-check`
- Agent-containing workflow runs: 0
- Commands: `pnpm exec acpus --help`; one `workflows check`.
- Check attempts: 1
- Check result: passed with 0 diagnostics, 8 nodes.
- Run result: not run by design.
- Tool-call count: 8 top-level tool invocations, 12 shell commands including doc reads.
- Workflow Agent tool-call count: 0
- Score: 98
- Observed failures: none.
- Skill changes proposed: add a compact reusable-task plus inline-capture-avoidance `agent-check` example.

### Loop 16 - Loop Exhaustion Runtime

- Agent: Franklin
- Prompt direction: no-Agent workflow exercising `onExhausted: "returnLast"` and `onExhausted: "fail"` branches, Signal, terminal inspect.
- Workflow file: `.acpus/tmp/acpus-skill-bench/r6-loop16/loop-exhaustion.workflow.ts`
- Loop type: `agentless-run`
- Agent-containing workflow runs: 0
- Commands: two `workflows check` inputs; one approval-path background run plus signal; one failing-path background run; terminal inspect.
- Check attempts: 2
- Check result: both passed with 0 errors.
- Run result: approval path completed with `approved: true`, `returnRound: 2`, `returnTotal: 5`; failing path failed before Signal with `Loop exhausted after 2 iterations.` at `fail_on_exhaustion_loop`.
- Tool-call count: 26 developer-tool actions counting shell calls.
- Workflow Agent tool-call count: 0
- Score: 98
- Observed failures: intentional loop exhaustion failure correctly attributed to the loop node.
- Skill changes proposed: document `onExhausted: "fail"` and that downstream Signal nodes are not reached after loop exhaustion failure.

### Loop 17 - Agent Override Validation

- Agent: Beauvoir
- Prompt direction: check-only workflow with declared `reviewer: { use: "pi" }`, valid `--agents`, then invalid override cases.
- Workflow file: `.acpus/tmp/acpus-skill-bench/r6-loop17/pi-review.workflow.ts`
- Loop type: `agent-check`
- Agent-containing workflow runs: 0
- Commands: valid `workflows check --agents`; invalid checks for unknown agent, simultaneous `use` and `command`, legacy `policy`, broad `options`, raw `kind`; repeated invalid checks with `--json`.
- Valid check result: passed with 0 diagnostics, 5 nodes.
- Invalid override result: all rejected before runtime in `validate` phase.
- Tool-call count: 10 visible assistant invocations, 22 shell commands plus one scratch-file patch.
- Workflow Agent tool-call count: 0
- Score: 100
- Observed failures: none; override validation matched the Skill guidance.
- Skill changes proposed: mention `--json workflows check` exposes `phase` for override failures.

### Round Summary

- Round average score: 98.7
- Recorded optimize loops complete: 17 of 20
- Cumulative agent-containing workflow runs used: 5
- Remaining Agent workflow executions available under strict `<10` cap: 4
- Changes applied after round: `authoring-typescript-workflows.md` documents `onExhausted: "fail"` and downstream signal non-reachability; `cli-operations.md` notes `--json` exposes exact failure phase for invalid overrides.

## Round 7 - Environment, Catalog, And Final Adversarial Loop

Date: 2026-07-07

### Loop 18 - Source Checkout Environment Recovery

- Agent: Noether
- Prompt direction: static drill for stale `dist` or workspace link recovery using read-only evidence.
- Notes file: `.acpus/tmp/acpus-skill-bench/r7-loop18/source-checkout-recovery-report.md`
- Loop type: `static-drill`
- Agent-containing workflow runs: 0
- Commands: `pnpm exec acpus --help`; `runs list`; `doctor`; link and dist realpath/mtime checks.
- Result: command surface was healthy; `doctor` passed; expected package dist files existed; no install/build was run.
- Recovery sequence documented: verify help/doctor/list, inspect links and dist paths, run `pnpm install --frozen-lockfile --offline` if links are broken, run `pnpm build` if dist is stale, then re-run read-only verification.
- Tool-call count: 17 `exec_command`, 1 `apply_patch`, 4 parallel batches.
- Workflow Agent tool-call count: 0
- Score: 96
- Observed failures: none; minor score loss for broad environment inspection.

### Loop 19 - Catalog Workflow Runtime

- Agent: Linnaeus
- Prompt direction: project catalog workflow under `.acpus/workflows/r7-loop19-catalog/workflow.ts`, no Agent nodes, Task + Signal + nested composites, list/show/check/run by catalog name.
- Workflow file: `.acpus/workflows/r7-loop19-catalog/workflow.ts`
- Loop type: `agentless-run`
- Agent-containing workflow runs: 0
- Commands: `workflows list`; `workflows show r7-loop19-catalog`; `workflows check r7-loop19-catalog`; background `workflows run r7-loop19-catalog`; inspect; signal; terminal inspect; runs list.
- Check attempts: 1
- Check result: passed with 0 diagnostics, 12 static nodes.
- Run result: completed after signal. Final output included `approved: true`, `reviewer: "round7-loop19"`, `itemCount: 3`, `firstRoute: "ship"`.
- Workflow Agent tool-call count: 0
- Score: 100
- Observed failures: none; `rg -n "agent|agents"` exited 1 because there were intentionally no matches.
- Skill changes proposed: mention that Task/Signal-only catalog workflows may omit `agents` entirely.

### Loop 20 - Final Adversarial Agent Run

- Agent: Carson
- Prompt direction: final adversarial workflow with Task, Signal, deeply nested composites, complex expressions, and exactly one `pi` Agent node outside fanout.
- Workflow file: `.acpus/tmp/acpus-skill-bench/r7-loop20/final-adversarial.workflow.ts`
- Loop type: `agent-run`
- Agent-containing workflow runs: 1
- Commands: one `workflows check`; one background `workflows run`; inspect; signal; final text and JSON inspect.
- Check attempts: 1
- Check result: passed with 0 diagnostics.
- Run result: completed after signal at `operator_gate.then/human_approval~5dd35880ef44`.
- Output: `agentRisk: 0.15`, `approved: true`, `firstLane: "urgent"`, `firstSummary: "alpha urgent priority 3"`.
- Agent telemetry: one completed `agent_attempt` for `single_agent_review~a2adad8ff9f8`, one turn, stop reason `end_turn`, workflow Agent tool calls `0`, telemetry artifacts exposed.
- Score: 98
- Observed failures: none; JSON inspect can be very large for composite-heavy runs.
- Skill changes proposed: document single-Agent-outside-fanout pattern and Agent telemetry location.

### Round Summary

- Round average score: 98.0
- Recorded optimize loops complete: 20 of 20
- Cumulative agent-containing workflow runs used: 6
- Agent workflow execution cap: satisfied under strict `<10`
- Changes applied after round: `authoring-typescript-workflows.md` documents single-Agent placement for execution budgeting and that Task/Signal-only workflows may omit `agents`; `runtime-recovery.md` documents Agent telemetry metadata; `cli-operations.md` clarifies compact text inspect versus JSON metadata.

## Final Benchmark Summary

- Optimize loops completed: 20 of 20
- Agent-containing workflow runs used: 6
- Final five-loop average: 98.2
- Repeated setup failures from early rounds were eliminated by workspace-contained scratch paths, `--help` command-surface verification, source-checkout recovery docs, and richer composite/expression examples.
- Remaining improvements are incremental examples and UI/verbosity polish, not blocking Skill correctness.
