# CLI Reference

Acpus exposes its interface through the `acpus` binary. Invoke commands directly:

```bash
acpus <command>
```

## Command Groups

Acpus groups commands under four verbs: **Compose**, **Conduct**, **Recover**, and **Catalogue**.

### Compose -- Prepare and author workflows

```bash
# Validate a workflow spec without running it.
acpus validate --spec workflows/examples/simple-feature.workflow.spec.json

# Inspect the compiled execution plan as structured output.
acpus preview --spec workflows/examples/simple-feature.workflow.spec.json --json

# Save a workflow to the catalogue for reuse.
acpus save simple-feature --spec workflows/examples/simple-feature.workflow.spec.json
acpus save simple-feature --spec workflows/examples/simple-feature.workflow.spec.json --overwrite

# Generate a starter workflow draft under .acpus/drafts/.
acpus generate --name draft-workflow
```

`validate` checks schema correctness, graph structure, variable binding, and output contracts. It reports errors in a structured format suitable for automated repair loops.

`preview` compiles the spec into an execution plan and returns it without creating or starting a run. Use `preview` before `run` when you need to inspect the plan first.

`save` writes a saved workflow directory containing `workflow.spec.json`, `execution-plan.json`, README, schema documentation, wrapper scripts, and helper files from the current package build. Saving is always explicit; running a workflow does not save it.

`generate` writes a starter workflow draft to `.acpus/drafts/`. Generated drafts are templates only; validate and preview them before running.

### Conduct -- Execute and observe runs

```bash
# Run a workflow from a spec file.
acpus run --spec workflows/examples/simple-feature.workflow.spec.json
acpus run --spec workflows/examples/simple-feature.workflow.spec.json --wait

# Run a saved workflow by name.
acpus run --workflow simple-feature

# Follow a run with streaming output.
acpus follow <logical-run-id>
acpus follow <logical-run-id> --json

# Open the observation-only TUI monitor.
acpus monitor <logical-run-id>
acpus monitor <logical-run-id> --json
acpus monitor detail <logical-run-id> <task-id> --json

# Resume a blocked or failed run.
acpus resume <logical-run-id> --wait
acpus resume <logical-run-id> --max-fanout-items review_files=4 --allow-partial-fanout review_files
```

`run` validates the spec automatically, prepares a logical run, writes `execution-plan.json`, starts a background worker, and returns the run identifier. With `--wait`, the command runs in the foreground until terminal status and prints progress output.

`follow` observes and syncs the selected logical run. It does not create a new workflow. `follow --json` returns the Run Monitor View as structured output.

`monitor <run>` opens the observation-only Ink TUI. Navigate with up/down (move), left/right (switch panels), enter (task detail), esc (return), r (refresh), q (quit). `monitor <run> --json` returns the same Run Monitor View as `follow --json`. `monitor detail <run> <task-id> --json` returns bounded detail for one stage task from the monitor output.

`resume` advances an existing run from its persisted snapshot and `execution-plan.json` when the run is blocked, failed, or diagnosed blocked. Without `--wait`, resume resets recoverable state, starts a background worker, and returns immediately. With `--wait`, it runs in the foreground until terminal status. Resume refuses ownership while a non-stale worker is active.

Resume policy flags:

- `--max-fanout-items <stage=count>` lowers the effective fanout item cap for the named stage.
- `--skip-fanout-item <stage=index>` skips a zero-based item index by position.
- `--allow-partial-fanout <stage>` permits partial results for read-only fanout stages.

Resume persists policy overrides into `run.json` before advancing the scheduler. Blocked fanout stages re-aggregate from existing item outputs without rerunning completed items. Blocked or failed non-fanout stages reset to pending so the next scheduler tick retries them.

### Recover -- Diagnose and repair runs

```bash
# Produce a read-only diagnostic artifact for troubleshooting.
acpus diagnose <logical-run-id> --wait
acpus diagnose <logical-run-id> --wait --json

# Restart a stale or dead worker for a non-terminal run.
acpus recover <logical-run-id>
```

`diagnose` produces a recovery diagnostic prompt and artifact. It does not rerun edit work and does not change the saved workflow spec. `diagnose --json` returns the post-diagnose Run Diagnostics View.

`recover` restarts a stale or dead workflow worker for a non-terminal run. It does not restore arbitrary in-memory agent runtime state; recovery attempts use the scheduler's stale recovery rules.

### Catalogue -- List and inspect saved artifacts

```bash
# List saved workflows, completed runs, or draft files.
acpus list workflows
acpus list runs
acpus list drafts

# Show details of a saved workflow, run, or draft.
acpus show workflow simple-feature
acpus show run <logical-run-id>
acpus show draft <draft-name>
```

`list` and `show` operate on three namespaces: `workflows`, `runs`, and `drafts`.

## General Conventions

All commands accept `--json` where structured output is useful. JSON output follows stable schemas documented in the error-codes reference and specification files.

State produced by Acpus lives under `.acpus/` in the working directory. This includes run records, drafts, execution plans, and event logs.
