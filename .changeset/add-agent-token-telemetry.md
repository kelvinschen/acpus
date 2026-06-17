---
"@acpus/runtime": minor
"acpus": patch
"@acpus/tui": patch
---

Add opt-in agent token telemetry: display token usage in run status and TUI detail pane

- `@acpus/runtime`: Add `AgentTokenUsage` type and `tokenUsage` field on `AgentAttemptTelemetry`. Token usage is opt-in — only populated when the agent adapter reports it.
- `@acpus/cli`: Display token counts in `acpus runs show` agent activity summaries.
- `@acpus/tui`: Show token usage in the detail pane. Fix field label indentation in definition and context sections.
