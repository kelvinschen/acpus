# Fiber Ownership

- Status: approved
- Effect version: `4.0.0-rc.111`
- Sources: `FiberSet.ts`, `FiberMap.ts`, `Semaphore.ts`, `Scope.ts`, `Cause.ts`

Use this pattern for a dynamic set of operations that share one Scope owner.

## Admission fence

Create one scoped `FiberSet` and register work under the same small permit that
checks whether admission is closed:

```ts
const children = yield* FiberSet.make<unknown, unknown>()
const admission = yield* Semaphore.make(1)

const start = <A, E>(effect: Effect.Effect<A, E>) =>
  admission.withPermit(Effect.gen(function* () {
    if (closed) return yield* Effect.fail(closedError)
    return yield* FiberSet.run(children, effect)
  }))
```

The permit closes the race between passing a `closed` check and registering the
Fiber. Perform only policy and registration under it; the managed Fiber performs
the actual operation.

Shutdown closes admission under that permit, then clears and awaits the set.
`awaitEmpty` alone is insufficient while later registration remains possible.
`FiberSet.join` propagates child failure; it is not a drain operation.

Use `FiberMap` when identity-keyed replacement is the policy. Keep durable lease
or contention outcomes in a small domain map rather than interpreting Fiber
membership or interruption as the product contract.

## Finalizer ordering

Use `Effect.acquireUseRelease` when an operation acquires authority, runs an
interruptible inner Scope, and must release authority after every child
finalizer completes. Preserve the combined Cause when both use and release fail;
do not rebuild it as a Promise cleanup array.

Interruption remains process-local. Durable cancellation, retry, steer, and
claim release happen through their fenced scheduler transitions before physical
interruption.

## Evidence

Test start-versus-close admission, Scope-close interruption, semantic cleanup
before membership disappears, use plus finalizer failure, and the relevant
durable-before-interrupt ordering.
