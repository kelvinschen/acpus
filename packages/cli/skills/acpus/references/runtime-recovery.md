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

For exact settled-turn prompt/response data and the run-local ACP session projection, see [Agent Records](agent-records.md). Summary and Timeline expose bounded semantic activity and visible observation gaps.

Only when diagnosis requires comparing the frozen definition, actual invocation, and accepted result, read [Forensics](advanced-cli-operations.md#forensics). Do not use it for ordinary monitoring or proof of activity.

Agent failures preserve Acpus origin/code separately from their upstream Agent or provider cause. Do not infer an authentication, model, or quota category from error wording.

- `RUNTIME_UPDATE_BLOCKED`: Leave the old daemon and runs untouched; wait for current work to finish, then retry.
- `RUNTIME_AUTHORITY_LOST`: The run remains durable; continue with `acpus runs inspect <run-id> --follow`.

For `ACPUS_WORKSPACE_UNAVAILABLE`, restore the exact original workspace path, then repeat the same operation. Do not rebind the task or submit a replacement.

## Phase-based fixes

| Symptom | Likely phase | Fix |
| --- | --- | --- |
| invalid JSON input or invalid CLI option | `usage` | Fix command syntax before preparing. |
| invalid, incomplete, or changed authored source | `source` | Fix or regenerate the source, then repeat the command. |
| TypeScript diagnostics, Expr in JS truthiness, task capture, output admissibility | `check` | Revise the workflow source, then repeat the command that produced this phase. |
| module import failed, default export invalid, build callback throws | `compile` | Fix module exports/imports or build-time code. |
| unknown IR fields, malformed task target, invalid schema/expression IR | `validate` | Fix authoring shape or Acpus package mismatch. |
| task command failed, agent failed, signal timed out, assert false | `run` | Inspect artifacts; choose Retry or Fork according to the durable state. |
| control target not found, run terminal, conflict | `control` | Re-inspect and use the public authored id or exact `@ref` that currently exists. |

## Recovery decision

| Choose | Use when | Effect |
| --- | --- | --- |
| Wait | No recovery condition or new information exists. | Leaves correct active work uninterrupted. |
| Steer | The admitted task remains correct, but an exactly active Agent Turn needs an in-scope information update. | Interrupts and drains that Turn, then runs a replacement Attempt in the same Agent Session. |
| Retry | A failed or timed-out Task, Agent, or frame can repeat under unchanged admitted state. | Reopens the complete required range; affected local Agent Sessions are replaced by a new generation. |
| Fork | The workflow, input, Agent mapping, or task definition must change. | Creates a new run and reuses compatible completed work when safe. |

Prefer the smallest action that preserves correct admitted state:

- **Steer**
  - Use for one exact active Agent when new context or a compatible constraint belongs to the same task.
  - Delivery is Interrupt & Continue; completed side effects are not rolled back.
  - It may be rejected after proof of the exact active Turn disappears.
  - **NEVER Steer for elapsed time, silence, or convergence pressure.** Fork when task scope or admitted state must change.
- **Retry**
  - Use for one failed or timed-out Task, Agent, or frame when workflow and inputs remain correct.
  - Retry a timed-out Signal target; do not signal its closed wait.
- **Fork**
  - Use when authored behavior, input, Agent mapping, or Task definition must change.
  - Use instead of Retry when the range intersects an explicit shared Agent Session. Run the exact Fork command supplied by Acpus.
  - Reuse earlier results only when their outputs and side effects remain valid.

Read [Advanced CLI Operations](advanced-cli-operations.md#runtime-control-details) for command syntax, target resolution, fencing, retry reopening, fork inheritance, receipts, and other control mechanics.

## Stale non-terminal execution

- `runs inspect` may report non-terminal execution as stale based on daemon heartbeat or lease evidence. DO NOT mutate state just because a run is stale.

- `--follow` and `--await-decision` remain read-only through stale state; stale alone is not a decision boundary.
- Run `acpus doctor`; choose a control only when the user asks to recover or continue.

- Acpus settles derivable work after cancellation or owner loss, even while another branch awaits an untimed Signal.
- **DO NOT intervene solely because a run is temporarily non-terminal.** Re-inspect after settlement, then Retry or Fork if needed.

- For artifact lookup, read [CLI Operations](cli-operations.md#artifacts); use target inspection when paths need surrounding recovery state. DO NOT guess at run-local paths.

## ACP worker silence and residual ownership

- `ACP silent for <duration>` is an observation, not proof of failure. Do not act on silence alone.
- To fail a long-silent Agent automatically, set `ACPUS_AGENT_ACP_INACTIVITY_FAIL_AFTER_MS` before starting the daemon. Then inspect its checkpoint and choose Retry, Steer, or Fork.
- Pause, failure, completion, and cancel release the worker. `acpus doctor` warns only when cleanup leaves an unresolved worker.
