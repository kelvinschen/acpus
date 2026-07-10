---
"@acpus/runtime": minor
---

Make run-local `workflow.ir.json` and `lock.json` the sole frozen workflow
artifacts, persist their required paths and digests in the current SQLite
schema, and initialize that schema directly.
