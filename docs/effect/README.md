# Effect Patterns

[Effect Maintenance](../effect-maintenance.md) is the required development
guide. The notes below are optional references for Acpus-specific shapes that
are easy to implement incorrectly; they are not prerequisites for every Effect
change.

- [Durable Concurrency](patterns/durable-concurrency.md): versioned wakeups,
  serialized publication, deadlines, and the boundary between local and durable
  concurrency.
- [Fiber Ownership](patterns/fiber-ownership.md): dynamic child admission,
  shutdown fencing, and finalizer ordering.
- [Runtime Boundaries](patterns/runtime-boundaries.md): executable roots,
  Promise/AsyncIterable adapters, detached daemon spawn, and raw lock leaves.
- [Owned Process](patterns/owned-process.md): why `ProcessHost` is a distinct
  Scope-owned Acpus capability.
- [Testing](patterns/testing.md): `@effect/vitest`, Scope, Layer, and TestClock
  usage when the Effect runtime itself is part of the risk.

Pattern notes are subordinate to owning product specs, Effect Maintenance, and
the installed Effect version. Revalidate a note after a dependency update that
changes its referenced API or semantics. Add a new note only for a reused or
high-risk Acpus-specific pattern.
