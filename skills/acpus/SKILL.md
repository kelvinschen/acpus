---
name: acpus
description: Use when the user wants runtime-driven workflow orchestration for ACP agents: validate, preview, save, generate, run, follow, monitor, resume, recover, or diagnose a workflow spec (score) or logical run (opus). The Main Agent writes structured workflow specs; the Acpus CLI conducts execution over the acpx agent runtime.
---

# Acpus

Acpus is a runtime-driven workflow orchestrator for ACP agents, built on the
acpx agent runtime. It accepts a structured *workflow spec* (总谱), validates it,
compiles a deterministic execution plan, and conducts heterogeneous fanout across
parallel lanes. Every run is catalogued as a numbered, replayable opus (作品).

The public surface is the `acpus` CLI binary. Do not generate or execute
`workflow.flow.ts`, `materialized.flow.ts`, or `acpx flow run` artifacts
directly.

## Core Workflow

1. The Main Agent writes a workflow spec under `.acpus/drafts/` or selects a
   saved spec under `.acpus/workflows/`.

2. **Compose** -- validate and preview before execution:

   ```bash
   acpus validate --spec <workflow.spec.json>
   acpus preview --spec <workflow.spec.json>
   ```

3. **Conduct** -- run after preview confirms correctness. Plain `run` creates the
   run, starts a background worker, and returns immediately. Use `--wait` only
   when the calling context requires the process to remain attached until the
   workflow reaches terminal status:

   ```bash
   acpus run --spec <workflow.spec.json>
   acpus run --workflow <saved-name>
   acpus run --workflow <saved-name> --wait
   ```

4. **Observe and recover** -- operate on logical runs by run id:

   ```bash
   acpus monitor <logical-run-id>
   acpus follow <logical-run-id>
   acpus recover <logical-run-id>
   ```

   Use `recover <logical-run-id>` only when the execution driver is stale or dead
   and the run has not reached terminal status. Use `resume <logical-run-id>`
   only for blocked, failed, or diagnosed-blocked recovery. `monitor` and
   `follow` are observation-only; they must not start workers or advance
   workflow state. Use `diagnose <logical-run-id> --wait` for blocked runs --
   it produces a read-only recovery diagnostic without rerunning edit work.

## Spec Authoring (编曲)

Specs declare `schemaVersion: "acpus.workflow/v1"`, an explicit `root`
stage id, and one or more stage kinds:

- `agentTask`
- `discover`
- `fanout`
- `reduce`
- `loop`
- `decisionGate`
- `gate`

Prompt text is freeform. Variables are explicit and interpolated as
`${variableName}`. Agent outputs should terminate with one plain JSON object;
the parser selects the last balanced JSON object and tolerates non-JSON trailing
text. Markdown code fences are tolerated but not required. Zod-backed contracts
validate outputs; deterministic `checks[].result -> checks[].status`
normalization is permitted, and one schema-aware repair turn may execute within
the same session.

Treat **preview** as the mandatory preflight step: verify roles, edit modes,
fanout configuration, partial-result policy, limits, and audit paths before
running. Running does not persist a reusable workflow -- use
`save <name> --spec <path>` as a separate, explicit action.

## Reference

- [specs/INDEX.md](specs/INDEX.md) -- schema reference
- [docs/cli.md](docs/cli.md) -- complete CLI documentation

Example workflows reside in `workflows/examples/`.
