---
"@acpus/runtime": patch
---

Use the Core typed duration parser for runtime and hook configuration, reject
unsafe or non-persistable deadlines with typed failures, and preserve long hook
and task timeouts with cancellable chunked timers and deadline-first process
settlement. Surface corrupted persisted deadlines by stopping a permanently
failing daemon loop with complete teardown, journal synchronous hook spawn
failures, and make run-scoped control idempotency exact for successful no-op
controls, state-stable retry/cancel aliases, and explicit `root` node targets.
Preserve cooperative Task cleanup when cancellation races child-process startup
by delivering start before the already-pending abort.
