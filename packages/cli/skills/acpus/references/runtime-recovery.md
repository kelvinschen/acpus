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
| TypeScript diagnostics, Expr in JS truthiness, task capture, output admissibility | `check` | Edit workflow TypeScript, then repeat the command that produced this phase. |
| module import failed, default export invalid, build callback throws | `compile` | Fix module exports/imports or build-time code. |
| unknown IR fields, malformed task target, invalid schema/expression IR | `validate` | Fix authoring shape or Acpus package mismatch. |
| task command failed, agent failed, signal timed out, assert false | `run` | Inspect artifacts; retry or fork depending on cause. |
| control target not found, run terminal, conflict | `control` | Re-inspect and target the dynamic nodeKey/frameKey or static alias that currently exists. |

## Retry vs fork

| Choose | Use when | Effect |
| --- | --- | --- |
| Retry | The admitted workflow, input, and agent mapping are still correct. | Continues the same run and preserves completed work. |
| Fork | The workflow, input, or agent mapping / task defination must change. | Creates a new run and reuses compatible completed work when safe. |

### Retry

```sh
acpus runs retry <run-id>
acpus runs retry <run-id> --target <nodeKey-or-frameKey-or-static-alias>
```

- Use targeted retry for one unambiguous failed node or frame; use run-level retry when several failures must be retried together.
- Resume a paused run first. Retry is rejected if completed/canceled ancestors, independent failures, or composite strategy rules make progress impossible; it never silently broadens the target.
- Targets belong to the source run's frozen workflow, so dynamic keys from `runs inspect` are valid.
- Retry a pre-execution configuration-resolution failure through its containing frame or the whole run.

A timed-out Signal wait is closed. Retry its dynamic target; do not signal the closed wait again.

### Fork

```sh
acpus runs fork <run-id> --workflow fixed.workflow.ts
acpus runs fork <run-id> --agents '{"reviewer":{"use":"codex"}}'
acpus runs fork <run-id> --input '{"repoPath":"/repo","ready":true}'
```

- Unchanged input and Agent overrides are inherited; do not repeat them unnecessarily. An explicit `--input` disables normal safe completed-output reuse.
- Omit `--target` by default. Fork targets belong to the replacement workflow, so source-run dynamic keys may not resolve there.
- Use `--unsafe-reuse` only when reusing earlier results is intentional and its side effects are acceptable. It relaxes compatibility checks but does not fix an invalid replacement target.

## Stale non-terminal execution

`runs inspect` may report non-terminal execution as stale based on daemon heartbeat or lease evidence. Do not mutate state just because a run is stale.
An attached `--follow` view remains read-only and continues waiting through a stale state. Run `acpus doctor`, and choose a control only when the user asks to recover or continue.

A running `all` composite with a canceled required member fails on the next scheduler drive and cancels its remaining active members as `parent_failed`; it does not remain indefinitely non-terminal. Startup recovery also resumes admissible ready work, supersedes an expired owner's started attempts, settles due attempts and immediately derivable `all`, `race`, or `quorum` completions, and propagates pending leaf/frame/ancestor state even when another branch is waiting on an untimed Signal. Re-inspect the terminal result and choose retry or fork normally.

For standalone artifact registry lookup, read `advanced-cli-operations.md`; use target inspection when paths need surrounding recovery state. Do not guess at run-local paths.

Do not edit SQLite state or run-local frozen files by hand. Use CLI controls.
