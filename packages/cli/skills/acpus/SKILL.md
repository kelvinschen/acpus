---
name: acpus
description: Helps author, check, run, inspect, recover, and explain Acpus TypeScript workflows, durable runs, agent/task/signal nodes, runtime controls, catalog entries, hooks.json. Use when the user mentions Acpus, acpus workflow/runs/hooks, TypeScript workflow modules, WorkflowIR, task.define, acpus/core, acpus/expression, acpus/tasks/git, or retry/fork/signal/pause/resume/cancel operations.
---

# Acpus

Use this Skill for the TypeScript implementation of Acpus.

Acpus is a local durable harness for AI-first workflows. Authors write typed TypeScript workflow modules, Acpus compiles them and advances runs.

Assume the user can run the CLI as `acpus`. If the CLI is unavailable, ask whether they want to install it with `npm install -g acpus` before giving installation steps.

## First classify the request

| Path | Use when the user asks to... | Start here |
| --- | --- | --- |
| Explain | understand Acpus concepts, node types, WorkflowIR, expressions, or durable runs | Answer conceptually; use the focused reference for the topic. |
| Author / adapt | create or edit a TypeScript workflow module, task, agent, signal, composite, schema, or prompt | For new workflows, start with `acpus workflow init file <file.ts>` or `init catalog <name>`; then choose the closest `Pattern`/`Nodes` example, read `references/authoring.md`, and edit the generated file. |
| Check | validate a workflow before running it | Use `acpus workflow check <workflow.ts>`; read `references/cli-operations.md`. |
| Run | start an existing workflow or catalog entry | Use `acpus workflow run <workflow-or-catalog>`; read `references/cli-operations.md`. |
| Inspect / monitor | inspect a run, pick a run interactively, observe status, diagnose awaiting signal or stale execution | Use `acpus runs inspect [run-id]`; read `references/runtime-recovery.md`. |
| Recover / control | pause, resume, retry, cancel, fork, or signal a run | Inspect first; then choose the smallest safe control in `references/runtime-recovery.md`. |
| Configure hooks | validate or explain runtime hook config | Read `references/hooks-json.md`. |

A single conversation may move through several paths. Re-classify before each material action.

## Operating defaults

1. Use `acpus <cmd> --help` for exact command syntax.
2. Check workflows before running; inspect runs before retry, fork, signal, cancel, pause, resume, or delete.
3. Ask before destructive actions such as canceling, deleting `.acpus`, unsafe fork reuse, publishing, pushing, or deleting files.

## Authoring quick sheet

Use one boundary rule throughout authoring: plain `T` is declaration-time structure; `Resolvable<T>` accepts either a durable literal or an `Expr<T>` and resolves from workflow scope at run time. Timeouts, prompts/messages, node cwd/env, repair/quorum counts, and concurrency limits are resolvable. Node ids, strategies, schemas, task targets, agent identity/policy, runners, shells, and secret names are static. Top-level Agent cwd/env are static; node `run.cwd`/`run.env` are resolvable.

For a new workflow, create a checkable scaffold before editing:

```sh
acpus workflow init file workflow.ts
acpus workflow check workflow.ts
```

```ts
import { defineWorkflow, z } from "acpus/core";
import { fmap, template } from "acpus/expression";

export default defineWorkflow({
  name: "diff-review",
  description: "Review a repository diff for readiness.",
  inputSchema: z.object({ repoPath: z.string(), headRef: z.string().default("HEAD") }),
  agents: {
    reviewer: { use: "codex" },
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
    outputSchema: z.object({
      ready: z.boolean(),
      riskCount: z.number(),
      summary: z.string(),
    }),
    run: {
      agent: agents.reviewer,
      prompt: template`Review this patch and return JSON: ${diff.output.patch}`,
    },
    retry: { max: 2 },
    timeout: "30m",
  });

  step("require_ready").assert({
    condition: fmap(review.output, output => output.ready && output.riskCount <= 3),
    message: template`Review failed: ${review.output.summary}`,
  });

  return { runId: meta.runId, ready: review.output.ready, summary: review.output.summary };
});
```

## Run quick sheet

Check before admitting a durable run:

```sh
acpus workflow check <workflow.ts-or-catalog>
```

Run workflow with input, `--background` for background run:

```sh
acpus workflow run <workflow.ts-or-catalog> --input '<json>'  [--background]
```

Inspect run

```sh
acpus runs inspect <run-id>
```

## Reference map

Read only the file needed for the current task (Files are relative to this skill directory):

| Need | Read |
| --- | --- |
| TypeScript workflow DSL, nodes, expressions, schemas, tasks, agents, artifacts | `references/authoring.md` |
| Built-in and locally configured acpx agent names for `use` vs `command` | `references/acpx-agents.md` |
| Exact public API signatures | Use the declaration lookup protocol in `references/authoring.md` |
| CLI operation defaults and help discovery | `references/cli-operations.md` |
| Inspecting, monitoring, retry/fork/signal/cancel/pause/resume decisions | `references/runtime-recovery.md` |
| hooks.json format and hook validation/listing | `references/hooks-json.md` |
| Adversarial review with dynamic lenses, fanout, cross-critique, and structured synthesis (`agent`, `fanout`) | `examples/workflows/adversarial-review/workflow.ts` |
| Issue triage with fanout, parallel, switch, companion reusable task module, and agent review (`agent`, `task`, `switch`, `parallel`, `fanout`) | `examples/workflows/issue-triage/workflow.ts` |
| Issue triage companion task module | `examples/workflows/issue-triage/tasks.ts` |
| Change approval with agent plan refinement, loop, optional signal, if, and assert (`agent`, `task`, `signal`, `assert`, `if`, `loop`) | `examples/workflows/change-approval/workflow.ts` |
| Worktree tournament with `createWorktree`, three implementation agents, and a judge (`agent`, `task`, `parallel`) | `examples/workflows/worktree-tournament/workflow.ts` |
| Multi-aspect brainstorm workflow (`agent`, `parallel`, `loop`) | `examples/workflows/multi-aspect-brainstorm/workflow.ts` |
| Copyable hook config | `examples/hooks.example.json` |
