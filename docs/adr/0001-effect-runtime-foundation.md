# ADR-0001: Effect as the Acpus Runtime Foundation

- Status: Accepted
- Date: 2026-08-20
- Implementation status: Complete (2026-08-22)
- Baseline commit: `9b82a57aa761fed16f3edf0d35a2481e8ebd3b0b`
- Decision owners: Acpus maintainers

## Context

Acpus already owns a durable workflow model: workflow IR, scheduler events,
projections, control planning, retry semantics, replay, owner epochs, fencing,
SQLite transactions, agent/session ownership, and recovery behavior. At the
same time, the process-local runtime manually implements a second class of
concerns with Promises, `AbortController`, timers, mutable registries,
subprocess lifecycle protocols, cleanup aggregation, wakeups, and ad-hoc
resource ownership.

These process-local concerns are where Effect provides the strongest leverage:
typed effects, dependency requirements, structured concurrency, interruption,
resource scopes, queues, deferred values, clocks, schedules, and structured
observability.

The migration is treated as greenfield architecture work. Temporary
compatibility layers are not a goal. The repository should converge to one
process-local effect system rather than retain both `neverthrow`/Promise and
Effect models.

## Decision

Effect is the foundation for **effectful application and runtime code** in
Acpus.

Effect is **not** the workflow language, durable scheduler, persistence model,
or universal return type for pure code.

The architecture is divided into four conceptual layers:

```text
Workflow DSL / canonical data
            |
            v
Pure domain core
- IR and data types
- reducers / transitions
- plans / materialization
- durable event semantics
- native v4 Result / Option / plain ADTs when useful
            |
            v
Effect application runtime
- scheduler execution
- workspace / daemon lifecycle
- agent and ACP sessions
- subprocesses / hooks
- concurrency / interruption / time
            |
            v
Effect services and platform adapters
- SQLite store adapter
- Node process / filesystem / socket adapters
- ACP SDK adapter
- configuration / observability
```

### Durable truth remains Acpus-owned

The durable event log, store, projection, owner epoch, fencing, idempotency,
retry identity, replay, and recovery semantics remain authoritative.

The following identities are explicitly rejected:

```text
Fiber != Run
Fiber != NodeInstance
Fiber != Attempt
Fiber interruption != durable cancellation
Effect.retry != workflow retry
Deferred / Queue != durable signal
Effect success != SQLite commit
```

A Fiber is a process-local execution of work derived from durable state. Its
outcome may produce durable scheduler events; it never replaces them.

### One effectful failure channel

Effectful internal APIs use `Effect<A, E, R>`.

`neverthrow` is absent from the repository and must not be reintroduced. New
`ResultAsync` APIs are forbidden. Pure code may use plain discriminated unions,
native v4 `Result`, `Option`, or direct values as appropriate.

Nested failure channels such as `Effect<Result<...>>` are not used merely to
represent Effect failure. They are valid only when the nested value is itself
intentional domain data.

### Error taxonomy

Acpus distinguishes four categories:

1. **Normal domain outcome**: values such as completed, cancelled, or timed out
   when those are workflow outcomes.
2. **Expected effectful failure**: typed Effect errors such as store busy,
   protocol failure, spawn failure, or invalid external input at an effectful
   boundary.
3. **Interruption**: Fiber interruption caused by shutdown, loss of ownership,
   cancellation, or an external cancellation bridge.
4. **Defect / invariant violation**: impossible internal states and programmer
   errors. These are not normalized into recoverable typed failures.

Domain outcomes must not be converted to technical failures merely because
Effect has an error channel.

### Scope is the ownership model

Every long-lived resource belongs to a Scope. Child processes, ACP sessions,
terminal resources, leases, repeating jobs, active attempts, hook processes,
and similar resources must not outlive their owning Scope.

The expected ownership tree is conceptually:

```text
Process scope
  Workspace scope
    Store / authority lease
    Scheduler fibers
      Run scope
        Attempt scope
          executor / process resources
    Agent supervisor scope
      ACP session scope
        terminal / process resources
    Hook scope
```

Manual lifetime registries such as `closePromise`, `Set<Promise<...>>`, and
unstructured detached tasks are not patterns to reproduce inside Effect.

### Platform cancellation is an adapter concern

Fiber interruption is the application-level cancellation mechanism.
`AbortController` / `AbortSignal` are retained only where required by Node,
ACP, or third-party APIs. The bridge between interruption and AbortSignal is
centralized in platform/SDK adapters rather than reimplemented throughout
application code.

### Time uses Effect Clock

Application/runtime code uses Effect time abstractions for sleeping, timeout,
scheduling, and test control. Platform-specific timer APIs remain only in
adapters where unavoidable.

Process termination policy remains an Acpus concern. For example,
SIGTERM -> grace period -> SIGKILL is a domain/platform lifecycle protocol; it
is implemented with Effect time and Scope, not replaced by a generic timeout.

### Retry remains split by meaning

Effect retry/Schedule may be used for transient infrastructure operations such
as SQLite busy handling or retryable transport setup.

Workflow retry is always represented through Acpus scheduler planning, durable
attempt identity, and events. It must not be implemented by wrapping node
execution in `Effect.retry`.

### Services are capability-oriented

Services expose stable Acpus capabilities such as RuntimeStore,
AgentExecutor, AcpSessionManager, or ProcessHost. The application layer
must not depend on low-level SQL statements, callbacks, child-process event
plumbing, or similar platform details.

Layers assemble and scope services at composition roots. Deep application code
must not repeatedly construct or provide Layers as a service-locator pattern.

### Effect adapters are leaves

`Effect.tryPromise` and `Effect.async` are boundary tools. They belong around
Promise/callback APIs at platform or SDK adapter leaves. Application programs
must compose native Effects rather than wrap large async functions in
`tryPromise`.

`Effect.runPromise` / `runFork` belong only at executable entry points or an
explicit JavaScript API boundary. They are not used to escape structured
concurrency from inside Effect code.

## Non-goals

This decision does not require:

- replacing the Acpus workflow DSL with Effect;
- replacing scheduler reducers or projections with Effect programs;
- replacing SQLite persistence semantics;
- replacing durable signals with Queue/Deferred;
- adopting Effect Workflow as the Acpus workflow engine;
- migrating the current SQLite implementation to Effect SQL as part of this
  work;
- converting every pure function to Effect;
- exposing Effect types to workflow authors where plain TypeScript remains the
  simpler contract.

## Consequences

### Positive

- One process-local model for async work, typed failures, dependencies,
  cancellation, resources, concurrency, and time.
- Stronger shutdown and subprocess/session lifecycle guarantees.
- Deterministic time-based runtime tests.
- Less manual Promise/Abort/timer/cleanup plumbing.
- Explicit service requirements and easier replacement with test Layers.
- Better observability around workspace, run, attempt, agent session, and
  process lifecycles.
- A more regular architecture for AI agents to modify reliably.

### Costs

- Significant one-time conversion across packages that used neverthrow or
  Promise-based runtime APIs.
- The team and coding agents must learn Effect semantics rather than only its
  syntax.
- Generic-heavy types can harm readability if service and error taxonomies are
  over-designed.
- Incorrect use of detached Fibers, broad Cause handlers, or Layer composition
  can recreate the old lifecycle problems in a different syntax.

## Rejected alternatives

### Keep neverthrow at public/internal boundaries

Rejected for the target architecture. It creates two typed async failure
models and makes `ResultAsync` versus `Effect` an arbitrary local choice.
Migration compatibility does not justify a permanent second effect system in
this greenfield branch.

### Effect everywhere, including pure reducers

Rejected. Pure deterministic transformations are easier to read, replay, and
test as ordinary functions or explicit pure ADTs.

### Replace the durable scheduler with Effect primitives

Rejected. Process-local structured concurrency is not durable orchestration.
Owner fencing, event ordering, replay, retry identity, and SQLite commit
semantics remain Acpus responsibilities.

### Adopt unstable workflow/SQL capabilities during this migration

Rejected. Runtime architecture and persistence-engine replacement are
independent decisions and should not be coupled.

## Governance

The repository-wide migration implementing this decision completed on
2026-08-22. [Effect Maintenance](../effect-maintenance.md),
[Testing Maintenance](../testing-maintenance.md), and the optional
[Effect patterns](../effect/README.md) govern ongoing implementation and review;
completed migration plans remain in Git history.

Any change that would make Effect a durable source of truth, reintroduce a
second effect system, or change the ownership/fencing/event model requires a
new ADR that explicitly supersedes this one.
