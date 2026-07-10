---
"@acpus/runtime": patch
---

Propagate malformed durable scheduler and projection read failures from
run-detail APIs instead of silently omitting dynamic state.
