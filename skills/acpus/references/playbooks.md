# Agent Workflow Playbooks

Acpus public playbooks live in the repository catalog under `.acpus/workflows/`.
Do not keep local copies inside this skill. Fetch the GitHub raw source when you need to inspect or adapt one:

```sh
curl -L https://raw.githubusercontent.com/kelvinschen/acpus/main/.acpus/workflows/codebase-deep-research.workflow.spec.yaml
```

## Quick Reference

Pick a playbook by task shape:

| When the task is… | Use playbook |
| --- | --- |
| Classify a request then route to different handlers | `dynamic-workflow-designer` |
| Fan out research on multiple topics, synthesize findings | `codebase-deep-research` |
| Adversarially review an implementation from multiple angles | `adversarial-feature-implementation-review` |
| Generate several solution options, filter, and rank | `solution-generate-filter` |
| Run competing implementations in isolated worktrees, pick winner | `worktree-implementation-tournament` |
| Iteratively fix failing tests until green | `loop-until-green-fix` |
| Drive development from a goal, loop-plan-execute until done | `goal-driven-development` |
| Dispatch N parallel subagents, each with its own task | `subagent-fanout` |

## Public Playbooks

| Ref | Pattern | Mutates workspace | Source |
| --- | --- | --- | --- |
| `project:dynamic-workflow-designer` | classify-and-act | Yes | [source](https://github.com/kelvinschen/acpus/blob/main/.acpus/workflows/dynamic-workflow-designer.workflow.spec.yaml) / [raw](https://raw.githubusercontent.com/kelvinschen/acpus/main/.acpus/workflows/dynamic-workflow-designer.workflow.spec.yaml) |
| `project:codebase-deep-research` | fanout-and-synthesize | No | [source](https://github.com/kelvinschen/acpus/blob/main/.acpus/workflows/codebase-deep-research.workflow.spec.yaml) / [raw](https://raw.githubusercontent.com/kelvinschen/acpus/main/.acpus/workflows/codebase-deep-research.workflow.spec.yaml) |
| `project:adversarial-feature-implementation-review` | adversarial-verification | No | [source](https://github.com/kelvinschen/acpus/blob/main/.acpus/workflows/adversarial-feature-implementation-review.workflow.spec.yaml) / [raw](https://raw.githubusercontent.com/kelvinschen/acpus/main/.acpus/workflows/adversarial-feature-implementation-review.workflow.spec.yaml) |
| `project:solution-generate-filter` | generate-and-filter | No | [source](https://github.com/kelvinschen/acpus/blob/main/.acpus/workflows/solution-generate-filter.workflow.spec.yaml) / [raw](https://raw.githubusercontent.com/kelvinschen/acpus/main/.acpus/workflows/solution-generate-filter.workflow.spec.yaml) |
| `project:worktree-implementation-tournament` | tournament | Yes | [source](https://github.com/kelvinschen/acpus/blob/main/.acpus/workflows/worktree-implementation-tournament.workflow.spec.yaml) / [raw](https://raw.githubusercontent.com/kelvinschen/acpus/main/.acpus/workflows/worktree-implementation-tournament.workflow.spec.yaml) |
| `project:loop-until-green-fix` | loop-until-done | Yes | [source](https://github.com/kelvinschen/acpus/blob/main/.acpus/workflows/loop-until-green-fix.workflow.spec.yaml) / [raw](https://raw.githubusercontent.com/kelvinschen/acpus/main/.acpus/workflows/loop-until-green-fix.workflow.spec.yaml) |
| `project:goal-driven-development` | goal-driven (GDD) | Yes | [source](https://github.com/kelvinschen/acpus/blob/main/.acpus/workflows/goal-driven-development.workflow.spec.yaml) / [raw](https://raw.githubusercontent.com/kelvinschen/acpus/main/.acpus/workflows/goal-driven-development.workflow.spec.yaml) |
| `project:subagent-fanout` | fanout-subagents | No | [source](https://github.com/kelvinschen/acpus/blob/main/.acpus/workflows/subagent-fanout.workflow.spec.yaml) / [raw](https://raw.githubusercontent.com/kelvinschen/acpus/main/.acpus/workflows/subagent-fanout.workflow.spec.yaml) |

When adapting a playbook, rewrite prompts, inputs, outputs, agent roles, and write boundaries for the actual user task. Do not copy a playbook mechanically.
