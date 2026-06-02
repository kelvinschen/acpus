---
name: acpx-workflow-orchestrator
description: Use when the user explicitly wants dynamic acpx workflow orchestration, reusable agent workflows, or multi-agent coding workflows backed by the acpx runtime. The Main Agent generates structured workflow specs; the skill CLI validates, previews, saves, runs, monitors, follows, recovers, resumes, and diagnoses logical workflow runs.
---

# ACPX Workflow Orchestrator

This skill implements runtime-driven dynamic workflow orchestration over
`acpx/runtime`.

Do not generate or execute `workflow.flow.ts`, `materialized.flow.ts`, or
`acpx flow run` artifacts. The public surface is
`skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator`.

## Core Workflow

1. Main Agent writes a workflow spec under `.acpx-workflow-orchestrator/drafts/` or uses
   a saved spec under `.acpx-workflow-orchestrator/workflows/`.
2. Validate and preview:

```bash
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator validate --spec <workflow.spec.json>
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator preview --spec <workflow.spec.json>
```

3. Run after preview when the user wants execution. Plain `run` creates the run,
   starts a background worker, and returns immediately. Use `--wait` only when
   the command itself should stay attached until the workflow reaches terminal
   status:

```bash
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator run --spec <workflow.spec.json>
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator run --workflow <saved-name>
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator run --workflow <saved-name> --wait
```

4. Observe and operate on logical runs by run id:

```bash
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator monitor <logical-run-id>
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator follow <logical-run-id>
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator recover <logical-run-id>
```

Use `recover <logical-run-id>` only when the execution driver is stale or dead
and the run is not terminal. Use `resume <logical-run-id>` only for
blocked/failed/diagnosed-blocked recovery. `monitor` and `follow` are
observation-only and must not start workers or advance workflow state. Use
`diagnose <logical-run-id> --wait` for blocked runs; it prepares a read-only
recovery diagnostic without rerunning edit work.

## Spec Authoring

Specs use `schemaVersion: "acpx-workflow-orchestrator.workflow/v1"`, an explicit `root`
stage id, and authoring stage kinds:

- `agentTask`
- `discover`
- `fanout`
- `reduce`
- `loop`
- `decisionGate`
- `gate`

Prompt text is freeform, but variables are explicit and interpolated as
`${variableName}`. Agent outputs should end with one plain JSON object; the
parser selects the last balanced JSON object and tolerates non-JSON tail text.
Markdown code fences are tolerated by the parser but not required. Zod-backed
contracts validate outputs, deterministic
`checks[].result -> checks[].status` normalization is allowed, and one
schema-aware repair turn may run in the same session.

Preview must be treated as the preflight artifact: check roles, edit modes,
fanout, partial-result policy, limits, and audit paths before running.
Running does not save a reusable workflow; use `save <name> --spec <path>` as a
separate explicit action.

Read:

- [specs/INDEX.md](specs/INDEX.md)
- [docs/cli.md](docs/cli.md)

Examples live in `workflows/examples/`.
