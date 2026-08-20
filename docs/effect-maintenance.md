# Effect Maintenance Guide

This is the lasting engineering authority for Effect usage in Acpus. Read it
before changing Effect-based runtime/application code, service Layers,
concurrency, cancellation, time, or scoped resources.

The architectural decisions are recorded in
`architecture/ADR-0001-effect-runtime-foundation.md` and
`architecture/ADR-0002-effect-v4-runtime-baseline.md`. Active migration agents
also read `effect-migration/INDEX.md`.

## Effect version baseline

Acpus targets **Effect v4**. During the migration, the exact release-candidate
pinning/API rules live in `effect-migration/v4-rc-baseline.md`.

Use native v4 APIs and semantics. Do not preserve or re-create Effect v3 API
shapes through local wrappers. In particular, verify central service,
Cause/error, Fiber/forking, Scope, Layer, runtime, and package/import decisions
against the installed v4 types and official v4 documentation rather than v3
examples or memory.

`effect/unstable/*` modules are not default dependencies. Their use requires an
explicit architectural/work-package reason; Effect Workflow and Effect SQL do
not become Acpus's durable workflow/persistence engines merely because the
repository targets v4.

## Scope boundary

Use Effect for effectful application/runtime concerns:

- external I/O and expected effectful failure;
- service requirements and construction;
- process-local concurrency;
- interruption/cancellation;
- resource lifetime;
- time, schedules, and deterministic timeout behavior;
- structured runtime observability.

Do not use Effect merely because a function can fail. Pure reducers, planners,
parsers, materializers, and domain transformations stay ordinary pure code and
may use direct values, discriminated unions, `Either`, or `Option` where useful.

Effect primitives never replace Acpus durable scheduler semantics. Persisted
events/store/projections/fencing/replay are authoritative after process exit.

## Failure model

- Normal domain outcomes are values.
- Expected effectful failures use `Effect<A, E, R>`'s typed `E` channel.
- Process-local cancellation/shutdown uses Fiber interruption.
- Internal invariant/programmer failures remain defects.

Do not create nested Result/Either values solely to duplicate the Effect error
channel. Do not collapse defects, interruption, and unrelated recoverable
failures into a generic unknown error just to simplify a type.

Prefer a small error taxonomy organized by caller recovery. A reason ADT inside
one boundary error is often better than one class per implementation branch.

Use the narrowest error handler possible. Broad Cause operations and defect
conversion require a concrete reason and must not silently discard
interruption or finalizer failures. Because Cause/error APIs changed in v4,
always verify the exact pinned-v4 operation rather than copying v3 handler
names.

## Resource ownership

Every long-lived resource has a Scope owner. Resource construction and
finalization belong together.

Prefer scoped APIs and structured child Fibers over manual `.close()` state,
Promise registries, listener registries, and detached work. Public close/stop
operations may exist when they are meaningful operations, but they should
terminate the owned Scope/resource tree rather than duplicate finalization.

A Fiber/resource that escapes its Scope requires an explicit longer-lived owner.
Detached Fibers are exceptional, not a convenience mechanism. Forking and
keep-alive behavior are version-sensitive in Effect v4; use the pinned v4 API
and prove the ownership semantics instead of relying on v3 assumptions.

## Concurrency primitives

Choose primitives by semantics:

| Need | Primitive |
| --- | --- |
| one concurrent computation | Fiber |
| lifetime/ownership | Scope |
| one-shot completion | Deferred |
| producer/consumer channel | Queue |
| process-local one-to-many broadcast | PubSub |
| atomic shared state | Ref |
| bounded process-local capacity | Semaphore |
| time/repetition/retry schedule | Clock / Schedule |

Prefer private state owned by one Fiber over turning every mutable collection
into a shared Ref.

Queue, Deferred, Ref, PubSub, Semaphore, and Fiber are process-local. They are
not durable signals, retry records, ownership epochs, or workflow state.

## Cancellation and external AbortSignal

Fiber interruption is the application-level cancellation mechanism.

`AbortController`/`AbortSignal` are allowed at adapters for Node/SDK APIs that
require them. Centralize bridges so application code does not manually create
controllers and listeners.

If interruption corresponds to a durable scheduler cancellation, explicitly
commit the durable transition according to scheduler semantics. Interruption by
itself is not evidence that durable cancellation succeeded.

## Time and retry

Use Effect Clock/Schedule for application/runtime sleeps, timeouts, polling, and
repeating work. Tests should control time when the behavior is time-dependent.

Process termination policies such as graceful signal then forced kill remain
explicit Acpus policies implemented with Effect time/resource primitives.

Effect retry is for safe transient infrastructure repetition. It must not
implement workflow retry, create hidden workflow attempts, or cross durable
commit boundaries unsafely.

## Services and Layers

Services represent Acpus capabilities, not abstraction for abstraction's sake.
Examples include RuntimeStore, AgentExecutor, AcpSessionManager, and an owned
process capability.

Define and consume services with native Effect v4 service APIs. Do not introduce
v3-shaped `Context.Tag` compatibility helpers or local aliases whose only
purpose is to make v4 resemble old examples.

Avoid tiny services that merely wrap deterministic stdlib helpers unless a
real capability/ownership/testing boundary exists.

Layers assemble implementations, dependencies, and scoped resources. Provide
Layer graphs at composition roots. Deep application functions request services;
they should not construct and provide mini Layer graphs repeatedly.

Keep application-facing services narrower than third-party SDKs and storage
engines. Expose the operations Acpus owns, not every primitive of the external
library.

## Adapter leaves

Promise/callback adaptation APIs are boundary tools. Keep them at small
platform/SDK leaves and use the exact pinned v4 forms.

Do not wrap an entire application workflow in a Promise adapter when its
internal steps can compose as Effects. Do not invoke Effect runtime execution
APIs inside Effect code to escape structured concurrency; running the runtime
belongs at entry points or explicit plain-JavaScript boundaries.

Wrapping synchronous blocking work in `Effect.sync` changes error/lifetime
composition, not event-loop blocking characteristics.

## Pure domain core

Pure deterministic code should be replayable/testable without constructing an
Effect environment.

Do not make scheduler reducers, durable event application, retry planning, or
canonical IR transformations Effectful unless they acquire a genuine external
capability. This keeps durable semantics visibly separate from execution
mechanics.

## Observability

Use Effect's structured logging/tracing/metrics capabilities at meaningful
operation boundaries. Prefer annotations such as workspace, run, node,
attempt, owner epoch, session, and process identity when available.

Observability failures that are intentionally non-authoritative must still be
handled explicitly; do not hide arbitrary Cause values.

If an observability capability lives under a v4 unstable module for the pinned
release, its use follows ADR-0002 rather than being adopted automatically.

## Testing

Follow `testing-maintenance.md`.

Test semantic ownership and failure behavior, not internal Effect structure.
Useful runtime risks include:

- resource release on success/failure/interruption;
- interruption races around acquisition and durable commit;
- finalizer failure together with a primary failure;
- deterministic timeout/grace periods;
- queue ordering/concurrency limits;
- owner/fencing rejection of stale work;
- shutdown leaves no owned background work.

Do not assert Fiber IDs, exact Layer graphs, or internal Queue/Ref state unless
that internal structure itself owns a stable production rule.

## Code-review smells

Treat these as review triggers in runtime/application code:

- large Promise-adapter blocks around application workflows;
- Effect runtime execution below an entry point;
- detached/process-lifetime Fiber APIs without process-scope justification;
- broad Cause handlers or defect conversion that erase information;
- deep repeated dependency provisioning;
- `Ref<Map<...>>` used instead of clear single-owner state;
- manual Promise/timer/AbortController lifecycle next to Effect equivalents;
- Effect primitives treated as durable workflow state;
- Effect retry around workflow node execution;
- Layers/services with one trivial caller and no capability boundary;
- v3 compatibility aliases/helpers in v4 code;
- unapproved `effect/unstable/*` imports.

The desired result is not the most Effect code. It is the smallest complete
architecture in which each concern has one authoritative abstraction, expressed
with native Effect v4 where Effect owns the concern.
