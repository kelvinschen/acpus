# CLI Specification

## Status

- Current implementation: current
- Source modules: `src/cli.ts`, `src/commands/`, `skills/acpus/scripts/acpus`
- Maintenance trigger: update this spec when changing commands, flags, YAML/JSON output behavior, lifecycle semantics, saved workflow layout, or command error behavior

## Purpose

The CLI is the developer and Main Agent entry point for planning, running, observing, monitoring, resuming, saving, listing, and showing workflows.

## Normative Requirements

- The CLI MUST read workflow authoring specs from YAML paths or saved workflow names.
- File auto-detection MUST treat `.yaml`, `.yml`, `.workflow.spec.yaml`, and `.workflow.spec.yml` values as file paths.
- Non-YAML workflow spec paths MUST be rejected by the schema loader.
- `plan` MUST validate the workflow spec and preview the compiled execution plan.
- `plan --quiet` MUST suppress the plan preview and show only validation issues.
- `run` MUST validate, prepare a logical run, write runtime artifacts, start a background worker, and return unless `--wait` is set.
- `run --wait` MUST run in the foreground until terminal status and enable fanout draining.
- `run --input <json-or-yaml-or-path>` MUST accept an inline JSON object string, a JSON file path, or a YAML/YML file path. Inline detection MUST treat values whose first non-whitespace character is `{` as JSON; all other values MUST be read as file paths, so inline YAML is not supported. Parsed input MUST be a top-level object.
- `run --json --wait` MUST emit NDJSON progress events and a final terminal summary with `finalOutput` when a gate output artifact exists.
- `follow` and `monitor` observation paths MUST read `workflow.spec.yaml`.
- `follow --json <run>` MUST stream existing/new events as NDJSON and emit a final Run Monitor View containing `finalOutput` when the run is terminal and a gate output artifact exists.
- `follow` and `monitor` without a run argument MUST provide an observation-only run list for the current project. In interactive TTY mode they MUST open a selectable run list; in non-TTY mode they MUST print the text run list and exit successfully.
- `follow --json` and `monitor --json` without a run argument MUST output a run summary list JSON object and MUST NOT attach to a run.
- `show workflow` MUST display saved YAML by default.
- `show workflow --json` MUST output the parsed YAML object as JSON.
- `save` MUST write `workflow.spec.yaml` and `execution-plan.json` into saved workflow directories.
- `save --template` MUST generate a YAML workflow spec using the current model.
- `resume` without `--force` MUST be limited to blocked or failed recovery and MUST reject active non-stale workers.
- `resume --force` MAY recover blocked, failed, running, or pending runs when no active non-stale worker owns the run; it MUST reject terminal runs and MUST NOT take ownership from an active non-stale worker.
- Resume fanout policy flags MUST remain item-level.
- `list` MUST support `runs` and `workflows`.
- `show` MUST support `run` and `workflow`.
- `_run-worker` is internal.

## Interfaces and Contracts

Primary commands:

```bash
skills/acpus/scripts/acpus plan workflows/examples/simple-feature.workflow.spec.yaml
skills/acpus/scripts/acpus plan workflows/examples/simple-feature.workflow.spec.yaml --json
skills/acpus/scripts/acpus plan simple-feature
skills/acpus/scripts/acpus run workflows/examples/simple-feature.workflow.spec.yaml --wait
skills/acpus/scripts/acpus run workflows/examples/simple-feature.workflow.spec.yaml --input '{"task":"review"}'
skills/acpus/scripts/acpus run workflows/examples/simple-feature.workflow.spec.yaml --input input.json
skills/acpus/scripts/acpus run workflows/examples/simple-feature.workflow.spec.yaml --input input.yaml
skills/acpus/scripts/acpus run simple-feature
skills/acpus/scripts/acpus save simple-feature workflows/examples/simple-feature.workflow.spec.yaml
skills/acpus/scripts/acpus save simple-feature --template basic
skills/acpus/scripts/acpus show workflow simple-feature
skills/acpus/scripts/acpus show workflow simple-feature --json
skills/acpus/scripts/acpus monitor
skills/acpus/scripts/acpus monitor <logical-run-id> --json
skills/acpus/scripts/acpus monitor detail <logical-run-id> <task-id> --json
skills/acpus/scripts/acpus follow
skills/acpus/scripts/acpus resume <logical-run-id> --wait
```

JSON output envelopes:

- `plan --json` MUST include validation and plan data.
- `run --json` without `--wait` MUST include run ID, run directory, status, and worker metadata.
- `run --json --wait` MUST finish with a `terminal_summary`; terminal summaries MUST include `finalOutput` when a gate output artifact exists.
- `resume --json` MUST include run ID, status, worker metadata, and message.
- `monitor --json <run>` MUST return the current Run Monitor View JSON object, including `finalOutput` for terminal runs when a gate output artifact exists.
- Empty `monitor --json` and empty `follow --json` MUST return `{kind:"runs", dir, entries}` where entries are run summaries sorted newest first.
- Empty observation run summary entries MUST include `runId`, `runDir`, `sortTime`, and MAY include `workflowName`, `status`, `progress`, `createdAt`, `updatedAt`, `durationMs`, `elapsedMs`, `worker`, `invalid`, and `error`.
- Empty observation run summary sorting MUST use the newest valid run timestamp first and MUST fall back to the run ID timestamp or directory mtime for unreadable or malformed runs.
- `monitor detail --json` MUST return the current Task Detail View JSON object.
- Monitor JSON task objects MUST expose retry summary fields for agent work when attempts exist.
- Monitor detail JSON attempt objects MUST expose retry metadata for agent attempts.

## Data Model

CLI commands operate on YAML workflow specs, saved workflow directories, logical run IDs or run directories, execution plans, run indexes, monitor projections, task detail projections, and JSON command envelopes.

Saved workflow directories contain `workflow.spec.yaml`, `execution-plan.json`, README, schema/docs references, wrapper, and built helper files from the current package build.

## Runtime Behavior

Lifecycle commands route through the schema loader, compiler, run-index, runtime, and projection modules. Commands that observe existing runs sync persisted artifacts without starting pending work. Commands that mutate execution are limited to explicit run and resume paths.

## Extension Points

New commands and flags MAY be added through `src/commands/` and `src/cli.ts`. Public command behavior, flags, and JSON surfaces MUST be reflected in this SPEC.

## Non-Goals

- YAML is the only workflow authoring format.
- No workflow control server.
- No mutation controls in monitor.

## Implementation Map

- CLI registration -> `src/cli.ts`
- Common command helpers -> `src/commands/common.ts`
- Lifecycle commands -> `src/commands/plan.ts`, `src/commands/run.ts`, `src/commands/run-worker.ts`, `src/commands/follow.ts`, `src/commands/monitor.ts`, `src/commands/resume.ts`
- Optional observation run selection -> `src/commands/run-selection.tsx`, `src/run-index/run-summary.ts`, `src/tui/run-picker-app.tsx`
- Workflow library commands -> `src/commands/save.ts`, `src/commands/list.ts`, `src/commands/show.ts`
- Skill wrapper -> `skills/acpus/scripts/acpus`
