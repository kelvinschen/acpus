---
name: acpx-workflow-orchestrator
description: Use when the user explicitly wants dynamic acpx workflow orchestration, reusable agent workflows, or multi-agent coding workflows backed by the acpx runtime. The Main Agent generates structured workflow specs; the skill CLI validates, previews, saves, runs, follows, resumes, diagnoses, and reports logical workflow runs.
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

3. Run only after preview/approval. Use `--yes` when the user explicitly allows
   running:

```bash
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator run --spec <workflow.spec.json> --yes
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator run --workflow <saved-name> --yes
```

4. Follow/report logical runs by run id:

```bash
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator follow <logical-run-id>
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator report --run <logical-run-id>
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator report --run <logical-run-id> --html --output report.html
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator report serve --run <logical-run-id> --port 0
```

Use `--wait` when the user wants the command to advance until terminal status.
Use `diagnose <logical-run-id> --wait` for blocked runs; it prepares a
read-only recovery diagnostic without rerunning edit work.

HTML reports are observation-only. Snapshot HTML is self-contained, while
`report serve` streams run state over SSE and syncs with `startPending: false`.

## Spec Authoring

Specs use `schemaVersion: "acpx-workflow-orchestrator.workflow/v1"`, an explicit `root`
stage id, and authoring stage kinds:

- `agentTask`
- `discover`
- `fanout`
- `reduce`
- `fixLoop`
- `decisionGate`
- `gate`

Prompt text is freeform, but variables are explicit and interpolated as
`${variableName}`. Agent outputs should end with one plain JSON object; the
parser selects the last balanced JSON object and tolerates non-JSON tail text.
Markdown code fences are tolerated by the parser but not required. Zod-backed
contracts validate outputs, deterministic
`checks[].result -> checks[].status` normalization is allowed, and one
schema-aware repair turn may run in the same session.

Preview must be treated as the approval artifact: check roles, edit modes,
fanout, partial-result policy, limits, and audit paths before using `--yes`.
Running does not save a reusable workflow; use `save <name> --spec <path>` as a
separate explicit action.

Read:

- [docs/runtime-orchestrator-refactor-implementation.md](docs/runtime-orchestrator-refactor-implementation.md)
- [docs/workflow-spec.md](docs/workflow-spec.md)
- [docs/cli.md](docs/cli.md)
- [docs/html-report-design.md](docs/html-report-design.md)

Examples live in `workflows/examples/`.
