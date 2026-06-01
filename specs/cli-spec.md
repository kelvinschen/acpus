# CLI Specification

## Status

- Current implementation: current
- Source modules: `src/cli.ts`, `src/commands/`, `skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator`
- Maintenance trigger: update this spec when changing commands, flags, JSON output behavior, lifecycle semantics, saved workflow layout, generated drafts, or command error behavior

## Purpose

The CLI is the developer and Main Agent entry point for validating, previewing, running, observing, diagnosing, resuming, reporting, saving, listing, showing, and generating workflows.

## Normative Requirements

- The skill-local wrapper MUST invoke the package CLI.
- Commands that expose useful machine-readable output SHOULD support `--json`.
- `validate` MUST validate the workflow spec without running it.
- `preview` MUST show the compiled workflow plan without running it.
- `run` MUST validate automatically.
- `run` without `--yes` MUST print a preview and exit with approval required.
- `run --yes` MUST prepare a logical run, write `execution-plan.json`, advance one scheduler tick, and return unless `--wait` is set.
- `run --yes --wait` MUST advance until terminal status and MUST enable fanout-stage-local draining.
- `run --prepare-only` MUST prepare the logical run and write runtime artifacts without starting runtime turns.
- `follow` MUST observe and sync existing artifacts for an existing logical run and MUST NOT create a new workflow or start pending workflow work.
- `diagnose` MUST prepare read-only recovery diagnostic prompt/artifacts and MUST NOT rerun edit work or change the saved workflow spec.
- `resume` MUST advance an existing run from persisted `run.json` and `execution-plan.json`.
- `resume --wait` MUST advance until terminal status or current scheduler quiescence and MUST enable fanout-stage-local draining.
- Resume fanout policy flags MUST only tighten fanout handling.
- `save` MUST write a saved workflow directory only when explicitly requested.
- Approval to run MUST NOT imply approval to save.
- `report --html --output <file>` MUST write a self-contained HTML snapshot.
- `report` commands MUST sync existing artifacts with observation-only semantics and MUST NOT start pending workflow work.
- `report serve` MUST start an observation-only local server.
- `report serve --open` MAY open the local report URL in a browser.
- `report serve --interval-ms <ms>` MUST configure live report sync interval.
- `generate` MUST write starter workflow drafts under `.acpx-workflow-orchestrator/drafts/`.
- `list` MUST support `workflows`, `runs`, and `drafts` kinds.
- `show` MUST support `workflow`, `run`, and `draft` kinds.

## Interfaces and Contracts

Primary commands:

```bash
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator validate --spec workflows/examples/simple-feature.workflow.spec.json
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator preview --spec workflows/examples/simple-feature.workflow.spec.json --json
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator run --spec workflows/examples/simple-feature.workflow.spec.json --yes
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator run --spec workflows/examples/simple-feature.workflow.spec.json --yes --wait
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator run --spec workflows/examples/simple-feature.workflow.spec.json --yes --prepare-only
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator save simple-feature --spec workflows/examples/simple-feature.workflow.spec.json
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator save simple-feature --spec workflows/examples/simple-feature.workflow.spec.json --overwrite
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator run --workflow simple-feature --yes
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator list workflows
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator list runs
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator list drafts
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator show workflow simple-feature
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator show run <logical-run-id>
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator show draft <draft-name>
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator follow <logical-run-id>
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator diagnose <logical-run-id> --wait
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator resume <logical-run-id> --wait
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator resume <logical-run-id> --max-fanout-items review_files=4 --allow-partial-fanout review_files
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator report --run <logical-run-id>
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator report --run <logical-run-id> --html --output report.html
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator report --run <logical-run-id> --json --detailed
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator report serve --run <logical-run-id> --port 0 --interval-ms 1000 --open
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator generate --name draft-workflow
```

Resume policy flags:

- `--max-fanout-items <stage=count>` lowers the effective fanout item cap.
- `--skip-fanout-item <stage=index>` skips a zero-based item index.
- `--allow-partial-fanout <stage>` allows partial read-only fanout results.

## Data Model

CLI commands operate on workflow specs, saved workflow directories, logical run IDs or run directories, execution plans, run indexes, report projections, generated drafts, and JSON command output envelopes.

Saved workflow directories contain `workflow.spec.json`, `execution-plan.json`, README, schema/docs references, wrapper, and built helper files from the current package build.

## Runtime Behavior

Lifecycle commands route through the same schema, compiler, run-index, runtime, and projection modules used by non-CLI entry points. Commands that observe existing runs sync persisted artifacts before rendering output. Commands that mutate workflow execution are limited to explicit run/resume paths. Wait-style run and resume commands pass the scheduler option that enables fanout draining; bounded run/resume commands do not.

## Extension Points

New commands and flags MAY be added through `src/commands/` and `src/cli.ts`. Public command behavior, flags, and JSON surfaces MUST be reflected in this SPEC and developer docs.

## Non-Goals

- The CLI does not provide a long-running workflow control server.
- `follow`, `diagnose`, and report serving are not hidden run/resume commands.
- Generated drafts are templates only and are not validated or run automatically.

## Implementation Map

- CLI registration -> `src/cli.ts`
- Common command helpers -> `src/commands/common.ts`
- Lifecycle commands -> `src/commands/validate.ts`, `src/commands/preview.ts`, `src/commands/run.ts`, `src/commands/follow.ts`, `src/commands/resume.ts`, `src/commands/diagnose.ts`
- Workflow library commands -> `src/commands/save.ts`, `src/commands/list.ts`, `src/commands/show.ts`, `src/commands/generate.ts`
- Report command -> `src/commands/report.ts`
- Skill wrapper -> `skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator`
