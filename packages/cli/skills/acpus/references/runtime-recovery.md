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

Use `--target <nodeId-or-nodeKey-or-frameKey-or-attemptId>` when the compact
tree identifies the relevant execution. Use `--all` only when every repeated
fanout or loop context is needed. These views stay normalized and status-first;
`--raw --json` is the explicit unbounded diagnostic fallback.

Agent failures preserve Acpus origin/code separately from their upstream acpx
cause. Compact text shows the actionable upstream detail and bounded acpx code;
use target JSON for the complete parsed JSON-RPC error data. Do not infer an
authentication, model, or quota category from provider error wording.

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

Use fork when the workflow source, input, or agent mapping must change:

```sh
acpus runs fork <run-id> --workflow fixed.workflow.ts
acpus runs fork <run-id> --input '{"repoPath":"/repo","ready":true}'
acpus runs fork <run-id> --agents '{"reviewer":{"use":"codex"}}'
acpus runs fork <run-id> --target <target> --workflow fixed.workflow.ts --unsafe-reuse
```

Fork creates a new run from frozen source run data and may freeze replacement prepared workflow/input/agents. It should not read live workflow source except where the CLI explicitly prepares a replacement `--workflow`.

Use `--unsafe-reuse` when the user clearly wants to reuse earlier completed nodes and accepts the side effects of doing so. Typical cases include a failed node inside one loop iteration where rerunning the whole loop is undesirable, or a fork that changes agent definitions mid-run while keeping already-completed prerequisites.

## Signal

Compact inspection gives a copyable command; target inspection exposes the
complete persisted prompt and schema. General form:

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

`runs inspect` may report non-terminal execution as stale based on daemon
heartbeat or lease evidence. Do not mutate state just because a run is stale.
An attached `--follow` view remains read-only and continues waiting through a
stale state. Run `acpus doctor`, and choose a control only when the user asks to
recover or continue.

## Artifact reading

Prefer artifact references from `runs inspect <run-id> --target <target> --json`.
Do not guess at run-local paths unless inspection exposes them. Typical
run-local data is under `.acpus/.local/runs/<run-id>/`; durable runtime state is
under `.acpus/.local/state/runtime.db`.

Do not edit SQLite state or run-local frozen files by hand. Use CLI controls.

## Agent telemetry

`runs inspect --json` is a bounded status-first projection. Use
`runs inspect <run-id> --target <agent-node-or-attempt> --json` for complete
matching attempt history, progress, session/turn summaries, stop reason, and
artifact references. Artifact contents remain separate and lazy. Use
`--raw --json` only when the unbounded run/frozen-WorkflowIR/artifact bundle is
specifically required. Full authored Agent commands are available under
`.workflow.agents`; compact inspection never exposes them.

During an active run, prefer non-TTY `--follow` output when operating through
an agent or pipe. Its progress rows report the authored Agent key, last
activity, current turn, context/token counters, and up to three intent-only tool
commands. Semantic rows start with elapsed run time, such as `+14s`; text omits
event-sequence and progress-version identifiers because append order already
communicates operator-visible chronology. Matching terminal transition and
Agent progress from one observation are merged into one complete text row. Use
structured JSON/NDJSON for an unmerged projection; `--follow --json` preserves
the separate, ordered changes and exact durable-event, progress-version, and
cursor values. A 30-second checkpoint means observation is still attached; it
does not indicate a runtime state transition. Silence between changes or
checkpoints does not mean the run has stopped.
