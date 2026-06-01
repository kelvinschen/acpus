# HTML Report Design

HTML reporting follows the runtime orchestrator data model.

## Supported Surfaces

- `skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator report --run <run-id-or-dir>`
- `skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator report --run <run-id-or-dir> --json`
- `skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator report --run <run-id-or-dir> --json --detailed`
- `skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator report --run <run-id-or-dir> --html --output report.html`
- `skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator report serve --run <run-id-or-dir> --host 127.0.0.1 --port 0`

## Runtime Data

Reports are generated from the run directory:

- `run.json` for status, stages, attempts, usage, and final verdict;
- `workflow.spec.json` for author-stage graph metadata;
- `execution-plan.json` for compiled stage/runtime metadata;
- `outputs/*.json` for parsed stage outputs;
- `attempts/*/` for prompt, raw output, parse diagnostics, and repair
  artifacts;
- `sessions/role-bindings.json` for role/session identity.

## UI Model

The detailed report shows:

- run summary and final verdict;
- author-stage graph and per-stage status;
- attempt list with role, agent, session key, status, prompt path, output path,
  and parse diagnostics;
- contract outputs, warnings, risks, checks, changed files, and diagnostics.

The live server is read-only. It serves report data and attempt artifacts from
the selected run directory and does not start, resume, or mutate workflow work.
