# Effect Migration Work Packages

This directory contains the concrete execution packets compiled by the Master
from the migration roadmap and fact registries.

## Status authority

For **implementation readiness**, this index plus the individual work-package
packet is authoritative. The roadmap remains the dependency/progress overview
and may lag by one coordination commit while a packet is being compiled.

A worker may start only when:

1. the package appears here as `ready`;
2. its packet says `Status: ready`;
3. every prerequisite package listed here is `done` (or there are none);
4. the worker uses the exact baseline commit/release facts in the packet.

A roadmap item without a `ready` packet is not executable.

## Active status

| Work package | Status | Prerequisites | Packet |
| --- | --- | --- | --- |
| A01 — Effect v4 RC baseline and migration guardrails | **ready** | none | `A01.md` |
| A02 — Pure Result removal | planned | A01 done | not compiled |
| A03 — Runtime error/API vocabulary | planned | A01 done | not compiled |
| A04 — ACP/agent error/API vocabulary | planned | A01 done | not compiled |
| A05 — Peripheral Result removal | planned | A01 done plus relevant shared contracts | not compiled |
| B01+ | planned | see roadmap | not compiled |

## A01 frozen baseline

```text
effect            4.0.0-rc.111
@effect/vitest    4.0.0-rc.111
Effect upstream   648f566dd259898e7697c7fcb796183ccbc474ab
```

A01 is the only package currently authorized for worker implementation.

## Master transition rules

- `planned -> ready`: Master freezes and commits a complete packet.
- `ready -> active`: one worker accepts ownership; record the worker/branch in
  the orchestration record if one is maintained.
- `active -> review`: worker returns the required evidence and stops editing.
- `review -> done`: Master validates architecture/quality gates and accepts the
  package.
- Master may return `review -> active` with a bounded correction list.
- A worker never marks its own package `done`.

When A01 reaches `done`, Master compiles A02/A03/A04 packets before allowing the
first migration fan-out.