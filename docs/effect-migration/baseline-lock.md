# Effect Migration Baseline Lock

Status: **frozen for A01**

This file records the Master-selected Effect release baseline for the current
migration wave. It is an execution fact, not a lasting architecture decision.
ADR-0002 remains the authority for targeting Effect v4.

## Selected release train

```text
effect          4.0.0-rc.111
@effect/vitest  4.0.0-rc.111
```

Use exact versions. Do not use `^`, `~`, `rc`, `next`, `latest`, workspace
protocol indirection to a moving external version, or any range that can advance
without an explicit repository change.

The current Acpus test runner is Vitest 4.1.10, which satisfies the selected
`@effect/vitest` peer range (`>=4.1.0 <5.0.0`).

## Matching upstream source

The matching Effect upstream release/version commit is:

```text
repository: Effect-TS/effect
commit:     648f566dd259898e7697c7fcb796183ccbc474ab
message:    Version Packages (rc) (#7297)
```

At this commit:

- `packages/effect/package.json` is `4.0.0-rc.111`;
- `packages/vitest/package.json` is `4.0.0-rc.111`;
- root `LLMS.md` exists and documents the v4 coding-agent guidance;
- the source tree contains the v4 public APIs and ai-docs that workers must use
  as local reference after A01 vendors it.

A01 MUST vendor this exact commit under `repos/effect/` and MUST NOT vendor a
moving branch such as `main`.

## Dependency placement for A01

A01 establishes the repository-wide reference/test baseline only. It must not
preemptively add `effect` to every workspace package.

Required root dev dependencies:

```text
effect          4.0.0-rc.111
@effect/vitest  4.0.0-rc.111
```

Later work packages add `effect: 4.0.0-rc.111` to the specific package(s) that
ship Effect-based production code. Those additions must use this exact version
while this baseline lock is active.

Rationale: root installation gives all migration workers one installed type/API
truth and one Effect test integration baseline without creating unused runtime
dependencies in packages that have not yet migrated.

## Allowed upstream modules for A01

A01 may use/read only stable/core Effect and `@effect/vitest` surfaces required
to validate the baseline. No `effect/unstable/*` module is approved by A01.

In particular, A01 does not approve:

- `effect/unstable/process`;
- `effect/unstable/sql`;
- `effect/unstable/rpc`;
- `effect/unstable/workflow`;
- `effect/unstable/observability`;
- any other unstable namespace.

Approval, if ever granted, belongs to a named downstream work package.

## Pin coherence invariant

The following four values move together or not at all:

```text
root effect dependency version
root @effect/vitest dependency version
pnpm lockfile resolution
repos/effect vendored upstream commit
```

A mismatch is a baseline-coherence defect. Workers must stop and return it to
Master rather than silently choosing one source as authoritative.

## Upgrade protocol

While any downstream work package is active, do not change this baseline.

An RC upgrade requires a Master-coordinated change that:

1. selects the next exact RC;
2. resolves its matching Effect release/version commit;
3. updates root dependency pins and lockfile;
4. refreshes `repos/effect` to exactly that commit;
5. verifies `LLMS.md`, package versions and relevant v4 pattern notes;
6. runs repository typecheck/tests required by the baseline change;
7. updates this file and all active Execution Packets;
8. only then resumes worker fan-out.

## Source-of-truth order while this lock is active

1. installed `effect@4.0.0-rc.111` and `@effect/vitest@4.0.0-rc.111` declarations;
2. `repos/effect` at commit `648f566dd259898e7697c7fcb796183ccbc474ab`;
3. vendored `repos/effect/LLMS.md` and `ai-docs` at that commit;
4. official Effect upstream material corresponding to this RC line;
5. all other material only after verification against the above.

## Master release decision

This baseline is frozen for A01. The A01 worker does not choose a different RC,
substitute a newer release because it became available during execution, or
reduce the version to match an older example. Any such change returns to Master.
