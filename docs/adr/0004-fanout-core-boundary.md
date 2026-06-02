# Fanout Core Boundary

Status: accepted for planned implementation

## Decision

Top-level fanout and Loop Body fanout share a narrow Fanout Core for reusable fanout semantics. Their execution adapters remain separate. Fanout Core is a pure in-memory runtime semantic core over compiled `FanoutPlan` data: it owns item and lane expansion, lane selection, status derivation, aggregate output construction, and partial-policy evaluation.

Fanout Core does not read author-facing schema, know about `maxConcurrency`, run a worker pool, write files, update `run.json`, append events, manage runtime lifecycle, or understand loop rounds.

## Considered Options

- Keep top-level fanout and Loop Body fanout semantics separately implemented.
- Replace both paths with one generic fanout runner.
- Share only lane selection while leaving aggregate output construction duplicated.

## Consequences

Top-level fanout and Loop Body fanout call the same Fanout Core for behavior that must not drift: Lane Group selection, `oneOf` failure handling, skipped item handling, partial policy, item output shape, stage aggregate shape, blocked lane diagnostics, and fanout summary counts.

Their adapters remain responsible for execution lifecycle concerns: top-level scheduler pool draining, resume and stale recovery, loop round sequencing, session keys, attempt identity, output paths, run-index updates, and event emission.

Loop Body fanout converges to the current Fanout Core contract rather than preserving older unreleased output behavior. Future fanout behavior changes update Fanout Core first; then adjust only the top-level and Loop Body adapters where execution lifecycle genuinely differs.
