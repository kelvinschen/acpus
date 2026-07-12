---
name: acpus
description: Author, validate, run, inspect, recover, and explain Acpus TypeScript workflows and durable runs. Use for workflow modules, Agent/Task/Signal nodes, WorkflowIR, catalogs, hooks.json, runtime controls, task.define, acpus/core, acpus/expression, acpus/tasks/git, and retry/fork/signal/pause/resume/cancel operations.
metadata:
  acpus-version: 0.6.0-alpha.5
---

# Acpus

Acpus compiles typed TypeScript workflow modules into durable runs. Assume the CLI is `acpus`; if unavailable, ask before suggesting installation.

## Route the request

- **Author or adapt:** Read `references/authoring.md` completely before editing. For new workflows, choose the closest file under `examples/workflows/` by its `Pattern` and `Nodes` header, then write the target workflow module directly.
- **Advanced Task authoring:** **DO NOT read `references/advanced-authoring.md` by default.** Read it only when the requirement needs reusable or prebuilt Tasks, third-party package imports, artifacts, Task process controls, or cancellation handling.
- **Check, run, list, or show:** Read `references/cli-operations.md` and use `acpus <cmd> --help` for exact syntax.
- **Inspect or control a run:** Read `references/runtime-recovery.md`; inspect before retry, fork, signal, cancel, pause, resume, or delete.
- **Configure hooks:** Read `references/hooks-json.md`.
- **Choose an agent:** Read `references/acpx-agents.md` when built-in or local agent availability matters.
- **Explain concepts:** Use `references/authoring.md` for workflow, node, expression, schema, or inline Task semantics. Use `references/advanced-authoring.md` only for its gated Task topics.

Re-route when the request changes materially.

## Inspection guardrails [Mandatory]

- **NEVER start run inspection with `--json`.** Start with compact text; add `--target` or `--all` only when needed.
- **ALWAYS pipe inspection `--json` or NDJSON through `jq`.** Select only fields needed for the current question. If `jq` is unavailable, stay in text mode.
- **Use `--raw --json` only as last-resort diagnostics**, with a focused `jq` query. Never load the unbounded bundle into context by default.

## Safety

- Ask before destructive run, state, or repository actions.
