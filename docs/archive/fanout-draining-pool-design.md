# Fanout Draining Pool Design

> Historical design record. Current behavior is specified under `specs/`.

## Accepted Direction

Fanout scheduling should move from fixed concurrency-window batches to a fanout-stage-local draining pool.

A fanout-stage-local draining pool means one fanout stage keeps up to its effective concurrency limit active inside a scheduler invocation. When one item finishes, the scheduler can start the next pending item for that same fanout stage without waiting for every item in the current concurrency window to finish.

## Current Gap

Current fanout scheduling starts a selected batch of ready items and waits for the full batch to settle before selecting more ready work. This can leave concurrency capacity idle when fanout item durations vary.

## Scope Boundary

The first implementation should stay local to a single fanout stage. It should not introduce a cross-run, cross-process, or background worker system.

`run --yes` without `--wait` should keep the current bounded-step behavior and return after a finite scheduler advancement. Fanout-stage-local draining should be used by wait-style paths such as `run --yes --wait` and `resume --wait`, where blocking until terminal progress is already expected.

Fanout item results should be merged immediately when each item settles. The scheduler should update `run.json`, attempts, item status, and `agentUsage` before deciding whether to refill the freed concurrency slot.

Concurrency should mean active agent work units, not internal agent calls. Repair and retry calls inside one active item should not consume additional concurrency slots.

The new scheduling design should remove `limits.maxAgents` and top-level `limits.maxConcurrency`. Concurrency should be controlled only by stage-level `limits.maxConcurrency` on stages that can introduce concurrent work. Agent call counts should remain usage/reporting data, not scheduling budget.

Fanout stages should default to serial execution when stage-level `limits.maxConcurrency` is omitted. Authors should set `limits.maxConcurrency > 1` only when they intentionally want concurrent fanout item execution.

The first draining implementation should run at most one ready fanout stage at a time. Multi-pool scheduling should wait until future graph shapes can produce multiple independent concurrent fanout or parallel-stage groups.

When a fanout item blocks or fails and `allowPartial` is false, the pool should stop launching new items. Already running items should be allowed to settle, pending items should be terminalized with a cascade blocked reason, and the fanout stage should aggregate to blocked.

The first implementation should not cancel already running fanout items. It should stop refilling the pool, wait for active items to settle, and rely on existing recovery paths for process interruption.

Fanout draining should be enabled through an explicit option on the existing `syncRun` scheduler entry point, such as `drainFanoutPool`. Wait-style commands should pass the option, while bounded-step and observation-only paths should not.

Active pool state should not be persisted as a separate `run.json` object. Pool state should be derived from fanout item statuses, attempts, and output artifacts; events should record pool lifecycle for observation.

The scheduler should stop producing `scheduler_batch_started` and `scheduler_batch_completed` events. Runtime events should describe the active execution primitive instead of a generic scheduler batch:

- Ordinary single work should use `work_started` and `work_settled`.
- Fanout draining should use fanout pool events such as `fanout_pool_started`, `fanout_pool_item_started`, `fanout_pool_item_settled`, and `fanout_pool_completed`.
- Future parallel-stage execution should use parallel group and branch events rather than reusing fanout pool or batch events.

Implementation should be split into two migrations:

1. Remove `limits.maxAgents` and top-level `limits.maxConcurrency`, move concurrency semantics to stage-level limits, and stop using agent call counts as scheduler budget.
2. Add fanout-stage-local draining and replace scheduler batch events with execution-primitive events.

The limits migration should hard-delete the removed fields without a compatibility period. Workflow validation should reject top-level `limits.maxAgents`, top-level `limits.maxConcurrency`, and stage-level `limits.maxAgents` after the migration.

After the first migration, stage-level `limits.maxConcurrency` should be accepted only on fanout stages. Other stage kinds should reject `limits.maxConcurrency` until they gain explicit concurrent execution semantics.

`limits.maxFanoutItems` should also be removed from the top-level workflow limits and remain only as a fanout stage-level limit. Fanout stages should default `maxFanoutItems` to `1` when omitted.

`maxFixRounds` should be removed from the workflow and stage `limits` objects. Fix-loop round count should be controlled only by the `fixLoop.maxRounds` field.

After the limits migration, top-level `limits` should retain only workflow-wide fields: `stageTimeoutMinutes` and `maxOutputChars`.

Stage-level `limits.stageTimeoutMinutes` should remain supported as an override bounded by the top-level timeout. Stage-level `limits.maxOutputChars` should not be supported; output size limiting should remain a workflow-wide setting.
