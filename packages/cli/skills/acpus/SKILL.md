---
name: acpus
description: Author, validate, run, inspect, recover, and explain Acpus TypeScript workflows and durable runs. Use for workflow modules, Agent/Task/Signal nodes, WorkflowIR, catalogs, hooks.json, runtime controls, task.define, acpus/core, acpus/expression, acpus/tasks/git, and steer/retry/fork/signal/pause/resume/cancel operations.
metadata:
  acpus-version: 0.8.0
---

# Acpus

Acpus compiles typed TypeScript workflow modules into durable runs. Assume the CLI is `acpus`; if unavailable, ask before suggesting installation.

## Operate

Use Acpus to achieve user's goal, own the Acpus loop: *author → run → inspect/recover → verify the goal*. For one named operation, route directly.

## Route the request

### **READ first**

- **Author or adapt:** Read `references/authoring.md` completely, then edit the target directly. Use only its linked examples; never inspect workflow-library implementations.
- **Run, observe, or control:** Read `references/cli-operations.md` for status, overrides, and controls; use `acpus <cmd> --help` for exact syntax.
- **Recover a run:** Read `references/runtime-recovery.md` for failed/timed-out/stale runs, drifting-agent steering, steer/retry/fork decisions, or deep diagnostics.
- **Workflow reuse:** `/wf:<hint>` / `/workflow:<hint>` mean reuse. Check library/catalog before authoring; otherwise skip catalog. Use library only for a good fit; read README first and implementation only to modify/diagnose, else follow **Author or adapt**.

| Workflow | Use when | Read first |
| --- | --- | --- |
| `deep-research` | Investigate complex questions with verified evidence | `workflows/library/deep-research/README.md` |
- **Choose an agent:** Read `references/acpx-agents.md` when Agent availability matters.

### **DO NOT read by default**

- **Advanced authoring:** Read `references/advanced-authoring.md` only when the requirement needs Agent session reuse, reusable or prebuilt Tasks, third-party package imports, artifacts, Task process controls, cooperative Task cancellation, or Agent tracing configuration.
- **Signal authoring:** Read `references/signal-authoring.md` only for parallel Signal waits, payload validation, timeout behavior, or duration syntax.
- **Advanced CLI operations:** Read `references/advanced-cli-operations.md` only when the requirement needs inspection pagination/follow resume, detailed runtime-control mechanics, catalogs, import, static visualization, WebUI, bundled-skill management, standalone artifact lookup, run deletion, version lookup, or structured CLI automation.
- **Review Agent evidence:** Read `references/agent-tracing.md` only for exact turn boundaries, opt-in Trace, or raw ACP.
- **Configure hooks:** Read `references/hooks-json.md`.

### **Explain concepts:**
Search all available documentation under `references/` to explain concepts. Choose the most relevant reference(s) for each topic.

## Inspection budget [Mandatory]

- Inspect the target controlling the next decision. Add `--timeline` only when process activity matters; use an exact attempt for Evidence metadata.
- Use dynamic keys for repeats and `--all` only for topology. Follow one transition, refresh Summary, filter with `jq`, and use raw last.

## Safety

- Ask before destructive run, state, or repository actions.
