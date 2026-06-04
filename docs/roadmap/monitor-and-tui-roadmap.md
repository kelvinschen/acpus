# Monitor and TUI Roadmap

This roadmap records the planned migration from the existing report surface to lightweight monitor, diagnostics, and TUI surfaces. It is future work and is not current implementation truth.

## Phase 1: Remove Report Surface and Add Diagnostics Projection

Status: completed.

- Delete the `report` CLI command, `RunReportView`, report renderers, live report server, web-report frontend, and report-specific tests.
- Delete `specs/report-spec.md` and remove current report requirements from other SPEC files.
- Keep `RunDiagnosticsView` as an internal troubleshooting projection.
- Do not restore a public `diagnose` command; ADR 0007 removed that product surface.
- Keep `RunView` temporarily for existing run and follow summaries.
- Keep `save` helper snapshots, but remove the requirement for `dist/report-web`.
- Remove web-report build/test scripts and web-only dependencies.

## Phase 2: Add Monitor and Task Detail Projections

Status: completed.

- Add `RunMonitorView` as the lightweight current-state projection for runs, stages, and Stage Tasks.
- Add `TaskDetailView` for bounded, on-demand detail about one selected Stage Task.
- Make `follow --json` output `RunMonitorView`.
- Add `monitor <run> --json` with the same `RunMonitorView` output as `follow --json`.
- Add `monitor detail <run> <task-id> --json` for `TaskDetailView`.
- Keep monitor observation-only: it MUST call `syncRun` with `startPending: false`.
- Do not read `events.ndjson` in `RunMonitorView`; only diagnostics may read bounded tail events.

## Phase 3: Add Ink TUI

Status: completed.

- Introduce Ink and required TUI runtime dependencies in this phase, not earlier.
- Implement `monitor <run>` as an Ink TUI.
- Use polling of `RunMonitorView` snapshots; do not tail `events.ndjson` in the first TUI.
- Render stages, selected-stage Stage Tasks, and Task Detail in the TUI.
- Default selection should prefer the current running stage, then the first blocked stage, then the first non-completed stage.
- Load `TaskDetailView` lazily when a Stage Task is selected.
- Keep the first TUI observation-only: no resume, cancel, or workflow mutation actions.
- Do not display token usage or tool-call counts in the first TUI.
- Do not inline full prompt, raw output, or output artifacts; show bounded previews and paths only.
