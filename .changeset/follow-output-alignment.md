---
"acpus": patch
---

Align follow-mode output with `runs show` format and fix two bugs:

- **Bug fix**: Terminal summary for completed runs now includes the workflow `Output:` section (was silently discarded in human-readable mode).
- **Bug fix**: Duration formatting in terminal summary now matches `runs show` exactly (hours < 48 show as `Xh`, not `XhYm`).
- Extract shared `computeRunDurationMs` and `formatDurationFromMs` into `runs-show.ts` to eliminate duplicate duration logic.
- Export `formatWorkflowOutput` from `runs-show.ts` so follow-mode can render the output section.
- `--poll` now accepts duration strings (`2s`, `1m`, `500ms`, `1h`) using `parseDurationMs`, aligned with workflow spec timeout syntax.
- Follow observations use `formatNodeLines` and `STATE_GLYPH` from `runs-show.ts` for consistent formatting.
- Container filtering and activity dedup added to follow loop.
- Richer JSON observations: node events include `kind`, `startedAt`, `completedAt`, `attempt`, `agentTelemetry`, `artifactRefs`, `output`; run events include `workflowName`, `workflowRef`, `createdAt`; summary events include `runDuration` and `output`.
