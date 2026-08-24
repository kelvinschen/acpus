# ADR-0002: Effect v4 as the Runtime Technology Baseline

- Status: Accepted
- Date: 2026-08-20
- Implementation status: Complete (2026-08-22)
- Baseline commit: `9b82a57aa761fed16f3edf0d35a2481e8ebd3b0b`
- Depends on: [ADR-0001](0001-effect-runtime-foundation.md)
- Decision owners: Acpus maintainers

## Context

[ADR-0001](0001-effect-runtime-foundation.md) establishes Effect as the
foundation for Acpus effectful application/runtime code while preserving
Acpus-owned durable scheduler, persistence, fencing, retry, replay, and
workflow semantics.

The remaining version choice materially affects the implementation vocabulary.
Effect v4 is not a source-compatible repackaging of v3: it changes package
organization and several core APIs/semantics around services, Cause/error
handling, Fiber forking, Scope, Layer provisioning, runtime execution, and
other areas that the Acpus runtime uses deeply.

Effect v4 has entered its release-candidate publication line. Because this
branch is intentionally treated as greenfield and the adoption was completed
coherently rather than maintained as a long-lived dual stack, implementing the
new architecture on v3 and then performing a second structural migration to v4
would have added substantial work with little architectural value.

## Decision

Acpus adopts **Effect v4** as its target Effect generation. The repository-wide
adoption was implemented directly against the **Effect v4 RC** release line.

Effect v3 is not an intermediate implementation target and no v3 compatibility
layer will be maintained.

During the RC period, maintainers select an exact compatible RC release train
and pin it. The exact transient RC patch is an execution
configuration, not a permanent architectural contract; the lasting contract is
that Acpus targets Effect v4.

## Version discipline

While Acpus remains on a v4 release candidate:

- Effect dependencies use `4.0.0-rc.*` releases selected explicitly;
- Effect v3, v4 beta, and snapshot builds are not mixed into the runtime;
- semver ranges must not silently advance the pinned RC;
- ecosystem packages published as one v4 release train remain version-coherent;
- changing the pinned RC is a deliberate coordinating change followed by
  typecheck, tests and review before dependent development resumes.

After Effect v4 reaches stable GA, moving from the selected RC to stable v4 is
a dependency stabilization task unless a concrete upstream breaking change
requires a new architectural decision.

## Native v4 model

Implementation uses native v4 APIs and semantics. Agents must not recreate v3
surface area through local wrappers.

Particular review attention applies to areas changed between generations,
including:

- service definition/dependency access;
- Cause representation and inspection;
- typed error-handler APIs;
- Fiber forking/supervision and process keep-alive behavior;
- Scope/resource APIs;
- Layer provisioning/memoization;
- runtime entry APIs;
- package consolidation and import locations;
- Schema APIs when Schema is separately in scope.

The exact pinned v4 type declarations are the implementation authority. Official
v4 documentation/source corresponding to the selected line is the primary
external reference. v3 documentation is used only to identify what must be
translated, never as target syntax.

## Unstable modules

Effect v4 distinguishes unstable subsystems under `effect/unstable/*`.
Selecting v4 RC does not imply blanket adoption of those subsystems.

The default architecture uses stable/core v4 capabilities required by
ADR-0001. An unstable module requires an explicit architectural decision
that explains:

- why the stable/core surface is insufficient;
- what complexity it removes;
- which upgrade risk is accepted;
- how Acpus durable semantics remain unchanged.

In particular, this decision does not authorize replacing the Acpus durable
scheduler with Effect Workflow or replacing the current SQLite persistence
model with Effect SQL. Those remain separate architectural decisions.

## Implementation verification rule

Every substantial Effect API or dependency change must identify:

```text
Pinned Effect v4 RC version(s)
Official/pinned API surface consulted
Unstable modules used (normally none)
Any v3 pattern translated to its native v4 equivalent
Version-specific verification performed
```

A change is rejected if it obtains passing types by emulating obsolete v3 APIs,
mixing Effect generations, or hiding an unstable dependency without the
required decision record.

## Consequences

### Positive

- Acpus pays the structural migration cost once rather than v3 migration plus a
  second v4 migration.
- New service/resource/concurrency architecture is designed directly around the
  generation expected to carry forward.
- AI agents operate against one target vocabulary rather than maintaining
  temporary cross-generation abstractions.
- v4 package consolidation can reduce dependency and adapter duplication from
  the beginning.

### Costs

- RC updates can still contain API changes and therefore require controlled
  pinning and explicit upgrades.
- Examples and prior Effect knowledge are frequently v3-oriented and cannot be
  trusted without verification.
- Some attractive v4 subsystems remain explicitly unstable and require
  stronger adoption discipline.
- Review must distinguish native v4 design from merely coerced or aliased v3
  patterns.

## Rejected alternatives

### Implement on Effect v3 stable, migrate to v4 later

Rejected. It introduces a planned second migration across precisely the service,
resource, error, Fiber, and runtime boundaries being redesigned now. The
short-lived compatibility benefit is not justified on this greenfield branch.

### Follow the latest RC automatically

Rejected. Reproducible agent work requires a frozen API surface. RC advancement
is coordinated explicitly rather than happening through package-range drift.

### Adopt all v4 unstable modules because v4 is RC

Rejected. Release-candidate status of the overall package does not erase the
separate stability contract of `effect/unstable/*` modules.

### Freeze permanently on the first selected RC

Rejected. The exact RC patch is operational, not architectural. Controlled RC
upgrades and eventual v4 GA adoption are expected.

## Governance

[Effect Maintenance](../effect-maintenance.md) contains the lasting API and
dependency maintenance rules. [ADR-0001](0001-effect-runtime-foundation.md)
remains authoritative for where Effect belongs and where it does not.

A future decision to move Acpus back to Effect v3, maintain two Effect
major-version models, or make an unstable Effect subsystem authoritative for
Acpus durable workflow semantics requires a new ADR that explicitly supersedes
this one and/or ADR-0001.
