---
name: acpus
description: Helps author, check, run, inspect, recover, and explain Acpus next TypeScript workflows, durable runs, agent/task/signal nodes, runtime controls, catalog entries, hooks.json, and acpx agent overrides. Use when the user mentions Acpus, acpus workflows/runs/hooks, TypeScript workflow modules, WorkflowIR, task.define, acpus/core, acpus/expression, acpus/tasks/git, or retry/fork/signal/pause/resume/cancel operations.
---

# Acpus

Use this Skill for the next TypeScript implementation of Acpus. Do not use legacy YAML Workflow Spec patterns unless the user explicitly asks about the archived legacy implementation.

Acpus is a local durable harness for AI-first workflows. In the next implementation, authors write typed TypeScript workflow modules, Acpus compiles them to frozen `WorkflowIR`, and the durable runtime admits and advances runs from that frozen state.

## First classify the request

| Path | Use when the user asks to... | Start here |
| --- | --- | --- |
| Explain | understand Acpus concepts, node types, WorkflowIR, expressions, durable runs, or migration from legacy | Answer conceptually; read `references/legacy-migration.md` for old-to-new mapping. |
| Author / adapt | create or edit a TypeScript workflow module, task, agent, signal, composite, schema, or prompt | Read `references/authoring-typescript-workflows.md`, then examples under `assets/examples/`. |
| Check | validate a workflow before running it | Use `acpus workflows check <workflow.ts>`; read `references/cli-operations.md`. |
| Run | start an existing workflow or catalog entry | Use `acpus workflows run <workflow-or-catalog>`; read `references/cli-operations.md`. |
| Inspect / monitor | inspect a run, pick a run interactively, observe status, diagnose awaiting signal or stale execution | Use `acpus runs inspect [run-id]`; read `references/runtime-recovery.md`. |
| Recover / control | pause, resume, retry, cancel, fork, or signal a run | Inspect first; then choose the smallest safe control in `references/runtime-recovery.md`. |
| Configure hooks | validate or explain runtime hook config | Read `references/hooks-json.md`. |

A single conversation may move through several paths. Re-classify before each material action.

## Operating defaults

1. Verify the command surface before taking action: `acpus --help`. Use `acpus doctor` for read-only workspace health checks.
2. Prefer read-only commands first: `acpus doctor`, `acpus runs inspect`, `acpus workflows list`, `acpus workflows show`, `acpus hooks validate`, and `acpus hooks list`.
3. Ask before destructive or hard-to-reverse actions: `runs cancel`, targeted `cancel`, deleting `.acpus`, `runs fork --unsafe-reuse`, publishing packages, pushing Git refs, deleting files, or running arbitrary external side-effect commands.
4. Use `--json` only when structured parsing is needed. For human diagnosis, compact text output is often enough and cheaper.
5. Treat live workflow source as authoring input only. Runtime inspection and controls operate on frozen admitted runs in `.acpus/.local/`.

## Current command surface quick sheet

```sh
# Health and discovery
acpus doctor
acpus workflows list [--project | --global]
acpus workflows show <name> [--project | --global]

# Validate without admitting a run or writing durable artifacts
acpus workflows check <workflow.ts-or-catalog> [--input '<json>'] [--agents '<json>'] [--project | --global]

# Generate a standalone static workflow visualization
acpus workflows viz <workflow.ts-or-catalog> --out workflow-viz.html [--force] [--project | --global]

# Admit and execute a durable run
acpus workflows run <workflow.ts-or-catalog> [--input '<json>'] [--agents '<json>'] [--background] [--project | --global]

# Inspect durable runtime state
acpus runs inspect [run-id]

# Runtime controls
acpus runs delete [run-id]
acpus runs pause <run-id>
acpus runs resume <run-id>
acpus runs retry <run-id> [--target <nodeKey-or-frameKey-or-static-alias>]
acpus runs cancel <run-id> [--target <nodeKey-or-frameKey-or-static-alias>]
acpus runs signal <run-id> --target <signal-nodeKey-or-static-alias> --payload '<json-or-string>'
acpus runs fork <run-id> [--workflow <workflow.ts>] [--input '<json>'] [--agents '<json>'] [--target <target>] [--unsafe-reuse]

# Hooks
acpus hooks validate [--project | --global]
acpus hooks list [--project | --global]
```

Legacy guardrails: avoid `acpus runs show`, `acpus workflows lint`, YAML Workflow Specs, `hooks.yaml`, `program` nodes, CEL snippets, `fork --from`, and `runs replay` unless the user is explicitly working in the archived legacy implementation.

## Authoring quick sheet

```ts
import { defineWorkflow, z } from "acpus/core";
import { template, and, lte } from "acpus/expression";

const ReviewOut = z.object({
  ready: z.boolean(),
  riskCount: z.number(),
  summary: z.string(),
});

export default defineWorkflow({
  name: "release-review",
  inputSchema: z.object({ repoPath: z.path(), headRef: z.string().default("HEAD") }),
  agents: {
    reviewer: { use: "codex", permissionMode: "approve-reads" },
  },
}).build(({ input, agents, step, meta }) => {
  const diff = step("collect_diff").task({
    run: {
      input: { repoPath: input.repoPath, headRef: input.headRef },
      cwd: input.repoPath,
      exec: async ({ input, $, artifact }) => {
        const result = await $`git diff ${input.headRef}`;
        return {
          patch: await artifact.writeText("diff.patch", result.stdout, {
            mediaType: "text/x-patch",
          }),
        };
      },
    },
    timeout: "5m",
  });

  const review = step("review").agent({
    outputSchema: ReviewOut,
    run: {
      agent: agents.reviewer,
      prompt: template`Review this patch and return JSON: ${diff.output.patch}`,
    },
    retry: { max: 2 },
    timeout: "30m",
  });

  step("require_ready").assert({
    condition: and(review.output.ready, lte(review.output.riskCount, 3)),
    message: template`Review not ready: ${review.output.summary}`,
  });

  return { runId: meta.runId, ready: review.output.ready, summary: review.output.summary };
});
```

## Reference map

Read only the file needed for the current task:

| Need | Read |
| --- | --- |
| TypeScript workflow DSL, nodes, schemas, composites, reusable tasks | `references/authoring-typescript-workflows.md` |
| Expression helpers, templates, schema boundaries, output admissibility | `references/expressions-and-schemas.md` |
| CLI commands, JSON/text output, catalog lookup, input and agent overrides | `references/cli-operations.md` |
| Inspecting, monitoring, retry/fork/signal/cancel/pause/resume decisions | `references/runtime-recovery.md` |
| Agent execution, acpx mapping, task `$`, artifacts, reusable tasks | `references/tasks-agents-artifacts.md` |
| hooks.json format and hook validation/listing | `references/hooks-json.md` |
| Legacy YAML-to-next TypeScript migration | `references/legacy-migration.md` |
| Common next-version failure modes and fixes | `references/troubleshooting.md` |
| Evaluation scenarios for this Skill | `references/evaluations.md` |
| Benchmark metrics for maintaining this Skill | `references/benchmark.md` |
| 20-loop benchmark boundary plan | `references/benchmark-loop-plan.md` |
| Benchmark result log for this Skill | `references/benchmark-results.md` |
| Copyable minimal workflow | `assets/examples/minimal.workflow.ts` |
| Copyable review workflow with task + agent + assert | `assets/examples/review-with-task.workflow.ts` |
| Copyable signal approval workflow | `assets/examples/signal-approval.workflow.ts` |
| Copyable composite workflow with fanout + parallel + loop + signal | `assets/examples/composite-review.workflow.ts` |
| Copyable advanced boundary workflow with nested composites and complex expressions | `assets/examples/advanced-boundary.workflow.ts` |
| Copyable agentless nested runtime workflow | `assets/examples/agentless-nested.workflow.ts` |
| Copyable quorum fanout workflow without Agent nodes | `assets/examples/quorum-agentless.workflow.ts` |
| Copyable hook config | `assets/hooks.example.json` |

For maintaining this Skill, run `python scripts/verify-skill.py .` from the skill directory after edits.
