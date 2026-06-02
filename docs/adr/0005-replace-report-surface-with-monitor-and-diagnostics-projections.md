# Replace Report Surface With Monitor and Diagnostics Projections

Status: accepted for planned implementation

## Decision

Remove the existing report surface. This includes the `report` CLI command, `RunReportView`, report renderers, live report server, and web-report frontend.

The replacement is a lightweight observation model: `RunMonitorView` for current run, stage, and Agent Work Unit progress; `WorkUnitDetailView` for bounded on-demand selected-work-unit details; and `RunDiagnosticsView` for diagnose and troubleshooting workflows.

## Considered Options

- Keep the current report command and web-report frontend, then adapt them into a TUI.
- Keep `RunReportView` as the shared model for TUI and future Web UI.
- Delete the report surface and split observation into monitor, detail, and diagnostics projections.

## Consequences

Delete the old `report` command and report SPEC rather than archive them. The `diagnose` command retains its current behavior but must stop depending on report projection data; it uses `RunDiagnosticsView` instead. The `save` helper snapshot continues to exist but must no longer require a built `dist/report-web` bundle.

`RunMonitorView` is the shared lightweight contract for TUI and future Web UI. It reads authoritative current state from `run.json` and related run metadata, returns all materialized Agent Work Unit metadata by default, and avoids reading `events.ndjson` or inlining large prompts, raw output, or output artifacts. `WorkUnitDetailView` may lazily read bounded previews for one selected Agent Work Unit. `RunDiagnosticsView` may read a bounded tail of events for troubleshooting, but monitor state must not depend on event replay.

The first TUI uses Ink. It remains observation-only, polls monitor snapshots, shows stages on the left and selected-stage Agent Work Units on the right, and loads work-unit details on selection. Control actions such as resume, diagnose, or cancel are out of scope for the first TUI.
