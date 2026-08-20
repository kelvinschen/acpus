# Effect v4 Pattern Catalog for Acpus

This catalog gives migration agents canonical **shapes**, not copy-paste APIs.
The exact pinned Effect v4 RC type declarations remain authoritative. Before
using a pattern, verify its API names/signatures against the pinned package.

The purpose is to make architectural choices predictable and prevent agents
from importing v3 habits or hiding the old Promise runtime inside Effect.

## Pattern 1 — pure domain stays pure

Use ordinary functions, domain ADTs, `Either`, or `Option` for deterministic
computation.

```ts
const planRetry = (projection, command): Either<RetryPlan, RetryRejected> => ...
```

Do not introduce an Effect environment merely because a pure function can
reject input.

**Reject:** reducers, event application, retry planning, canonical IR transforms
or deadline parsing becoming Effectful without an external capability.

## Pattern 2 — v4 capability service

A service represents an Acpus capability. In v4, use the native service API
verified from the pinned RC. The v4 source currently exposes `Context.Service`
as a service key that is itself yieldable from `Effect.gen`.

Conceptual shape:

```ts
import { Context, Effect } from "effect"

type RuntimeStoreShape = {
  readonly loadRun: (...) => Effect.Effect<..., StoreError>
  readonly appendEvents: (...) => Effect.Effect<..., StoreError>
}

const RuntimeStore = Context.Service<RuntimeStoreShape>("acpus/RuntimeStore")

const program = Effect.gen(function* () {
  const store = yield* RuntimeStore
  return yield* store.loadRun(...)
})
```

The exact declaration style may change between RCs; verify it. Do not recreate
v3 `Context.Tag` wrappers locally.

**Good service boundary:** RuntimeStore, Process capability, ACP transport or
session capability.

**Bad service boundary:** StringService, JsonService, DateService, or one Layer
per helper solely for abstraction purity.

## Pattern 3 — adapter leaf

External Promise/callback mechanics enter Effect at the smallest boundary.

```ts
const externalRequest = (...) =>
  Effect.tryPromise({
    try: () => sdk.request(...),
    catch: cause => new AcpTransportError(...)
  })
```

Application orchestration then composes native Effects.

```ts
const runTurn = Effect.gen(function* () {
  const transport = yield* AcpTransport
  const reply = yield* transport.request(...)
  yield* persistObservation(reply)
  return reply
})
```

**Reject:** one `tryPromise(async () => { ... })` containing store operations,
process lifecycle, application state transitions, retries and cleanup.

## Pattern 4 — scoped resource

Acquisition and finalization are one ownership definition.

Conceptual shape:

```ts
const acquireProcess = Effect.acquireRelease(
  spawnOwnedProcess(...),
  process => terminateOwnedProcess(process)
)
```

The resource is consumed inside an owning Scope. A public `close` operation may
remain when it is a meaningful product operation, but it should terminate the
owned scope/tree rather than implement a second cleanup state machine.

**Reject:** scoped resource plus parallel `closePromise`, timer registry and
listener cleanup protocol.

## Pattern 5 — structured child Fiber

Concurrent work belongs to a parent Scope/Fiber and is either joined,
supervised, or structurally interrupted with its owner.

Conceptual shape:

```ts
const child = yield* Effect.forkChild(work) // verify exact pinned v4 API
...
yield* Fiber.join(child)
```

Do not copy this exact API name without checking the pinned RC. The invariant is
that ownership is explicit.

**Reject:** `Effect.runPromise` inside application code, detached promises,
`forkDaemon`-style escape because correct ownership is inconvenient.

## Pattern 6 — one-shot wakeup vs message queue

Use `Deferred` for one completion/pulse and `Queue` for multiple consumed
messages. A versioned wakeup may combine a version value with a one-shot
notification if lost wakeups must be prevented.

For scheduler wakeups, preserve the current semantic property: if a wake occurs
between observing the version and waiting, the waiter must not sleep forever.
Do not mechanically replace the existing versioned wakeup with a bare Deferred
without proving this property.

For mutation serialization, prefer one owning consumer Fiber plus Queue when
that directly models ordered consumption.

## Pattern 7 — single-owner state before Ref

A mutable map owned by one scheduler/supervisor Fiber can remain private local
state. Do not automatically convert every `Map` into `Ref<Map<...>>`.

Use Ref only when multiple Fibers genuinely require atomic shared access.
Ownership is preferred over shared mutation.

## Pattern 8 — time through Effect

Application sleeps, timeouts, polling and repeating work use Effect Clock /
time combinators verified against the pinned v4 RC.

Process policy remains explicit:

```text
request cooperative close
  -> wait grace period with Effect time
  -> inspect liveness
  -> force termination if required
```

Do not replace policy with a generic timeout that loses the SIGTERM/SIGKILL or
ACP cooperative-close semantics.

## Pattern 9 — typed failure, interruption and defect remain distinct

```text
normal workflow cancellation  -> domain value / durable event
expected store/transport error -> Effect E
runtime shutdown/cancel        -> interruption
impossible internal state      -> defect
```

Use narrow typed handlers. Cause-aware APIs are reserved for places that truly
need to reason about interruption/defect/finalizer composition.

**Reject:** `UnknownError` around everything; converting interruption to an
ordinary error by default; `catchAllCause(() => Effect.void)`.

## Pattern 10 — durable commit surrounds process-local execution

Scheduler execution always follows this conceptual flow:

```text
read durable state / validate owner
  -> durably start attempt
  -> execute in process-local Fiber
  -> obtain outcome
  -> fenced durable commit
  -> projection/event state becomes authoritative
```

Fiber success is not commit. Fiber interruption is not durable cancellation.
Workflow retry is not `Effect.retry`.

## Pattern 11 — composition root

Layer/service construction is concentrated at process/workspace composition
roots. Application functions request capabilities rather than repeatedly
providing local Layer graphs.

Conceptual shape:

```text
Executable boundary
  -> construct Main/Workspace Layer graph
  -> run Effect runtime once
  -> Workspace Scope owns runtime tree
```

`runPromise`/equivalent runtime entry belongs here or at an explicit plain-JS
public boundary, not below it.

## Pattern 12 — testing with controlled runtime capabilities

Test semantic behavior through replacement services and controlled time. Test:

- acquire/use/release on success, failure and interruption;
- queue ordering and concurrency bounds;
- timeout/grace policy without arbitrary sleeps where possible;
- durable commit races with interruption;
- finalizer failure preserving primary failure information.

Do not assert exact Fiber ids, Layer graph shape or internal queue size unless
that structure is itself a product contract.

## v4 verification checklist

Before accepting any central Effect pattern, the implementing agent records:

```text
Pinned RC:
Pinned type/source consulted:
Native v4 service API used:
Native v4 Scope/Fiber API used:
Cause/error API used (if any):
Unstable import used (normally none):
Equivalent v3 idiom deliberately NOT copied:
```

This catalog is intentionally semantic. If an RC changes a combinator name,
update the implementation to the pinned v4 API without weakening the pattern.
