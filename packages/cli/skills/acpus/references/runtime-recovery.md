# Runtime Recovery

## Triage checklist

1. Inspect first:

   ```sh
   acpus runs inspect <run-id>
   ```

   Keep the view attached while the run is changing:

   ```sh
   acpus runs inspect <run-id> --follow
   ```

2. Identify:
   - durable run status and derived execution state
   - failed, timed-out, canceled, paused, or awaiting node/frame
   - dynamic `nodeKey` or `frameKey` when targeting a control
   - rendered signal prompt and expected payload, if awaiting
   - agent attempt metadata and artifact refs, if available
   - whether the workflow source changed after admission

3. Choose the smallest safe action.

Use `--target <nodeId-or-nodeKey-or-frameKey-or-attemptId>` when the compact tree identifies the relevant execution. Use `--all` only when every repeated fanout or loop context is needed. These views stay normalized and status-first; 
`--raw --json` is the explicit unbounded diagnostic fallback.

Agent failures preserve Acpus origin/code separately from their upstream acpx cause. Compact text shows the actionable upstream detail and bounded acpx code;
use target JSON for the complete parsed JSON-RPC error data. Do not infer an authentication, model, or quota category from provider error wording.

## Phase-based fixes

| Symptom | Likely phase | Fix |
| --- | --- | --- |
| invalid JSON input or invalid CLI option | `usage` | Fix command syntax before preparing. |
| TypeScript diagnostics, Expr in JS truthiness, task capture, output admissibility | `check` | Edit workflow TypeScript, then run `workflow check` again. |
| module import failed, default export invalid, build callback throws | `compile` | Fix module exports/imports or build-time code. |
| unknown IR fields, malformed task target, invalid schema/expression IR | `validate` | Fix authoring shape or Acpus package mismatch. |
| task command failed, agent failed, signal timed out, assert false | `run` | Inspect artifacts; retry/fork/signal depending on cause. |
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

`--unsafe-reuse` relaxes compatibility checks; it does not make a source target valid in a replacement graph. If control reports `not materialized in the replacement workflow` or `resolved to 0 dynamic replacement instances`, first retry without `--target`. If an explicit target is essential, inspect the replacement workflow's authored/static identity and choose its unambiguous recovery point rather than copying the source dynamic key.

## Signal

Compact inspection gives a copyable command; target inspection exposes the complete persisted prompt and schema. General form:

```sh
acpus runs signal <run-id> --target <signal-nodeKey-or-static-alias> --payload '<json-or-string>'
```

Rules:

- Schema-backed signals expect JSON that validates against the signal output schema.
- Schema-less signals receive raw string payloads.
- Static signal aliases are accepted only when they resolve to exactly one open signal wait.
- A dynamic `nodeKey` target is safest when fanout/loop instances create multiple waits.
- Invalid schema-backed payloads are rejected without consuming the wait. The control may surface as `RUN_NOT_CONTROLLABLE` with a schema path message; re-inspect and send a corrected payload to the same awaiting dynamic target.
- Successful signal control means the payload was validated and consumed, not
  that downstream work is terminal. The receipt shows the requested target,
  resolved dynamic node key, and schema summary or raw-string validation; use
  its follow command until the run reaches terminal state.
- A timed-out Signal wait is closed. Inspection shows its persisted deadline
  and timeout failure, then offers targeted retry and run fork commands. Do not
  send another signal to the closed wait.

## Pause, resume, and cancel

```sh
acpus runs pause <run-id>
acpus runs resume <run-id>
acpus runs cancel <run-id>
acpus runs cancel <run-id> --target <nodeKey-or-frameKey-or-static-alias>
```

Pause records a durable pause gate and best-effort aborts active attempts so eligible work can resume later. Resume clears that gate and re-drives runnable work. Cancel terminalizes the run or the selected scheduler subtree.

Ask before canceling unless the user already clearly requested cancellation.

## Stale non-terminal execution

`runs inspect` may report non-terminal execution as stale based on daemon heartbeat or lease evidence. Do not mutate state just because a run is stale.
An attached `--follow` view remains read-only and continues waiting through a stale state. Run `acpus doctor`, and choose a control only when the user asks to recover or continue.

## Artifact reading

List registry metadata and absolute paths without loading bodies:

```sh
acpus runs artifacts <run-id>
acpus runs artifacts <run-id> --target <target>
```

Use target inspection when artifact paths need surrounding attempt state. Do not guess at run-local paths unless inspection or `runs artifacts` exposes them.
Typical run-local data is under `.acpus/.local/runs/<run-id>/`; durable runtime state is under `.acpus/.local/state/runtime.db`.

Do not edit SQLite state or run-local frozen files by hand. Use CLI controls.
