# Durable Scheduler Implementation Record

This document records the durable scheduler implementation goal and the delivered
V1 result. It is a roadmap implementation record, not current product truth.
Current runtime behavior lives in `specs/`.

Source decision log: [Durable Scheduler Design Record](durable-scheduler-design.md).

**Implements with Clean Code and Good Test @AGENTS.md**

## Delivered Goal

Replace the previous recursive non-agent scheduler path in `@acpus/runtime` with
a durable, workflow-aware scheduler module that owns dynamic execution identity,
composite frames, node attempt lifecycle, cancellation, retry, signal targeting,
and concurrency policy behind one run-level interface.

The delivered implementation keeps the scheduler runtime-internal, persists
scheduler transitions as typed events, rebuilds fast read projections through
reducers, and advances runs through a small `advanceRun(runId, reason?)`
interface.

## Completion Gates

- [x] Runtime scheduler advances frozen admitted IR without reading current
  workflow source files.
- [x] Dynamic node execution uses `instancePath` and derived `nodeKey`
  rather than static `node.id` as runtime identity.
- [x] Scheduler state is event-backed, with projection updates applied through
  reducers in the same store transaction.
- [x] Supported V1 `parallel all`, `parallel race`, `fanout all`,
  `fanout quorum`, and `loop` shapes follow the semantics in the design record.
- [x] Node-level retry, timeout, cancellation, attempt ids, and late commit
  rejection are scheduler-visible.
- [x] Leaf executors run one scheduler-visible attempt at a time and return
  accepted attempt results.
- [x] Pause, resume, retry, signal, supervisor recovery, and deadline wakeup use
  durable command/event state rather than in-memory scheduler state.
- [x] Unit and integration coverage exercises the scheduler reducer and store
  risks before broad CLI/E2E expansion.
- [x] `specs/runtime-spec.md` is updated only after the implementation matches
  the new durable scheduler behavior.

Delivered V1 status:

- Admitted frozen IR now advances through the internal scheduler-backed runtime
  path for supported root scopes: scheduler-visible leaves, root `assert`,
  narrow root `if`/`switch` branches, root `parallel`/`fanout` composites whose
  branch or item scopes contain one or more scheduler-visible leaves in sequence,
  and root `loop` composites whose body contains one or more scheduler-visible
  leaves in sequence. Nested composite materialization remains outside the V1
  supported shape and is recorded as roadmap follow-up rather than current spec
  truth.

## Non-Goals

- No public scheduler package or public scheduler subpath.
- No multi-owner scheduling for the same run.
- No deterministic-workflow replay requirement.
- No output-only retry for a leaf attempt whose output expression failed.
- No broad CLI/E2E matrix for every composite edge case in the first pass.
- No retention or garbage-collection policy for historical attempt
  artifacts.

## Field Model Direction

The schema is projection-oriented and event-backed. These records describe the
runtime concepts and query paths delivered by the V1 implementation.

### Field Ownership Principles

- Scheduler semantic truth starts from typed events. Projection rows are the
  fast decision/read model rebuilt by reducers in the same transaction.
- Root frame terminal events are the scheduler projection's terminal source for
  a run. Bridging that state to public `runs` rows happens in the store
  transaction outside the scheduler core reducer.
- Identity fields are semantic, not display-only. `instance_path_json` is the
  source field; `node_key`, `frame_key`, `group_key`, and `member_key` are
  derived durable keys used for joins, targeting, artifacts, and logs.
- Events carry the facts needed to rebuild state. Projection-only fields can
  denormalize for query speed, but scheduler decisions remain explainable from
  the event stream.
- State tables contain scheduler decisions. Executor-internal details such as
  provider retries, invalid-output reprompts, timings, prompts, and debug traces
  stay in execution metadata, logs, or artifacts unless scheduler retry,
  cancellation, or recovery logic needs them.
- Composite group result metadata and user-visible node output stay separate.
  Group metadata answers scheduler questions such as accepted members and
  cancellation; composite frame results are derived from declared scope outputs
  for supported materialized scopes.
- Runtime control targeting uses dynamic identity first. Static `node_id`
  aliases are convenience inputs only when they resolve to one relevant dynamic
  instance.

### Naming

- `node_id`: static IR node id.
- `node_key`: dynamic node instance key, derived from `instancePath`.
- `instance_path_json`: structured dynamic path used as the source of truth.
- `frame_key`: durable key for a root, composite, branch, item, or loop
  iteration frame.
- `group_key`: durable key for a parallel or fanout group frame.
- `member_key`: durable key for a group member, such as a branch or fanout item.
- `attempt_id`: globally unique id for one scheduler-visible node attempt.
- `attempt_no`: monotonic number within one `node_key`.
- `owner_epoch`: run ownership generation used to reject stale commits.
- `readiness_sequence`: durable FIFO ordering for ready work inside one run.

### Existing Tables Kept Or Reoriented

- `runs`: keep as the run-level projection. Add or reuse fields for paused,
  awaiting, failed, completed, and updated timestamps as the public read model
  requires.
- `run_inputs`: keep as the frozen run truth for `workflow_ir_json`,
  `input_json`, lock data, task bundle count, and run directory.
- `run_events`: keep as the mixed public event stream and typed scheduler event
  stream. Scheduler events use an internal payload envelope so public events
  with overlapping names are not replayed by scheduler reducers.
- `commands`: keep as durable control command admission. Extend payloads around
  dynamic `nodeKey` targeting, idempotency keys, normalized signal payloads,
  and command processing state.
- `artifacts`: keep as the artifact registry. Store dynamic `node_key` and add
  `attempt_id` or `attempt_no` so retry artifacts remain auditably attached to
  the attempt that created them.

### New Scheduler Projections

`run_leases`

- Purpose: ownership metadata for single-owner run advancement.
- Key fields: `run_id`, `owner_id`, `owner_epoch`, `lease_expires_at`,
  `heartbeat_at`, `claimed_at`, `released_at`, `reason`.
- Notes: this is not workflow semantic state. It stays separate from scheduler
  execution projections.

`scheduler_frames`

- Purpose: durable projection for root, composite, branch, fanout item, and loop
  iteration frames.
- Key fields: `run_id`, `frame_key`, `parent_frame_key`, `node_key`,
  `node_id`, `frame_kind`, `status`, `strategy`, `terminal_reason`,
  `instance_path_json`, `scope_json`, `result_json`, `error_json`,
  `created_at`, `updated_at`.
- Notes: `scope_json` is the frame creation-time local lexical binding snapshot
  for `nodeId -> nodeKey`. Full execution scope is rebuilt from dynamic
  instances and completed child frames in projection; normalize later only if
  query pressure appears. Root frame terminal status is the scheduler projection
  source for run completion/failure.

`node_instances`

- Purpose: dynamic node projection and user-visible node output state.
- Key fields: `run_id`, `node_key`, `node_id`, `parent_frame_key`,
  `instance_path_json`, `status`, `status_reason`, `readiness_sequence`,
  `output_json`, `error_json`, `accepted_attempt_id`, `created_at`,
  `updated_at`.
- Notes: this replaces the static-node-centered projection for scheduler
  decisions. Public read APIs can still present static ids where unambiguous.

`node_attempts`

- Purpose: scheduler-visible attempt lifecycle for task and agent leaf work.
- Key fields: `run_id`, `attempt_id`, `node_key`, `node_id`, `attempt_no`,
  `owner_id`, `owner_epoch`, `status`, `deadline_at`, `started_at`,
  `finished_at`, `result_json`, `error_json`, `terminal_reason`,
  `cancel_reason`.
- Notes: agent conformance retries and provider call details stay in logs or
  execution metadata, not in this projection.

`group_members`

- Purpose: branch and fanout item membership, status, ordering, and quorum/race
  accounting.
- Key fields: `run_id`, `group_key`, `member_key`, `member_kind`,
  `branch_id`, `item_key`, `item_index`, `item_json`, `child_frame_key`, `status`,
  `readiness_sequence`, `accepted_rank`, `terminal_reason`, `output_json`,
  `error_json`, `created_at`, `updated_at`.
- Notes: fanout item identity rows are eager. Child frames under each item are
  lazy and created when scheduling reaches that item. `accepted_rank` is optional
  projection metadata; V1 quorum acceptance order is derived from durable
  completion sequence.

### Composite Result Shape Direction

- `parallel all`: composite frame result is an object keyed by branch id. Each
  value is the branch `ScopeIR.outputs` evaluated in that branch lexical scope.
- `parallel race`: composite frame result records the winning branch id and the
  winning branch output. Loser summaries remain in projection/event history for
  debugging and visualization.
- `fanout all`: composite frame result is an array of item outputs in item index
  order. Each item output is the fanout body `ScopeIR.outputs` evaluated with
  durable `fanout.<nodeId>.item/itemIndex` and the item's leaf output.
- `fanout quorum`: composite frame result is an object with `accepted` and
  `completed`. `accepted` is the first quorum-sized prefix by durable completion
  sequence; `completed` includes successes that committed before the group
  stopped.
- `loop`: loop frame result is the body `ScopeIR.outputs` result from the
  terminating iteration, or the last result when exhaustion returns last.
- Workflow output evaluation reads composite results through
  `nodes.<compositeId>.output`, using lexical scope rather than static ids as
  runtime storage keys.

`signal_waits`

- Purpose: awaiting signal state, normalized payload consumption, and signal
  timeout handling.
- Key fields: `run_id`, `node_key`, `node_id`, `status`, `payload_json`,
  `payload_digest`, `command_idempotency_key`, `deadline_at`, `consumed_at`,
  `timed_out_at`, `terminal_reason`.
- Notes: signal payload validation happens at command admission; this table
  stores only normalized durable payloads. Signal waiting and consumption are not
  scheduler-visible leaf attempts and do not consume run-wide leaf permits.

`execution_metadata`

- Purpose: optional debug metadata for executor-internal details.
- Key fields: `run_id`, `attempt_id`, `kind`, `metadata_json`, `created_at`.
- Notes: this is not scheduler state. Reducers do not depend on it.

### Event Taxonomy

Events stay medium-grained and typed. Each event definition records its purpose,
payload fields, reducer effect, and intended readers before implementation adds
it.

Initial categories:

- Frame: `frame.started`, `frame.completed`, `frame.failed`,
  `frame.cancelled`.
- Instance: `instance.ready`, `instance.started`, `instance.completed`,
  `instance.failed`, `instance.awaiting`, `instance.cancelled`.
- Attempt: `attempt.started`, `attempt.completed`, `attempt.failed`,
  `attempt.timed_out`, `attempt.cancelled`, `attempt.superseded`.
- Group: `group.started`, `group.member_ready`, `group.member_started`,
  `group.member_completed`, `group.member_failed`, `group.completed`,
  `group.failed`, `group.cancelled`.
- Branch: `branch.decided`.
- Signal: `signal.awaiting`, `signal.consumed`, `signal.timed_out`.
- Control: pause, resume, retry, signal, lease recovery, and deadline wakeup
  events that connect command processing to scheduler state.

### Index Direction

- `run_events(run_id, sequence)` remains the ordered event stream.
- Event idempotency keys stay globally unique.
- `node_instances(run_id, node_key)` is primary.
- `node_instances(run_id, node_id, status)` supports static alias resolution.
- `scheduler_frames(run_id, parent_frame_key, status)` supports frame progress.
- `node_attempts(run_id, node_key, attempt_no)` is unique.
- `node_attempts(run_id, owner_epoch, status)` supports stale commit handling.
- `node_attempts(run_id, deadline_at, status)` supports timeout wakeups.
- `group_members(run_id, group_key, readiness_sequence)` supports FIFO
  scheduling.
- `group_members(run_id, group_key, status)` supports quorum/impossible checks.
- `signal_waits(run_id, node_key, status)` supports exact dynamic signal
  targeting.
- `signal_waits(run_id, deadline_at, status)` supports timeout wakeups.
- `run_leases(lease_expires_at)` supports abandoned-run recovery.

## Implementation Phases

### Phase 0: Preflight

- [x] Read the design record and this goal document.
- [x] Check worktree status and avoid unrelated user changes.
- [x] Inventory current runtime scheduler, store, supervisor, command, replay,
  fork, signal, task executor, and agent executor entrypoints.
- [x] Inventory current runtime tests that depend on static `node_states` rows
  or current parallel/fanout/loop behavior.
- [x] Confirm package scripts for runtime unit, integration, typecheck, and
  broader verification.

Exit criteria:

- [x] Current scheduler and store coupling points are known.
- [x] Existing tests that encode old scheduler behavior are identified for
  rewrite or replacement.

Phase 0 baseline inventory:

- Before this implementation, the scheduler entrypoint was
  `packages/runtime/src/execution/advance.ts`, which delegated to
  `packages/runtime/src/execution/scheduler.ts`.
- The previous scheduler was recursive and in-memory. It used static node ids in
  `scope.nodes`, `completedNodes`, signal payload lookup, and node outputs.
- The previous store projection centered on `node_states`. Admission eagerly
  created one row per static node id through `collectNodeIds`.
- Previous controls in `packages/runtime/src/control/apply-command.ts` mutated
  run state through store methods such as `pauseRun`, `resumeRun`, `retryRun`,
  `retryNode`, and `signalRun`, then called the old `advanceRun`.
- The previous supervisor tick in `packages/runtime/src/supervisor/tick.ts`
  listed runnable runs and advanced each run directly. Command ownership
  existed, but run-level scheduler ownership did not.
- Previous task artifact paths used static `nodeKey` in
  `packages/runtime/src/execution/task-executor.ts`; retry attempt subpaths are
  not represented.
- The previous task executor owned node-level retry and timeout internally in
  `packages/runtime/src/execution/task-executor.ts`. Phase 5 moves those
  lifecycle decisions to scheduler-visible attempts while keeping single-attempt
  command execution and artifact APIs in the executor adapter.
- The previous agent executor forwarded node retry, timeout, and output
  acceptance to
  `@acpus/agent-executor` through `packages/runtime/src/execution/agent-node.ts`.
  Phase 5 separates scheduler-visible node attempts from executor-internal
  provider calls and output conformance retry.
- Previous replay only checked terminal run events, static `node_states`, and
  artifact registry integrity.
- Tests that encode old behavior include
  `packages/runtime/test/runtime-scheduler.integration.test.ts`,
  `packages/runtime/test/runtime-admission.integration.test.ts`,
  `packages/runtime/test/runtime-controls.integration.test.ts`,
  `packages/runtime/test/runtime-supervisor.integration.test.ts`,
  `packages/runtime/test/supervisor-lease.integration.test.ts`,
  `packages/runtime/test/runtime-evaluator.unit.test.ts`,
  `packages/runtime/test/public-api.contract.test.ts`, and
  `packages/runtime/test/public-types.type.test-d.ts`.
- Verification commands are workspace-level: `pnpm test:unit`,
  `pnpm test:integration`, `pnpm test`, and `pnpm typecheck`. The runtime
  package itself exposes `build` and `typecheck`, not a package-local test
  script.

### Phase 1: Scheduler Types And Reducers

- [x] Add internal scheduler type definitions for `instancePath`,
  `nodeKey`, frames, group members, attempts, event payloads, and snapshots.
- [x] Add identity helpers for dynamic keys and structured path construction.
- [x] Add maintained event taxonomy definitions with reducer purpose comments.
- [x] Add transition reducers for frames, instances, attempts, groups, branch
  decisions, signal waits, pause/resume controls, and retry target
  classification.
- [x] Add lexical scope resolution helpers that map static `nodeId` refs to
  dynamic `nodeKey` through the current frame scope.

Exit criteria:

- [x] Reducer unit tests cover identity, state transitions, race/quorum/all,
  loop exhaustion, cancellation reasons, retry classification, and scope lookup.
- [x] Reducers can rebuild scheduler projections from a typed event list in
  memory.

Phase 1 implementation notes:

- Added internal scheduler files under `packages/runtime/src/scheduler/`:
  `types.ts`, `identity.ts`, `events.ts`, and `transitions.ts`.
- Added low-level unit coverage in
  `packages/runtime/test/scheduler-reducers.unit.test.ts`.
- Verification completed for this phase:
  `pnpm test:unit -- packages/runtime/test/scheduler-reducers.unit.test.ts`,
  `pnpm --filter @acpus/runtime typecheck`, and `pnpm test:unit`.
- Adversarial review completed for this phase. Review findings were addressed
  around terminal transition guards, durable completion order, loop resume state,
  cancellation coverage, signal idempotency, group kind/member consistency, and
  branch decision ownership.

### Phase 2: Store Schema And Port

- [x] Add scheduler migrations for leases, frames, node instances, attempts,
  group members, signal waits, and optional execution metadata.
- [x] Extend event storage for typed scheduler events without turning events
  into unstructured logs.
- [x] Implement `SchedulerStorePort` around scheduler-intent transactions rather
  than raw projection CRUD.
- [x] Implement run claim, heartbeat, lease expiry recovery, expected-version
  checks, owner epoch validation, idempotency, and projection reducer commits.
- [x] Implement snapshot loading for one claimed run.

Exit criteria:

- [x] SQLite integration tests cover event plus projection atomicity,
  idempotency, owner epoch compare-and-set, stale commit rejection, lease
  recovery, and snapshot rebuild.
- [x] No normal scheduler execution path patches projection rows without an
  event reducer.

Phase 2 implementation notes:

- Added compatible scheduler projection tables and indexes to the runtime SQLite
  migration before the later runtime advancement switch.
- Added the internal `SchedulerStorePort` shape and an initial SQLite adapter
  exposed through `RuntimeStore.scheduler`.
- Scheduler events are stored in `run_events` with an internal versioned payload
  envelope so old runtime events with overlapping type names are not replayed by
  the scheduler reducer.
- Multi-event scheduler append idempotency is tracked by exact
  `scheduler_commits` rows instead of string-prefix event-key scans.
- Scheduler projection tables are rebuilt from reducer output inside the same
  transaction as event append; existing attempt and signal lifecycle timestamps
  are preserved across projection rebuilds.
- Added targeted integration coverage in
  `packages/runtime/test/scheduler-store-schema.integration.test.ts` and
  `packages/runtime/test/scheduler-store-port.integration.test.ts`.
- Adversarial review completed for this phase. Review findings were addressed
  around legacy event overlap, append idempotency prefix collisions, projection
  timestamp stability, reducer-before-commit atomicity, owner epoch recovery
  checks, cancellation reason consistency, and idempotent replay conflicts.

### Phase 3: Scheduler Interface And Drain Loop

- [x] Add the runtime-internal scheduler module with `advanceRun(runId,
  reason?)`.
- [x] Implement complete-snapshot loading at the start of `advanceRun`.
- [x] Implement deterministic FIFO ready work selection.
- [x] Add `ConcurrencyLimiter` adapter with `p-queue` behind the internal
  interface.
- [x] Enforce run-wide leaf cap and direct-member composite `maxConcurrency`
  caps.
- [x] Implement terminal, awaiting, paused, idle, and lease-lost return
  summaries.

Exit criteria:

- [x] Scheduler tests with fake store/executor/limiter prove that callers do not
  need node-level scheduler entrypoints.
- [x] `advanceRun` can resume from store snapshot without long-lived scheduler
  cache.

Phase 3 implementation notes:

- Added internal scheduler drain-loop types and `advanceRun` in
  `packages/runtime/src/scheduler/advance.ts`.
- Added `ConcurrencyLimiter` and the default `p-queue` adapter in
  `packages/runtime/src/scheduler/limiter.ts`; scheduler code depends on the
  Acpus-owned interface.
- `advanceRun` claims a run, loads a fresh store snapshot, schedules ready
  dynamic node instances by durable readiness FIFO, and returns compact
  terminal/awaiting/paused/idle/lease-lost summaries.
- Store attempt intents now reduce instance and attempt transitions together:
  `startAttempt` moves a ready instance to running and records
  `attempt.started`; `commitAttemptResult` records the attempt terminal event
  and matching instance terminal event in one transaction.
- Added low-level scheduler loop coverage in
  `packages/runtime/test/scheduler-advance.unit.test.ts`, plus store coverage
  for expired heartbeat rejection.
- Adversarial review completed for this phase. Review findings were addressed
  around expired lease heartbeat revival and local composite concurrency using
  direct `groupMembers` rather than arbitrary leaf grouping.

### Phase 4: Composite Semantics

- [x] Implement conditional branch decision persistence and resume behavior.
- [x] Implement `parallel all` fail-fast cancellation.
- [x] Implement `parallel race` first-success winner selection and loser
  summaries.
- [x] Implement `fanout all` with eager item identity rows and lazy child frames.
- [x] Implement `fanout quorum` early success, accepted order by commit
  sequence, and impossible quorum failure.
- [x] Implement loop frames, lazy iteration creation, `maxIterations`, and
  `onExhausted` for supported root loop bodies.
- [x] Implement internal group result metadata separate from user-visible node
  output.

Exit criteria:

- [x] Unit tests cover V1 composite terminal paths, cancellation paths, await
  interactions, and retry targeting.
- [x] Integration tests prove durable resume for interrupted supported
  parallel, fanout, and loop runs.

Phase 4 implementation notes:

- Added reducer-level composite helpers for group terminal event derivation,
  fanout item materialization, and loop next/exhaustion decisions.
- Added unit coverage for parallel all fail-fast cancellation, parallel race
  winner cancellation, fanout quorum accepted order and cancellation, duplicate
  fanout keys, and loop next/exhaustion outcomes.
- Wired `advanceRun` to drain derived group completion events from durable
  projection before starting ready work.
- Added SQLite integration coverage for interrupted `parallel race` and
  `fanout quorum` resume. Derived cancellation now cancels corresponding
  ready/running/awaiting child instances when member keys match dynamic
  instance keys.
- Store leaf attempt start/result transactions update direct group member
  lifecycle when a matching group member exists, which lets real leaf completion
  drive group terminal derivation.
- Added live early cancellation for already-running race/quorum losers by
  draining derived group transitions after each attempt settles and aborting
  active attempts whose dynamic instance became cancelled.
- Added conservative root bootstrap and continuation materialization for frozen
  IR: the scheduler can create the root frame and advance root-level supported
  nodes sequentially without reading workflow source files. Unsupported root
  node kinds are intentionally not skipped until their semantic materializers
  exist.
- Root bootstrap binds the materialized leaf in the root lexical scope. Root
  signal bootstrap records an open wait only; deadline synthesis remains tied to
  later admission/wakeup wiring with an explicit clock.
- Root `parallel` bootstrap now materializes the parallel node frame/group,
  branch frames, branch members, and branch leaf instances when every branch
  contains one or more scheduler-visible leaves in sequence. Multi-leaf branch
  members use the branch frame key as `memberKey`, so group concurrency and
  race/all accounting apply to the branch rather than to an individual leaf.
- Unsupported root parallel shapes, including branches with pure nodes before
  the first leaf, fall back to root-frame-only bootstrap so the scheduler does
  not create partial groups that can falsely complete.
- Root parallel branch continuation now schedules the next leaf in a running
  branch frame only after the previous leaf commits. The runner maps child
  instances back to their parent branch member, so local `maxConcurrency` counts
  the branch slot once while still allowing sequential work inside that branch
  to continue.
- Root parallel branch materialization now completes the composite frame after
  the durable group completes. `parallel all` frame output is branch-id keyed and
  evaluates each branch's declared `ScopeIR.outputs`; `parallel race` records
  winner branch id plus winner output for the narrow supported shape.
- Root parallel `maxConcurrency` is enforced by the internal runner for the
  narrow materialized root parallel case, using the frozen IR's static group key
  mapping rather than adding speculative event fields.
- Root `fanout` bootstrap now materializes item frames, item members, and item
  leaf instances when `over` evaluates to an array and the `do` scope contains
  one or more scheduler-visible leaves in sequence. Multi-leaf item members use
  the item frame key as `memberKey`, so fanout concurrency/quorum accounting
  applies to the item rather than to an individual leaf. `group.member_ready`
  carries the durable item value, and the runtime node executor rebuilds
  `fanout.<nodeId>.item/itemIndex` scope from the scheduler projection.
- Root fanout `all` and `quorum` execute supported item bodies with one or more
  scheduler-visible leaves in sequence, including item-scoped task inputs,
  durable `item_json` projection storage, quorum cancellation of unstarted
  items, and root fanout `maxConcurrency`.
- Fanout item scope coverage now closes and reopens the runtime store between
  scheduler drives to prove item scope is rebuilt from durable events rather
  than in-memory executor state.
- Root fanout guardrails reject duplicate item keys and avoid partial group
  materialization for non-array `over` and non-leaf `do` shapes.
- Root fanout item continuation now schedules the next leaf in a running item
  frame only after the previous leaf commits. Executor scope includes completed
  prior leaf outputs from the same frame, which lets later item tasks read
  `nodes.<priorLeaf>.output` and durable fanout `item/itemIndex` together.
- Root fanout quorum coverage now includes active loser cancellation where an
  already-started item observes scheduler abort after quorum is reached.
- Root fanout materialization now completes the composite frame after the
  durable group completes. `fanout all` frame output is item-index ordered body
  output; `fanout quorum` frame output records `accepted` and `completed`
  outputs by durable completion sequence.
- Non-array fanout failure propagation remains pending.
- Root `loop` bootstrap and continuation now support loop bodies with one or
  more scheduler-visible leaves in sequence. Single-leaf loops keep the direct
  leaf path; multi-leaf loops create a durable `loop_iteration` frame for each
  iteration and evaluate the body `ScopeIR.outputs` from that frame before
  applying `stopWhen`.
- The internal runner materializes iteration 0, rebuilds
  `loop.<nodeId>.iter/previous` scope for leaf executors, records
  `frame.loop_advanced` after each completed iteration, evaluates `stopWhen`
  from durable projection state, and materializes the next iteration or terminal
  loop frame.
- Loop iteration result is computed from the loop body's `ScopeIR.outputs`
  using durable `nodes.<leaf>.output`, not from the raw leaf output. Integration
  coverage uses a transformed task output to protect this distinction.
- `frame.loop_advanced` reducer checks iteration continuity: loop progress
  starts at iteration 0, cannot skip forward, and the next iteration's
  `previous` matches the prior iteration result.
- Loop resume coverage now closes and reopens the runtime store between
  iterations, proving `loop.iter/previous` executor scope is rebuilt from
  durable events/projection.
- Root loop guardrails avoid partial materialization for non-leaf loop bodies.
- Loop continuation currently covers root loop frames only. Nested loops and full
  retry-from-zero behavior remain pending.
- Root leaf/composite completion now records `frame.completed(root)` after the
  root sequence finishes and drives scheduler projection run terminal status
  from the root frame. The store bridge mirrors terminal scheduler state into
  the public `runs` read model.
- Root scope sequencing now materializes the next supported root node only
  after all prior root nodes are completed, rebuilds prior root outputs from
  durable projection for later task input evaluation, and completes the root
  frame only after every root node is completed.
- Root `assert` nodes now materialize as scheduler frames. Passing assertions
  complete with `assert_passed`; failing assertions fail the assert frame and
  then propagate through root terminal derivation.
- Root `if` and `switch` now persist a `branch.decided` event, create only the
  selected branch frame, and resume from the durable decision rather than
  re-evaluating the condition. Empty selected branches complete from branch
  `ScopeIR.outputs`; single scheduler-visible leaf branches complete the branch
  frame after the leaf commits.
- Root assert, conditional, branch, parallel, fanout item, and loop frames now
  carry structured `instancePath` in scheduler events and projection rows, so
  frame identity remains reconstructable from durable state rather than only
  from derived keys.
- Root conditional branch output uses the selected branch's declared
  `ScopeIR.outputs` evaluated in that branch lexical scope, then exposes the
  conditional frame result as `nodes.<conditionalId>.output` to later root
  nodes.
- Conditional coverage now includes reopening the store after `branch.decided`
  and selected branch materialization but before the branch leaf runs, then
  continuing from the durable decision. Unit coverage also checks selected leaf
  failure and cancellation propagation through branch, conditional node, and
  root frames.
- Selected conditional branches now support one or more scheduler-visible leaf
  nodes in sequence. The selected branch frame stores a full lexical scope map,
  materializes one leaf at a time, evaluates branch `ScopeIR.outputs` after all
  branch leaves complete, and then exposes the conditional frame result to
  later root nodes.
- Unsupported selected conditional branch shapes, including pure nodes before
  the first leaf or nested composites, remain unmaterialized so the scheduler
  does not create partial branch state that can falsely complete.
- Broader nested branch/composite materialization wiring is still pending.

### Phase 5: Leaf Attempt Lifecycle

- [x] Refactor task and agent execution behind a scheduler `NodeExecutor` that
  runs one scheduler-visible attempt.
- [x] Move node-level retry and timeout lifecycle to scheduler-owned attempt
  state.
- [x] Keep agent executor sub-attempt metadata separate from scheduler-visible
  attempt identity.
- [x] Make leaf attempt startup durable-first.
- [x] Add durable deadlines for task/agent attempts.
- [x] Write attempt-local artifacts under dynamic node key and attempt-specific
  subpaths.

Exit criteria:

- [x] Attempt lifecycle tests cover started, completed, failed, timed out,
  cancelled, superseded, retryable failure, terminal failure, and late commit
  rejection.
- [x] Scheduler-backed command agents run one agent-executor sub-attempt per
  scheduler-visible attempt.

Phase 5 implementation notes:

- Added runtime-internal `createRuntimeNodeExecutor` adapter that executes one
  scheduler-visible leaf attempt by static `nodeId` and dynamic `nodeKey`.
- Task execution can now receive scheduler attempt context: dynamic `nodeKey`,
  scheduler `attemptNo`, and scheduler abort signal.
- In scheduler attempt mode, task execution runs one invocation and does not
  consume `node.retry` internally; scheduler remains responsible for visible
  node retry.
- In scheduler attempt mode, command-backed agent execution also receives a
  single-attempt boundary for `node.retry`; runtime scheduler retry policy owns
  visible node retry, while provider/output retry remains an executor-internal
  concern independent of `node.retry`.
- Task runtime context, artifact registration, output directories, and work
  directories now use dynamic `nodeKey` when provided.
- Scheduler abort signals now propagate to task execution and command-backed
  agent attempts.
- Added integration coverage for dynamic task runtime context/artifacts and for
  one task invocation per scheduler-visible attempt. Agent executor coverage
  verifies pre-aborted and actively aborted command-backed attempts.
- Added integration coverage that bootstraps a frozen root task into scheduler
  projection and executes it through the internal `advanceFrozenRun` helper
  using the admitted frozen IR and the derived dynamic node key. The helper
  remains runtime-internal and now also covers sequential root scopes with
  narrow root parallel, fanout, and loop composites.
- `advanceRun` accepts an internal bootstrap callback for adding initial
  reducer-backed scheduler events after a run owner claim. The scheduler core
  still receives events through the store port rather than depending on frozen
  runtime storage directly.
- Bootstrap append reloads once on a scheduler version mismatch so a concurrent
  scheduler event before first materialization can be observed before deciding
  whether root bootstrap is still needed.
- SQLite integration coverage now drives the same admitted frozen run twice and
  verifies that root bootstrap events, node attempts, and artifacts are not
  duplicated. The second drive now proves a real new owner epoch is claimed
  after `advanceRun` releases its run lease.
- Durable attempt deadline derivation now emits `attempt.timed_out`, matching
  dynamic instance failure, and direct group member failure before scheduling new
  work. The advance loop also aborts active executors when durable projection
  marks their instance failed.
- Derived transitions now drain by priority instead of batching competing
  terminal outcomes from one snapshot: group completion/cancellation is applied
  before attempt deadlines, and attempt deadlines before signal timeouts.
- Coverage now includes overlapping group cancellation versus attempt timeout,
  expired old-owner deadlines before recovery supersede in SQLite, recovery
  re-drive for non-expired old-owner attempts, and stale late commits after a
  durable timeout.
- Scheduler-owned retry policy now derives retry requeue events for failed
  dynamic task and agent instances before composite terminal derivation. The
  frozen-run adapter maps static leaf `retry.max` to a maximum count of
  scheduler-visible attempts, so retryable failures are requeued through
  `instance.retry_requested` and direct group members through
  `group.member_retry_requested` instead of being retried inside the executor.
- Coverage now proves a failed `parallel all` member is requeued before group
  fail-fast, a task with `retry.max` produces distinct failed and completed
  scheduler attempts, and a scheduler-visible agent attempt does not spend
  `node.retry` inside one executor call.
- Scheduler attempt start now accepts a derived `deadlineAt` value. The
  frozen-run adapter maps task and agent leaf `timeout` durations to durable
  attempt deadlines, so recovery and deadline derivation can reason from
  scheduler state instead of only executor-local timers.
- V1 keeps in-flight timeout enforcement inside the task/agent executor; the
  durable deadline covers recovery, stale attempts, and later deadline wakeups
  rather than introducing a separate background timer in `advanceRun`.
- Coverage now proves scheduler core stores derived attempt deadlines before
  executor work starts, and a real timeout-bearing task persists the expected
  `node_attempts.deadline_at` value.
- Task attempt-local `runtime.outputDir`, `runtime.workDir`, and artifact files
  now live under `attempt-<n>` subpaths beneath the dynamic `nodeKey`, while the
  registry keeps the same `node_key` and numeric `attempt` columns.
- Coverage now proves a failed scheduler-visible task attempt and its retry write
  artifacts to distinct attempt subdirectories.
- Command-backed agents now receive scheduler runtime identity through
  `ACPUS_RUNTIME_RUN_ID`, `ACPUS_RUNTIME_NODE_ID`, `ACPUS_RUNTIME_NODE_KEY`, and
  `ACPUS_RUNTIME_ATTEMPT` environment variables injected by the runtime wrapper.
  This stays separate from `ACPUS_AGENT_ATTEMPT`, which remains the agent
  executor's internal provider/output sub-attempt counter.
- `ACPUS_RUNTIME_*` variables are runtime-owned: the wrapper overwrites known
  context values and deletes absent optional values before invoking the command,
  so stale host or node env cannot create a mixed scheduler identity.
- Scheduler-backed command agents currently run one agent-executor sub-attempt
  per scheduler-visible attempt. A future output-conformance retry policy is
  intended to remain internal to that executor boundary rather than becoming a
  user-visible retry.

### Phase 6: Controls, Signals, And Recovery

- [x] Wire pause as durable gate plus best-effort active attempt cancellation.
- [x] Wire resume to clear the pause gate and wake `advanceRun`.
- [x] Wire retry commands for failed terminal runs and dynamic instances only.
- [x] Wire signal admission with normalized payload storage and idempotency.
- [x] Wire signal consumption, signal timeout deadlines, and signal/timeout
  race ordering.
- [x] Wire supervisor lease recovery to mark expired-owner running attempts as
  superseded before re-driving eligible work.

Exit criteria:

- [x] Pause tests prove no new work starts while paused, active attempts receive
  abort, late results are rejected, resume can re-drive, and lease recovery does
  not start work under a pause gate.
- [x] Signal and retry tests cover exact instance targeting, ambiguous static
  aliases, idempotency, already-consumed payloads, and invalid targets.

Phase 6 implementation notes:

- `advanceRun` now supersedes started attempts owned by expired owner epochs
  after the new owner claims the run and after expired attempt deadlines are
  drained. Remaining old-owner attempts are superseded and their running
  dynamic instances/direct group members are requeued so recovery can re-drive
  eligible work.
- Added unit and SQLite integration coverage for lease recovery superseding
  old-owner attempts and rejecting stale late commits.
- `advanceRun` now drains expired signal wait deadlines into
  `signal.timed_out` and matching failed dynamic signal instances before
  returning awaiting/idle summaries.
- Scheduler store signal consumption now records `signal.consumed` and the
  matching dynamic instance completion in one reducer-backed transaction, with
  command idempotency and timeout/consume race rejection covered by SQLite
  integration tests.
- Signal consumption now also completes a matching ready or running group member
  for fanout/parallel signal leaves. The member completion sequence records the
  `group.member_completed` event position, so fanout signal bodies can advance
  to group and frame completion after all required signals are consumed.
- Signal target resolution treats a wait as open only when the signal wait and
  its matching dynamic node instance are both awaiting. This lets race losers
  keep historical wait projection rows for inspection without making them
  consumable after the branch instance has been cancelled.
- Adversarial review found and fixed a signal replay bug for signal waits that
  are also running group members. Repeated signal delivery now replays from the
  consumed wait when the command idempotency key and payload match, including
  when the first delivery completed a group member.
- Scheduler store pause intent now records `control.paused`, cancels
  scheduler-visible started attempts with reason `paused`, and requeues the
  matching running dynamic instance and direct group member so resume can
  re-drive work instead of treating pause as terminal cancellation.
- Pause gate hardening now rejects `startAttempt` and signal consumption while
  paused, aborts active work that observes pause/requeue through the advance
  loop monitor, and rejects malformed requeue events while a matching attempt is
  still started.
- Scheduler store dynamic instance retry now requeues only failed dynamic
  instances and matching direct failed group members through reducer-backed
  retry events. Retry idempotency is bound to the dynamic `nodeKey`, and direct
  group members are failed before a matching instance retry can proceed.
- Pause gate is respected by `advanceRun` when the durable projection is already
  paused.
- `advanceRun` now releases its run lease when the drive finishes or throws, so
  immediate follow-up scheduler drives and durable control commands are not
  forced to wait for lease expiry.
- Added an internal durable scheduler control adapter for already-admitted
  commands. It claims a run owner epoch, applies pause/resume/retry/signal
  intents through `SchedulerStorePort`, marks the command applied or failed,
  and can re-drive the admitted frozen run after resume/retry/signal.
- If a scheduler control command cannot claim the run lease because another
  owner is active, the command is deferred back to pending instead of being
  marked failed. This keeps transient lease contention out of terminal command
  state.
- Internal control adapter coverage includes pause then resume re-drive, signal
  consumption against a dynamic node key, and dynamic failed-instance retry.
  Store-port coverage also checks wrong-owner and stale-owner release attempts
  do not release the active run lease.
- Internal control targeting now resolves dynamic instance keys first and uses
  static `nodeId` aliases only when the alias maps to exactly one relevant
  dynamic target. Retry aliases resolve among failed dynamic node instances;
  signal aliases resolve among open signal waits. Ambiguous aliases fail with
  candidate dynamic node keys instead of choosing heuristically.
- Pause coverage now includes pausing between sequential root nodes, proving a
  paused run does not materialize the next root node or start already-ready
  work, and resume can re-drive eligible work.
- Public admission and supervisor runnable-run advancement now use the
  scheduler-backed frozen-run advancement wrapper. The wrapper repeatedly
  advances a run while it is making progress, so sequential supported root
  nodes can reach terminal state from public admission or a supervisor tick.
- Public `applyControlCommand` now delegates scheduler-backed runs to the
  internal scheduler control adapter for pause, resume, signal, dynamic node
  retry, and failed run-level retry commands. Fork remains on the older public
  path.
- Public scheduler control delegation applies the durable intent first and then
  drains through the same runtime advancement wrapper used by admission and
  supervisor ticks, except pause which intentionally stops after setting the
  pause gate. This keeps signal/resume/retry public behavior from exposing a
  half-advanced scheduler step.
- Public pause, resume, and signal commands now use per-call command
  idempotency keys. Scheduler event idempotency remains internal, while each
  user control action is admitted as a fresh durable intent. This avoids stale
  applied or failed command rows swallowing later valid controls, such as
  `pause -> resume -> pause` or an ambiguous static signal alias becoming
  unique after a dynamic signal is consumed.
- Missing provider or executor prerequisites now surface as failed scheduler
  runs rather than durable blocked state on the public admission path.
- Scheduler run-level retry is represented by a typed
  `control.run_retry_requested` event. It is accepted only from failed
  scheduler runs, resets the current scheduler projection to a clean pending
  materialization point, clears public output and stale public node state, then
  re-drives through the frozen-run advancement wrapper. Historical failure
  facts remain in `run_events`; replay audits use the latest terminal event
  after retry rather than assuming a run has at most one terminal public event.

### Phase 7: Runtime Reads, Fork, Replay, And Visualization Overlay

- [x] Update runtime read APIs to expose dynamic instance state where needed
  while preserving clean static summaries for simple runs.
- [x] Update retry/signal error responses to include candidate dynamic instance
  keys for ambiguous static aliases.
- [x] Update fork to inherit compatible completed accepted outputs and reachable
  artifacts, not active frames or attempt history.
- [x] Update replay to rebuild scheduler projections from events and compare
  projection state.
- [x] Add a view helper that combines static `WorkflowIR` with runtime
  projection/event overlay for visualization.

Exit criteria:

- [x] Fork integration tests cover accepted-output artifact reachability and
  exclude failed/superseded attempt artifacts.
- [x] Replay integration tests catch projection mismatch, artifact mismatch, and
  terminal event conflicts for the new scheduler projections.

Phase 7 implementation notes:

- Scheduler projection terminal state now bridges into the public run projection
  inside the scheduler store transaction. Root `frame.completed` updates
  `runs.status`, persists `run_inputs.output_json`, and writes one public
  `run.completed` event. Root `frame.failed` updates `runs.status`, clears
  public output, and writes one public `run.failed` event.
- Non-terminal scheduler state now updates public run status for paused,
  awaiting, and pending scheduler states without creating terminal run events.
  This lets `getRun` and `listRuns` reflect scheduler-driven root completion,
  failure, signal awaiting, and signal completion for the current narrow
  scheduler slice.
- Replay now rebuilds scheduler projection state from typed scheduler events and
  compares it against `scheduler_frames`, `node_instances`, `node_attempts`,
  `group_members`, and `signal_waits` without mutating stored state. Replay
  also reports unreplayable scheduler event streams, such as late terminal frame
  conflicts, malformed scheduler event envelopes, and unreadable projection
  table JSON as projection issues instead of repairing or throwing. Projection
  tables left behind after scheduler event loss are compared against an empty
  rebuilt scheduler projection and reported as drift.
- Visualization overlay now has a pure
  `createWorkflowVisualizationOverlay(ir, dynamic)` helper and a read-only
  `getRunVisualizationOverlay(cwd, runId)` use case. The overlay combines
  static `WorkflowIR` node paths with runtime dynamic frames, instances,
  attempts, group members, and signal waits without adding layout or UI-specific
  view state. The public bridge now mirrors completed dynamic node instances
  into `node_states` and exposes a static `nodeId` alias only when exactly one
  completed dynamic instance has that static id, which keeps simple public
  output/fork paths working while avoiding ambiguous dynamic guesses. Replay
  still uses the public `node_states` actual-output path for workflow output
  comparison, with scheduler projection validation as a separate audit.
- `getRun` now includes an optional `dynamic` read summary when scheduler
  projection rows exist and can be read. The summary exposes `version`, frames,
  dynamic node instances, attempts, group members, and signal waits as read-only
  runtime state, while legacy/simple runs or unreadable scheduler projections
  keep the previous compact shape.
- Same-workflow public fork now preserves inherited completed dynamic node
  state alongside copied dynamic artifacts, so simple scheduler-backed completed
  forks can still replay through the current public `node_states` path.
  Replacement workflow forks remain conservative: dynamic source instance keys
  are not treated as compatible just because both old and new static signature
  maps lack that dynamic key.
- Fork artifact inheritance now copies only artifact ids reachable from
  inherited completed outputs, then prunes non-selected files from the copied
  run directory. Failed or superseded historical attempt artifacts under the
  same dynamic node key are not copied into the fork.

### Phase 8: Specs, Cleanup, And Verification

- [x] Remove or rewrite tests that only encode the old static-node scheduler
  behavior.
- [x] Update `specs/runtime-spec.md` after the durable scheduler behavior is
  implemented.
- [x] Keep roadmap rationale in roadmap docs and current behavior in specs.
- [x] Run narrow runtime checks during development and broader checks before
  handoff.

Suggested verification:

- [x] `pnpm test:unit -- packages/runtime/test`
- [x] `pnpm test:integration -- packages/runtime/test`
- [x] `pnpm --filter @acpus/runtime typecheck`
- [x] `pnpm test`
- [x] `pnpm typecheck`

Exit criteria:

- [x] Runtime tests cover scheduler unit rules and SQLite integration risks.
- [x] Specs describe the delivered scheduler behavior without documenting old
  behavior as compatibility.
- [x] Final handoff records every verification command that passed or could not
  be run.

Phase 8 implementation notes:

- Public admission integration tests now assert durable scheduler current
  behavior instead of the old two-event/static-node-state model.
- The representative workflow compiler fixture assertion now matches the current
  lowered fallback literal used by the fixture.
- `specs/runtime-spec.md` now describes the delivered durable scheduler behavior:
  event-backed scheduler projection tables, dynamic `nodeKey` identity,
  scheduler-visible attempts, controls, signal targeting, replay validation,
  dynamic run details, and visualization overlay reads.
