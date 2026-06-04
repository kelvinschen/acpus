# CLI Reference

Acpus exposes its interface through the `acpus` binary. Invoke commands directly:

```bash
acpus <command>
```

## Command Groups

Acpus groups commands under three verbs: **Compose**, **Conduct**, and **Catalogue**.

### Compose -- Prepare and author workflows

```bash
# Plan a workflow spec (validate and preview in one step).
acpus plan <spec>
acpus plan <spec> --quiet
acpus plan <spec> --json

# Save a workflow to the local store for reuse.
acpus save <name> --template basic
acpus save <name> --template basic --overwrite
```

`plan` validates schema correctness, graph structure, variable binding, and output schema declarations, then compiles the spec into an execution plan. It returns the plan without creating or starting a run. Use `plan` before `run` when you need to inspect the plan first. `--quiet` suppresses non-essential output. `--json` returns the compiled execution plan as structured output.

`save` writes a saved workflow directory containing `workflow.spec.yaml`, `execution-plan.json`, README, schema documentation, wrapper scripts, and helper files from the current package build. Saving is always explicit; running a workflow does not save it. Provide the spec as a positional argument and the template name with `--template`.

### Conduct -- Execute and observe runs

```bash
# Run a workflow from a spec file or saved workflow name.
acpus run foo.workflow.spec.yaml
acpus run my-workflow
acpus run foo.workflow.spec.yaml --wait
acpus run foo.workflow.spec.yaml --input '{"task":"review"}'
acpus run foo.workflow.spec.yaml --input input.json
acpus run foo.workflow.spec.yaml --input input.yaml

# Follow a run with streaming output.
acpus follow
acpus follow <logical-run-id>
acpus follow <logical-run-id> --json
acpus follow --json

# Open the observation-only TUI monitor.
acpus monitor
acpus monitor <logical-run-id>
acpus monitor <logical-run-id> --json
acpus monitor --json
acpus monitor detail <logical-run-id> <task-id> --json

# Resume a blocked or failed run.
acpus resume <logical-run-id> --wait
acpus resume <logical-run-id> --max-fanout-items review_files=4 --allow-partial-fanout review_files
acpus resume <logical-run-id> --force

```

`run` validates the spec automatically, prepares a logical run, writes `execution-plan.json`, starts a background worker, and returns the run identifier. The positional argument accepts either a spec file path or a saved workflow name. `--input <json-or-yaml-or-path>` accepts either an inline JSON object or a JSON/YAML file path. Inline YAML is not supported; non-JSON-inline values are interpreted as file paths. With `--wait`, the command runs in the foreground until terminal status and prints progress output.

`follow <run>` observes a run by streaming its output in real time. It does not create a new workflow. `follow <run> --json` streams events and emits a final Run Monitor View as structured output. Without a run argument, `follow` lists current project runs; in an interactive TTY it opens a run picker, in non-interactive text mode it prints the list and exits, and with `--json` it prints the run summary list JSON.

`monitor <run>` opens the observation-only Ink TUI. Navigate with up/down (move), left/right (switch panels), enter (task detail), esc (return), r (refresh), q (quit). `monitor <run> --json` returns the same Run Monitor View as `follow --json`. Without a run argument, `monitor` lists current project runs with the same interactive, text, and JSON modes as `follow`. `monitor detail <run> <task-id> --json` returns bounded detail for one stage task from the monitor output.

`resume` advances an existing run from its persisted snapshot and `execution-plan.json` when the run is blocked or failed. Without `--wait`, resume resets recoverable state, starts a background worker, and returns immediately. With `--wait`, it runs in the foreground until terminal status. Resume refuses ownership while a non-stale worker is active. `--force` also permits recovery of running or pending runs after their worker is stale; it still refuses to take ownership from an active non-stale worker.

Resume policy flags:

- `--max-fanout-items <stage=count>` lowers the effective fanout item cap for the named stage.
- `--skip-fanout-item <stage=index>` skips a zero-based item index by position.
- `--allow-partial-fanout <stage>` permits partial results for read-only fanout stages.

Resume persists policy overrides into `run.json` before advancing the scheduler. Blocked fanout stages re-aggregate from existing item outputs without rerunning completed items. Blocked or failed non-fanout stages reset to pending so the next scheduler tick retries them.

### Catalogue -- List and inspect saved artifacts

```bash
# List saved workflows or completed runs.
acpus list runs
acpus list workflows

# Show details of a saved workflow or run.
acpus show run <id>
acpus show workflow <name>
```

`list` and `show` operate on two namespaces: `workflows` and `runs`.

## General Conventions

All commands accept `--json` where structured output is useful. JSON output follows stable schemas documented in the error-codes reference and specification files.

State produced by Acpus lives under `.acpus/` in the working directory. This includes run records, execution plans, and event logs.
