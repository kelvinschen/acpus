# Effect Agent Pattern Notes

This directory stores narrow, project-local pattern notes distilled from the
vendored Effect v4 source under `repos/effect`.

These notes exist to prevent execution agents from repeatedly rediscovering the
same upstream idioms and to make Master-approved Effect usage concrete for
Acpus.

## Authority

A pattern note is subordinate to:

1. ADR-0001 and ADR-0002;
2. the exact installed Effect v4 RC types;
3. the matching vendored Effect source;
4. Acpus semantic invariants, boundary and ownership registries.

A note is not permission to violate durable scheduler semantics merely because
an upstream Effect example demonstrates a different architecture.

## Creation rule

Create a note only when a pattern is expected to be reused across multiple work
packages or is high-risk enough that repeated independent interpretation would
be dangerous.

Each note must record:

```text
Concept:
Status: draft | master-approved | stale
Pinned Effect RC:
Vendored Effect commit:
Relevant upstream paths:
Affected Acpus work packages:
```

Then document:

- the approved Acpus shape;
- the semantics that matter;
- the minimal representative code shape;
- rejected alternatives / bad taste;
- tests or compile probes used to verify the pattern.

## Lifecycle

A note is `draft` while an agent extracts it from upstream source. Master review
changes it to `master-approved` before downstream packages may rely on it.

An Effect RC/subtree update marks affected notes `stale` until their upstream
references are revalidated. Do not silently keep using a stale pattern note.

## Expected notes during this migration

Likely notes include:

- `service-and-layer.md`
- `scoped-process.md`
- `fiber-supervision.md`
- `deferred-queue.md`
- `clock-and-timeout.md`
- `cause-finalization.md`
- `effect-testing.md`

Do not create them all speculatively. Master should commission each note just
before the first work package that needs the pattern, then reuse it thereafter.
