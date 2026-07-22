---
name: acpus
description: Author, validate, run, inspect, recover, and explain Acpus TypeScript workflows and durable runs. Use for workflow modules, Agent/Task/Signal nodes, WorkflowIR, catalogs, hooks.json, runtime controls, task.define, acpus/core, acpus/expression, acpus/tasks/git, and retry/fork/signal/pause/resume/cancel operations.
metadata:
  acpus-version: 0.7.0
---

# Acpus

Acpus compiles typed TypeScript workflow modules into durable runs. Assume the CLI is `acpus`; if unavailable, ask before suggesting installation.

## Operate

When invoked with a task, accomplish it with acpus: own the full loop of *author → run → status tracking / recover on failure → verify output meets the goal*. Route each step below. For a single named operation, skip straight to that route.

## Route the request

- **Author or adapt:** Read `references/authoring.md` completely before editing, then write the target workflow module directly.
- **Advanced authoring:** **DO NOT read `references/advanced-authoring.md` by default.** Read it only when the requirement needs Agent session reuse, reusable or prebuilt Tasks, third-party package imports, artifacts, Task process controls, cooperative Task cancellation, or Agent tracing configuration.
- **Signal authoring:** **DO NOT read `references/signal-authoring.md` by default.** Read it only for parallel Signal waits, payload validation, timeout behavior, or duration syntax.
- **Run, observe, or control:** Read `references/cli-operations.md` for live workflow/Agent status, overrides, signal, pause, resume, or cancel; use `acpus <cmd> --help` for exact syntax.
- **Advanced CLI operations:** **DO NOT read `references/advanced-cli-operations.md` by default.** Read it only when the requirement needs catalogs, import, static visualization, WebUI, bundled-skill management, standalone artifact lookup, run deletion, version lookup, or structured CLI automation.
- **Recover a run:** Read `references/runtime-recovery.md` for failed, timed-out, or stale execution, retry/fork decisions, or deep diagnostics. Inspect before recovery.
- **Review Agent history:** Read `references/agent-tracing.md` for persisted turns/traces and raw ACP. Use `references/cli-operations.md` for live status.
- **Configure hooks:** Read `references/hooks-json.md`.
- **Choose an agent:** Read `references/acpx-agents.md` when built-in or local agent availability matters.
- **Explain concepts:** Use `references/authoring.md` for workflow, node, expression, schema, or inline Task semantics. Use `references/advanced-authoring.md` only for its gated topics, including Agent session reuse, and `references/agent-tracing.md` for Agent tracing semantics.

Re-route when the request changes materially.

## Inspection budget [Mandatory]

- Start with compact text: foreground already follows; after background/detach, run one-shot `inspect`.
- Use `--target` before `--all`; choose a dynamic target for repetitions. Reserve `--all` for cross-occurrence topology.
- Bound piped `--follow` to the needed transition, then take a fresh snapshot. Never default to `--all --follow`.
- Filter JSON/NDJSON with focused `jq`; use `--raw --json` only as a focused last resort.

## Safety

- Ask before destructive run, state, or repository actions.
