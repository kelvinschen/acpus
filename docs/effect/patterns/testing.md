# Effect Testing

- Status: approved
- Effect version: `4.0.0-rc.111`
- Sources: `@effect/vitest/src/index.ts`, `@effect/vitest/src/internal/*`

Use this pattern only when the test subject is an Effect program, service,
resource, clock, or concurrency contract. Test value and layer selection remain
governed by [Testing Maintenance](../../testing-maintenance.md).

## Runner and ownership

Return one composed Effect from `it.effect`. It supplies a per-test Scope,
`TestClock`, `TestConsole`, and interruption tied to the Vitest signal. The
pinned API has no separate `it.scoped`; use nested `Effect.scoped` only when the
test must observe cleanup before it finishes.

Use `layer(TestLayer)` only when a block intentionally shares an expensive
fixture. Its Scope spans the block, so mutable state is shared. Prefer a fresh
Layer per test when isolation matters.

Keep ordinary Vitest for pure rules and for Promise, callback, subprocess, or
wire adapters when that adapter is the observable boundary. Do not convert a
test merely to increase `it.effect` usage.

## Time and concurrency

Fork time-dependent work before advancing `TestClock`. Use `adjust` for elapsed
sleep behavior and `setTime` for wall-clock deadlines. Coordinate concurrent
states with Deferred, Latch, Queue, or a controlled service rather than a short
sleep.

Use `it.live` only when live Clock/runtime behavior is itself part of the
contract. Retain a small subprocess test for actual signal, process-tree, or
wire risk.

## Oracles

Assert typed failures, durable state, emitted protocol values, ordering, and
cleanup evidence. Do not assert Fiber ids, Layer graph shape, internal Queue or
Ref state, source representation, or mock calls without an observable outcome.
