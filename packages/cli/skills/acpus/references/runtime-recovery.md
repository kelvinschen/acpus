# Runtime Recovery

## Triage checklist

1. Inspect first:

   ```sh
   acpus runs inspect <run-id>
   ```

2. Identify:
   - durable run status and derived execution state
   - failed, timed-out, canceled, paused, or awaiting node/frame
   - dynamic `nodeKey` or `frameKey` when targeting a control
   - rendered signal prompt and expected payload, if awaiting
   - agent attempt metadata and artifact refs, if available
   - whether the workflow source changed after admission

3. Choose the smallest safe action.

## Phase-based fixes

| Symptom | Likely phase | Fix |
| --- | --- | --- |
| invalid JSON input or invalid CLI option | `usage` | Fix command syntax before preparing. |
| TypeScript diagnostics, Expr in JS truthiness, task capture, output admissibility | `check` | Edit workflow TypeScript, then run `workflows check` again. |
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

Use fork when the workflow source, input, or agent mapping must change:

```sh
acpus runs fork <run-id> --workflow fixed.workflow.ts
acpus runs fork <run-id> --input '{"repoPath":"/repo","ready":true}'
acpus runs fork <run-id> --agents '{"reviewer":{"use":"codex"}}'
acpus runs fork <run-id> --target <target> --workflow fixed.workflow.ts --unsafe-reuse
```

Fork creates a new run from frozen source run data and may freeze replacement prepared workflow/input/agents. It should not read live workflow source except where the CLI explicitly prepares a replacement `--workflow`.

`--unsafe-reuse` is dangerous. Use it only after the user explicitly accepts that completed source outputs may be reused despite changed input or workflow signature changes.

## Signal

Inspect output usually gives a copyable command. General form:

```sh
acpus runs signal <run-id> --target <signal-nodeKey-or-static-alias> --payload '<json-or-string>'
```

Rules:

- Schema-backed signals expect JSON that validates against the signal output schema.
- Schema-less signals receive raw string payloads.
- Static signal aliases are accepted only when they resolve to exactly one open signal wait.
- A dynamic `nodeKey` target is safest when fanout/loop instances create multiple waits.
- Invalid schema-backed payloads are rejected without consuming the wait. The control may surface as `RUN_NOT_CONTROLLABLE` with a schema path message; re-inspect and send a corrected payload to the same awaiting dynamic target.

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

`runs inspect` may report non-terminal execution as stale based on daemon heartbeat or lease evidence. Do not mutate state just because a run is stale. Re-inspect, run `acpus doctor`, and choose a control only when the user asks to recover or continue.

## Artifact reading

Prefer artifact references and metadata from `runs inspect --json`. Do not guess at run-local paths unless the inspection output exposes them. Typical run-local data is under `.acpus/.local/runs/<run-id>/`; durable runtime state is under `.acpus/.local/state/runtime.db`.

Do not edit SQLite state or run-local frozen files by hand. Use CLI controls.

## Agent telemetry

`runs inspect --json` exposes Agent attempt metadata under `run.dynamic.executionMetadata[]` entries with `kind: "agent_attempt"`. These entries can include session name, turn count, stop reason, workflow Agent tool-call telemetry, and artifact references for prompt, response, parsed JSON, and telemetry. JSON inspection can be large for composite-heavy runs; use it with `jq` to query exact telemetry or dynamic node keys you need.
