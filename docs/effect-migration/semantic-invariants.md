# Effect Migration Semantic Invariant Registry

These IDs are stable references for migration work packages. They describe
behavior that the Effect rewrite must preserve unless a separate approved
product/spec change explicitly supersedes it.

They are migration guardrails, not a replacement for owning specs or tests.

## Scheduler and durable execution

### SCH-001 — owner fencing precedes authoritative writes

An execution owned by a stale/lost owner must not successfully commit a new
attempt outcome or scheduler transition as authoritative state. Owner epoch and
store fencing remain Acpus durability mechanisms, not Fiber identity.

Evidence area: scheduler/store fencing, owner-epoch and lease-loss tests.

### SCH-002 — interruption is not durable cancellation

Interrupting/aborting local execution is insufficient to claim that an attempt
or run is durably cancelled. Durable state changes only through the existing
scheduler/store event/commit path.

### SCH-003 — attempt start is durable before executor authority

The scheduler durably starts/identifies an attempt before launching the local
executor for that attempt. Effect must not launch an anonymous Fiber first and
retroactively invent durable identity.

### SCH-004 — executor result becomes authoritative only after fenced commit

A local executor/Fiber result is process-local until `tryCommitAttemptResult`
or its final Effect-native equivalent commits under the current owner epoch.
Local success must not be exposed as durable completion before that boundary.

### SCH-005 — workflow retry remains durable scheduler semantics

Retry identity, retry closure/targeting, attempt numbering and event history
remain scheduler-owned. `Effect.retry` may not wrap workflow node execution.

### SCH-006 — reducers and event application remain deterministic

Scheduler transition/reducer behavior remains reconstructable from durable data
without an Effect runtime, Fiber registry, Queue, Deferred or Ref.

## Store and persistence

### STORE-001 — event/version/idempotency rules remain authoritative

Scheduler writes preserve expected-version and idempotency behavior. Version
mismatch remains a concurrency signal handled according to current scheduler
semantics.

### STORE-002 — transaction boundaries are not weakened

Event append/projection changes and attempt commits retain their existing
transactional/fencing guarantees. Wrapping SQLite calls in Effect must not split
an atomic operation across multiple independently interruptible commits.

### STORE-003 — SQLite implementation semantics remain intact in B01

B01 does not replace `node:sqlite`, WAL behavior, synchronous transaction
semantics or schema. Effect wrapping changes composition/lifetime/error typing,
not database durability.

## Runtime authority

### AUTH-001 — workspace authority is durable and fenced

Runtime authority owner id/epoch is stored and validated independently of the
Workspace Fiber/Scope. Restarted processes cannot infer