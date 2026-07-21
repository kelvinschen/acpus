---
"@acpus/runtime": patch
"acpus": patch
---

Make targeted retry distinguish failed target paths from `parent_failed`
completion dependencies, restore required canceled work in one event, preserve
resolved timeouts, and atomically reject terminal, paused, configuration, or
strategy-blocked retries that cannot schedule progress. Fail and recover
running `parallel all` and `fanout all` groups whose required work is canceled
instead of leaving the run non-terminal without schedulable work. After a
restart, reconcile all immediately derivable composite transitions, resume
admissible ready work, and recover an expired owner's started attempts even
beside an untimed Signal wait. Derive wide member cancellation batches without
rescanning the projection per member.
