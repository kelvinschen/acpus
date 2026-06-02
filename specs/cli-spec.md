# CLI Specification

## Status

- Current implementation: current
- Source modules: `src/cli.ts`, `src/commands/`, `skills/acpus/scripts/acpus`
- Maintenance trigger: update this spec when changing commands, flags, JSON output behavior, lifecycle semantics, saved workflow layout, generated drafts, or command error behavior

## Purpose

The CLI is the developer and Main Agent entry point for validating, previewing, running, observing, monitoring, diagnosing, resuming, saving, listing, showing, and generating workflows.

## Normative Requirements

- The skill-local wrapper MUST invoke the package CLI.
- Commands that expose useful machine-readable output SHOULD support `--json`.
- `validate` MUST validate the workflow spec without running it.
- `preview` MUST show the compiled workflow plan without running it.
- `preview` estimated agent calls MUST account for bounded loop body agent and fanout calls multiplied by loop `maxRounds`.
- `run` MUST validate automatically.
- `run` MUST prepare a logical run, write `execution-plan.json`, start a background worker, and return immediately unless `--wait` is set.
- `run --wait` MUST run the workflow in the foreground until terminal status and MUST enable fanout-stage-local draining.
- `run --json` without `--wait` MUST output a lightweight run envelope with worker metadata, not a full RunView.
- `run --json --wait` MUST output newline-delimited JSON progress events and a final terminal summary line.
- `preview` MUST be the explicit preview-only command; `run` MUST be the execution entrypoint.
- `_run-worker` is an internal worker command and SHOULD NOT be invoked by users.
- `follow` MUST observe and sync existing artifacts for an existing logical run and MUST NOT create a new workflow or start pending workflow work.
- `follow --json` MUST output the Run Monitor View.
- `monitor <run>` MUST observe the selected run and render the Ink monitor TUI.
- `monitor <run> --json` MUST observe the selected run and output the Run Monitor View.
- `monitor detail <run> <task-id> --json` MUST observe the selected run and output the Task Detail View for the selected Stage Task.
- `monitor detail` MUST be registered as a real CLI subcommand, not parsed by treating the first positional `monitor` argument as a sentinel.
- `monitor detail` without `--json` MAY fail because task detail is reached through the TUI.
- `diagnose` MUST prepare read-only recovery diagnostic prompt/artifacts and MUST NOT rerun edit work or change the saved workflow spec.
- `diagnose --json` MUST include the post-diagnose Run Diagnostics View.
- `recover <run>` MUST restart a stale or dead workflow worker for a non-terminal run and MUST NOT recover half-complete in-memory agent turns.
- `resume` MUST be limited to blocked, failed, or diagnosed-blocked recovery and MUST reject pending, running, completed, and cancelled runs.
- `resume` without `--wait` MUST reset recoverable persisted state, start a background worker, and return immediately.
- `resume --wait` MUST run the recovered workflow in the foreground until terminal status.
- `resume` MUST reject runs with an active non-stale worker.
- Resume `--max-fanout-items` and `--skip-fanout-item` policy flags MUST tighten fanout handling. Resume `--allow-partial-fanout` MAY allow partial results only for read-only fanout stages.
- `save` MUST write a saved workflow directory only when explicitly requested.
- Running a workflow MUST NOT save it as a reusable workflow.
- `generate` MUST write starter workflow drafts under `.acpus/drafts/`.
- `list` MUST support `workflows`, `runs`, and `drafts` kinds.
- `show` MUST support `workflow`, `run`, and `draft` kinds.

## Interfaces and Contracts

Primary commands:

```bash
skills/acpus/scripts/acpus validate --spec workflows/examples/simple-feature.workflow.spec.json
skills/acpus/scripts/acpus preview --spec workflows/examples/simple-feature.workflow.spec.json --json
skills/acpus/scripts/acpus run --spec workflows/examples/simple-feature.workflow.spec.json
skills/acpus/scripts/acpus run --spec workflows/examples/simple-feature.workflow.spec.json --wait
skills/acpus/scripts/acpus save simple-feature --spec workflows/examples/simple-feature.workflow.spec.json
skills/acpus/scripts/acpus save simple-feature --spec workflows/examples/simple-feature.workflow.spec.json --overwrite
skills/acpus/scripts/acpus run --workflow simple-feature
skills/acpus/scripts/acpus list workflows
skills/acpus/scripts/acpus list runs
skills/acpus/scripts/acpus list drafts
skills/acpus/scripts/acpus show workflow simple-feature
skills/acpus/scripts/acpus show run <logical-run-id>
skills/acpus/scripts/acpus show draft <draft-name>
skills/acpus/scripts/acpus follow <logical-run-id>
skills/acpus/scripts/acpus follow <logical-run-id> --json
skills/acpus/scripts/acpus monitor <logical-run-id>
skills/acpus/scripts/acpus monitor <logical-run-id> --json
skills/acpus/scripts/acpus monitor detail <logical-run-id> <task-id> --json
skills/acpus/scripts/acpus diagnose <logical-run-id> --wait
skills/acpus/scripts/acpus diagnose <logical-run-id> --wait --json
skills/acpus/scripts/acpus recover <logical-run-id>
skills/acpus/scripts/acpus resume <logical-run-id> --wait
skills/acpus/scripts/acpus resume <logical-run-id> --max-fanout-items review_files=4 --allow-partial-fanout review_files
skills/acpus/scripts/acpus generate --name draft-workflow
```

Resume policy flags:

- `--max-fanout-items <stage=count>` lowers the effective fanout item cap.
- `--skip-fanout-item <stage=index>` skips a zero-based item index.
- `--allow-partial-fanout <stage>` allows partial read-only fanout results.
- Fanout resume skip policy MUST remain item-level; group-level and lane-level skip selectors MUST NOT be accepted.

JSON output envelopes:

- `run --json` without `--wait` MUST include `ok`, `logicalRunId`, `runDir`, `status`, `worker`, and `note`.
- `run --json --wait` MUST emit NDJSON progress events and finish with a `terminal_summary` object containing `ok`, `logicalRunId`, `runDir`, `status`, optional `blockedReason`, and optional `gateVerdict`.
- `recover --json` MUST include `ok`, `runId`, `runDir`, `worker`, and `message`.
- `resume --json` MUST include `ok`, `runId`, `status`, `worker`, and `message`.

## Data Model

CLI commands operate on workflow specs, saved workflow directories, logical run IDs or run directories, execution plans, run indexes, monitor projections, task detail projections, diagnostics projections, generated drafts, and JSON command output envelopes.

Saved workflow directories contain `workflow.spec.json`, `execution-plan.json`, README, schema/docs references, wrapper, and built helper files from the current package build.

## Runtime Behavior

Lifecycle commands route through the same schema, compiler, run-index, runtime, and projection modules used by non-CLI entry points. Commands that observe existing runs sync persisted artifacts before rendering output. Commands that mutate workflow execution are limited to explicit run, recover, and resume paths. Non-wait run starts a background worker. Wait-style run and resume execute in the foreground and pass the scheduler option that enables fanout draining.

## Extension Points

New commands and flags MAY be added through `src/commands/` and `src/cli.ts`. Public command behavior, flags, and JSON surfaces MUST be reflected in this SPEC and developer docs.

## Non-Goals

- The CLI does not provide a long-running workflow control server.
- `follow`, `monitor`, and `diagnose` are not hidden run/resume commands.
- `monitor` does not provide workflow mutation controls.
- `monitor detail` does not provide a non-JSON CLI detail renderer.
- `recover` does not restore arbitrary in-memory agent runtime state.
- Generated drafts are templates only and are not validated or run automatically.

## Implementation Map

- CLI registration -> `src/cli.ts`
- Common command helpers -> `src/commands/common.ts`
- Lifecycle commands -> `src/commands/validate.ts`, `src/commands/preview.ts`, `src/commands/run.ts`, `src/commands/run-worker.ts`, `src/commands/recover.ts`, `src/commands/follow.ts`, `src/commands/monitor.ts`, `src/commands/resume.ts`, `src/commands/diagnose.ts`
- Workflow library commands -> `src/commands/save.ts`, `src/commands/list.ts`, `src/commands/show.ts`, `src/commands/generate.ts`
- Skill wrapper -> `skills/acpus/scripts/acpus`
