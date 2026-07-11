---
name: acpus
description: Author, validate, run, inspect, recover, and explain Acpus TypeScript workflows and durable runs. Use for workflow modules, Agent/Task/Signal nodes, WorkflowIR, catalogs, hooks.json, runtime controls, task.define, acpus/core, acpus/expression, acpus/tasks/git, and retry/fork/signal/pause/resume/cancel operations.
---

# Acpus

Acpus compiles typed TypeScript workflow modules into durable runs. Assume the CLI is `acpus`; if unavailable, ask before suggesting installation.

## Route the request

- **Author or adapt:** Read `references/authoring.md` completely before editing. For new workflows, choose the closest file under `examples/workflows/` by its `Pattern` and `Nodes` header, then write the target workflow module directly.
- **Check, run, list, or show:** Read `references/cli-operations.md` and use `acpus <cmd> --help` for exact syntax.
- **Inspect or control a run:** Read `references/runtime-recovery.md`; inspect before retry, fork, signal, cancel, pause, resume, or delete.
- **Configure hooks:** Read `references/hooks-json.md`.
- **Choose an agent:** Read `references/acpx-agents.md` when built-in or local agent availability matters.
- **Explain concepts:** Read the focused reference above; use `references/authoring.md` for workflow, node, expression, schema, Task, or artifact semantics.

Re-route when the request changes materially.

## Authoring guardrails [Mandatory]

- **NEVER treat graph tokens from input, meta, or node output as ordinary JavaScript values during graph construction**. **NEVER apply JavaScript operators or control flow to them**. These tokens are Expr<T> values resolved at run time. Treat Expr as a *Functor*: use fmap to map one token, lift2/lift3/lift to combine multiple tokens, and graph nodes for control flow.
- **NEVER hide dependencies inside `fmap`/`lift*`. NEVER capture outer values.** Pass every dependency as an argument; callbacks are inline synchronous computations over resolved values.
- **NEVER capture workflow values inside inline Task `exec`.** Bind every workflow dependency through the Task step's top-level `input` and read it from Task context; use `task.define` for imports or shared code.
- **ALWAYS run `acpus workflow check <workflow.ts-or-catalog>` after editing.** Resolve every error before running.

## Safety

- Ask before destructive run, state, or repository actions.
