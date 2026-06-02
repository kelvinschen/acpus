# Replace Report Surface With Monitor and Diagnostics Projections

Status: accepted for planned implementation

We decided to remove the existing report surface, including the `report` CLI command, `RunReportView`, report renderers, live report server, and web-report frontend. The replacement direction is a lightweight observation model: `RunMonitorView` for current run, stage, and Agent Work Unit progress; `WorkUnitDetailView` for bounded on-demand selected-work-unit details; and `RunDiagnosticsView` for diagnose and troubleshooting workflows.

**Considered Options**

- Keep the current report command and web-report frontend, then adapt them into a TUI.
- Keep `RunReportView` as the shared model for TUI and future Web UI.
- Delete the report surface and split observation into monitor, detail, and diagnostics projections.

**Consequences**

The old `report` command and report SPEC should be deleted rather than archived. `diagnose` remains current behavior but must stop depending on report projection data and instead use `RunDiagnosticsView`. The `save` helper snapshot should continue to exist but must no longer require a built `dist/report-web` bundle.

`RunMonitorView` is the shared lightweight contract for TUI and future Web UI. It should read authoritative current state from `run.json` and related run metadata, return all materialized Agent Work Unit metadata by default, and avoid reading `events.ndjson` or inlining large prompt, raw output, or output artifacts. `WorkUnitDetailView` may lazily read bounded previews for one selected Agent Work Unit. `RunDiagnosticsView` may read a bounded tail of events for troubleshooting, but monitor state must not depend on event replay.

The first TUI should use Ink, remain observation-only, poll monitor snapshots, show stages on the left and selected-stage Agent Work Units on the right, and load work-unit details on selection. Control actions such as resume, diagnose, or cancel are out of scope for the first TUI.
