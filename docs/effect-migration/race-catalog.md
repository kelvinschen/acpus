# Concurrency and Race Catalog

This catalog names high-risk races that migration agents must reason about.
Work packages reference these IDs and add focused evidence where the risk is
owned. The expected resolution is semantic; tests should avoid asserting
internal Fiber implementation details.

## Scheduler races

### RACE-001 — executor completes while cancellation/control commits

Risk: local execution reports success while durable projection has already
moved the attempt out of `started`.

Expected resolution: durable store/fencing/terminal rules decide whether the
result can commit. Local completion must not resurrect or contradict a durably
cancelled/failed/superseded attempt.

### RACE-002 — owner lease is lost while attempt Fiber is active

Expected resolution: local owned execution is interrupted/aborted promptly;
stale owner cannot commit authoritative outcome; new owner recovers from durable
state and supersedes expired-owner attempts according to existing rules.

### RACE-003 — interruption occurs around attempt-result commit

Before successful commit: interruption is not evidence of durable terminal
state. After successful commit: local interruption must not emit a second
contradictory terminal event. Transaction/fencing result is authoritative.

### RACE-004 — heartbeat detects lease loss while pump is waiting

Expected resolution: wake the scheduler, stop/interrupt local owned attempts and
return lease-lost behavior without waiting indefinitely on an unrelated local
settlement.

### RACE-005 — wake occurs between version observation and waiter registration

Current versioned wakeup prevents a lost wake by comparing observed/current
versions. Any Deferred/Queue replacement must preserve this property or prove a
stronger single-owner design that makes the race impossible.

## Workspace/runtime races

### RACE-006 — workspace close races with active tick/heartbeat/mutation

Expected resolution: no new work is admitted after shutdown begins; owned
activity settles/interupts according to policy; authority is not released and
store closed while an owned operation can still perform an authoritative write.

### RACE-007 — authority loss races with explicit close

Expected resolution: shutdown is idempotent at the ownership level. Authority
loss cannot spawn a detached duplicate cleanup path, and explicit close cannot
leave heartbeat/tick work alive.

## Process/agent races

### RACE-008 — process exits while cooperative close is in progress

Expected resolution: close observes terminal process state once, releases
listeners/resources and does not turn an already-exited process into a spurious
cleanup failure solely because a later signal cannot be delivered.

### RACE-009 — acquire cancellation occurs after spawn but before capsule ready

Expected resolution: spawned process is still owned and cleaned; ownership
manifest/process-tree policy is completed; caller receives the appropriate
cancel/open failure without orphaning the worker.

### RACE-010 — turn deadline/inactivity fires while terminal IPC arrives

Expected resolution: one terminal settlement wins according to existing turn
policy; timers/waiters are finalized; no double resolve, duplicate terminal
observation or leaked cleanup timer remains.

### RACE-011 — supervisor shutdown/neutralize races with a new or active turn

Expected resolution: lease/session ownership decides whether the turn may
continue. Closing supervisor/session prevents new unowned work and settles
active work without leaving registry entries or worker processes behind.

## ACP races

### RACE-012 — session close races with pending reverse-RPC permission/terminal

Expected resolution: pending operations are settled/interrupted by Session
Scope closure; terminal/file/process resources release exactly once; no waiter
survives the session.

### RACE-013 — external AbortSignal races with ACP turn completion

Expected resolution: adapter bridge is removed/finalized; completion and
interruption cannot both produce contradictory public turn outcomes; external
cancellation does not invent durable scheduler cancellation.

## Cleanup/failure composition

### RACE-014 — primary failure plus finalizer failure

Expected resolution: primary failure information is not silently overwritten by
cleanup failure. Cause/finalizer composition remains inspectable/loggable at the
appropriate boundary.

### RACE-015 — forced process cleanup budget expires

Expected resolution: hard-cleanup evidence/failure follows current process-tree
contract; Scope closure does not wait forever and does not falsely report clean
termination.

## Work-package protocol

For every referenced race, the agent reports one of:

```text
preserved by existing test: <test>
new focused test: <test>
proved impossible by new ownership model: <reason + test of the ownership rule>
not owned by this WP: <named downstream WP>
```

"Effect handles races" is never sufficient evidence.
