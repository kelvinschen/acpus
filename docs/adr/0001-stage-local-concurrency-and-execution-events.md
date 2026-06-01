# Stage-local concurrency and execution-primitive events

We decided that fanout draining should remove top-level `limits.maxAgents` and `limits.maxConcurrency`, use stage-level `limits.maxConcurrency` only where a stage can introduce concurrent work, and treat agent call counts as usage reporting rather than scheduling budget. We also decided to replace generic scheduler batch events with execution-primitive events because fanout draining and future parallel-stage execution do not share fixed batch boundaries.

**Considered Options**

- Keep global limits and continue using `scheduler_batch_started` / `scheduler_batch_completed`.
- Keep global limits but add fanout-specific pool events.
- Remove global concurrency controls and use stage-local concurrency with fanout pool, ordinary work, and future parallel group events.

**Consequences**

This migration required updates to the workflow schema, compiler defaults, lint rules, runtime scheduler, specs, examples, tests, and any report or diagnostic wording that treated agent calls as a scheduling limit.

The implementation should be split into a limits-semantics migration first and the fanout draining/event migration second, so schema contract changes and scheduler behavior changes can be validated independently.

Removed limit fields should be hard-deleted without a compatibility period because preserving them would keep the misleading global-budget model alive inside the scheduler.
