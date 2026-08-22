# Durable Concurrency

- Status: approved
- Effect version: `4.0.0-rc.111`
- Sources: `Deferred.ts`, `Semaphore.ts`, `Clock.ts`, `TestClock.ts`

This pattern applies when process-local coordination protects durable scheduler
state. The store remains authoritative; Deferred, Semaphore, Queue, and Fiber
state never become workflow state.

## Versioned wakeup

A scheduler wake is a coalescing version signal, not a consumed message. Compare
the observed version and capture the current pulse inside one suspended action:

```ts
let version = 0
let pulse = Deferred.makeUnsafe<number>()

const waitForChange = (after: number) => Effect.suspend(() =>
  after === version ? Deferred.await(pulse) : Effect.succeed(version))

const wake = () => {
  version += 1
  const current = pulse
  pulse = Deferred.makeUnsafe<number>()
  Deferred.doneUnsafe(current, Effect.succeed(version))
}
```

Wake-before-wait observes the newer version immediately. Wait-before-wake holds
the exact Deferred that `wake` completes. Concurrent waiters intentionally
coalesce and always re-read durable state after waking. Interrupting one waiter
does not consume the pulse for another.

## Publication and shutdown

Use one permit when a durable mutation boundary needs local serialization. An
accepted authoritative mutation and its permit wait are uninterruptible when
interruption would create an unknown outcome. Failure releases the permit and
does not poison later work.

Workspace shutdown closes admission before placing a serialized drain barrier.
A pre-created Effect started after the fence must recheck admission inside the
permit and reject without touching the store.

Persist one authored Attempt deadline. Consumers recompute remaining time and
never restart the budget between process phases, Agent turns, repair, or
cleanup. Use Effect Clock for waits and monotonic elapsed time; persist only
wall-clock domain timestamps.

Do not add a local Semaphore around scheduler-admitted Attempt work. That would
create a second capacity policy after durable `attempt.started` publication.

## Evidence

Keep focused tests for wake-before-wait, wait-before-wake, concurrent waiters,
waiter interruption, mutation ordering/failure recovery, shutdown fencing, and
single-deadline behavior under `TestClock`.
