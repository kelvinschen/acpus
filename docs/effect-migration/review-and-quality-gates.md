# Effect Migration Review and Quality Gates

This document defines review gates for the Effect migration. Passing tests is
necessary but not sufficient. Reviewers and AI agents must also verify that the
code converges on the architecture in ADR-0001 rather than reproducing the old
Promise/Result/lifecycle model in Effect syntax.

## Review order

Review migrated code in this order:

1. durable semantics;
2. ownership and lifetime;
3. failure taxonomy;
4. concurrency and cancellation;
5. service boundaries;
6. Effect taste and simplicity;
7. tests and static searches.

Do not begin with style. A beautifully composed Effect program is still wrong
if it changes event ordering, commit boundaries, fencing, or process ownership.

## Gate 1: Durable semantics are unchanged

For runtime/scheduler changes, reviewers must be able to answer:

- What remains the durable source of truth?
- Which event(s) are written for each execution outcome?
- Where is owner/fencing validation performed?
- What happens if interruption races with durable commit?
- What happens if process completion races with cancellation?
- Can a Fiber outcome be observed as durable before the transaction commits?
- Can a restarted owner reconstruct the same state without any Fiber state?

Reject changes where correctness depends on a process-local Fiber registry,
Ref, Deferred, Queue, or Scope surviving a process restart.

## Gate 2: Scope owns lifetime

Every long-lived resource must have a visible owner.

Reviewers should trace:

```text
acquire -> owner Scope -> child use -> interruption/normal exit -> finalizer
```

Red flags:

- `closePromise` or equivalent idempotence state machine;
- `Set<Promise<...>>` used to track work for shutdown;
- detached background Promise/Fiber without a documented owner;
- listener cleanup distributed across several unrelated functions;
- a scoped resource returned to a longer-lived context without its Scope;
- `forkDaemon` used because wiring the correct ownership is inconvenient;
- `.close()` methods that independently reproduce finalizers already owned by
  Scope.

A close operation can remain a public semantic operation, but its
implementation should close/interrupt the owned resource tree rather than
maintain a second cleanup protocol.

## Gate 3: Failure is modeled once

Expected effectful failures belong in Effect's `E` channel. Pure domain
branching belongs in values/ADTs/Either/Option.

Reject:

- `Effect<Result<...>>` used as a second error channel;
- `Effect<Either<...>>` when the Either simply duplicates Effect failure;
- `UnknownError` that collapses unrelated actionable error categories;
- every branch becoming its own error class with identical recovery behavior;
- converting normal workflow statuses into technical failures;
- converting defects/invariants into recoverable errors merely to avoid dies;
- broad `catchAllCause` that discards interruption or finalizer information.

Review error taxonomies from the consumer's recovery action. If two failures
lead to the same handling and carry the same stable information, prefer one
error with a reason ADT over abstraction proliferation.

## Gate 4: Interruption is not domain cancellation by accident

Application cancellation should use Fiber interruption. External AbortSignals
are adapter mechanics.

Reviewers must verify:

- external AbortSignal listeners are centralized and removed correctly;
- Fiber interruption aborts the SDK/Node operation when required;
- durable cancellation is explicitly committed by scheduler/domain logic;
- interruption before commit cannot masquerade as committed cancellation;
- interruption after commit cannot cause duplicate or contradictory events;
- finalizers remain correct under interruption.

Reject code that treats `Fiber.interrupt` as sufficient evidence that an
attempt/run/session reached a durable cancelled state.

## Gate 5: Effect adapters stay at leaves

`Effect.tryPromise` and `Effect.async` are expected at Promise/callback
boundaries, not around entire application operations.

Red flag shape:

```text
Effect.tryPromise(async () => {
  await store...
  await process...
  await session...
  try/finally...
})
```

Preferred shape:

```text
small Promise/callback adapter
        -> Effect capability
        -> Effect.gen / combinators for application orchestration
```

Wrapping synchronous blocking SQLite work in Effect does not make it
non-blocking. Review performance assumptions accordingly.

## Gate 6: Services describe Acpus capabilities

A service should exist because multiple application operations need a stable
capability boundary, a resource needs Layer/Scope construction, or testing
benefits from replacing an owned boundary.

Reject service/Layers created solely to wrap trivial pure helpers or individual
stdlib functions without a meaningful capability boundary.

Red flags:

- `DateService`, `JsonService`, `StringService` abstractions with no ownership or
  external boundary;
- Layer per helper function;
- application code constructing/providing a Layer inside every operation;
- leaking SQL statements, event emitters, or Node callback details through
  application-facing services;
- service methods that simply mirror an entire third-party SDK rather than the
  subset Acpus owns.

Prefer composition roots to provide the graph once.

## Gate 7: Structured concurrency replaces Promise orchestration

In migrated runtime/application code, question every occurrence of:

- `new Promise`;
- `Promise.all`, `Promise.race`, `Promise.allSettled`;
- `void somePromise`;
- `.catch(...)`/`.finally(...)` used for lifecycle coordination;
- manually stored resolvers;
- timer IDs and listener registries;
- `Effect.runPromise` or `runFork` below an entry point;
- `forkDaemon`.

Some platform adapters may legitimately use Promise APIs. The burden is on the
adapter to remain small and not own application orchestration.

## Gate 8: Choose the narrow concurrency primitive

Review primitive choice by semantics:

| Need | Preferred primitive |
| --- | --- |
| one-shot completion | Deferred |
| producer/consumer messages | Queue |
| one-to-many process-local broadcast | PubSub |
| bounded process-local capacity | Semaphore |
| atomic shared process-local state | Ref |
| lifetime | Scope |
| concurrent computation | Fiber |
| time/repetition | Clock / Schedule |

Do not replace every mutable Map with a `Ref<Map>` by default. If one owning
Fiber can hold the state privately, prefer ownership over shared mutation.

Do not replace durable scheduler admission, signals, or retry with process-local
primitives.

## Gate 9: Time is deterministic

Migrated runtime logic should not introduce uncontrolled wall-clock behavior.

Reviewers should reject new application-level `setTimeout`, `setInterval`, or
`Date.now` when Effect Clock can express the behavior.

Tests that depend on waiting should use controllable time where practical.
Real subprocess integration tests may still require real time at the platform
boundary; keep those few, bounded, and semantically necessary.

## Gate 10: Retry semantics are separated

`Effect.retry`/Schedule are allowed only for transient infrastructure failures
where repetition does not create a new durable workflow attempt or violate
idempotency.

Reject `Effect.retry(executeNode)` or equivalent implementations of workflow
retry.

For every infrastructure retry, reviewers should confirm:

- the operation is safe to repeat;
- retry does not cross a durable commit boundary incorrectly;
- the schedule is bounded/appropriate rather than defensive retry theater;
- existing Acpus retry policy is not being shadowed.

## Gate 11: Best-effort behavior remains explicit

Some existing side effects are intentionally non-authoritative, such as
activity reporting, optional progress publication, or secondary diagnostics.
Effect migration must not turn them into silent broad Cause suppression.

Prefer narrow handlers that state why the failure is non-fatal and preserve
observability where useful.

Review-sensitive APIs include:

- `catchAllCause`;
- `sandbox`;
- `orDie`;
- `ignore`;
- broad `catchAll` on a wide union;
- converting Cause to a string and discarding structure.

## Static bad-taste searches

At work-package completion, search the changed scope. At final migration
completion, search the repository.

The exact search tool may be `rg`, repository code search, or a future lint
script. The intent is what matters.

Expected zero repository-wide at final completion:

```text
neverthrow
ResultAsync
```

Expected zero in migrated application/runtime code, with adapter/entrypoint
exceptions reviewed individually:

```text
new Promise
new AbortController
setTimeout
setInterval
Promise.all
Promise.race
Promise.allSettled
Effect.runPromise
Effect.runFork
Effect.forkDaemon
```

Review individually rather than blindly banning repository-wide:

```text
Effect.tryPromise
Effect.async
Effect.catchAllCause
Effect.sandbox
Effect.orDie
Effect.ignore
Effect.either
Effect.provide
Ref.make
```

For each occurrence ask whether it is at the correct architectural boundary.

## Suggested automated architecture gates

After the migration stabilizes, prefer small repository checks over relying on
memory. Candidate gates include:

- fail if `neverthrow` exists in manifests/source/lockfile;
- fail if `ResultAsync` exists in production source;
- restrict `Effect.runPromise`/`runFork` to approved entrypoint paths;
- restrict `Effect.tryPromise`/`Effect.async` to approved adapter directories or
  documented exceptions;
- flag direct timer/AbortController usage under migrated runtime application
  directories;
- flag `forkDaemon` for manual review.

Do not build a large custom lint framework. A small check script or existing
lint capability is preferable if it provides a stable closed-set rule.

## Test evidence checklist

A migrated ownership/concurrency boundary should have evidence for the risks it
actually owns. Typical risks include:

- normal success releases resources;
- expected failure releases resources;
- interruption releases resources;
- finalizer failure does not silently replace the primary failure;
- repeated close/stop semantics remain correct where publicly meaningful;
- timeout is deterministic;
- queue ordering is preserved;
- concurrency limits are preserved;
- shutdown waits for or interrupts exactly the owned work;
- child process termination escalation matches policy;
- owner loss/fencing prevents stale writes;
- durable events remain idempotent and replayable.

Use the lowest stable test layer that can observe each risk. Do not create tests
for Effect implementation details such as exact Fiber IDs, internal Queue
sizes, or Layer graph shapes.

## Work-package acceptance template

A master/reviewer should not accept a work package until the implementing agent
can report all of the following in concrete terms:

```text
Boundary migrated:
Pure/effectful split:
Scope/ownership tree:
Expected error types:
Interruption path:
External adapter path:
Durable invariants preserved:
Legacy abstractions deleted:
Narrow tests run:
Broader checks run:
Bad-taste searches run:
Remaining work (must name a later package, not a tactical TODO):
```

If the report cannot identify the owner of a Fiber/resource or the durable
commit boundary, the implementation is not ready for acceptance even if tests
pass.

## Final architecture review

At migration completion, perform one repository-level review independent of
individual work-package approvals.

The final review must verify:

- there is exactly one effectful runtime model;
- neverthrow is gone rather than hidden behind adapters;
- pure domain code did not become unnecessarily Effectful;
- Layer/service count reflects real capabilities rather than abstraction
  enthusiasm;
- durable scheduler semantics still live in Acpus domain/store code;
- all process-local background work has ownership;
- timeout/cancellation/process behavior is deterministic and testable;
- public workflow authoring remains simple;
- the net codebase is simpler: obsolete helpers, adapters, and lifecycle state
  machines were deleted rather than retained beside Effect equivalents.
