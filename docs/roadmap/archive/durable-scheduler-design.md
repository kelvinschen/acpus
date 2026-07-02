# Durable Scheduler Design Record

本文记录 2026-06-30 关于 durable scheduler 重设计的已确认方向。它是 roadmap/design record，不是当前 runtime spec；当前已实现行为仍以 `specs/runtime-spec.md` 为准。实现落地后，再把已经交付的行为同步进 spec。

## Context

当前 `@acpus/runtime` 已有 non-agent scheduler skeleton，可以递归执行 `assert`、`if`、`switch`、`parallel`、`fanout` 和 `loop`。已知 gap 是它仍以静态 `node.id` 和一次性内存递归执行为中心，不具备完整的 dynamic execution identity、durable frame、resume、retry、signal targeting、cancellation 和 concurrency policy。

目标是把 scheduler 抽成 `@acpus/runtime` 内部的 deep module：接口集中，行为完整，store、executor 和 queue 通过小 port 接入。

## Decisions

- Scheduler's external seam is run-level. Runtime and supervisor code ask the scheduler to advance a run, rather than asking it to execute individual nodes or frames.
- Scheduler stays runtime-internal. It is a workflow-aware module inside `@acpus/runtime`, not a public package or public subpath.
- Scheduler owns workflow scheduling semantics. It understands `WorkflowIR`, composite frames, dynamic execution identity, lexical scope resolution, retry/signal targeting, and group completion policy.
- Compiler and validator own static graph invariants. Scheduler trusts frozen IR for facts such as globally unique static node ids and does not repeat compile-layer checks during normal execution.
- Scheduler advances the frozen IR and run artifacts captured at admission. It does not reload current workflow source files while resuming, retrying, or processing signals for an admitted run.
- Scheduler owns workflow node attempt lifecycle. Node-level retry, timeout, cancellation, and attempt visibility are scheduler concerns; the leaf executor runs one attempt at a time.
- Concurrency is delegated through an internal adapter. The default implementation can use `p-queue`, but scheduler code depends on an Acpus-owned `ConcurrencyLimiter` interface rather than third-party APIs.
- Persistence uses event core plus projection. Scheduler transitions are appended as durable events, and projections are updated in the same transaction. Events are the rebuildable history; projections are the fast resume/read model.
- Scheduler events use maintained, typed, medium-grained taxonomy rather than ad hoc log records or one opaque transition event. Event definitions document their purpose, reducer effect, and intended readers before implementation adds new event types.
- Scheduler execution projections are updated through event reducers in normal execution. Direct projection repair is reserved for explicit migration, backfill, or replay repair tooling, and ownership lease heartbeat state stays separate from workflow semantic projections.
- State transitions use Acpus-owned transition tables and typed reducers. XState or similar libraries are not part of scheduler core. Transition tables can later be exported to Mermaid, DOT, or another visualization format.
- Dynamic identity is based on structured `instancePath`. The canonical `instanceKey` is a stable, readable head/tail plus hash derived from `instancePath`.
- `nodeId` remains the static, globally unique IR node id. `nodeKey` represents the dynamic execution instance key and is used for events, projections, artifacts, work dirs, output dirs, and task runtime context.
- Retry reuses the same dynamic `instanceKey`. Attempts are distinguished by `attemptNo` and `attemptId`, not by creating new node instances.
- Expression refs stay author-facing. `nodes.<id>.output` resolves through the current lexical execution scope's `nodeId -> instanceKey` mapping.
- Durable `blocked` is removed from the target model. Missing provider, runner, or executor prerequisites become failed node/run state; retry after environment repair is the recovery path.
- Workflow visualization is a separate module. It combines static `WorkflowIR` with runtime projection/event overlay; scheduler does not produce UI view models directly.
- Runtime can run multiple supervisor processes, but a single run has only one scheduler owner at a time. Store lease and heartbeat decide ownership before scheduling or commit.
- Leaf attempts carry an execution epoch or attempt id. The store rejects late commits from stale owners, cancelled work, or superseded attempts.
- Run ownership guards both scheduling and commit. Scheduler verifies an active lease before enqueueing or starting leaf attempts, and leaf completion commits still include owner epoch and attempt id for store-side validation.
- The runtime targets durable commit correctness, not exactly-once external side effects from user tasks or agents. Task code that mutates external systems still needs idempotency at that external boundary.
- Provider or client libraries can perform internal transient retry only when that retry is not observable as workflow node retry.
- Agent output conformance retry is executor-internal sub-attempt behavior. When an agent response cannot be parsed or accepted as the expected output, the agent executor can silently reprompt or retry within the same scheduler-visible attempt, bounded by the outer attempt timeout and abort signal.
- Durable controls use a three-part split: CLI/API admits commands or events, supervisor owns lease and wakeup, and scheduler reduces command effects into run, frame, instance, and attempt state.
- Scheduler uses an internal classification for awaited input, cancellation, retryable failure, terminal failure, timeout, and superseded stale attempts. Public run/node state stays compact while reducers still get the distinctions needed for retry, quorum, race, and recovery.
- Parent-driven sibling stops are cancellation, not failure or ordinary skip. Internal cancellation reasons include parent failure, race lost, quorum reached, pause, and superseded owner/attempt.
- Unchosen `if` and `switch` branches are represented by branch decision metadata and static visualization overlay rather than eager dynamic child instances. Only the chosen branch enters lexical scope and materializes child instances.
- Branch decisions are durable truth within a run attempt. Resume uses the persisted `if` or `switch` decision, while retrying the composite instance re-evaluates the condition.
- Runtime expression evaluation failures belong to the current node or frame being evaluated and become terminal failure for that dynamic instance unless a normal retry policy applies.
- The first implementation does not include output-only retry after a successful leaf attempt whose output expression failed. Retrying that node instance reruns the node attempt through the normal scheduler path.
- Scheduler recovery is durable-state based, not deterministic replay based. Expression results that affect branch decisions, output values, or group transitions are persisted when first evaluated, and resume uses those persisted results instead of requiring helpers to be deterministic.

## Composite Semantics

- `parallel all` treats every branch as required. The first required branch failure fails the group and best-effort cancels remaining active or queued branch work.
- `parallel race` is first-success race. Branches run subject to concurrency limits; the first successful branch that commits durably becomes the winner. Failed branches are tolerated until no branch can still succeed.
- Successful `parallel race` keeps loser branch terminal summaries for debugging, replay, and visualization. Loser failures do not fail the composite and are not part of the user-visible output unless referenced by the declared output expression.
- `fanout all` treats every item as required. The first required item failure fails the group and best-effort cancels remaining active or queued item work.
- `fanout quorum` is early quorum. The group succeeds after `count` successful item outputs. `accepted` contains the first `count` successes, and `completed` contains successful item outputs completed before the group stops. The group fails when successful count plus remaining possible successes cannot reach quorum.
- `fanout quorum` accepted order follows durable success commit sequence. Authors who need input-order presentation can use completed item metadata and item keys to reorder in the output expression.
- `fanout.key` provides stable item identity. Missing keys fall back to zero-based item index, matching the usual index-key tradeoff: useful by default, but authors provide keys when stable item identity matters.
- `fanout.key` results are limited to string or number values. Duplicate keys fail the fanout frame before item execution begins.
- Fanout materialization follows `items eager, child scopes lazy`. Item identity, index, and key rows are created up front for duplicate checks and quorum accounting, while per-item child node instances are created only when the scheduling window reaches that item.
- `loop` persists a loop frame and per-iteration child instances. The frame carries `iter`, `previous`, and `result` so an interrupted loop can resume without reusing a static child node output across iterations.
- Loop iteration materialization is fully lazy. The next iteration frame is created only after the current iteration output is available, `stopWhen` does not stop, and the frozen IR `maxIterations` cap still allows another iteration.
- Loop iteration caps are compile-layer authoring requirements. Current authoring and IR use required `maxIterations`, so scheduler enforces the frozen value rather than inventing a runtime default.
- Loop exhaustion is a loop-frame terminal reason. `onExhausted: "fail"` fails the loop node with `loop_exhausted`; `onExhausted: "returnLast"` succeeds the loop node with the last completed iteration result and records `exhausted_return_last` metadata.
- Retrying a loop node instance reruns the whole loop frame from iteration 0. Retrying a specific child leaf attempt remains the mechanism for local recovery within an iteration.
- Awaiting signal instances do not automatically stop race, quorum, or all groups. The group continues scheduling useful remaining work and only leaves the run awaiting when it cannot make progress without signal input.
- Composite group results are scheduler-internal and standardized for persistence, retry, and visualization. User-visible composite node output still comes from the node's declared output expression.
- Scheduler can use unified internal group frames, while author-facing expressions use domain roots rather than a generic `group` root.
- Planned composite expression roots include `parallel.branches`, `parallel.winner`, `parallel.completed`, `parallel.failed`, `fanout.item`, `fanout.index`, `fanout.key`, `fanout.accepted`, `fanout.completed`, `fanout.failed`, `loop.iter`, `loop.previous`, and `loop.result`.

## Identity Model

Example structured path:

```ts
[
  { kind: "fanout", nodeId: "items", itemKey: "pkg-a", itemIndex: 0 },
  { kind: "loop", nodeId: "retry", iter: 2 },
  { kind: "node", nodeId: "check" },
]
```

Example key derived from that path:

```text
items[pkg-a]/retry#2/check~a13f09c2d8e4
```

When paths grow long, the key keeps readable head/tail context and a canonical hash. Runtime logic uses structured columns or stored path data rather than reparsing the readable key.

Lexical execution scope is a dynamic overlay on top of globally unique static node ids. Entering a fanout item, loop iteration, or parallel branch pushes a `nodeId -> instanceKey` mapping. `nodes.<id>.output` resolves from the current scope outward to the nearest completed instance. Parent scopes observe composite outputs, not arbitrary branch/item internals. Ambiguous dynamic lookups are treated as scope errors rather than guessed.

## Concurrency Model

- Each run has a run-wide leaf execution cap. The default cap is `32`.
- A composite can declare `maxConcurrency`. If it does not, the planned default local cap is `min(runCap, 10)`.
- Concurrency limiter permits are in-memory owner resources, not durable state. Recovery rebuilds schedulable work from projections and reacquires permits under the current owner.
- Composite `maxConcurrency` limits only that composite's direct active members. Nested composites keep their own local caps, and the run-wide leaf cap is the only global concurrency cap.
- Branch/item scopes hold local composite slots.
- Leaf execution holds run-wide slots.
- Within one run, ready work is scheduled by deterministic FIFO using durable readiness sequence. Priority and weighted fairness stay out of the first implementation.
- Multi-run fairness is supervisor policy, not single-run scheduler policy.
- Pure control/expression evaluation does not consume run-wide leaf permits.
- Cancellation is best-effort through `AbortSignal`. Scheduler still guards durable commits so late success, late failure, and artifact writes after cancellation do not become accepted results.
- Leaf work starts only while the scheduler owner lease is active. A recovered owner may re-drive abandoned instances after lease expiry, while stale owners cannot commit their late results.
- Leaf attempt startup is durable-first. Scheduler reserves and records `attempt.started` in a transaction before starting the external task or agent process; immediate spawn failures are recorded as attempt failures afterward.
- Attempt timeout records a durable deadline when the attempt starts. The current owner uses in-memory timers for prompt abort, while supervisor recovery can wake scheduler from the persisted deadline if the owner misses or loses the timer.
- Signal awaiting records a durable wait deadline when configured. It does not consume a run-wide leaf slot. Deadline expiry is reduced by scheduler according to the signal node timeout/onTimeout policy.
- Signal payload arrival and signal timeout race through store event ordering. The first committed transition wins, and the later transition is treated as already consumed, already timed out, or stale.

## Runtime Surface Effects

- Store schema needs projections for run, frame, group, and dynamic node instances, plus event types for instance and frame transitions.
- Planned scheduler event categories include frame, instance, attempt, group member, branch decision, and signal consumption events. Payloads carry typed fields such as node kind, strategy, reason, instance key, parent frame key, owner epoch, and attempt id.
- Attempt lifecycle needs event and projection support for started, completed, failed, timed out, cancelled, and superseded attempts.
- Retry supports whole-run retry and instance retry. Static `nodeId` is a convenience alias only when it maps to exactly one relevant failed instance.
- Signal delivery targets `instanceKey`. Static `nodeId` is a convenience alias only when it maps to exactly one awaiting signal instance.
- Ambiguous static `nodeId` retry or signal aliases fail rather than choosing heuristically. The runtime can return candidate dynamic instance keys with item key/index, loop iteration, status, and error summary for user selection.
- Pause is a durable gate plus best-effort cancellation. It moves the run projection directly to `paused`, starts no new work, sends abort to active attempts, and rejects late commits from work that keeps running. It does not introduce a run-level `pausing` state.
- Resume clears the durable pause gate and wakes `advanceRun`.
- Signal commands store normalized payloads for awaiting instances. Scheduler consumes those payloads while advancing the targeted dynamic instance.
- Signal payload normalization happens at command admission. Invalid payloads are rejected before mutating runtime state, and scheduler consumes only normalized durable payloads.
- Signal commands are idempotent by command key. The same key can be replayed safely for the same awaiting instance, while a different key cannot replace a payload that has already been consumed.
- Retry commands request whole-run or dynamic-instance retry. Scheduler owns the resulting frame, instance, and attempt transitions.
- Retry commands are idempotent by command key and target failed terminal run or dynamic instance state. Succeeded, running, awaiting, paused, and parent-cancelled instances are not retry targets in this design.
- Task and agent runtime context keeps `runtime.nodeId` as static IR id and uses `runtime.nodeKey` as dynamic instance key.
- Artifacts, output dirs, and work dirs are keyed by dynamic instance key, not static node id.
- Attempt-local files live under the dynamic instance key with attempt-specific subpaths, so retries do not overwrite prior attempt artifacts.
- Retry keeps prior attempt artifacts and logs for audit/debug. User-visible node output references only the accepted attempt result, and fork inheritance follows artifacts reachable from accepted outputs rather than every historical attempt artifact.
- Fork creates a new run and does not inherit active, failed, awaiting, or cancelled scheduler frames. It can copy compatible completed accepted outputs and artifacts, but not attempt history or in-flight dynamic state.
- Artifact garbage collection is a future retention-policy concern, separate from scheduler retry semantics.
- Executor-internal sub-attempt details, such as agent provider calls or conformance retries, stay in attempt logs, artifacts, or execution metadata registries rather than scheduler core projections.
- Replay checks can rebuild projections from scheduler events and compare them to persisted projections.
- Supervisor recovery uses run ownership lease expiry. A new supervisor can continue an abandoned run after the previous owner stops renewing its lease.
- Projection tables keep internal group result metadata separate from user-visible node output.
- During recovery, running attempts owned by an expired lease are marked superseded before the new owner re-drives eligible work. Late commits from the superseded owner or attempt id are rejected.

## Implementation Notes

- The scheduler depends on small ports: `SchedulerStorePort`, `NodeExecutor`, and `ConcurrencyLimiter`.
- `SchedulerStorePort` exposes scheduler-intent transactions rather than raw projection CRUD. The store adapter owns SQLite, idempotency, expected-version checks, owner epoch validation, and projection updates.
- The main scheduler entrypoint is shaped around `advanceRun(runId, reason?)`. It reads durable projections, starts eligible work, consumes completions from work owned by the current owner, drains available transitions, and returns at terminal, awaiting, paused, idle/no-active-work, or lease-lost state with a concise advancement summary.
- The first implementation loads a complete scheduler snapshot when advancing a claimed run and keeps only short-lived in-memory state inside that `advanceRun` call. Long-lived scheduler caches and incremental snapshot loading are deferred until there is a measured need.
- The store adapter owns SQLite and transaction mechanics.
- The leaf executor adapter owns single-attempt task target loading, agent execution, signal payload handling, schema normalization, and artifact APIs.
- Leaf executors return scheduler-ready attempt results. Task, agent, and signal output parsing, acceptance, and schema normalization happen before scheduler receives the result.
- Agent executor internals can record provider calls, parse failures, and conformance retries in attempt logs or metadata without creating extra scheduler attempt events. If conformance retry is exhausted, scheduler sees one failed attempt with an invalid-output style reason.
- Transition reducers, frame reducers, and identity helpers are internal scheduler seams used by scheduler tests, not public runtime interfaces.
- The scheduler test surface should target transition reducers, instance identity, composite group behavior, lexical scope resolution, and port interactions.
- Pause coverage is called out explicitly: command admission flips the durable gate, scheduler stops enqueueing new work, active attempts receive abort, late results are rejected, resume can re-drive eligible instances, and no work starts while paused during lease recovery.
- Unit tests carry the scheduler semantics: transition tables, reducers, group completion, race/quorum/fail-fast behavior, loop exhaustion, retry classification, dynamic identity, and lexical scope lookup.
- Integration tests carry the store and orchestration risks: event plus projection transactions, idempotency, owner epoch compare-and-set, deadline recovery, fork artifact reachability, replay rebuild, and scheduler behavior with fake executors/limiters.
- E2E tests stay narrow until the product shape stabilizes; CLI coverage focuses on command wiring rather than every composite edge case.

## Follow-Up

- Use [Durable Scheduler Implementation Goal](durable-scheduler-implementation-goal.md) as the executable implementation checklist and high-level field model.
- Update `docs/roadmap/durable-runtime-roadmap.md` only if its audit notes need cross-linking.
- Update `specs/runtime-spec.md` after the implemented behavior matches this design.
- Add runtime unit, integration, and contract tests during implementation.
