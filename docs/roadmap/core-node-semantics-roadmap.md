# Core Node Semantics Roadmap

This roadmap tracks unresolved node-semantics gaps for the TypeScript-first
`@acpus/core`. Current node contracts live in `specs/core-workflow-spec.md`; this
file does not repeat completed decisions.

## Design Filters

- Output contracts should not imply values that a successful path cannot
  produce.
- Early success paths need a complete and explainable workflow output.
- Boolean control fields should stay boolean workflow values, not JavaScript
  truthy/falsy checks.
- One node should carry one control meaning; assertion, branching, racing,
  quorum, and external waiting should stay separate.

## Open Gaps

### Race Result Narrowing

`parallel` race output currently exposes a `winner` key and a result union.
TypeScript does not narrow `result` based on `winner`.

Candidate direction: evaluate a tagged result envelope or helper-based narrowing
only if real workflows need branch-specific race result handling.

### Final Node Output Schema Derivation

Some runner and UI features may need a complete schema for a node's final output,
including strategy-derived shapes such as `parallel(all)` and `fanout(quorum)`.

Candidate direction: design one shared derivation utility in core before runner
or UI layers reimplement this logic independently.

### Loop Execution Metadata

Loop business output does not say whether the loop stopped normally, exhausted
with `returnLast`, or exhausted with failure. That distinction belongs to runner
execution metadata, not workflow output.

Candidate direction: add runner state/event metadata when the runtime execution
model is implemented.

### Signal Timeout Defaults

Signal timeout is fail-only today. A future workflow may need timeout to continue
successfully with a schema-valid default payload.

Candidate direction: evaluate schema-aware default output only if successful
timeout continuation becomes a real runtime requirement.
