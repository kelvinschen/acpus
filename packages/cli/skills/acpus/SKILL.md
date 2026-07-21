---
name: acpus
description: Author, validate, run, inspect, recover, and explain Acpus TypeScript workflows and durable runs. Use for workflow modules, Agent/Task/Signal nodes, WorkflowIR, catalogs, hooks.json, runtime controls, task.define, acpus/core, acpus/expression, acpus/tasks/git, and retry/fork/signal/pause/resume/cancel operations.
metadata:
  acpus-version: 0.6.2
---

# Acpus

Acpus compiles typed TypeScript workflow modules into durable runs. Assume the CLI is `acpus`; if unavailable, ask before suggesting installation.

## Operate

When invoked with a task, accomplish it with acpus: own the full loop of *author → run → status tracking / recover on failure → verify output meets the goal*. Route each step below. For a single named operation, skip straight to that route.

## Route the request

- **Author or adapt:** Read `references/authoring.md` completely before editing, then write the target workflow module directly.
- **Advanced authoring:** **DO NOT read `references/advanced-authoring.md` by default.** Read it only when the requirement needs reusable or prebuilt Tasks, third-party package imports, artifacts, Task process controls, cooperative Task cancellation, or Agent tracing configuration.
- **Signal authoring:** **DO NOT read `references/signal-authoring.md` by default.** Read it only for parallel Signal waits, payload validation, timeout behavior, or duration syntax.
- **Run, observe, or routine controls:** Read `references/cli-operations.md` for run, inspect, Agent overrides, signal, pause, resume, or cancel; use `acpus <cmd> --help` for exact syntax.
- **Advanced CLI operations:** **DO NOT read `references/advanced-cli-operations.md` by default.** Read it only when the requirement needs catalogs, import, static visualization, WebUI, bundled-skill management, standalone artifact lookup, run deletion, version lookup, or structured CLI automation.
- **Recover a run:** Read `references/runtime-recovery.md` for failed, timed-out, or stale execution, retry/fork decisions, or deep diagnostics. Inspect before recovery.
- **Trace Agent execution:** Read `references/agent-tracing.md` for turn records, normalized traces, raw ACP diagnostics, and trace consumption.
- **Configure hooks:** Read `references/hooks-json.md`.
- **Choose an agent:** Read `references/acpx-agents.md` when built-in or local agent availability matters.
- **Explain concepts:** Use `references/authoring.md` for workflow, node, expression, schema, or inline Task semantics. Use `references/advanced-authoring.md` only for its gated topics and `references/agent-tracing.md` for Agent tracing semantics.

Re-route when the request changes materially.

## Inspection guardrails [Mandatory]

- **NEVER start run inspection with `--json`.** Start with compact text; add `--target` or `--all` only when needed.
- **ALWAYS pipe inspection `--json` or NDJSON through `jq`.** Select only fields needed for the current question. If `jq` is unavailable, stay in text mode.
- **Use `--raw --json` only as last-resort diagnostics**, with a focused `jq` query. Never load the unbounded bundle into context by default.

## Safety

- Ask before destructive run, state, or repository actions.
