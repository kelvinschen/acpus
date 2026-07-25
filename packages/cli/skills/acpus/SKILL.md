---
name: acpus
description: Author, validate, run, inspect, recover, and explain Acpus TypeScript workflows and durable runs. Use for workflow modules, Agent/Task/Signal nodes, WorkflowIR, catalogs, hooks.json, runtime controls, task.define, acpus/core, acpus/expression, acpus/tasks/git, and retry/fork/signal/pause/resume/cancel operations.
metadata:
  acpus-version: 0.8.0
---

# Acpus

Acpus compiles typed TypeScript workflow modules into durable runs. Assume the CLI is `acpus`; if unavailable, ask before suggesting installation.

## Operate

When invoked with a task, accomplish it with acpus: own the full loop of *author → run → status tracking / recover on failure → verify output meets the goal*. Route each step below. For a single named operation, skip straight to that route.

## Route the request

### **READ first**

- **Author or adapt:** Read `references/authoring.md` completely, then edit the target directly. Use only its linked examples; never inspect workflow-library implementations.
- **Run, observe, or control:** Read `references/cli-operations.md` for live workflow/Agent status, overrides, and controls; use `acpus <cmd> --help` for exact syntax.
- **Recover a run:** Read `references/runtime-recovery.md` for a failed/timed-out/stale execution, drifting-agent steering, steer/retry/fork decisions, or deep diagnostics.
- **Workflow reuse:** `/wf:<hint>` / `/workflow:<hint>` mean reuse. Check library/catalog before authoring; otherwise skip catalog. Use library only for a good fit; read README first and implementation only to modify/diagnose, else follow **Author or adapt**.

| Workflow | Use when | Read first |
| --- | --- | --- |
| `deep-research` | Investigate complex questions with verified evidence | `workflows/library/deep-research/README.md` |
- **Choose an agent:** Read `references/acpx-agents.md` when built-in or local agent availability matters.

### **DO NOT read by default**

- **Advanced authoring:** Read `references/advanced-authoring.md` only when the requirement needs Agent session reuse, reusable or prebuilt Tasks, third-party package imports, artifacts, Task process controls, cooperative Task cancellation, or Agent tracing configuration.
- **Signal authoring:** Read `references/signal-authoring.md` only for parallel Signal waits, payload validation, timeout behavior, or duration syntax.
- **Advanced CLI operations:** Read `references/advanced-cli-operations.md` only when the requirement needs detailed runtime-control mechanics, catalogs, import, static visualization, WebUI, bundled-skill management, standalone artifact lookup, run deletion, version lookup, or structured CLI automation.
- **Review Agent history:** Read `references/agent-tracing.md` for persisted turns/traces and raw ACP. Use `references/cli-operations.md` for live status.
- **Configure hooks:** Read `references/hooks-json.md`.

### **Explain concepts:**
Search all available documentation under `references/` to explain concepts. Choose the most relevant reference(s) for each topic.



## Inspection budget [Mandatory]

- Start with compact text: foreground already follows; after background/detach, run one-shot `inspect`.
- Use `--target` before `--all`; choose a dynamic target for repetitions. Reserve `--all` for cross-occurrence topology.
- Bound piped `--follow` to the needed transition, then take a fresh snapshot. Never default to `--all --follow`.
- Filter JSON/NDJSON with focused `jq`; use `--raw --json` only as a focused last resort.

## Safety

- Ask before destructive run, state, or repository actions.
