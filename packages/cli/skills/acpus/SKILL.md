---
name: acpus
description: Use when Acpus is the intended orchestration layer, or when an existing Acpus workflow or durable run is in scope.
metadata:
  acpus-version: 0.9.0
---

# Acpus

Acpus compiles typed TypeScript workflow modules into durable runs. Assume the CLI is `acpus`; if unavailable, ask before suggesting installation.

## Operate

Use Acpus to achieve user's goal, own the Acpus loop: *author → run → inspect/recover → verify the goal*. For one named operation, route directly.

For Agent-heavy authoring, calibrate logical work before topology; broad or uncertain work without an explicit user budget defaults to standard scale.

## Route the request

### **READ first**

- **Authoring** Read `references/authoring.md` completely;
- **Run, observe, or control:** Read `references/cli-operations.md` for status, overrides, and controls;
- **Recover a run:** Read `references/runtime-recovery.md` for failed/timed-out/stale runs, drifting-agent steering, steer/retry/fork decisions, or deep diagnostics.
- **Library/catalog reuse:** Only user-written `/wf:<hint>` or `/workflow:<hint>` requests enable library/catalog lookup or reuse. Unmarked, read only user-named workflows to explain/modify/diagnose. For reuse read README first, implementation only to modify/diagnose; else follow **Author or adapt**.
- **Choose an agent:** Read `references/acpx-agents.md` when Agent availability matters.

### **DO NOT read by default**

- **Advanced authoring:** Read `references/advanced-authoring.md` only when the requirement needs Agent session reuse, reusable or prebuilt Tasks, third-party package imports, artifacts, Task process controls, cooperative Task cancellation, or Agent tracing configuration.
- **Signal authoring:** Read `references/signal-authoring.md` only for parallel Signal waits, payload validation, timeout behavior, or duration syntax.
- **Advanced CLI operations:** Read `references/advanced-cli-operations.md` only when the requirement needs inspection pagination/follow mechanics, detailed runtime-control mechanics, catalogs, import, static visualization, WebUI, bundled-skill management, standalone artifact lookup, run deletion, version lookup, or structured CLI automation.
- **Review Agent evidence:** Read `references/agent-tracing.md` only for exact turn boundaries, opt-in Trace, or raw ACP.
- **Configure hooks:** Read `references/hooks-json.md`.

### **Explain concepts:**
Search all available documentation under `references/` to explain concepts. Choose the most relevant reference(s) for each topic.

## Inspection budget [Mandatory]

- Inspect adaptively: start with sparse, minute-scale inspections, tighten cadence only near a decision boundary, and never poll.
- Inspect the target controlling the next decision. Start with Summary and deepen only enough to decide.
- For repeats, copy the candidate view's `@ref`. Use one live follow for a decision-controlling transition, not scheduled inspection.

## Safety

- Ask before destructive run, state, or repository actions.
