# Effect Maintenance Guide

This is the required authority for Effect-based runtime and application code in
Acpus. Read it before changing services, Layers, concurrency, cancellation,
time, or scoped resources. The [Effect patterns](effect/README.md) are optional
implementation references; consult only the pattern relevant to the change.

## Architecture boundary

Use Effect for effectful application/runtime concerns:

- external I/O and expected effectful failure;
- capabilities and their construction;
- process-local concurrency, cancellation, time, and observability;
- resource ownership and finalization.

Keep pure reducers, planners, parsers, materializers, canonical data transforms,
and other deterministic domain logic as ordinary TypeScript. Use direct values,
discriminated unions, native v4 `Result`, or `Option` where useful.

Effect primitives never replace Acpus durable semantics. SQLite state, events,
projections, attempts, owner epochs, fencing, replay, and recovery remain
authoritative after process exit. In particular:

```text
Fiber != Run or Attempt
Fiber interruption != durable cancellation
Effect.retry != workflow retry
Deferred / Queue != durable signal
Effect success != durable commit
```

## Version, imports, and references

Acpus targets Effect v4 with exact dependency versions. The installed package
declarations, source, and lockfile are authoritative. Do not recreate v3 APIs
through wrappers or aliases.

Resolve API and semantic questions in this order:

1. exact versions in `package.json` and `pnpm-lock.yaml`;
2. declarations and source shipped in installed npm packages;
3. [official Effect documentation](https://effect.website/docs/);
4. the [official Effect repository](https://github.com/Effect-TS/effect) for a
   concrete implementation or upstream test.

Verify remote examples against the installed version. Do not vendor Effect
source, tests, generated documentation, repository metadata, or `ai-docs`.
Dependency upgrades update exact versions and the lockfile; they do not require
an upstream commit pin.

Import stable modules through public subpaths such as `effect/Effect` and
`effect/Result`, including in tests and type-only code. Do not add a local
Effect barrel or facade. With the pinned `effect@4.0.0-rc.111`, controlled
unit-suite measurements increased from about 6.9 seconds with subpaths to 9.3
seconds with the root barrel; remeasure this rule when Effect, Vitest, Node, or
test isolation changes.

`effect/unstable/*` is not a default dependency. Adoption requires a concrete
architectural reason and must not make Effect Workflow or Effect SQL the owner
of Acpus durable workflow or persistence semantics.

## Failures and cancellation

- Normal domain outcomes are values.
- Expected effectful failures use the typed `E` channel.
- Process-local cancellation and shutdown use Fiber interruption.
- Invariants and programmer errors remain defects.

Do not duplicate the error channel with `Effect<Result<...>>` unless the nested
Result is intentional domain data. Keep error taxonomies small and organized
by caller recovery. Use narrow error handlers; broad Cause handling or defect
conversion needs a specific reason and must preserve interruption and finalizer
failures.

Fiber interruption is the application cancellation mechanism.
`AbortController` and `AbortSignal` belong only at Node or SDK adapters that
require them; use `Effect.abortSignal` or one centralized incoming-signal
bridge. Durable cancellation still requires its explicit fenced scheduler
transition.

## Ownership, concurrency, and time

Every long-lived resource has one Scope owner. Put acquisition and finalization
together with `Effect.acquireRelease`, a scoped Layer, or another bracketed
operation. Multi-step acquisition must register ownership atomically and roll
back partial handles on failure. Never open a resource, return to an
interruptible region, and register its finalizer later.

Prefer structured child Fibers and scoped APIs over close flags, Promise
registries, listener registries, or detached work. A Fiber or resource may
escape only to an explicit longer-lived owner.

Choose process-local primitives by semantics:

| Need | Primitive |
| --- | --- |
| owned concurrent work | Fiber + Scope |
| one-shot completion or pulse | Deferred |
| consumed messages | Queue |
| broadcast | PubSub |
| atomic shared state | Ref |
| bounded local capacity | Semaphore |
| time and repetition | Clock / Schedule |

Prefer private state owned by one Fiber over shared `Ref<Map<...>>`. These
primitives are never durable workflow state.

Use Effect Clock/Schedule for application sleeps, timeouts, polling, and
repeating work. Tests control time when time is part of the contract. Process
termination policies such as `SIGTERM -> grace -> SIGKILL` remain explicit
Acpus policies implemented with Effect time and ownership.

Effect retry is only for safe transient infrastructure repetition. It must not
create workflow attempts or cross durable commit boundaries. Once an accepted
durable mutation enters publication, make the authoritative section
uninterruptible when interruption would create an unknown outcome.

## Services and Layers

Services represent meaningful Acpus capabilities, not every helper. Define and
consume them with native v4 service APIs. Keep application-facing shapes
narrower than the SDK or storage engine they adapt.

Layers assemble dependencies and scoped resources at composition roots. Deep
application functions request services; they do not repeatedly construct local
Layer graphs or hide undeclared requirements with `Effect.provide`.

Avoid one-use services for deterministic standard-library work, v3-shaped
`Context.Tag` compatibility helpers, and parallel Promise/Effect versions of
the same capability.

## Runtime and adapter boundaries

Promise and callback APIs enter Effect at the smallest platform/SDK leaf with
`Effect.tryPromise`, `Effect.promise`, `Effect.async`, or a scoped Stream
adapter. Application orchestration remains native Effect.

Runtime execution belongs only at an executable root or an explicit
plain-JavaScript/third-party adapter. Internal services must not call
`runPromise`, `runFork`, or `runSync` to escape structured concurrency.
Long-lived daemon and worker executables use `NodeRuntime.runMain`; the
interactive CLI uses one top-level `Effect.runPromise` so command-owned SIGINT
detach semantics remain authoritative.

An API that must return `AsyncIterable` first builds a typed-error `Stream` and
uses `Stream.toAsyncIterable` only at that JavaScript boundary. Iterator return
must close the adapter-owned Stream Scope.

Two deliberate platform exceptions remain narrow:

- detached daemon spawn uses native Node `detached` plus `unref` because the
  child must outlive the invoking CLI Scope;
- filesystem locks may use a small Promise polling driver below a scoped lock
  acquisition, but a successful raw handle must never cross an interruptible
  boundary before a finalizer owns it.

Wrapping synchronous blocking work in `Effect.sync` improves composition but
does not make it non-blocking.

## Observability

Use structured logging, tracing, or metrics at meaningful operation boundaries.
Annotate workspace, run, node, attempt, owner epoch, session, and process
identity when available. Non-authoritative observability failure must still be
handled explicitly.

## Testing

Follow [Testing Maintenance](testing-maintenance.md). Test semantic ownership
and failure behavior, not Effect representation. High-value risks include:

- release after success, failure, defect, and interruption;
- interruption around acquisition and durable commit;
- combined use and finalizer failure;
- deterministic timeout and grace periods;
- queue ordering, capacity, and admission fences;
- stale ownership/fencing rejection;
- shutdown leaving no owned fibers, listeners, sessions, processes, or writes.

Use `it.effect` for Effect programs, `TestClock` for Effect time, and controlled
coordination instead of sleeps. Keep ordinary Vitest for pure code and
Promise/subprocess tests when that adapter is the observable boundary. Do not
assert Fiber ids, exact Layer graphs, or internal Queue/Ref state.

## Review checklist

Reject changes that introduce:

- application-sized Promise adapters;
- Runtime execution below an approved boundary;
- detached work without a process-scope owner;
- manual Promise/timer/AbortController cleanup beside Effect ownership;
- late finalizer registration or ownership transfer flags;
- broad Cause handling that erases interruption or defects;
- workflow retry implemented with Effect retry;
- process-local primitives treated as durable state;
- speculative services, Layers, or v3 compatibility wrappers;
- unapproved `effect/unstable/*` imports.

The goal is not the most Effect code. It is the smallest architecture in which
each effectful concern has one authoritative owner.
