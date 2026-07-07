# Acpus Skill Benchmark

Use this benchmark when maintaining the Skill itself. It measures whether an agent using the Skill can recall the right guidance, author valid current-version TypeScript workflows, and reach check/run success with low waste.

## Core Metrics

Score each scenario on a 100 point scale:

| Metric | Points | Evidence |
| --- | ---: | --- |
| Recall accuracy | 20 | The agent reads the right Skill references and uses next-version TypeScript APIs instead of legacy YAML, `program`, CEL snippets, `hooks.yaml`, `runs show`, `workflows lint`, or `runs replay`. |
| Authoring correctness | 25 | The final workflow uses valid imports, `defineWorkflow`, stable step ids, Task/Agent/Signal schemas, expression helpers, and composite callbacks that pass `workflows check`. |
| Execution success | 20 | The agent checks before run, uses valid `--input` and `--agents`, runs only when appropriate, handles signal waits with `runs inspect` and `runs signal`, and reports terminal or blocked status accurately. |
| Efficiency | 15 | Fewer tool calls, fewer check attempts, fewer repeated diagnostics, smaller context reads, and no broad unrelated repository scans. Record both assistant/developer tool invocations and workflow Agent telemetry when available. |
| Diagnosis quality | 10 | Failures are attributed to the right phase: `usage`, `check`, `compile`, `validate`, `run`, or `control`; fixes target the earliest failing phase. |
| Reporting quality | 10 | The final report includes files, commands, check attempts, run attempts, agent-run count, failure modes, and concrete Skill improvements. |

Default thresholds:

- `90-100`: stable; only polish or new coverage is likely to improve the Skill.
- `80-89`: usable; improve docs/examples for repeated misses.
- `65-79`: unstable; add or fix guidance before the next round.
- `<65`: failing; investigate whether the Skill or Acpus implementation is wrong.

## Efficiency Rubric

Start at 15 points and subtract:

- `-2` per failed `workflows check` attempt after the first failure.
- `-2` per avoidable command-surface mistake such as `acpus --version` when the current CLI does not expose it.
- `-1` per broad context read that does not inform the scenario.
- `-3` for using legacy terms or commands after reading the Skill.
- `-5` for exceeding the scenario's allowed agent-containing workflow run count.

Do not penalize one targeted failed check that reveals a genuine Acpus or Skill defect.

## Required Scenario Log

Record each evaluation with this shape:

```md
### Scenario Name

- Agent:
- Prompt direction:
- Workflow file:
- Agent-containing workflow runs:
- Commands:
- Check attempts:
- Check result:
- Run result:
- Tool-call count:
- Workflow Agent tool-call count:
- Context-window notes:
- Score:
- Observed failures:
- Skill changes proposed:
```

## Scenario Set

Run at least three clean-agent scenarios per round. Keep total workflow executions that include Agent nodes under the user-specified cap.

Scratch workflows MUST live inside the workspace used as CLI `cwd`, for example `.acpus/tmp/acpus-skill-bench/<agent>/workflow.ts` in this repository. This directory is ignored by git, keeps package resolution stable, and avoids the compiler's outside-workspace rejection.

For long-running optimization, follow the 20-loop boundary plan in `references/benchmark-loop-plan.md`. After the Agent workflow execution budget is close to the cap, continue with `agent-check`, `agentless-run`, and `static-drill` loops rather than spending more live Agent runs.

For `agent-check` scenarios, "Agent workflow executions started" MUST be `0`. `workflows check` can validate Agent declarations without invoking an agent.

1. Release review with human approval:
   - Must use Task to collect deterministic context.
   - Must use one Agent node with `--agents '{"reviewer":{"use":"pi"}}'` or an equivalent declared `use: "pi"`.
   - Must use Signal for approval.
   - Must use at least one `if`, `parallel`, or `switch` node.

2. Goal-driven implementation loop:
   - Must use Task for workspace/report setup.
   - Must use Agent for planning or auditing.
   - Must use `loop` with `initial`, `stopWhen`, `maxIterations`, and `onExhausted`.
   - Must inspect and report whether a run is awaiting signal, failed, completed, or blocked.

3. Worktree or candidate tournament:
   - Must use Task for deterministic candidate setup or summarization.
   - Must use `fanout` or `parallel` for candidate lanes.
   - Must use Agent for review/judgment.
   - Must avoid modifying tracked repository files during evaluation unless explicitly scoped.

4. Hooks and recovery drill:
   - No Agent workflow run required.
   - Must validate `.acpus/hooks.json`.
   - Must explain retry vs fork from frozen run state.
   - Must avoid legacy hook and recovery commands.

## Interpreting Results

Repeated misses usually map to one of three fixes:

- Recall miss: tighten `SKILL.md` classification, command sheet, or legacy guardrails.
- Authoring miss: add a copyable example or a short pattern to `references/authoring-typescript-workflows.md`.
- Operation miss: clarify `references/cli-operations.md`, `references/runtime-recovery.md`, or `references/troubleshooting.md`.

If a checked workflow follows the Skill and still fails because Acpus rejects valid current behavior, fix Acpus at the owning package, update the relevant spec, add a focused test, then ask a clean subagent to review the patch.
