# Effect Migration Guide Index

This directory contains the active execution guidance for the repository-wide
Effect migration accepted by ADR-0001 and ADR-0002.

## Required reading order

Every agent implementing migration work reads, in order:

1. `../architecture/ADR-0001-effect-runtime-foundation.md`
2. `../architecture/ADR-0002-effect-v4-runtime-baseline.md`
3. `v4-rc-baseline.md`
4. `upstream-source-workflow.md`
5. `agent-execution-manual.md`
6. `migration-plan.md`
7. `review-and-quality-gates.md`
8. `work-packages/INDEX.md`
9. the concrete work package / Execution Packet issued by the coordinating Master
10. every repository maintenance guide required by `AGENTS.md` for the files
    being changed
11. once A01 has vendored Effect, `repos/effect/LLMS.md` before substantial
    Effect implementation work

## Document roles

| Document | Role |
| --- | --- |
| ADR-0001 | Lasting architectural decision: where Effect owns runtime concerns and where it does not. |
| ADR-0002 | Lasting version-generation decision: Acpus targets native Effect v4. |
| v4 RC baseline | Authoritative Effect v4 RC version/API policy while migration executes. |
| Upstream source workflow | How matching Effect source is vendored, explored, refreshed and used by agents. |
| v4 pattern catalog | Acpus-level canonical semantic shapes and bad-taste examples. |
| Agent pattern notes | Narrow Master-approved idioms distilled from the vendored Effect source. |
| Migration inventory | Machine-readable current hotspot census and target abstraction map. |
| Semantic invariants | Stable migration IDs for behavior that must survive the rewrite. |
| Target boundaries | Frozen dependency direction and forbidden cross-layer shortcuts. |
| Resource ownership | Scope/Fiber/resource lifetime registry. |
| Race catalog | Named concurrency races and required resolutions. |
| Test evidence map | Invariant/race-to-test routing for work-package evidence. |
| Deletion map | Which legacy abstractions must disappear with each work package. |
| Execution Packet template | Compiled Master-to-Agent implementation contract. |
| Work-package index | Authoritative implementation-readiness status for compiled packets. |
| Agent execution manual | Normative implementation behavior for AI agents. |
| Migration plan | Pass ordering, dependency strategy, and Definition of Done. |
| Review and quality gates | Acceptance criteria and bad-taste detection. |
| Roadmap status | Dependency/progress overview; concrete packet readiness is governed by the work-package index. |

## Core architecture sentence

Acpus keeps durable workflow meaning in its own events, store, projections,
fencing, replay, and retry model; Effect owns process-local effects,
dependencies, structured concurrency, interruption, resources, time, and
observability.

The implementation baseline is Effect v4 RC. API decisions follow the exact
pinned v4 RC types and the matching vendored upstream source; v3 compatibility
idioms are not migration targets.

## Upstream knowledge rule

After A01, the repository contains the Effect source at `repos/effect` pinned to
the same RC as the installed dependency. Execution agents use it as read-only
reference material.

Knowledge priority for central Effect choices:

```text
installed pinned types
  -> matching vendored source/tests
  -> repos/effect/LLMS.md + ai-docs
  -> official upstream documentation
  -> other sources only after verification
```

Never import application code from `repos/effect`, edit it during normal work,
or follow moving upstream `main` independently of the dependency pin.

For reusable/high-risk concepts, Master commissions a narrow note under
`agent-patterns/` so later agents consume one reviewed Acpus interpretation
rather than repeatedly exploring from scratch.

## Migration vocabulary

Use these terms consistently:

- **domain outcome**: an intentional Acpus value/status;
- **typed effect error**: an expected recoverable failure in Effect's `E`;
- **interruption**: process-local Fiber cancellation/shutdown;
- **defect**: invariant/programmer failure;
- **durable state**: state reconstructable from persisted Acpus data;
- **process-local state**: Fiber/Ref/Queue/Deferred/Scope state that disappears
  on process exit;
- **adapter leaf**: the smallest boundary translating Promise/callback/Node/SDK
  mechanics into Effect;
- **ownership tree**: the Scope/Fiber/resource lifetime relationship;
- **work package**: one closed migration unit with explicit scope, invariants,
  dependencies, checks, and cleanup requirements;
- **Execution Packet**: the Master-compiled task contract that turns a roadmap
  item into executable work;
- **pattern note**: a narrow Master-approved Acpus idiom distilled from the
  pinned vendored Effect source.

## Master compilation rule

A roadmap item is not executable by itself. Before marking one `ready`, Master
must combine current code inspection with:

- migration inventory;
- semantic invariants;
- target boundaries;
- resource ownership;
- race catalog;
- test evidence;
- deletion map;
- approved v4 pattern catalog / pattern notes;
- exact pinned Effect + vendored-source pair.

The result is one concrete Execution Packet. A worker may execute it only when
`work-packages/INDEX.md` and the packet both say `ready`. The worker never
promotes its own package to `done`; Master review owns that transition.

## Completion rule

Do not call the migration complete because Effect is present or because the
test suite passes. Completion means the old competing abstractions have been
removed and the repository satisfies the Definition of Done and final
architecture review in this guide set.
