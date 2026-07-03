# Replay Semantics Cleanup Goal

This goal records the decision to remove replay as a product concept and as a
runtime maintenance surface. It is a planning record, not current product truth.
Current implemented behavior continues to live in `specs/` until the cleanup
change lands.

**Implements with Clean Code and Good Test @AGENTS.md**

## Status

- [x] Product judgment accepted: replay is not a real user workflow capability.
- [x] Cleanup direction accepted: remove the replay noun and delete the replay
  verifier surface instead of renaming or parking it behind diagnostics.
- [x] Maintenance direction accepted: scheduler reducer tests and scheduler store
  integration tests own event/projection correctness after replay is removed.
- [x] Implement the cleanup in runtime, specs, and tests.
- [x] Remove replay-oriented runtime exports, store methods, helper functions,
  specs, and tests.
- [x] Rename scheduler idempotency test/helper wording from replay to duplicate
  so runtime code and tests no longer carry the removed product noun.
- [x] Mark the older replay verifier audit roadmap as superseded historical
  context rather than an active roadmap item.

## Problem

The current replay naming suggests that Acpus can re-run or simulate a workflow.
The implemented behavior does not do that. It reads durable state and checks
whether persisted facts, projection rows, and artifact files still agree.

That mismatch creates a shallow interface:

- users need to learn internal scheduler and projection concepts to interpret
  the result;
- normal product flows already have better commands: inspect, retry, fork,
  cancel, signal, and doctor;
- the replay label makes future semantics harder because it competes with
  resume, retry, fork, recovery, and deterministic execution.

The useful engineering concern is narrower: Acpus uses an event-plus-projection
runtime store, so the scheduler needs tests that prove normal event writes,
reducer application, projection-table synchronization, and rollback behavior are
correct. That concern belongs to the scheduler reducer and store write path, not
to a separate replay verifier.

## Goal

Clean replay out of the product vocabulary and delete the replay verifier
maintenance surface.

The target shape is:

- no user-facing replay command;
- no public product promise that a run can be replayed;
- no CLI output or docs that describe replay as workflow execution;
- no internal or narrowly exported replacement verifier such as run integrity,
  verify, or doctor-deep placeholders;
- scheduler reducer tests cover event-to-projection behavior through the reducer
  interface;
- scheduler store integration tests cover normal append/read/projection
  persistence behavior through the store interface.

## Final Maintenance Surface

No replay module is extracted. The remaining maintenance surface is the runtime
path that exists without replay:

- `applySchedulerEvents(createSchedulerProjection(runId), events)` as the pure
  reducer interface for event-to-projection rules;
- scheduler store append/start/commit/control methods that preflight event
  streams through the reducer, write scheduler events, synchronize projection
  tables, and roll back failed transitions in one transaction;
- focused reducer and store tests for branch, loop, retry, pause/resume,
  cancellation, group completion, signal, timeout, idempotency, projection
  persistence, and rollback behavior.

Replay-oriented logic to delete:

- the `replay` name in runtime public use cases and types;
- `RuntimeStore.replayRun`, `replayRun`, `ReplayResult`, and related package
  exports;
- replay-specific root-output reconstruction and `expected`/`actual` output
  comparison;
- replay-specific artifact registry verification that is not part of a concrete
  write operation such as fork artifact copying;
- replay-specific scheduler event scanners, malformed-envelope collectors,
  projection-table diff helpers, and non-mutating verifier result shapes;
- CLI-visible replay behavior and formatting remnants;
- tests whose only assertion is that replay works rather than a scheduler
  reducer or store write-path rule.

If normal runtime reads should reject malformed scheduler event envelopes, that
behavior belongs in the normal scheduler event decode/load path. It is not kept
as a separate diagnostic verifier.

## Implementation Plan

1. Inventory every `replay` symbol, command reference, spec line, test name, and
   roadmap reference outside `legacy/`.
2. Classify each item as product noun, normal scheduler reducer/store coverage,
   idempotency replay, or obsolete test scaffolding.
3. Remove product-level and runtime-level replay surfaces without adding a
   replacement verifier interface.
4. Move any still-useful invariant coverage into scheduler reducer/store tests
   only when that coverage maps to a normal runtime path.
5. Update `specs/runtime-spec.md` and `specs/cli-spec.md` in the same change so
   they describe the cleaned current behavior.
6. Rewrite tests around concrete scheduler risks: reducer behavior, event decode
   on the normal load path, projection persistence, idempotency, and rollback.
7. Remove the older replay audit roadmap or mark it completed/superseded after
   this goal lands.

## Acceptance

- Searching non-legacy code and specs for the replay product noun leaves only
  this cleanup record and superseded/archive roadmap context.
- CLI command surface has no replay command.
- Runtime public surface does not invite users to replay a workflow.
- Runtime store surface has no replay verifier method or replacement integrity
  verifier method.
- Scheduler reducer and store tests still cover the event/projection invariants
  used by normal runtime execution.
- Specs describe only the resulting current behavior and do not carry removed
  replay promises.

## Implementation Result

Completed cleanup:

- `specs/runtime-spec.md` no longer describes replay as a runtime purpose,
  control capability, read API, or verification obligation.
- `packages/runtime/src/index.ts` no longer exports `replayRun` or
  `ReplayResult`.
- `packages/runtime/src/runs/use-cases.ts` no longer exposes a replay use case.
- `packages/runtime/src/store/store.ts` no longer has `RuntimeStore.replayRun`,
  `ReplayResult`, root-output comparison, artifact registry verifier,
  terminal/projection verifier, scheduler event verifier, projection-table diff
  helpers, or replay-only JSON parsing helpers.
- Fork keeps its concrete artifact and frozen-file checks through
  `verifyCopiedArtifacts`, `verifyFrozenRunFiles`, and contained file reads.
- Scheduler append/control idempotency helpers and tests now use duplicate
  wording instead of replay wording.
- Current scheduler event types with malformed scheduler envelopes now fail on
  the normal scheduler snapshot load path instead of being silently ignored.
- Runtime admission/control/node-executor/public API/type tests no longer call
  or assert replay behavior.
- Dedicated artifact drift, projection drift, malformed-envelope,
  unknown-event, orphaned-projection, and unreplayable-stream tests were deleted
  because they only exercised the removed verifier.
- `docs/roadmap/durable-runtime-roadmap.md` and
  `docs/roadmap/cli-control-plane-implementation-goal.md` no longer present
  replay as current implementation or an active product decision.

Implementation gaps and intentional diffs:

- The superseded audit roadmap file remains in `docs/roadmap/` as historical
  context instead of being physically moved; `docs/roadmap/INDEX.md` lists it
  under Archive.
- No replacement run-integrity, verify, or doctor-deep API was added.
- Malformed scheduler envelopes are not given a new standalone diagnostic path;
  the normal scheduler store load path owns current scheduler-envelope decoding.
- Targeted integration tests for runtime control/store/contract/type surfaces
  pass. `runtime-admission.integration.test.ts` still has three unrelated
  fixture-preflight failures in this worktree; they are outside this cleanup's
  changed behavior.
- Whole-repo search still finds replay wording in this cleanup goal, the
  superseded audit record, and archived roadmap history. Runtime source, runtime
  tests, and specs are clean.

## Initial File Candidates

- `specs/runtime-spec.md`
- `specs/cli-spec.md`
- `docs/roadmap/INDEX.md`
- `docs/roadmap/replay-verifier-audit-roadmap.md`
- `docs/roadmap/durable-runtime-roadmap.md`
- `docs/roadmap/cli-control-plane-implementation-goal.md`
- `packages/runtime/src/index.ts`
- `packages/runtime/src/runs/use-cases.ts`
- `packages/runtime/src/store/store.ts`
- `packages/runtime/test/runtime-admission.integration.test.ts`
- `packages/runtime/test/runtime-controls.integration.test.ts`
- `packages/runtime/test/scheduler-node-executor.integration.test.ts`
- `packages/runtime/test/scheduler-reducers.unit.test.ts`
- `packages/runtime/test/scheduler-store-port.integration.test.ts`
- `packages/runtime/test/scheduler-advance-store.integration.test.ts`
- `packages/runtime/test/public-types.type.test-d.ts`
- `packages/runtime/test/public-api.contract.test.ts`

## Whole-Repo Scan Notes

Parallel read-only scans found no current CLI replay command or formatter
surface. The remaining cleanup is concentrated in runtime specs, runtime public
exports, store replay verifier helpers, runtime tests, and roadmap records.

Delete or update current-truth docs:

- remove replay requirements from `specs/runtime-spec.md`, including purpose
  text, the control/fork/signal/replay heading, replay requirement bullets, read
  API wording, and verification coverage;
- keep `specs/cli-spec.md` free of replay command surface;
- update `docs/roadmap/INDEX.md` so the old replay verifier audit is not listed
  as an active unresolved product decision;
- rewrite or archive `docs/roadmap/replay-verifier-audit-roadmap.md` as
  superseded history;
- update `docs/roadmap/durable-runtime-roadmap.md` references from fork/replay
  integrity to fork-only behavior, and remove the dedicated replay section.

Delete runtime replay surface:

- remove `replayRun` and `ReplayResult` from `packages/runtime/src/index.ts`;
- remove `replayRun` and the `ReplayResult` import from
  `packages/runtime/src/runs/use-cases.ts`;
- remove `RuntimeStore.replayRun`, `ReplayResult`, and the store `replayRun`
  implementation from `packages/runtime/src/store/store.ts`.

Delete replay-only store helpers:

- remove artifact replay verification helpers unless a concrete write path such
  as fork artifact copying still owns the check locally;
- remove terminal/public replay projection verification helpers;
- remove scheduler replay event scanners and malformed-envelope collectors;
- remove projection-table diff helpers and their private table readers/builders;
- remove dead JSON comparison/parsing helpers that become unused after verifier
  deletion;
- keep `evaluateRecordedOutputs(...)` for fork output inheritance, but rename the
  `"replay output"` validation label.

Keep normal scheduler maintenance surface:

- keep `applySchedulerEvents(createSchedulerProjection(runId), events)` as the
  pure reducer interface;
- keep scheduler store snapshot load, append/start/commit/control paths,
  projection-table synchronization, public projection synchronization, rollback,
  and typed store errors;
- keep scheduler reducer tests and scheduler store integration tests as the
  event/projection safety net;
- no additional scheduler reducer/store tests were identified as required by the
  scan.

Rewrite or delete tests:

- remove `replayRun` imports and assertions from runtime admission/control tests;
- delete replay drift, malformed-envelope, orphaned-projection, and unreplayable
  stream tests that only exercise the verifier;
- remove `replayRun` and `ReplayResult` from runtime public API and type tests;
- keep normal admission, control, fork, signal, scheduler-node-executor,
  scheduler-reducer, scheduler-store-port, and scheduler-advance-store tests;
- keep idempotency tests only when they mean duplicate command or commit
  handling, and use duplicate/recovered-command wording instead of replay
  wording.

Implemented idempotency cleanup:

- `replayAppendIdempotency` and `replayIntentIdempotency` were renamed to
  duplicate idempotency helpers;
- scheduler control/store tests that covered recovered or repeated signal/retry
  commands were renamed to duplicate/recovered-command wording.
