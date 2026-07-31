# Runtime Recovery

## Triage checklist

1. Inspect the run, then the item controlling the next decision:

```sh
acpus runs inspect <run-id>
acpus runs inspect <run-id> --target <nodeId|@ref|@ref#attemptNo>
```

2. Identify status, the public recovery target, and whether admitted source or inputs must change. For Agent interruption, use the exact `@ref#attemptNo` when one attempt matters.

3. Add Timeline only when activity is needed, then choose the smallest safe action:

```sh
acpus runs inspect <run-id> --target <resolved-target> --timeline
```

For exact settled-turn prompt/response data and the run-local acpx session projection, see [Agent Records](agent-records.md). Summary and Timeline expose bounded semantic activity and visible observation gaps.

Agent failures preserve Acpus origin/code separately from their upstream acpx cause. Do not infer an authentication, model, or quota category from error wording.

## Phase-based fixes

| Symptom | Likely phase | Fix |
| --- | --- | --- |
| invalid JSON input or invalid CLI option | `usage` | Fix command syntax before preparing. |
| invalid, incomplete, or changed authored source | `source` | Fix or regenerate the source, then repeat the command. |
| TypeScript diagnostics, Expr in JS truthiness, task capture, output admissibility | `check` | Revise the workflow source, then repeat the command that produced this phase. |
| module import failed, default export invalid, build callback throws | `compile` | Fix module exports/imports or build-time code. |
| unknown IR fields, malformed task target, invalid schema/expression IR | `validate` | Fix authoring shape or Acpus package mismatch. |
| task command failed, agent failed, signal timed out, assert false | `run` | Inspect artifacts; retry or fork depending on cause. |
| control target not found, run terminal, conflict | `control` | Re-inspect and use the public authored id or exact `@ref` that currently exists. |

## Recovery decision

| Choose | Use when | Effect |
| --- | --- | --- |
| Wait | No recovery condition or new information exists. | Leaves correct active work uninterrupted. |
| Steer | The admitted task remains correct, but a started Agent needs an admitted in-scope information update. | Fences that attempt and queues the update in the same run and Agent session. |
| Retry | Failed or timed-out work can repeat under unchanged admitted state. | Continues the same run and preserves completed work. |
| Fork | The workflow, input, Agent mapping, or task definition must change. | Creates a new run and reuses compatible completed work when safe. |

Prefer the smallest action that preserves correct admitted state:

- Steer one exact started Agent only when new context or a compatible constraint belongs to the same task. **NEVER steer for elapsed time, silence, or convergence pressure**; fork if admitted state or task scope must change.
- Retry one failed target when the failure is local and transient; retry the run when several failures share the same unchanged admitted state. Retry a timed-out Signal rather than signaling its closed wait.
- Fork when recovery requires changing authored behavior, input, Agent mapping, or task definition. Reuse earlier results only when their outputs and side effects remain valid.

Read [Advanced CLI Operations](advanced-cli-operations.md#runtime-control-details) for command syntax, target resolution, fencing, retry reopening, fork inheritance, receipts, and other control mechanics.

## Stale non-terminal execution

- `runs inspect` may report non-terminal execution as stale based on daemon heartbeat or lease evidence. DO NOT mutate state just because a run is stale.

- An attached `--follow` or `--await-decision` view remains read-only through a stale state; stale alone is not a decision boundary. Run `acpus doctor`, and choose a control only when the user asks to recover or continue.

- Runtime automatically settles derivable work after cancellation or owner loss, even when another branch awaits an untimed Signal.  DO NOT intervene solely because a run is temporarily non-terminal; re-inspect after settlement, then retry or fork if needed.

- For standalone artifact registry lookup, read `advanced-cli-operations.md`; use target inspection when paths need surrounding recovery state. DO NOT guess at run-local paths.

## ACP worker silence and residual ownership

- `ACP silent for <duration>` is an observation, not proof of failure. Do not act on silence alone.
- To fail a long-silent Agent automatically, set `ACPUS_AGENT_ACP_INACTIVITY_FAIL_AFTER_MS` before starting the daemon. Then use the normal retry, steer, or fork decision.
- Pause, failure, completion, and cancel release the worker. `acpus doctor` warns only when cleanup leaves an unresolved worker.
