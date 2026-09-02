---
name: acpus
description: Use when Acpus is the intended orchestration layer, or when an existing Acpus workflow or durable run is in scope.
metadata:
  acpus-version: 0.15.1
---

# Acpus

Acpus compiles typed TypeScript workflow modules into durable runs. Assume the CLI is `acpus`; if unavailable, ask before suggesting installation.

## Operate

Use Acpus to achieve user's goal, own the Acpus loop: *author → run → inspect/recover → verify the goal*. For one named operation, route directly.

For Agent-heavy authoring, select Presets by their guidance. The scale counts expected Agent execution occurrences across fanout, loops, and branches, not Tasks, Agent slots, or reused sessions. This is a guideline, not a hard limit — follow it unless the user's prompt calls for a different scale.

## Route the request

### **READ first**

- **Authoring** Read `references/authoring.md`;
- **Bind an agent:** Read `references/acp-agents.md` before selecting Presets or concrete Agent backends.
- **Run or observe:** Read `references/cli-operations.md` for admission, inspection, artifacts, ordinary interaction, and stop controls;
- **Library/catalog reuse:** Enable only for user-written `/wf:<hint>` or `/workflow:<hint>`. Read the README first; read implementation only to modify or diagnose. Without a marker, read only user-named workflows.

### **DO NOT read by default**

- **Recover or intervene:** Read `references/runtime-recovery.md` for failed/timed-out/stale runs, Retry, Steer, Fork decisions, or deep diagnostics.
- **Advanced authoring:** Read `references/advanced-authoring.md` only for Agent session reuse, reusable/prebuilt Tasks, imports, artifacts, Task process controls, or cooperative cancellation.
- **Signal authoring:** Read `references/signal-authoring.md` only for parallel Signal waits, payload validation, timeout behavior, or duration syntax.
- **Advanced CLI operations:** Read `references/advanced-cli-operations.md` only for Forensics, detailed controls, catalogs/import, visualization, WebUI, deletion, or version lookup.
- **Review Agent records:** Read `references/agent-records.md` only for settled turn artifacts or the run-local ACP session projection.
- **Configure Acpus:** Read `references/configuration.md` for named Agents, Presets, and Hooks.

### **Explain concepts:**
Search all available documentation under `references/` to explain concepts. Choose the most relevant reference(s) for each topic.

## Inspection discipline [Mandatory]

- Inspect Summary once, then narrow only to the target controlling the next decision.
- Use one `--await-decision` for that decision boundary; Re-inspect only after a returned boundary, hard attention, or new operator or external input; never poll.
- Elapsed time, silence, observation age, usage/context metrics, and available controls MUST NOT trigger intervention.
- For repeats, copy the candidate view's `@ref`; deepen only enough to decide.

## Safety

- Ask before destructive run, state, or repository actions.
