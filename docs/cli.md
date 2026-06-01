# CLI

Use the skill-local wrapper:

```bash
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator <command>
```

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

All commands support `--json` where structured output is useful.

`run` validates automatically. Without `--yes`, it prints a preview and exits
with approval required. With `--yes`, it prepares a logical run, writes
`execution-plan.json`, advances one scheduler tick, and returns. Use `--wait` to
advance until terminal status. Use `--prepare-only` to prepare the logical run
and write runtime artifacts without starting runtime turns.

`follow` observes and syncs the selected logical run. It does not create a new
workflow.

`generate` writes a starter workflow draft under `.acpx-workflow-orchestrator/drafts/`.
Generated drafts are templates only; validate and preview them before running.

`diagnose` prepares a read-only recovery diagnostic prompt/artifact. It does not
rerun edit work and does not change the saved workflow spec.

`resume` advances an existing run from its persisted run snapshot and
`execution-plan.json`. Resume policy flags may only tighten fanout handling:

- `--max-fanout-items <stage=count>` lowers the effective fanout item cap.
- `--skip-fanout-item <stage=index>` skips a zero-based item index.
- `--allow-partial-fanout <stage>` allows partial read-only fanout results.

Resume persists these policy overrides into `run.json` before advancing the
scheduler. Blocked fanout stages are re-aggregated from existing item outputs
without rerunning completed items; blocked/failed non-fanout stages are reset to
pending so the next scheduler tick can retry them.

`save` writes a saved workflow directory with `workflow.spec.json`,
`execution-plan.json`, README, schema/docs, wrapper, and built helper files from
the current package build. Approval to run is not save approval; saving is
always explicit.

`list` and `show` support `workflows`, `runs`, and `drafts`.

`report --html --output <file>` writes a self-contained HTML snapshot based on
the run index, final outputs, attempts, events, and diagnostics. `report serve`
starts an observation-only local server that streams RunReportView snapshots
over SSE after syncing existing artifacts with `startPending: false`; it does
not expose workflow control endpoints. `--interval-ms` controls live sync
interval, and `--open` opens the served report URL in a browser.
