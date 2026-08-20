# Effect Migration Agent Execution Manual

This guide is mandatory for any AI agent changing production code as part of
the Effect migration. Read ADR-0001 first:

- `docs/architecture/ADR-0001-effect-runtime-foundation.md`

The migration is a greenfield architecture convergence. Do not preserve old
internal abstractions for compatibility unless a task explicitly requires a
public compatibility contract.

## Mission

Converge Acpus onto one process-local effect system while preserving Acpus
semantics.

The target split is:

```text
pure domain code              -> values / ADTs / Either / Option
runtime and application code  -> Effect<A, E, R>
platform and SDK edges         -> small adapters into Effect
persistent orchestration      -> existing Acpus events/store/projection/fencing
```

The goal is not to maximize the number of Effect-returning functions. The goal
is to use the correct abstraction exactly once for each concern.

## Non-negotiable laws

1. Effectful internal functions MUST return `Effect<A, E, R>`. Do not add
   `ResultAsync` or a second async failure abstraction.
2. Pure functions MUST remain pure unless they genuinely require an Effect
   capability. Do not wrap deterministic transformations in Effect for style.
3. `neverthrow` MUST be removed as migration work reaches each package. The
   final repository MUST have no production or test dependency on neverthrow.
4. `Effect.tryPromise` and `Effect.async` MUST be limited to Promise/callback
   platform or SDK adapter leaves. They MUST NOT wrap an application workflow
   whose internals can be expressed as native Effect composition.
5. `Effect.runPromise`, `runFork`, and equivalent runtime escape hatches MUST
   appear only at executable entry points or explicit JavaScript API
   boundaries. Never use them inside Effect application code.
6. Long-lived resources MUST have Scope ownership. Do not introduce manual
   lifecycle constructs such as `closePromise`, `Set<Promise<...>>`, detached
   background promises, or ad-hoc cleanup registries when Scope can own them.
7. Application/runtime code MUST NOT directly introduce `setTimeout`,
   `setInterval`, `Date.now`, `new AbortController`, process event plumbing, or
   Node callback orchestration. Use Effect time/concurrency or the owning
   platform adapter.
8. Fibers MUST NOT become durable state. Scheduler events, SQLite transactions,
   owner epochs, fencing, and projections remain the source of truth.
9. `Effect.retry` MUST NOT implement workflow retry. Workflow retry remains a
   scheduler/domain operation with durable attempt identity and events.
10. The migration MUST preserve event schemas, persisted data contracts,
    fencing semantics, transaction boundaries, replay semantics, and observable
    workflow behavior unless a separate approved task explicitly changes them.

## Before editing a task

An execution agent should perform the following analysis before changing code.
It should not immediately translate syntax.

### 1. Classify the file

Choose one dominant category:

- **Pure domain**: reducers, transitions, parsing, planning, materialization,
  immutable data transformations.
- **Application/runtime**: orchestration of store, sessions, agents, attempts,
  daemon work, hooks, controls, or runtime behavior.
- **Service boundary**: an Acpus capability consumed by application code.
- **Platform/SDK adapter**: Node, SQLite, ACP SDK, child process, filesystem,
  socket, callback, or Promise integration.
- **Composition root**: executable startup and Layer wiring.
- **Public authoring surface**: workflow DSL or API where exposing Effect would
  reduce usability without improving correctness.

If a file mixes several categories, prefer separating the concerns before or
while migrating it rather than reproducing the mixture in Effect syntax.

### 2. Identify semantic invariants

Write down what must not change. Examples:

- Which durable event is appended before/after an external action?
- Where does a SQLite transaction begin and commit?
- Which owner epoch/fencing check makes an operation legal?
- What exactly counts as a workflow cancellation versus a process
  interruption?
- Which process must receive SIGTERM and when may SIGKILL follow?
- Which error is observable at the public boundary?
- Which ordering guarantees exist between queue entries, session updates, or
  scheduler wakeups?

Tests should protect these invariants; Effect implementation details should not
become the oracle.

### 3. Draw ownership before choosing primitives

For every resource or concurrent task, identify its owner:

```text
workspace -> scheduler -> run -> attempt -> executor/process
workspace -> agent supervisor -> ACP session -> terminal/process
workspace -> hooks -> hook process
```

Only after ownership is clear choose `Scope`, `Fiber`, `Queue`, `Deferred`,
`Ref`, `Semaphore`, `PubSub`, or another primitive.

Shared mutable state that can be eliminated by single-owner structured
concurrency SHOULD be eliminated rather than moved into a `Ref`.

## Choosing Effect primitives

### Effect

Use for effectful operations with typed expected failure and explicit service
requirements.

Do not encode an intentional domain result as an Effect failure solely because
it contains words such as `cancelled`, `timed_out`, or `rejected`.

### Either / Option / plain ADTs

Use in pure code where a computation branches without performing effects.
Prefer a small discriminated union when its domain vocabulary is clearer than
an imported generic type.

Do not create `Effect<Either<A, E>, E2, R>` when the inner Either merely repeats
the Effect error channel.

### Scope

Use for every resource with acquire/use/release lifetime. A resource obtained in
one Scope must not silently escape to a longer-lived owner.

Prefer scoped construction and finalizers over exposing `.close()` as the
primary lifecycle discipline. Explicit close operations may remain where they
are meaningful public operations, but they should close an owned Scope rather
than duplicate cleanup state machines.

### Fiber

Use for concurrent Effect execution. A Fiber must have a clear parent/Scope or
be explicitly joined/supervised.

Treat `forkDaemon` and equivalent detached execution as prohibited by default.
A task requiring process-lifetime background work must document why ordinary
Scope ownership is insufficient.

### Deferred

Use for one-shot completion or wakeup coordination.

Do not use Deferred as a durable signal and do not create a new Deferred for a
multi-message channel that is semantically a Queue.

### Queue

Use for producer/consumer work where each item has consumption semantics, for
example serialized mutation execution.

Prefer a single owning consumer Fiber when that removes shared mutation.

### PubSub

Use only when multiple subscribers should independently observe the same
process-local event. It is not a durable event log.

### Ref

Use for genuinely shared, process-local mutable state requiring atomic Effect
updates. First ask whether the state can instead be owned by one Fiber.

### Semaphore

Use for bounded process-local concurrency or scarce in-memory/platform
capacity. It does not replace durable scheduler admission or persisted
concurrency semantics.

### Clock / Schedule

Use for application-level time, sleeps, timeouts, polling, and repeating work.
Tests must be able to control time where behavior depends on it.

Schedules may retry transient infrastructure failures. They do not represent
workflow retry policy.

## Error modeling

Every failure encountered during migration must be classified before it is
modeled.

### Domain outcome

Return as a value. Examples include scheduler or turn outcomes whose status is
part of normal durable workflow semantics.

### Expected effectful failure

Use the Effect error channel. Build a useful taxonomy around consumer action,
not around every branch in the implementation.

Good categories are boundaries such as:

- store unavailable/busy/corrupt;
- process spawn/termination failure;
- ACP protocol/transport failure;
- invalid external configuration/input;
- ownership/lease operation rejected when the caller can recover.

Avoid creating one tagged error class per `if` statement. Prefer a small tagged
error with a reason ADT when the recovery behavior is shared.

### Interruption

Use Fiber interruption for process-local cancellation and shutdown. Do not
translate every interruption into an ordinary typed error.

When interruption must produce a durable cancellation event, the owning
application logic is responsible for the durable transition; Fiber
interruption alone does not prove the transition committed.

### Defect

Impossible internal states, violated invariants, and programmer errors remain
defects. Do not turn defects into broad `UnknownError` values merely to make an
Effect type look total.

### Cause handling

`catchAllCause`, `sandbox`, `orDie`, `ignore`, and broad Cause transformations
are review-sensitive operations. Use the narrowest typed error handler
possible.

Never use `catchAllCause(() => Effect.void)` as the Effect spelling of
`catch {}`. If an operation is intentionally best-effort, handle the expected
error explicitly and log/record the failure when appropriate.

## Boundary adapter rules

A platform adapter owns translation from external mechanics into Effect.

Examples:

```text
Promise API          -> Effect.tryPromise
callback API         -> Effect.async
AbortSignal input    -> interruption bridge
Fiber interruption   -> AbortController for an SDK that requires it
child_process events -> Effect-native process handle capability
SQLite sync calls    -> scoped/effectful RuntimeStore adapter
```

Keep the adapter small. Do not place application state transitions inside the
same `tryPromise`/`async` registration that adapts the external API.

If an external API is synchronous and blocking, wrapping it in `Effect.sync`
does not make it asynchronous. Preserve this fact in design and performance
reasoning.

## Layer and service rules

Define services around Acpus capabilities, not libraries or individual helper
functions.

Good examples:

- RuntimeStore
- AgentExecutor
- AcpSessionManager
- ProcessService
- HookRunner

Bad examples without a strong second use case:

- DateService
- JsonService
- StringService
- SqlStatementService
- FileReaderService + FileWriterService split only for abstraction purity

Layers are for construction, dependency wiring, resource acquisition, and
release. Prefer composition at program/workspace roots.

Avoid deep `Effect.provide(...)` calls that build local mini dependency graphs.
A leaf operation should generally request its capability and let the
composition root provide it.

## Durable scheduler rules

When migrating scheduler execution code, maintain this data flow:

```text
durable store/projection
        -> plan executable work
        -> run process-local Effect/Fiber
        -> produce execution outcome
        -> derive scheduler event(s)
        -> append transactionally with fencing
        -> new durable projection
```

Never invert it so a Fiber registry becomes authoritative.

A workflow retry always creates/uses the scheduler's existing durable retry
semantics. Effect-level retry is restricted to infrastructure operations where
re-execution does not invent a new workflow attempt.

## Process and session lifecycle rules

Process/session migration must preserve platform policies while replacing
manual lifetime plumbing.

For subprocesses:

- acquisition must establish the process/ownership state required by the
  current contract;
- interruption and Scope close must trigger the appropriate cooperative
  shutdown policy;
- grace periods use Effect Clock;
- forced termination remains explicit policy;
- event listeners and handles must be released by finalization;
- cleanup failure must not silently erase the primary failure.

For ACP sessions and reverse RPC:

- session Scope owns the child process, connection, pending requests, and
  terminal resources;
- terminal resources have a narrower lifetime than the session;
- external AbortSignals are bridged at the adapter edge;
- session shutdown must settle or interrupt process-local waiters without
  inventing durable outcomes that were never committed.

## Testing rules during migration

Read `docs/testing-maintenance.md` before modifying tests.

Preserve semantic tests and replace implementation-specific timing/plumbing
assertions only when the implementation boundary truly changes.

For migrated runtime behavior:

- use controllable Effect time instead of real sleeps where practical;
- test interruption at acquisition, active use, durable commit boundaries, and
  finalization when those races matter;
- test Scope closure releases resources;
- test queue ordering and concurrency limits semantically;
- retain store fencing/idempotency/replay/WAL tests unchanged where possible;
- never make Fiber IDs, Layer structure, or implementation traces product
  oracles.

Do not add migration/compatibility tests for abstractions that should disappear.
The repository is greenfield.

## Agent task protocol

Each migration task should be executed as a closed unit.

### Input expected by the agent

- exact files/modules in scope;
- owning migration pass/work package;
- semantic invariants to preserve;
- dependencies that are already Effect-native;
- tests/checks expected to prove completion.

If neighboring code must change to remove a temporary adapter or complete the
abstraction boundary, include that change rather than leaving a known hybrid
state solely to minimize the diff.

### Required workflow

1. Read ADR-0001 and this manual.
2. Read applicable repository maintenance guides.
3. Inspect the current implementation and relevant tests.
4. State the ownership/lifetime model before editing concurrency code.
5. Classify current failures into outcome/error/interruption/defect.
6. Implement the smallest complete Effect-native boundary.
7. Delete superseded neverthrow/Promise/lifecycle helpers in the same task when
   they no longer have callers.
8. Run narrow tests while iterating.
9. Run the work-package verification commands.
10. Search the changed scope for prohibited legacy/bad-taste patterns.
11. Report invariants preserved, checks run, and any intentionally deferred
    work that belongs to a later named work package.

### Do not leave tactical TODOs

Do not leave comments such as:

- "convert this to Effect later";
- "temporary ResultAsync adapter";
- "cleanup once migration finishes";
- "keep both paths for now".

If a work package cannot be complete without a later dependency, the migration
plan must name that dependency explicitly. Do not create hidden compatibility
debt in code.

## Completion criteria for an individual module

A migrated module is complete when:

- its effectful internals use Effect rather than ResultAsync/Promise
  orchestration;
- pure internals remain ordinary pure code;
- lifetime resources are Scope-owned;
- expected failures are typed at the meaningful boundary;
- cancellation uses interruption internally and bridges AbortSignal only at an
  adapter edge;
- time-dependent application logic uses Effect time abstractions;
- no detached process-local work can outlive its owner;
- durable scheduler semantics are unchanged unless explicitly in scope;
- obsolete helpers and dependencies are deleted;
- tests prove behavior rather than Effect implementation details;
- the quality gates in `review-and-quality-gates.md` pass for the changed
  scope.
