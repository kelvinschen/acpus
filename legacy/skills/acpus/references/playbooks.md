# Agent Workflow Playbooks

Acpus public playbooks live in the repository catalog under `.acpus/workflows/`.
Use the local catalog first:

```sh
acpus workflows list
acpus workflows show <catalog-ref>
```

For local workspace work, inspect `.acpus/workflows/` directly when you need source YAML. Use public GitHub URLs only when the user needs external links or the local catalog is unavailable.

## Quick Reference

Pick a playbook by task shape:

| When the task is… | Use playbook |
| --- | --- |
| Fan out research on multiple topics, synthesize findings | `codebase-deep-research` |
| Adversarially review an implementation from multiple angles | `adversarial-feature-implementation-review` |
| Generate several solution options, filter, and rank | `solution-generate-filter` |
| Run competing implementations in isolated worktrees, pick winner | `worktree-implementation-tournament` |
| Iteratively fix failing tests until green | `loop-until-green-fix` |
| Drive development from a goal, loop-plan-execute until done | `goal-driven-development` |
| Dispatch N parallel subagents, each with its own task | `subagent-driven` |
| Loop plan→implement→review with human approval via a Signal Node | `human-in-the-loop-development` |
| Discuss a topic through adversarial, constructive, synthetic, and empirical roles until consensus | `swarm-intelligence` |

## Public Playbooks

| Ref | Pattern | Mutates workspace | Source |
| --- | --- | --- | --- |
| `codebase-deep-research` | fanout-and-synthesize | No | [source](https://github.com/kelvinschen/acpus/blob/main/.acpus/workflows/codebase-deep-research.workflow.spec.yaml) |
| `adversarial-feature-implementation-review` | adversarial-verification | No | [source](https://github.com/kelvinschen/acpus/blob/main/.acpus/workflows/adversarial-feature-implementation-review.workflow.spec.yaml) |
| `solution-generate-filter` | generate-and-filter | No | [source](https://github.com/kelvinschen/acpus/blob/main/.acpus/workflows/solution-generate-filter.workflow.spec.yaml) |
| `worktree-implementation-tournament` | tournament | Yes | [source](https://github.com/kelvinschen/acpus/blob/main/.acpus/workflows/worktree-implementation-tournament.workflow.spec.yaml) |
| `loop-until-green-fix` | loop-until-done | Yes | [source](https://github.com/kelvinschen/acpus/blob/main/.acpus/workflows/loop-until-green-fix.workflow.spec.yaml) |
| `goal-driven-development` | goal-driven (GDD) | Yes | [source](https://github.com/kelvinschen/acpus/blob/main/.acpus/workflows/goal-driven-development.workflow.spec.yaml) |
| `subagent-driven` | fanout-subagents | No | [source](https://github.com/kelvinschen/acpus/blob/main/.acpus/workflows/subagent-driven.workflow.spec.yaml) |
| `human-in-the-loop-development` | human-in-the-loop (Signal-gated) | Yes | [source](https://github.com/kelvinschen/acpus/blob/main/.acpus/workflows/human-in-the-loop-development.workflow.spec.yaml) |
| `swarm-intelligence` | blackboard-swarm | No | [source](https://github.com/kelvinschen/acpus/blob/main/.acpus/workflows/swarm-intelligence/workflow.spec.yaml) |

When adapting a playbook, rewrite prompts, inputs, outputs, agent roles, and write boundaries for the actual user task. Do not copy a playbook mechanically.

`human-in-the-loop-development` loops plan→implement→review→route until approved. The reviewer agent gates each round; when it approves, a Signal Node (`workflow/dev_loop/route/human_gate`) blocks for an external decision delivered via `acpus runs signal <run_id> --node <nodeKey> --payload '{"approved":true|false,"notes":"..."}'`. A rejection's `notes` is carried into the next round so the planner/implementer/reviewer fix exactly what the decider objected to. The decider may be a human OR the agent driving the workflow.