---
"acpus": patch
---

Redesign the bundled deep-research workflow as an orchestrator-worker system: a
resident lead decomposes the question into independent lanes, parallel workers
each investigate one lane end to end from whichever sources fit (public web,
local workspace, or shell), and a writer fuses the lane reports into one
reader-facing report. Cross-check becomes an advisory skeptic pass rather than
the axis, and research judgment moves out of deterministic Tasks into the Agents.
The input surface collapses to `question`, `context`, a `depth` tier
(quick/deep/xdeep) that sets lane breadth, rounds, and cross-check together, and
`reportFormat`; the report is returned as a durable artifact.
