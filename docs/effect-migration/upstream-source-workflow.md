# Upstream Effect Source Workflow for Coding Agents

This workflow integrates the official Effect recommendation to vendor library
source so coding agents can learn from real code instead of guessing from
fragmented documentation.

It is normative for the repository-wide Effect migration.

## Why this exists

Coding agents are strong at repository exploration: following imports, reading
implementation and tests, and recognizing repeated patterns. Web/documentation
lookup is useful but fragments context and often separates an API from the code
that demonstrates its actual idioms.

For this migration, the Effect source tree is therefore treated as a local,
read-only reference corpus.

This does **not** change application dependency resolution. Acpus still imports
Effect from normal package dependencies. Vendored source is reference material,
not production source.

## Required location

A01 vendors the matching Effect v4 source under:

```text
repos/effect/
```

Use `git subtree --squash` rather than a submodule unless maintainers explicitly
choose another mechanism. The important properties are:

- source is physically present in a normal checkout;
- agents can search and traverse it without additional initialization;
- one upstream refresh appears as a deliberate reviewable repository change;
- application code never imports from `repos/effect`.

## Pin coherence is mandatory

The vendored source must correspond to the exact Effect v4 RC dependency
selected by A01.

Do **not** vendor moving `main` while package.json is pinned to an older RC.
That creates two different API truths in one repository.

A01 records:

```text
Installed Effect version:
Installed package integrity / lock entry:
Vendored upstream commit:
Vendored upstream release/tag if available:
Verification that the source corresponds to the installed RC:
```

When the Effect RC is upgraded, the dependency pin and vendored source update
are one coordinated change. Parallel execution work pauses until the new pair
is verified.

The implementation authority order becomes:

1. installed pinned Effect v4 package/type declarations;
2. vendored source at `repos/effect` corresponding to the same RC;
3. vendored `repos/effect/LLMS.md` and `ai-docs` examples corresponding to that
   source;
4. official upstream documentation/migration material;
5. everything else only after verification against the first three.

## Agent rules for vendored repositories

`repos/effect` is **read-only reference material** for Acpus execution agents.

Agents MUST:

- search it when selecting or verifying a non-trivial Effect API/pattern;
- prefer source, tests and `ai-docs` examples from the vendored tree over
  generated guesses or unrelated web snippets;
- read `repos/effect/LLMS.md` before writing substantial Effect code;
- verify examples against the installed RC types when an API is central to a
  work package;
- record the relevant vendored paths in work-package evidence for central
  service/Scope/Fiber/Cause/runtime decisions.

Agents MUST NOT:

- edit `repos/effect` as part of normal Acpus work;
- import production/test code from `repos/effect`;
- add it to TypeScript project references or package exports;
- copy large upstream implementations into Acpus when a library capability can
  be consumed directly;
- treat an upstream internal module as a public supported API merely because
  its source is visible;
- use vendored examples as justification for violating Acpus ADR/invariants.

Acpus architecture remains authoritative over upstream general-purpose
examples. For example, Effect Workflow may demonstrate a sound Effect pattern
but is still not Acpus's durable scheduler.

## Source exploration protocol

Before implementing a central Effect construct, use this order:

```text
1. Search LLMS.md / ai-docs for the concept.
2. Read the referenced example(s).
3. Read the public module/type declaration for the chosen API.
4. Read relevant Effect tests when lifecycle/interruption semantics matter.
5. Only then settle the Acpus pattern.
```

High-risk subjects that require this protocol include:

- Context.Service and Layer construction;
- scoped resource acquisition/finalization;
- Fiber forking, supervision and keep-alive semantics;
- Deferred/Queue/PubSub choice;
- Cause and typed error handling;
- interruption and external cancellation bridges;
- Clock, timeout and schedules;
- runtime entry / ManagedRuntime / NodeRuntime choices;
- testing APIs and controlled time;
- any proposed `effect/unstable/*` use.

## Pattern-note extraction

Do not make every execution agent rediscover the same upstream patterns.

Before a pass or work package introduces a new central Effect concept, the
Master may require a compact project-local pattern note under:

```text
docs/effect-migration/agent-patterns/
```

A pattern note is produced from the vendored source and answers only what Acpus
needs. It should include:

```text
Concept:
Pinned RC / vendored commit:
Relevant upstream files:
Approved Acpus shape:
Important semantics:
Common misuse / rejected alternatives:
Small representative example:
Affected work packages:
```

Do not duplicate all upstream documentation. A note exists to compress the
specific idiom that multiple Acpus agents will reuse.

Examples likely worth extracting during this migration:

- `service-and-layer.md` before B01/B04;
- `scoped-process.md` before B02/C01/C02;
- `fiber-supervision.md` before C04/C05/D02;
- `deferred-queue.md` before D01;
- `clock-and-timeout.md` before C01/D03;
- `cause-finalization.md` before lifecycle-heavy C/D packages;
- `effect-testing.md` before broad runtime test rewrites.

## Execution Packet integration

Every Execution Packet contains an **Upstream references** section.

For a work package using only already-established patterns, list the canonical
Acpus pattern note(s).

For a work package introducing or materially changing an Effect primitive,
Master must either:

1. provide an already-reviewed project-local pattern note; or
2. explicitly assign upstream exploration/pattern extraction as the first
   bounded step of the packet before production edits.

The execution agent reports:

```text
Vendored Effect commit consulted:
Vendored files/examples consulted:
Acpus pattern notes followed/updated:
Any API difference between vendored source and installed types:
```

If vendored source and installed types differ materially, stop implementation
for that API and report a baseline-coherence defect to Master. Do not choose one
silently.

## Editor and tooling isolation

The vendored tree should be easy for agents to search but should not pollute
human auto-imports, normal application typechecking, builds, linting, package
exports or test discovery.

Where editor configuration is maintained in the repository, exclude
`repos/**` from auto-import suggestions, file watching and ordinary human search
as appropriate. This is ergonomic configuration only; agent instructions must
still explicitly allow deliberate reads/searches of `repos/effect`.

Repository build/test/coverage tooling should also exclude `repos/**` unless a
specific upstream-reference check intentionally reads it.

## Updating the subtree

Effect source updates are Master/coordinator work, never incidental execution
agent cleanup.

A source refresh must be paired with the corresponding dependency update and:

1. update the subtree with `--squash`;
2. update lockfile/package pins;
3. re-run the A01 baseline validation;
4. refresh pattern notes only where upstream semantics/API changed;
5. run typecheck and relevant Effect architecture/tests;
6. record the new installed version + vendored commit pair;
7. only then resume downstream work.

Do not periodically refresh vendored source during an active work package.

## Trade-off accepted

Vendoring increases repository size and creates a small maintenance obligation.
For this migration the trade-off is accepted because the implementation is
agent-heavy, Effect v4 is on an RC line, and correctness depends on agents using
native v4 patterns rather than v3 memory or generated approximations.

The source corpus does not replace ADRs, invariants, ownership rules or quality
gates. It supplies accurate library knowledge inside those constraints.
