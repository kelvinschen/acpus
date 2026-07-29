# Runtime Recovery

## Triage checklist

1. Inspect the run, then the item controlling the next decision:

   ```sh
   acpus runs inspect <run-id>
   acpus runs inspect <run-id> --target <nodeId|nodeKey|frameKey|attemptId>
   ```

2. Identify status, the dynamic recovery target, and whether admitted source
   or inputs must change. For Agent interruption, also identify the exact
   `attemptId`, provider outcome, scheduler disposition, and completeness.

3. Add Timeline only when activity is needed, then choose the smallest safe
   action:

   ```sh
   acpus runs inspect <run-id> --target <resolved-target> --timeline
   ```

If Summary and Timeline are insufficient, read only the exact attempt's
Private Turn Evidence for prompt/fence/terminal boundaries. Use an opt-in Trace
or raw ACP artifact for provider-frame detail; see
[Agent Tracing](agent-tracing.md).

Agent failures preserve Acpus origin/code separately from their upstream acpx
cause. Do not infer an authentication, model, or quota category from error
wording.

## Phase-based fixes

| Symptom | Likely phase | Fix |
| --- | --- | --- |
| invalid JSON input or invalid CLI option | `usage` | Fix command syntax before preparing. |
| invalid, incomplete, or changed authored source | `source` | Fix or regenerate the source, then repeat the command. |
| TypeScript diagnostics, Expr in JS truthiness, task capture, output admissibility | `check` | Revise the workflow source, then repeat the command that produced this phase. |
| module import failed, default export invalid, build callback throws | `compile` | Fix module exports/imports or build-time code. |
| unknown IR fields, malformed task target, invalid schema/expression IR | `validate` | Fix authoring shape or Acpus package mismatch. |
| task command failed, agent failed, signal timed out, assert false | `run` | Inspect artifacts; retry or fork depending on cause. |
| control target not found, run terminal, conflict | `control` | Re-inspect and target the dynamic nodeKey/frameKey or static alias that currently exists. |

## Steer vs Retry vs Fork

| Choose | Use when | Effect |
| --- | --- | --- |
| Steer | An Agent is running on the correct admitted task but its current turn is drifting. | Fences that attempt and queues a correction in the same run and Agent session. |
| Retry | The admitted workflow, input, and agent mapping are still correct. | Continues the same run and preserves completed work. |
| Fork | The workflow, input, Agent mapping, or task definition must change. | Creates a new run and reuses compatible completed work when safe. |

Prefer the smallest action that preserves correct admitted state:

- **Steer only as a last resort** when an exact-attempt Timeline shows material task drift or imminent harmful action while the admitted task remains correct. Context/usage metrics, observation age, isolated tool failures, degraded visibility, and an available steer operation are not sufficient evidence. Account for external side effects that the old turn may already have performed.
- Retry one failed target when the failure is local and transient; retry the run when several failures share the same unchanged admitted state. Retry a timed-out Signal rather than signaling its closed wait.
- Fork when recovery requires changing authored behavior, input, Agent mapping, or task definition. Reuse earlier results only when their outputs and side effects remain valid.

Read [Advanced CLI Operations](advanced-cli-operations.md#runtime-control-details) for command syntax, target resolution, fencing, retry reopening, fork inheritance, receipts, and other control mechanics.

## Stale non-terminal execution

`runs inspect` may report non-terminal execution as stale based on daemon heartbeat or lease evidence. Do not mutate state just because a run is stale.
An attached `--follow` view remains read-only and continues waiting through a stale state. Run `acpus doctor`, and choose a control only when the user asks to recover or continue.

A running `all` composite with a canceled required member fails on the next scheduler drive and cancels its remaining active members as `parent_failed`; it does not remain indefinitely non-terminal. Startup recovery also resumes admissible ready work, supersedes an expired owner's started attempts, settles due attempts and immediately derivable `all`, `race`, or `quorum` completions, and propagates pending leaf/frame/ancestor state even when another branch is waiting on an untimed Signal. Re-inspect the terminal result and choose retry or fork normally.

For standalone artifact registry lookup, read `advanced-cli-operations.md`; use target inspection when paths need surrounding recovery state. Do not guess at run-local paths.

Do not edit SQLite state or run-local frozen files by hand. Use CLI controls.
