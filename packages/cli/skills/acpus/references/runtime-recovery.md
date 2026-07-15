# Runtime Recovery

## Triage checklist

1. Inspect first:

   ```sh
   acpus runs inspect <run-id>
   ```

2. Identify:
   - durable run status and derived execution state
   - failed, timed-out, canceled, or stale node/frame
   - dynamic `nodeKey` or `frameKey` when targeting recovery
   - agent attempt metadata and artifact refs, if available
   - whether the workflow source changed after admission

3. Choose the smallest safe action.

Use `--target <nodeId-or-nodeKey-or-frameKey-or-attemptId>` when recovery needs one execution. Use focused target JSON only after text inspection; `--raw --json` is the unbounded last resort.

Agent failures preserve Acpus origin/code separately from their upstream acpx cause. Compact text shows the actionable upstream detail and bounded acpx code;
use target JSON for the complete parsed JSON-RPC error data. Do not infer an authentication, model, or quota category from provider error wording.

## Phase-based fixes

| Symptom | Likely phase | Fix |
| --- | --- | --- |
| invalid JSON input or invalid CLI option | `usage` | Fix command syntax before preparing. |
| TypeScript diagnostics, Expr in JS truthiness, task capture, output admissibility | `check` | Edit workflow TypeScript, then run `workflow check` again. |
| module import failed, default export invalid, build callback throws | `compile` | Fix module exports/imports or build-time code. |
| unknown IR fields, malformed task target, invalid schema/expression IR | `validate` | Fix authoring shape or Acpus package mismatch. |
| task command failed, agent failed, signal timed out, assert false | `run` | Inspect artifacts; retry or fork depending on cause. |
| control target not found, run terminal, conflict | `control` | Re-inspect and target the dynamic nodeKey/frameKey or static alias that currently exists. |

## Retry vs fork

Use retry when the frozen admitted workflow is still the right plan and the failure is transient or localized:

```sh
acpus runs retry <run-id>
acpus runs retry <run-id> --target <nodeKey-or-frameKey-or-static-alias>
```

Targeted retry can reopen a failed dynamic leaf, composite/control frame, or a static alias that resolves unambiguously to one failed dynamic target.

A retry target belongs to the source run's frozen workflow. Exact dynamic keys shown by source inspection are appropriate here because retry continues that same admitted graph.

Use fork when the workflow source, input, or agent mapping must change. After fixing workflow source, default to root completion with no copied source target:

```sh
acpus runs fork <run-id> --workflow fixed.workflow.ts
```

This prepares the fixed replacement workflow, inherits unchanged input and Agent overrides, seeds compatible completed prerequisites, and resumes from the replacement graph's root completion frontier. Do not repeat unchanged `--input` or `--agents`; an explicit input override intentionally disables normal safe completed-output reuse even when its JSON text happens to be equal.

Replacement-fork targets belong to the replacement workflow. A source `nodeKey` or `frameKey` copied from `runs inspect` is not automatically meaningful there. Omit `--target` unless there is a deliberate recovery point in the replacement graph. A static replacement target is convenient when it resolves unambiguously; under a fanout or loop, an exact replacement dynamic identity may be required after materialization:

```sh
# Agent configuration changes; source input remains inherited.
acpus runs fork <run-id> --agents '{"reviewer":{"use":"codex"}}'

# Deliberate input change; safe output reuse is disabled.
acpus runs fork <run-id> --input '{"repoPath":"/repo","ready":true}'

# Explicit recovery point in the replacement workflow.
acpus runs fork <run-id> --workflow fixed.workflow.ts --target validate

# Intentional compatibility override, not a target-resolution workaround.
acpus runs fork <run-id> --workflow fixed.workflow.ts --target validate --unsafe-reuse
```

Fork creates a new run from frozen source data and may freeze replacement prepared workflow/input/agents. It does not read live workflow source except where the CLI explicitly prepares `--workflow`. Starting `workflow run fixed.workflow.ts` instead creates an unrelated run and cannot reuse compatible source completion.

Use `--unsafe-reuse` when the user clearly wants to reuse earlier completed nodes and accepts the side effects of doing so. Typical cases include a failed node inside one loop iteration where rerunning the whole loop is undesirable, or a fork that changes agent definitions mid-run while keeping already-completed prerequisites.

`--unsafe-reuse` relaxes compatibility checks; it does not make a source target valid in a replacement graph. If control reports `not materialized in the replacement workflow` or `resolved to 0 dynamic replacement instances`, reissue the fork without `--target`. If an explicit target is essential, inspect the replacement workflow's authored/static identity and choose its unambiguous recovery point rather than copying the source dynamic key.

A timed-out Signal wait is closed; inspection preserves its deadline and timeout failure. Use its dynamic target for retry, or fork when the workflow/input/Agent mapping must change; do not signal the closed wait again.

## Stale non-terminal execution

`runs inspect` may report non-terminal execution as stale based on daemon heartbeat or lease evidence. Do not mutate state just because a run is stale.
An attached `--follow` view remains read-only and continues waiting through a stale state. Run `acpus doctor`, and choose a control only when the user asks to recover or continue.

For standalone artifact registry lookup, read `advanced-cli-operations.md`; use target inspection when paths need surrounding recovery state. Do not guess at run-local paths.

Do not edit SQLite state or run-local frozen files by hand. Use CLI controls.
