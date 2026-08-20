# Effect v4 RC Baseline

This document is the authoritative technology baseline for ADR-0001 migration
work. Every Effect migration agent reads it before implementing or reviewing
production changes.

## Decision

Acpus targets **Effect v4 RC**, not Effect v3.

The migration intentionally adopts the v4 programming model while v4 is on its
release-candidate line. The architectural boundaries in ADR-0001 remain the
same: Effect owns process-local effects, dependencies, structured concurrency,
interruption, resource ownership, time, and observability; Acpus continues to
own durable workflow state, scheduler events, persistence, fencing, replay, and
workflow retry semantics.

## Version policy

The coordinating/master agent selects one exact v4 RC release train in A01 and
pins it deliberately.

Rules:

- use `4.0.0-rc.*`, never Effect v3, beta, or snapshot builds;
- do not use semver ranges that allow an RC to move underneath an active work
  package;
- keep Effect ecosystem packages on the same compatible v4 RC release train
  where the v4 ecosystem publishes them together;
- upgrade the pinned RC only as an explicit repository-wide dependency change,
  with typecheck/tests and architecture review before downstream work resumes;
- record the selected exact versions in A01/work-package evidence rather than
  hard-coding a transient RC patch number into the lasting ADR.

This policy separates the lasting architecture decision (Effect v4) from the
short-lived release-candidate patch selected while the migration executes.

## API source of truth

Effect v4 is not treated as Effect v3 with a new version number. Agents MUST
resolve APIs from v4 sources in this priority order:

1. the exact pinned package type declarations installed in this repository;
2. official Effect v4 source/documentation corresponding to that RC line;
3. official Effect v3-to-v4 migration guides when translating a known v3
   pattern;
4. other examples only after verifying them against the pinned v4 types.

Do not copy a v3 blog post, remembered v3 API, generated answer, or old snippet
and assume it is valid because TypeScript can be coerced to compile.

When documentation and installed types disagree, the pinned package types are
the implementation authority for that work package; report the mismatch in the
work-package handoff if it changes an architectural choice.

## v4-specific migration awareness

Execution agents must account for v4 structural changes instead of mechanically
porting v3 idioms. In particular, verify the current v4 form of:

- service definition and dependency access (v4 service APIs rather than v3
  `Context.Tag`-centric templates);
- Cause representation and Cause inspection;
- error-handler names and semantics;
- Fiber forking/supervision APIs and keep-alive behavior;
- Scope APIs and scoped-resource construction;
- Layer provisioning and memoization behavior;
- runtime execution APIs (do not design around the removed v3 `Runtime<R>`
  model);
- Schema APIs if a separately approved work package touches Schema.

These items are API-shape warnings, not reasons to weaken ADR-0001. Ownership,
interruption, typed failure, and durable-state boundaries remain mandatory.

## Package consolidation

Effect v4 consolidates capabilities that were separate packages in v3. Do not
recreate the old package/service structure by habit.

Before adding an Effect ecosystem package:

1. verify whether the capability now lives in the core `effect` package;
2. verify whether a platform-specific/provider-specific package is actually
   required;
3. prefer the smallest supported v4 dependency surface;
4. keep package versions coherent with the selected RC train.

A package present in a v3 example is not evidence that Acpus should add it.

## `effect/unstable/*` policy

Effect v4 has explicit unstable module namespaces. RC status does **not** grant
automatic approval to adopt every unstable subsystem.

Default policy:

- core/stable v4 capabilities needed for ADR-0001 are allowed;
- `effect/unstable/*` imports require an explicit named work-package decision;
- Effect Workflow is not adopted as the Acpus durable workflow engine;
- Effect SQL is not introduced merely to wrap the current SQLite store;
- unstable process/RPC/Schema/etc. modules are evaluated only when they reduce
  total complexity at an already-approved platform boundary and do not alter
  durable semantics;
- a work package using an unstable module must record why the stable/core v4
  surface is insufficient and what upgrade risk is accepted.

Do not hide an unstable dependency deep in an adapter without documenting it.

## No v3 compatibility layer

The repository is greenfield for this migration. Do not add wrappers whose only
purpose is to preserve a v3 Effect API shape.

Examples of bad taste:

- defining local `Tag` helpers to make v4 look like old `Context.Tag` code;
- creating compatibility aliases for renamed v3 combinators;
- keeping v3 and v4 Effect packages/types side by side;
- copying a v3 runtime abstraction to emulate removed `Runtime<R>` behavior;
- introducing adapter utilities that exist only until a later v4 cleanup.

Use native v4 idioms directly and delete obsolete abstractions in the same work
package.

## Agent verification requirements

Every Effect implementation work package reports:

```text
Pinned Effect v4 RC version(s):
Official/pinned API surface consulted:
Any unstable modules used (normally none):
Any v3 pattern translated and its v4 replacement:
Version-specific checks run:
```

Review rejects a work package when:

- it introduces Effect v3, beta, or snapshot dependencies;
- Effect ecosystem RC versions are incoherent without a documented reason;
- v3-only API patterns are reimplemented locally instead of using v4 idioms;
- an unstable module appears without explicit work-package approval;
- the agent cannot identify the pinned v4 API used for a central service,
  Scope, Fiber, Cause, or runtime decision.

## Relationship to other migration documents

ADR-0001 owns lasting architectural boundaries. This file owns the v4 RC
technology baseline during migration. `migration-plan.md` owns ordering,
`agent-execution-manual.md` owns implementation behavior, and
`review-and-quality-gates.md` owns acceptance.

If a generic example in another migration document uses terminology inherited
from Effect v3, interpret the example semantically and implement it with the
pinned v4 RC API. Do not preserve obsolete API syntax for textual consistency.
