---
"@acpus/runtime": minor
"@acpus/workflow-compiler": minor
"@acpus/loader": minor
"@acpus/web": patch
"acpus": minor
---

Move durable runtime state into private per-workspace shards under the Acpus
home, archive incompatible or partial storage generations before rebuilding,
preserve global-catalog source references for execution, and centralize
verified artifact reads in Runtime. Add `runs prune` with fixed confirmed
selection cutoffs and relocate CLI-owned cache, snapshot, import, and
report-draft data out of workspace runtime storage. Keep frozen catalog
sources separate from the workspace dependency authority during preparation
and reusable Task execution, and isolate daemon fallback endpoints and
temporary directories per Acpus home. Show the current workspace shard path
in Doctor text and JSON output without initializing it, highlighting the text
form on color-capable terminals.
