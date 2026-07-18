# Scheduler Work Conservation And Nested Concurrency

This archived roadmap records the completed closure of the scheduler's
fixed-wave and nested-concurrency gaps. Current product requirements live in
[`specs/runtime-spec.md`](../../../specs/runtime-spec.md); this record retains
the diagnosis, selected implementation shape, TDD delivery slices, and final
verification evidence.

**Implements with Clean Code and Good Test @AGENTS.md**

## Status

- [x] Reproduce heterogeneous-duration under-utilization with checked Tasks.
- [x] Confirm the fixed executable wave as the refill failure.
- [x] Confirm duplicate ancestor charging by descendant leaf rather than direct
  member identity.
- [x] Confirm independent nested caps after outer members are running.
- [x] Reproduce both 1000-step failures during valid durable progress.
- [x] Select the concurrency, wakeup, control, recovery, and fencing contract.
- [x] Freeze the selected contract in the Runtime spec.
- [x] Implement identity-aware admission and the owner-local completion pump.
- [x] Implement the production `RunExecution` seam without an `idle` exit.
- [x] Implement versioned control wakeup and stale-plan CAS handling.
- [x] Fence attempt results, artifact registration, and progress writes.
- [x] Add focused regression coverage for admission, refill, nested Signals,
  controls, recovery, fencing, and frozen workflow execution.
- [x] Remove count-only failure guards from control and due-Signal settlement,
  and cover production/control progress beyond 1000 batches.
- [x] Scope cooperative yielding and ownership recheck to claimed production
  run-execution drains; keep control settlement synchronous and count-unbounded.
- [x] Add the focused production-seam invariant regression described below.
- [x] Pass the merged-state integration gate (345 tests).
- [x] Resolve or explicitly disposition every post-implementation audit finding
  recorded below.
- [x] Pass the final merged-state repository gates and investigate the test
  benchmark.
- [x] Move this record to the archive and update the roadmap indexes after the
  final handoff.

## Confirmed Problem

The pre-change scheduler selected one fixed executable array and waited for
every promise in that array. A completed short attempt released capacity in
durable state, but the scheduler did not select replacement work until the
slowest attempt in the same array settled.

The checked `Parallel(2) -> Fanout(3)` workflow reached the expected peak of
six Tasks, yet heterogeneous durations left ready work idle for most of the
run:

| Interval | Active Tasks | Observation |
| --- | ---: | --- |
| `0.0s-0.7s` | 2 | Initial wave starts. |
| `0.7s-6.2s` | 1 | Fourteen instances remain ready without refill. |
| `6.2s-6.9s` | 4 | A later wave starts after the long attempt settles. |
| `6.9s-11.4s` | 1 | Ready work again waits behind one long attempt. |
| `11.5s-12.1s` | 6 | The nested peak is eventually reached. |

The same implementation shape created two related correctness gaps:

- selection counts an outer group by descendant leaf, so two leaves beneath
  one not-yet-active branch can consume two outer slots;
- progressing runs and materialization chains fail when they cross the two
  internal 1000-step limits, even though each step advances durable state.

Focused experiments established the boundary:

| Experiment | Result |
| --- | --- |
| Run cap two, gated + short + next | `next` did not start after `short` settled. |
| Fanout cap two, gated + short + next | Local capacity was not refilled. |
| Two leaves under branch A, one under branch B | The first admission charged A twice. |
| Two running outer branches, inner cap three | Each inner group independently reached three. |
| 1001 progressing runtime drives | Drive 1000 failed before valid completion. |
| 1001 progressing derived batches | Batch 1000 failed before quiescence. |
| Existing race cancellation and pause abort | Durable state remained correct. |
| Existing nested Signal coverage | Awaiting retained its local member slot. |

## Selected Model

### State Ownership

| State | Owner | Lifetime |
| --- | --- | --- |
| readiness order, groups, members, attempts, controls, deadlines | durable scheduler projection | survives recovery |
| logical leaf occupancy | durable `started` attempts | survives recovery until terminal or superseded |
| physical leaf occupancy | unsettled executor invocations launched by one owner epoch | discarded with that owner session |
| executor promises and abort controllers | owner-local completion pump | one claimed session |
| latest control wakeup version | owner-local run session | one claimed session |

The durable store remains the only scheduling truth. The completion pump does
not retain a backlog of work that has not durably started.

### Direct-Member Admission

Admission scans ready leaves by durable readiness sequence and `nodeKey`. For
each leaf it evaluates the run gate and every ancestor group. Local occupancy
is represented by distinct `(groupKey, memberKey)` identities:

- several descendants beneath one branch charge that outer branch once;
- separate Fanout items charge their Fanout independently;
- ancestor and descendant caps compose without sharing counters;
- an older leaf blocked by one group does not block a later leaf whose groups
  have capacity.

The run gate checks two views before starting Task or Agent work:

- logical occupancy from durable `started` attempts;
- physical occupancy from the current owner's unsettled executor invocations.

A Signal passes the same ancestor-group admission checks. Entering `awaiting`
holds the applicable direct-member slots, but neither the ready Signal nor its
wait consumes logical or physical run-wide leaf capacity.

### Owner-Local Completion Pump

The production run-execution seam is
`createRuntimeRunScheduler(...).start({runId,ownerId})`. It returns one
`RunExecution` with the claimed `ownerEpoch`, a `result`, a level-triggered
`wake()`, and owner-local `stop()`. Internally, one claimed run execution
repeatedly:

1. drains durable derived transitions;
2. computes the oldest admissible ready work;
3. durably starts work while logical, physical, and group capacity remain;
4. launches only work that has durably started;
5. waits for one executor settlement, a newer control wakeup version, or lease
   loss;
6. commits and drains the observed effect;
7. immediately returns to admission.

The pump has no fixed wave barrier. `RunExecution.result` resolves only after
durable state and owner-local executions justify `completed`, `failed`,
`canceled`, `paused`, `awaiting`, or `lease_lost`; `RunExecutionExit` has no
`idle` variant. A non-terminal state with neither an owner-local active
executor nor a durable wake source rejects `result` as an invariant failure.

The implementation uses an owner-local map of active promises plus completion
and wakeup races. A general-purpose in-memory promise queue is not part of the
selected scheduler seam because it would duplicate durable ordering and retain
work that controls or recovery can invalidate.

### Library Decision

No new concurrency dependency is selected. Mature flat limiters and promise
queues can bound an in-memory launch function, but they do not own the Runtime's
direct-member identity, independent nested caps, durable logical occupancy,
snapshot CAS, control wakeup, lease recovery, or stale-write fences. Putting
ready work into such a queue would create a second scheduling truth beside the
durable projection.

A library could be added later only as an owner-local physical safety limiter
at the executor boundary. The current completion map already supplies that one
cap without an additional abstraction or dependency, so adding one now would
not simplify the selected model.

### Control Wakeup And Admission CAS

After every successful durable control mutation commits, the daemon increments
the active execution's owner-local monotonic wakeup version. The pump compares
that level-triggered counter with its previously observed wakeup version before
sleeping or resolving the session, so a control between planning, yielding,
waiting, and exit cannot be lost.

Attempt start and its replay identity use the snapshot version that produced the
admission decision. A version mismatch reloads state and recomputes admission.
This makes pause, targeted cancellation, Signal delivery, and other concurrent
controls win through normal durable ordering rather than an in-memory queue
race.

Pause and untargeted run cancel commit their durable fence without first
settling unrelated derived work. Pause then aborts applicable owner-local
executors, completes bounded cleanup, and ends the claimed session. Resume and
retry start a new session and claim a new `ownerEpoch` only when that control
actually reopens durable work. A no-op or idempotently replayed control keeps
the current session and owner epoch. No additional scheduling epoch or
persisted queue generation is introduced.

### Attempt-Scope Fences

An executor mutation is accepted only while its `(attemptId, ownerEpoch)` still
identifies the current `started` attempt. The same fence applies independently
to:

- attempt result commit;
- artifact registration;
- progress writes.

Late writes after timeout, cancellation, pause, retry, or owner supersession
leave scheduler state, the artifact registry, and progress projection
unchanged. Attempt-local files can require cleanup separately; an unregistered
file is not a durable public artifact.

Execution metadata is intentionally outside this acceptance fence. It is
append-only attempt history for inspection and auditing, not an input to
scheduler admission, accepted output, or authoritative public attempt status.

### Recovery Boundary

A recovered owner first settles already-due authoritative attempt deadlines,
then durably supersedes the remaining expired-owner started attempts before it
recomputes admission. Superseded attempts no longer consume logical capacity.

Physical capacity is owner-local. Lease failover can briefly overlap a stale
external process with replacement work when the stale process cannot be
observed or stopped. Durable owner/attempt fences prevent the stale process from
publishing accepted results, artifacts, or progress. External side effects
remain subject to the Runtime contract's existing at-least-once boundary.

### Progress Without Count-Only Failure

The outer repeated-drive loop collapses into the continuous pump. Both its pump
turns and derived-transition drain use a bounded cooperative quantum, yield to
the event loop, and recheck stop/ownership before continuing. Control settlement
also permits more than 1000 progressing derived batches and remains a
synchronous single-CAS helper outside that yield contract. Due-Signal settlement
likewise drains to quiescence without a count-only cutoff. Crossing an internal
count while state keeps progressing is not treated as non-convergence.

## TDD Delivery Slices

Each slice starts with the lowest-layer red test and keeps the implementation
change local to the scheduler or store seam.

| Slice | Implementation | Focused regression | State |
| --- | --- | --- | --- |
| 1. Admission ordering and member identity | complete | complete | complete |
| 2. Continuous Task refill | complete | complete | complete |
| 3. Nested refill and Signal admission | complete | complete | complete |
| 4. Versioned wakeup and stale admission | complete | complete | complete |
| 5. Pause, resume, retry, and early termination | complete | complete | complete |
| 6. Artifact and progress fences | complete | complete | complete |
| 7. Lease failover and dual capacity | complete | complete | complete |
| 8. Progress scale and cooperative yield | complete | complete | complete |
| 9. Frozen workflow confirmation | complete | complete | complete |
| 10. Production `RunExecution` boundary | complete | complete | complete |

### Slice 1 — Pure Admission Ordering And Member Identity

**Risk:** one direct member is charged more than once, or an inadmissible old
leaf blocks unrelated work.

**First red tests:** exact selected `nodeKey` order for two descendants under
branch A plus one leaf under branch B; exact selection when the oldest leaf is
locally blocked and a later leaf is admissible.

**Implementation:** extract identity-aware admission using sets of direct
member identities and durable FIFO sorting.

**Exit oracle:** selection never exceeds any cap, charges each group/member
pair once, and returns the oldest admissible leaves.

### Slice 2 — Continuous Task Refill

**Risk:** the fixed-wave barrier remains after the admission helper changes.

**First red test:** under run cap two, `slow` and `short` start first and `next`
starts after `short` settles but before the `slow` gate is released.

**Implementation:** replace the fixed `Promise.all` array with the owner-local
completion pump and serialize durable transition drains after settlements.

**Exit oracle:** the exact start order is `slow, short, next`; active physical
and logical counts never exceed two.

### Slice 3 — Nested Refill And Signal Admission

**Risk:** direct-member fixes work for Tasks but Signal waits consume a run
slot or bypass a group cap.

**First red tests:** `Parallel(2) -> Fanout(3)` refills to six across uneven
Task durations; a Signal enters awaiting while the run Task cap is full when
its group has capacity; another Signal remains ready when its group is full.

**Implementation:** separate group admission from Task/Agent leaf-slot
admission and retain awaiting member lifecycle in durable group state.

**Exit oracle:** Signals consume group member slots only, and nested Task peaks
compose without cross-charging.

### Slice 4 — Versioned Wakeup And Stale Admission

**Risk:** a Signal or targeted cancel commits while the pump sleeps behind an
unrelated long attempt, or a pre-control plan starts afterward.

**First red tests:** Signal delivery wakes a session and starts newly ready work
before the long attempt settles; a version-changing control between selection
and attempt start forces reload and prevents stale start.

**Implementation:** add the owner-local versioned wakeup and snapshot-version
CAS at attempt start.

**Exit oracle:** no lost wakeup and no attempt starts from a stale admission
snapshot.

### Slice 5 — Pause, Resume, Retry, And Early Termination

**Risk:** a paused session retains ownership, or race/quorum cancellation waits
behind unrelated executor completion.

**First red tests:** pause aborts and releases the session before resume claims
a greater owner epoch; retry uses a fresh owner epoch; race/quorum settlement
aborts losers and refills unrelated admissible work.

**Implementation:** connect control completion to the pump wakeup and preserve
durable-first abort ordering.

**Exit oracle:** no pre-control work starts, late results remain stale, and the
new session alone advances the run.

### Slice 6 — Artifact And Progress Fences

**Risk:** stale executors cannot commit a result but can still publish an
artifact or overwrite current progress.

**First red tests:** timeout, targeted cancel, pause, retry, and expired-owner
supersession each reject later artifact registration and progress writes.

**Implementation:** carry owner identity through attempt-scoped mutation input
and validate the current started attempt in the same store transaction.

**Exit oracle:** stale writes add no registry row, change no node progress, and
do not advance progress version.

### Slice 7 — Lease Failover And Dual Capacity

**Risk:** replacement work starts before durable supersession, or recovery
counts only the new owner's in-memory executions.

**First red test:** recover a projection containing expired-owner started work,
observe supersession before replacement start, and prove the new owner respects
both the post-supersession logical count and its local physical count.

**Implementation:** keep recovery admission after supersession and expose the
physical overlap boundary only through stale-write fencing.

**Exit oracle:** no duplicate accepted attempt and no capacity violation inside
the recovered owner epoch.

### Slice 8 — Progress Scale And Cooperative Yield

**Risk:** valid large Fanouts, Loops, or materialization chains retain an
undocumented 1000-step failure.

**First red tests:** more than 1000 progressing derived batches and more than
1000 sequential leaf transitions complete without a count-only error.

**Implementation:** production run advancement yields after a bounded
processing quantum and rechecks ownership. Control settlement no longer has a
count-only guard, its focused 1001-batch regression passes, and it remains a
synchronous single-CAS helper outside the production `RunExecution` yield
contract. The store's due-Signal settlement path also drains without its former
1000-batch cutoff.

**Exit oracle:** production execution retains ownership through yield points,
control settlement exceeds 1000 progressing batches without a count-only
failure, due Signal timeouts settle without a count cutoff, and the run reaches
its authored terminal state.

### Slice 9 — Frozen Workflow Confirmation

**Risk:** scheduler-port behavior does not compose through materialization,
scope, real Task isolation, or public projection.

**First tests:** focused frozen-runtime nested Parallel/Fanout, Signal wakeup,
pause/resume, and failover scenarios using deterministic Tasks.

**Implementation:** adapter wiring only; scheduler semantics remain in the deep
run-level module.

**Exit oracle:** public run state and outputs match the Runtime contract while
measured utilization refills continuously.

### Slice 10 — Production RunExecution Boundary

**Risk:** the low-level `idle` checkpoint leaks through the daemon-facing seam,
silently ending ownership for a run that is non-terminal and has no durable
wake source.

**First red test:** construct that impossible production state through
`createRuntimeRunScheduler(...).start({runId,ownerId})` and assert that
`RunExecution.result` rejects instead of resolving an `idle` exit.

**Implementation:** keep `idle` internal to the low-level advancement helper;
the production factory returns `RunExecution`, exposes no `idle` in
`RunExecutionExit`, and converts that state into an invariant failure.

**Exit oracle:** production callers receive only `completed`, `failed`,
`canceled`, `paused`, `awaiting`, or `lease_lost`, and an impossible
non-terminal/no-wake state fails visibly.

## Post-Implementation Audit Findings

The implementation audit exposed four adjacent ownership/transaction gaps.
They did not change the direct-member or nested-cap model; each now has an
implemented or explicitly accepted disposition.

| Priority | Finding | Assessed root cause | Disposition |
| --- | --- | --- | --- |
| medium | An idempotent attempt-result replay could report success after the attempt owner became inactive. | The replay fast path ran before the active-owner fence. | closed — replay now validates the original attempt owner and its active lease; takeover replay is covered. |
| medium | Concurrent duplicate start/result calls through two store instances could miss the stable replay path. | The first idempotency lookup occurred before the write transaction. | closed — start/result replay lookup and validation now run inside `BEGIN IMMEDIATE`. |
| medium-low | A rejected Task artifact could leave an unregistered file if the child was force-killed before handling the rejection. | The child owned normal rejection cleanup while the parent owned bounded forced termination. | closed — the parent now removes a rejected artifact after validating attempt identity and the contained path. |
| decision | Execution metadata can be appended by a stale Agent attempt. | Metadata is intentionally historical rather than an accepted scheduler mutation. | accepted — metadata is append-only audit history; scheduler projection remains authoritative for admission, status, and accepted output. |

A post-implementation TDD review then exercised the production seams rather
than accepting the original layer-by-layer coverage:

| Finding | Experiment | Disposition |
| --- | --- | --- |
| Pause/run cancel could wait behind an unbounded pure derived drain. | A 1001-batch loop showed both controls settling the loop before their own fence. | closed — pause and untargeted cancel bypass unrelated settlement. |
| A wake or stop during a cooperative yield could be observed too late. | Deterministic `setImmediate` checkpoints reproduced stale exit and a drain continuing to batch 1001. | closed — exit reloads on a newer wake version and drain checkpoints observe stop. |
| Sequential immediate leaves did not share the derived-drain yield counter. | A controlled 1001-leaf session completed without yielding. | closed — pump turns now share a bounded cooperative quantum. |
| Fatal scheduler cleanup released its lease before an aborted executor settled. | A gated abort cleanup observed release before its completion. | closed — a still-owning session completes local cleanup before release. |
| A rejected session could be restarted against identical durable state. | A session mock rejected and the next daemon start launched the same run again. | closed — unchanged event state suppresses relaunch while other runs remain startable; durable change permits a retry. |
| Store fences lacked the exact lease-takeover oracle. | The old `(attemptId, ownerEpoch)` wrote after lease expiry but before supersede. | closed — artifact returns the owner fence and progress/versions remain unchanged. |
| A no-op or replayed Resume/Retry replaced the new active session. | Active-session mocks observed `stop()` and a second scheduler start despite no control-version change. | closed — the control seam reports whether the specific post-settlement mutation reopened work; only that disposition rotates the session. |
| `stop()` could arrive after a drain checkpoint but before admission. | A checkpoint callback requested stop and still observed one durable attempt start and executor call. | closed — the pump rechecks stop after checkpoint and before selecting work. |
| An orphan awaiting instance was treated as a durable wake source. | A projection with `instance.awaiting` but no open Signal wait returned `awaiting`. | closed — only an awaiting durable Signal wait justifies the session exit. |
| Equal-readiness ordering depended on the host locale. | Upper/lower-case node keys selected locale order rather than ordinal order. | closed — the final `nodeKey` tie-break uses code-unit comparison. |
| Recovery CAS and stale admission reload lacked direct pump/store oracles. | Correct-owner recovery used a stale expected version, and admission was invalidated immediately before start. | closed — recovery returns tagged `version-mismatch`; the pump reloads to paused state and never calls the executor. |
| A rejected old session could leave its failure fence on the replacement session. | Resume reopened work while the old execution rejected during stop; an awaiting replacement then remained blocked at two scheduler starts instead of a third. | closed — every newly launched execution clears the previous process-local failure fence, while ordinary start still blocks unchanged failures. |

## Accepted Residual Boundaries

- Execution metadata may contain a late historical observation from a stale
  attempt. It cannot drive admission or override authoritative scheduler status
  and accepted output.
- Target-dependent Signal, retry, resume, and targeted-cancel settlement can
  briefly monopolize the event loop during an unusually long pure derived
  drain. Pause and untargeted cancel do not wait behind it. Making every target
  control interruptible would require an asynchronous, claim-aware control
  seam and is not justified by the current risk.
- A deterministic two-Store concurrency regression would require an internal
  barrier inside the SQLite transaction implementation. Transaction-local
  idempotency lookup plus sequential identity coverage is retained instead of
  adding a timing-dependent Worker test.
- Hook checkpoints still load historical execution metadata when constructing
  effective Task/Agent context. No measured scheduler regression currently
  justifies adding an incremental metadata cache and its invalidation state.
- The unchanged-failure suppression is process-local. A daemon process restart
  may make one new recovery attempt because no durable fatal-state record is
  added; owner/attempt fences still protect accepted output. Persisting a new
  fatal scheduler state is not justified by the observed failure mode.

## Non-Goals

- No compatibility behavior for the archived YAML runtime.
- No author-facing batch, fairness, priority, or queue option.
- No weighted branch fairness or cross-run scheduling policy in this change.
- No persisted permits or in-memory backlog recovery.
- No exactly-once guarantee for external Task or Agent side effects.
- No real Agent calls in concurrency regression tests.

## Verification Plan

- `pnpm test:unit -- packages/runtime`: admission ordering, direct-member
  identity, refill, versioned wakeup, physical/logical caps, and daemon session
  use of the production scheduler factory.
- `pnpm test:integration -- packages/runtime`: nested frozen workflow refill,
  production no-wake invariant, SQLite CAS/fences, control settlement beyond
  1000 progressing batches, recovery, Signal, Task, artifact, and progress
  behavior.
- `pnpm test:contract -- packages/runtime`: public Runtime surface stability.
- `pnpm --filter @acpus/runtime typecheck`: internal interface consistency.
- `pnpm test`: complete repository behavior and the required material-test
  benchmark against the approximately ten-second baseline.
- `pnpm typecheck`: complete workspace type safety.

## Verification Results

| Gate | Result |
| --- | --- |
| `pnpm test:unit` | pass: 62 files, 612 tests |
| `pnpm test:integration` | pass in 7.75s: 30 files, 345 tests |
| `pnpm test` | three consecutive passes: 9.77s, 9.99s, and approximately 10.0s; regression 1/1, type 36/36, unit 612/612, e2e 5/5, contract 196/196, integration 345/345 |
| `pnpm typecheck` | pass |
| `pnpm check:dead-code` | pass |
| `pnpm build:clean` | pass |
| `pnpm test:dist` | pass |
| Real Task nested-concurrency smoke | 5/5 consecutive passes: peak 6; attempts 7 and 8 started before the two long gates were released; each local group stayed within 2/3/3 |

The first merged full test runs increased from the 9.216s measured baseline to
10.31-10.66s. Profiling identified the serial `daemon-lease` integration file
as the critical path: the real pause/resume and retry owner-epoch tests each
took about 1.0s. They retain the same daemon socket, SQLite lease, scheduler,
real Task process, and owner-epoch assertions, but now live in a separate
hermetic file and run concurrently in isolated workspaces. Five focused runs
passed, `pnpm test:integration` fell from 9.66s to 7.75-7.78s, and three
consecutive full runs completed in 9.77s, 9.99s, and approximately 10.0s. This
is roughly 0.55-0.8s above the original baseline and within the requested
ten-second budget.

Worker-count and shared-pool alternatives did not improve the critical path;
the shared-pool experiment was also less stable. The test orchestrator remains
unchanged. Lowering the owner-epoch tests to mocked executors would save little
full-suite wall time after the split while discarding the real IPC-abort and
lease-release oracle, so that tradeoff is rejected. The remaining measured
cost is accepted as risk-proportional integration coverage, not scheduler-loop
sleep or fixed-wave overhead.

## Exit Criteria

- Every selected Runtime requirement has a focused regression oracle.
- Production execution enters through
  `createRuntimeRunScheduler(...).start({runId,ownerId})`, never returns `idle`,
  and rejects a non-terminal state that has no active executor or durable wake
  source.
- Nested heterogeneous work continuously refills without exceeding logical,
  owner-local physical, or direct-member caps.
- Signal, race, quorum, timeout, pause, retry, cancellation, and recovery retain
  their durable semantics.
- Attempt results, artifact registration, and progress writes share the same
  stale-owner boundary.
- Valid progress beyond 1000 scheduler and control-settlement transitions
  completes without an internal count-only failure.
- Every post-implementation audit finding is either closed by a focused
  regression or captured as an explicit specification/non-goal decision.
- Narrow verification, full tests, typecheck, and the test benchmark pass.
- Only after all preceding conditions hold does this record move to
  `docs/roadmap/archive/`.

## Archive Summary

> Replaced fixed executable waves with a work-conserving owner-local completion
> pump; defined direct-member nested concurrency, versioned control wakeup,
> stale-plan CAS, dual logical/physical capacity, production no-idle execution,
> and attempt-scoped result/artifact/progress fences; removed count-only progress
> failures and verified heterogeneous `Parallel(2) -> Fanout(3)` refill.

The final gate commands and measured `pnpm test` duration are recorded above.
