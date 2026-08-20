# Effect Migration Work-Package Template

Use this template when the coordinating/master agent delegates a migration
unit. A work package is a contract, not a suggestion. The implementation agent
must not broaden architecture decisions that the package has already frozen.

---

# WP-<id>: <boundary name>

## Objective

One paragraph describing the final Effect-native boundary this package must
leave behind. Describe the capability/ownership result, not syntax changes.

## Pass

One of:

- Pass A: vocabulary convergence
- Pass B: platform and service boundaries
- Pass C: lifecycle kernel
- Pass D: scheduler execution runtime
- Pass E: surface cleanup and repository convergence

## Files/modules in scope

List exact primary modules and any tests/configuration/manifests expected to
change.

## Explicitly out of scope

List adjacent concerns that must not be redesigned by this package. Typical
examples:

- durable scheduler reducer semantics;
- persisted event/schema changes;
- SQLite schema changes;
- unrelated public API redesign;
- Effect SQL/Workflow adoption;
- broader Schema-library migration.

## Target contract frozen by master

State the intended interface/error/lifetime form that downstream work may rely
on.

Example dimensions:

```text
Service/API:
Success type:
Expected error union:
Requirements R:
Scoped or unscoped:
Public boundary form, if any:
```

Do not leave interface design open when multiple parallel packages depend on
it.

## Current legacy abstractions to remove

Enumerate only concrete migration debt in scope, for example:

```text
ResultAsync
neverthrow Result
manual Promise deferred
AbortController owned by application code
setTimeout/setInterval
closePromise
Set<Promise>
Promise.race/allSettled lifecycle
manual event-listener registry
```

The implementing agent should delete these when their final callers disappear.

## Ownership/lifetime model

State the desired tree before implementation.

Example:

```text
Workspace Scope
  Session Scope
    ACP child process
    connection
    active-turn Fiber
    terminal child Scopes
```

For every long-lived Fiber/resource identify:

- owner Scope;
- acquisition point;
- normal completion;
- interruption behavior;
- finalizer;
- whether any handle is allowed to escape and why.

## Durable invariants

List the exact persisted/domain semantics that must remain unchanged.

Examples:

- event append ordering;
- transaction commit boundary;
- owner epoch/fencing check;
- attempt identity;
- idempotency key behavior;
- replay result;
- terminal process-group policy;
- session ownership manifest semantics.

If the package has no durable semantics, say so explicitly.

## Failure classification

Classify meaningful failure cases before coding.

| Case | Classification | Target representation |
| --- | --- | --- |
| ... | domain outcome / expected error / interruption / defect | ... |

The agent must not invent a broad `UnknownError` to avoid this classification.

## Concurrency primitives selected

Name only primitives justified by semantics, for example:

```text
Scope: resource lifetime
Deferred: one-shot wakeup
Queue: serialized mutations
Semaphore: max process-local concurrency
Fiber: active execution
Clock: timeout/grace period
```

If a Ref is proposed, explain why single-owner state is insufficient.

## External adapter boundaries

List Promise/callback/AbortSignal/Node/SDK edges where `tryPromise`, `async`, or
other bridging is acceptable.

Any `tryPromise` outside these named leaves requires master review.

## Required implementation behavior

List concrete behavior required from the final implementation. Avoid line-level
instructions unless the detail is itself architectural.

## Required deletion

List obsolete files/helpers/types/dependencies that must be deleted in this
work package if no caller remains.

This section prevents an Agent from adding Effect beside the legacy mechanism
and calling the task complete.

## Tests/evidence to preserve

List existing tests that should stay semantically authoritative and new risks
that need evidence.

Prefer references such as:

```text
existing scheduler fencing integration tests
existing process lifecycle integration tests
new interruption-during-acquire regression test
new TestClock timeout unit test
```

Do not require tests of Fiber IDs, Queue sizes, Layer shape, or source syntax.

## Verification commands

Start with narrow commands. Include broader checks required for acceptance.

Example:

```text
pnpm vitest run <specific tests/project>
pnpm --filter <package> typecheck
pnpm test
pnpm typecheck
```

Use actual repository commands rather than invented wrappers.

## Bad-taste searches for this package

List expected-zero patterns in the changed scope, for example:

```text
neverthrow
ResultAsync
new Promise
new AbortController
setTimeout
Effect.runPromise
Effect.forkDaemon
```

Also list review-only patterns such as `tryPromise` and `catchAllCause`.

## Dependencies on other work packages

```text
Requires before start:
Can run in parallel with:
Blocks:
```

Do not solve an unmet dependency with a temporary compatibility shim unless the
master explicitly revises the package contract.

## Acceptance report required from implementing agent

The final handoff must contain:

```text
Boundary migrated:
Pure/effectful split:
Ownership tree implemented:
Expected errors implemented:
Interruption path implemented:
Adapter leaves used:
Durable invariants preserved:
Legacy abstractions deleted:
Tests/checks run:
Bad-taste search result:
Remaining named downstream package dependencies:
```

## Master review decision

After implementation, record:

```text
Accepted / Rework required
Reason:
Any architecture exception approved:
Follow-up work-package changes:
```

---

## Sizing guidance

A work package is correctly sized when one Agent can leave its boundary in the
final architecture without adding a temporary dual path.

Split a package when two parts have independent ownership and stable interfaces.
Merge packages when separating them would require compatibility adapters,
duplicate lifecycle state, or simultaneous redesign of the same service.

Prefer work packages named after boundaries such as `ACP session lifecycle` or
`scheduler active execution ownership`, not mechanical tasks such as `replace
Promise.all` or `convert five files to Effect`.
