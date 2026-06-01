# Report Specification

## Status

- Current implementation: current
- Source modules: `src/reports/`, `src/projections/run-report.ts`, `src/projections/run-view.ts`, `web-report/`, `src/commands/report.ts`
- Maintenance trigger: update this spec when changing report commands, markdown/JSON/HTML output, live server behavior, report projections, report data sources, or diagnostic presentation

## Purpose

Reports expose persisted run state, outputs, attempts, diagnostics, and final verdicts for humans and automation. Report generation is observation-only and follows the runtime orchestrator data model.

## Normative Requirements

- Report generation MUST read from persisted run artifacts.
- Report generation MUST NOT start, resume, or mutate workflow work.
- `report --run <run-id-or-dir>` MUST produce a human-readable report.
- `report --run <run-id-or-dir> --json` MUST produce structured JSON output.
- `report --run <run-id-or-dir> --json --detailed` MUST include detailed attempt and diagnostic data.
- `report --run <run-id-or-dir> --html --output <file>` MUST write a self-contained HTML snapshot.
- `report serve --run <run-id-or-dir>` MUST start a read-only local report server.
- The live report server MUST serve report data and attempt artifacts only; it MUST NOT expose workflow control endpoints.
- Reports MUST surface run-level blocked reasons and stable runtime diagnostics when present.

## Interfaces and Contracts

Supported report surfaces:

```bash
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator report --run <run-id-or-dir>
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator report --run <run-id-or-dir> --json
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator report --run <run-id-or-dir> --json --detailed
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator report --run <run-id-or-dir> --html --output report.html
skills/acpx-workflow-orchestrator/scripts/acpx-workflow-orchestrator report serve --run <run-id-or-dir> --host 127.0.0.1 --port 0
```

## Data Model

Reports are generated from:

- `run.json` for status, stages, attempts, usage, and final verdict;
- `workflow.spec.json` for author-stage graph metadata;
- `execution-plan.json` for compiled stage/runtime metadata;
- `outputs/*.json` for parsed stage outputs;
- `attempts/*/` for prompts, raw outputs, parse diagnostics, and repair artifacts;
- `sessions/role-bindings.json` for role/session identity;
- `events.ndjson` for event history when projected.

The detailed report model includes run summary, final verdict, graph view, per-stage status, attempts, role, agent, session key, prompt path, output path, parse diagnostics, contract outputs, warnings, risks, checks, changed files, and diagnostics.

## Runtime Behavior

Report commands locate a logical run, sync existing artifacts without starting pending work, project runtime artifacts into a report model, and render the requested surface. HTML snapshots embed the report state needed for offline viewing. The live server streams `RunReportView` snapshots over SSE.

## Extension Points

Report projections MAY add new fields when backed by persisted runtime artifacts. New fields SHOULD remain stable enough for JSON consumers or be documented as detailed-only diagnostics.

## Non-Goals

- Reports do not control workflow execution.
- The live report server is not a workflow API server.
- Report projections do not replace the run index as the source of truth.

## Implementation Map

- Markdown rendering -> `src/reports/markdown.ts`
- HTML snapshot rendering -> `src/reports/html.ts`, `web-report/`
- Live report server -> `src/reports/server.ts`
- Report projection -> `src/projections/run-report.ts`, `src/projections/run-view.ts`
- CLI command -> `src/commands/report.ts`
