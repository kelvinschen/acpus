# Benchmark Loop Plan

The long-running Skill optimization target is at least 20 optimize loops. A loop is one bounded evaluate -> score -> learn -> update-or-record cycle. Loops may use real Agent workflow execution, check-only authoring, agentless runtime execution, or static recovery/hook drills. The total number of workflow executions that include Agent nodes MUST stay below 10.

## Loop Types

| Type | Counts As Optimize Loop | Counts Against Agent Run Cap | Use For |
| --- | --- | --- | --- |
| `agent-run` | yes | yes | End-to-end Task + Agent + Signal + composite runtime behavior with `pi`. |
| `agent-check` | yes | no | Authoring success for workflows containing Agent nodes without admitting a run. |
| `agentless-run` | yes | no | Runtime behavior for nested composites, Signals, asserts, hooks, and recovery without Agent cost. |
| `static-drill` | yes | no | Recall, CLI command choice, recovery, hook config, and troubleshooting scenarios. |

## 20-Loop Boundary Matrix

| Loop | Type | Boundary |
| ---: | --- | --- |
| 1 | `agent-run` | Baseline release review with Task + Agent + Signal. |
| 2 | `agent-run` | Baseline goal-driven loop and candidate tournament. |
| 3 | `agent-run` | Release readiness with `parallel` lanes and denial signal. |
| 4 | `agent-run` | Goal audit with Signal before final Agent and expression-array count pitfall. |
| 5 | `agent-run` | Candidate filtering with `fanout`, `parallel`, Signal approval, and completed `pi` Agent. |
| 6 | `agent-check` | Deep nesting: `fanout -> parallel -> switch -> loop -> agent`. |
| 7 | `agentless-run` | Same deep nesting with Agent branch disabled by input, proving non-Agent runtime path. |
| 8 | `agent-check` | Expression collections: `filter`, `map`, `every`, `some`, `len`, `head`, `coalesce`. |
| 9 | `agentless-run` | Signal payload validation through a nested composite static alias and dynamic target. |
| 10 | `static-drill` | Recovery: retry vs fork after source change, frozen workflow semantics. |
| 11 | `agent-check` | `parallel` `race` output envelope and downstream access. |
| 12 | `agentless-run` | `fanout` quorum output as accepted item array, not envelope. |
| 13 | `agent-check` | Nullable/optional output handling with `coalesce` and `head`. |
| 14 | `static-drill` | Hook JSON validation and `node.failed` matching. |
| 15 | `agent-check` | Reusable `task.define` plus inline Task capture avoidance. |
| 16 | `agentless-run` | Loop exhaustion behavior: `onExhausted: "returnLast"` vs failure. |
| 17 | `agent-check` | Agent overrides allowlist and invalid legacy fields rejected. |
| 18 | `static-drill` | Source-checkout environment recovery for stale `dist` or workspace links. |
| 19 | `agentless-run` | Catalog workflow check/run from `.acpus/workflows/<name>/workflow.ts`. |
| 20 | `agent-run` if budget remains, otherwise `agent-check` | Final adversarial user workflow combining nested composites, complex expressions, Signal, and `pi`. |

Current recorded loops: 1-5. Current Agent workflow executions used: 5. Remaining Agent workflow executions available under the cap: 4 if treating "under 10" strictly as at most 9 total.

## Batch Rules

- Run clean subagents in batches of at least three when using subagents.
- Put scratch workflows under `.acpus/tmp/acpus-skill-bench/<loop>/`.
- Prefer `agent-check` or `agentless-run` for loops 6-19 unless the loop specifically needs live Agent behavior.
- Preserve failed attempts in `references/benchmark-results.md`; do not rewrite history to look cleaner.
- After each batch, update the Skill only for repeated misses or high-impact one-off bugs.
