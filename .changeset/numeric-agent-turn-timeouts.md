---
"@acpus/agent-executor": minor
---

Replace authored duration strings in agent turn requests with validated resolved
millisecond budgets, including monotonic shared deadlines, safe long-timeout
scheduling, acpx rounding, and race-safe subprocess cancellation.
