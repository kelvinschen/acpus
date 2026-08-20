# Effect Migration Execution Packet Template

The Master compiles one packet from the roadmap, fact registries, vendored
Effect source and concrete code inspection before assigning an implementation
agent. A roadmap label alone is not an executable task.

```text
# WP <ID> — <boundary>

Status: ready
Baseline commit:
Pinned Effect v4 RC:
Vendored Effect commit:

## Required reading
- AGENTS.md
- ADR-0001
- ADR-0002
- v4-rc-baseline.md
- upstream-source-workflow.md
- repos/effect/LLMS.md
- v4-pattern-catalog.md
- applicable docs/effect-migration/agent-patterns/*.md
- agent-execution-manual.md
- review-and-quality-gates.md
- this packet
- applicable repository maintenance guides

## Upstream references
Vendored Effect paths to inspect:
Approved Acpus pattern notes:
New pattern extraction required before coding: yes/no
If yes, pattern-note target path:

## Owned scope
Exact production files:
Exact test files:
Files allowed only for mechanical import/type updates:

## Explicitly out of scope
...

## Current-state facts
Legacy mechanisms present:
Current public/internal signatures:
Current resource owners:
Current durable commit boundaries:

## Frozen target contract
Pure/effectful split:
Service interface(s):
Success values:
Typed errors:
Interruption semantics:
Scope requirement:
Composition/provision point:
Adapter leaf:
Unstable modules approved: none / <explicit>

## Dependency direction
Consumes:
Must not import/depend on:
Downstream WPs relying on this contract:

## Invariants
- <SCH/STORE/AUTH/PROC/ACP/LIFE/LOCAL IDs>

## Race obligations
- <RACE IDs and expected evidence>

## Ownership tree
...

## Required deletion
- obsolete Result/ResultAsync path
- obsolete Promise/timer/Abort registry
- obsolete helper/service/adapter
...

## Must not change
- event schema
- DB schema
- transaction/fencing semantics
- workflow retry identity
- public authoring semantics
... as applicable

## Existing evidence
Invariant -> test path/case
Race -> test path/case

## Implementation sequence
1. verify installed Effect RC and vendored commit still match packet baseline
2. inspect required vendored Effect source/ai-docs/tests
3. create/update assigned pattern note if required; do not touch production
   code until that bounded pattern decision is complete
4. implement the frozen boundary
5. delete required legacy abstractions in the same package
6. run verification and bad-taste searches

## Verification
Narrow tests:
Typecheck/build:
Broader tests:
Bad-taste searches:
Vendored/import isolation checks:

## Handoff report required
Boundary migrated:
Pinned v4 API/source consulted:
Vendored Effect commit consulted:
Vendored files/examples consulted:
Acpus pattern notes followed/updated:
Any installed-types vs vendored-source mismatch:
Pure/effectful split:
Scope/ownership tree:
Expected errors:
Interruption path:
Adapter path:
Invariants preserved:
Race evidence:
Legacy abstractions deleted:
Checks run:
Remaining work (named downstream WP only):
```

## Master rules

A packet is `ready` only when shared interfaces and ownership decisions are
frozen enough that the execution agent does not need to invent cross-WP
architecture.

A packet is also not ready when a new high-risk Effect concept is required but
no reviewed upstream pattern has been established. Master must either reference
an existing approved pattern note or make narrowly-scoped upstream exploration
and pattern extraction the first explicit step of the packet.

Do not over-specify implementation combinators. Freeze semantics and boundaries,
then let the agent choose the smallest native v4 implementation consistent with
the pattern catalog, matching vendored source and pinned types.

If code inspection contradicts a registry, correct the registry before issuing
the packet. If implementation discovers a contradiction affecting a shared
contract, stop that WP and return it to Master rather than introducing a local
compatibility layer.

If installed Effect types and vendored source disagree, the repository baseline
is incoherent. Return to Master/A01; do not let an execution agent work around
it locally.
