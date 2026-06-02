# Stage-Local Concurrency and Execution-Primitive Events

Status: accepted for planned implementation

## Decision

Fanout draining removes top-level `limits.maxAgents` and `limits.maxConcurrency`. Concurrency controls move to stage-level `limits.maxConcurrency`, applied only where a stage introduces concurrent work. Agent call counts serve as usage reporting, not scheduling budget. Generic scheduler batch events are replaced by execution-primitive events because fanout draining and future parallel-stage execution do not share fixed batch boundaries.

## Considered Options

- Keep global limits and continue using `scheduler_batch_started` / `scheduler_batch_completed`.
- Keep global limits but add fanout-specific pool events.
- Remove global concurrency controls; use stage-local concurrency with fanout pool, ordinary work, and future parallel group events.

## Consequences

This migration requires updates to the workflow schema, compiler defaults, lint rules, runtime scheduler, specifications, examples, tests, and any report or diagnostic wording that treated agent calls as a scheduling limit.

Split the work into two phases: a limits-semantics migration first, then the fanout draining and event migration. This separates schema contract changes from scheduler behavior changes so each can be validated independently.

Remove deleted limit fields without a compatibility period. Preserving them would keep the misleading global-budget model alive inside the scheduler.
