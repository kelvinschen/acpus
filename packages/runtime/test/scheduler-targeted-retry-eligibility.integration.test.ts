import { admitRunForTest } from "./support/runtime-store.js";
import { defineWorkflow } from "@acpus/core";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { SchedulerEvent } from "../src/scheduler/events.js";
import type { RunOwnerClaim } from "../src/scheduler/store-port.js";
import { getRunInspection, getRunVisualizationSnapshot } from "@acpus/runtime";
import { applySchedulerControlIntent } from "../src/scheduler/control.js";
import { bootstrapRootEvents } from "../src/scheduler/materialize.js";
import { settleFrozenRunTransitions } from "../src/scheduler/runtime-runner.js";
import { frozenRunScope } from "../src/scheduler/settle.js";
import { openRuntimeStore, type RuntimeStore } from "../src/store/store.js";
import { prepareSyntheticWorkflow, runtimeDatabasePath, validWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";
import { throwingSchedulerStore } from "./support/scheduler-store.js";

describe("scheduler targeted retry eligibility", () => {
  it.each(["completed", "canceled"] as const)("rejects a failed target in a %s run without writing events", async terminalStatus => {
    await withClaimedRun(`scheduler-retry-${terminalStatus}-run`, async ({ store, runId, claim }) => {
      appendEvents(store, runId, claim, terminalStatus === "completed"
        ? completedRaceEvents(runId, "completed")
        : canceledRunEvents(runId));

      expectRejectedWithoutMutation(store, runId, claim, "race.loser.task");
    });
  });

  it("rejects a failed member of a completed race even when the run failed later", async () => {
    await withClaimedRun("scheduler-retry-completed-race-member", async ({ store, runId, claim }) => {
      appendEvents(store, runId, claim, completedRaceEvents(runId, "failed"));

      expectRejectedWithoutMutation(store, runId, claim, "race.loser.task");
    });
  });

  it("rejects one failed member of an all group when another failure would immediately refail it", async () => {
    await withClaimedRun("scheduler-retry-multi-failed-all", async ({ store, runId, claim }) => {
      appendEvents(store, runId, claim, multiFailedAllEvents(runId));

      expectRejectedWithoutMutation(store, runId, claim, "all.left.task");
    });
  });

  it("rejects a retry whose parent-failed dependency contains a preserved failure", async () => {
    await withClaimedRun("scheduler-retry-hidden-dependency-failure", async ({ store, runId, claim }) => {
      appendEvents(store, runId, claim, hiddenFailedDependencyEvents(runId));

      expectRejectedWithoutMutation(store, runId, claim, "outer.left.task");
    });
  });

  it("keeps an owner-valid large quorum on the typed blocked-retry path", async () => {
    await withClaimedRun("scheduler-retry-large-quorum-dependency", async ({ store, runId, claim }) => {
      appendEvents(
        store,
        runId,
        claim,
        hiddenFailedDependencyEvents(runId, Number.MAX_SAFE_INTEGER + 1),
      );

      expectRejectedWithoutMutation(store, runId, claim, "outer.left.task");
    });
  });

  it("rejects targeted retry while paused without writing events", async () => {
    await withClaimedRun("scheduler-retry-paused-run", async ({ store, runId, claim }) => {
      appendEvents(store, runId, claim, pausedFailedTargetEvents(runId));

      expectRejectedWithoutMutation(store, runId, claim, "target");
    });
  });

  it("rejects leaf retry after pre-execution expression resolution failure", async () => {
    await withClaimedRun("scheduler-retry-expression-resolution", async ({ workspace, store, runId, claim }) => {
      appendEvents(store, runId, claim, expressionResolutionFailureEvents(runId));

      expectRejectedWithoutMutation(store, runId, claim, "target");
      await expect(getRunVisualizationSnapshot(workspace, runId)).resolves.toMatchObject({
        controls: { canCancelRun: false, retryTargets: [] },
      });
      const details = await getRunInspection(workspace, {
        runId,
        mode: "details",
        target: "target",
      });
      expect(details.isOk() && details.value.kind === "details"
        ? details.value.availableControls
        : undefined).toEqual([]);
      const summary = await getRunInspection(workspace, {
        runId,
        mode: "target",
        target: "target",
      });
      expect(summary.isOk() && summary.value.kind === "target"
        ? summary.value.availableActions
        : undefined).toEqual([{ kind: "fork", target: "target" }]);
    });
  });

  it("projects exact retry targets that the mutation planner accepts", async () => {
    await withClaimedRun("scheduler-retry-projection-parity", async ({ workspace, store, runId, claim }) => {
      appendEvents(store, runId, claim, retryableFailedTargetEvents(runId));

      await expect(getRunVisualizationSnapshot(workspace, runId)).resolves.toMatchObject({
        controls: {
          canCancelRun: false,
          retryTargets: [{ target: "target", kind: "node", nodeId: "target" }],
        },
      });
      const retry = store.scheduler.tryRetry({
        runId,
        ownerEpoch: claim.ownerEpoch,
        idempotencyKey: "retry:projection-parity",
        target: "target",
      });
      expect(retry.isOk() ? retry.value.projection.instances.target : undefined)
        .toMatchObject({ status: "ready", statusReason: "retry" });
    });
  });

  it("projects an accepted retry target before root failure propagation", async () => {
    await withPendingParallelFailure("scheduler-retry-projection-intermediate", async ({ workspace, store, runId, claim, targetKey }) => {
      const before = throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId);
      const parentFrameKey = before.projection.instances[targetKey]?.parentFrameKey;
      if (!parentFrameKey || !before.projection.groupMembers[parentFrameKey]) {
        throw new Error("Expected target branch membership.");
      }
      throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
        runId,
        expectedVersion: before.version,
        ownerEpoch: claim.ownerEpoch,
        idempotencyKey: "retry:intermediate-propagation",
        events: [
          { type: "frame.failed", payload: { frameKey: parentFrameKey, error: { reason: "failed" } } },
          { type: "group.member_failed", payload: { memberKey: parentFrameKey, error: { reason: "failed" } } },
        ],
      });

      await expect(getRunVisualizationSnapshot(workspace, runId)).resolves.toMatchObject({
        run: { status: "running" },
        controls: {
          retryTargets: expect.arrayContaining([
            { target: targetKey, kind: "node", nodeId: "target" },
          ]),
        },
      });
      const retry = store.scheduler.tryRetry({
        runId,
        ownerEpoch: claim.ownerEpoch,
        idempotencyKey: "retry:intermediate-projection",
        target: targetKey,
      });
      expect(retry.isOk()).toBe(true);
    });
  });

  it("projects retry through pure multi-level failure settlement without writing", async () => {
    await withPendingNestedParallelFailure("scheduler-retry-projection-nested-intermediate", async ({
      workspace,
      store,
      runId,
      claim,
      targetKey,
      outerMemberKey,
    }) => {
      const before = throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId);
      expect(before.projection.groupMembers[outerMemberKey]).toMatchObject({ status: "running" });
      const eventCount = store.getRun(runId)?.eventCount;

      await expect(getRunVisualizationSnapshot(workspace, runId)).resolves.toMatchObject({
        run: { status: "running" },
        controls: {
          retryTargets: expect.arrayContaining([
            { target: targetKey, kind: "node", nodeId: "target" },
          ]),
        },
      });
      const details = await getRunInspection(workspace, {
        runId,
        mode: "details",
        target: targetKey,
      });
      expect(details.isOk() && details.value.kind === "details"
        ? details.value.availableControls
        : undefined).toContainEqual({ type: "retry", target: targetKey });

      const afterReads = throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId);
      expect(afterReads.version).toBe(before.version);
      expect(afterReads.projection.groupMembers[outerMemberKey]).toMatchObject({ status: "running" });
      expect(store.getRun(runId)?.eventCount).toBe(eventCount);

      const retried = store.scheduler.tryRetry({
        runId,
        ownerEpoch: claim.ownerEpoch,
        idempotencyKey: "retry:nested-intermediate-projection",
        target: targetKey,
      });
      expect(retried.isOk() ? retried.value.projection.instances[targetKey] : undefined)
        .toMatchObject({ status: "ready", statusReason: "retry" });
    });
  });

  it("does not project current-node controls onto a historical attempt", async () => {
    await withClaimedRun("scheduler-controls-historical-attempt", async ({ workspace, store, runId, claim }) => {
      appendEvents(store, runId, claim, [
        { type: "frame.started", payload: { runId, frameKey: "root", frameKind: "root" } },
        { type: "instance.ready", payload: { runId, nodeKey: "require_ready", nodeId: "require_ready", parentFrameKey: "root", instancePath: [] } },
        { type: "instance.started", payload: { nodeKey: "require_ready", attemptId: "attempt_old" } },
        { type: "attempt.started", payload: { runId, attemptId: "attempt_old", nodeKey: "require_ready", nodeId: "require_ready", attemptNo: 1, ownerEpoch: claim.ownerEpoch } },
        { type: "attempt.failed", payload: { attemptId: "attempt_old", error: { reason: "old_failure" } } },
        { type: "instance.failed", payload: { nodeKey: "require_ready", attemptId: "attempt_old", error: { reason: "old_failure" } } },
        { type: "instance.retry_requested", payload: { nodeKey: "require_ready" } },
        { type: "instance.started", payload: { nodeKey: "require_ready", attemptId: "attempt_current" } },
        { type: "attempt.started", payload: { runId, attemptId: "attempt_current", nodeKey: "require_ready", nodeId: "require_ready", attemptNo: 2, ownerEpoch: claim.ownerEpoch } },
      ]);

      const historical = await getRunInspection(workspace, {
        runId,
        mode: "details",
        target: "attempt_old",
      });
      expect(historical.isOk() && historical.value.kind === "details"
        ? historical.value.availableControls
        : undefined).toEqual([]);

      const current = await getRunInspection(workspace, {
        runId,
        mode: "details",
        target: "attempt_current",
      });
      expect(current.isOk() && current.value.kind === "details"
        ? current.value.availableControls
        : undefined).toEqual([{ type: "cancel", target: "require_ready" }]);
    });
  });

  it("fails closed when an authored node id collides with the root frame identity", async () => {
    await withRuntimeWorkspace("scheduler-controls-root-id-collision", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, rootIdWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "root-id-collision-owner", 60_000);
        if (!claim) throw new Error(`Run '${run.id}' could not be claimed.`);
        appendEvents(store, run.id, claim, [
          { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
          {
            type: "instance.ready",
            payload: {
              runId: run.id,
              nodeKey: "root~occurrence",
              nodeId: "root",
              parentFrameKey: "root",
              instancePath: [{ kind: "node", nodeId: "root" }],
            },
          },
        ]);

        const details = await getRunInspection(workspace, {
          runId: run.id,
          mode: "details",
          target: "root",
        });
        expect(details.isOk() && details.value.kind === "details"
          ? {
              target: details.value.target,
              availableControls: details.value.availableControls,
            }
          : undefined).toEqual({
          target: { kind: "frame", id: "root" },
          availableControls: [],
        });
      } finally {
        store.close();
      }
    });
  });

  it("rejects a retry whose ancestor frame has no runnable scheduler state", async () => {
    await withRuntimeWorkspace("scheduler-retry-non-runnable-ancestor", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const initial = await openRuntimeStore(workspace);
      const run = await admitRunForTest(initial, { prepared, input: { ready: true }, cwd: workspace });
      const claim = initial.scheduler.claimRun(run.id, "retry-corruption-owner", 60_000);
      if (!claim) throw new Error(`Run '${run.id}' could not be claimed.`);
      appendEvents(initial, run.id, claim, [
        { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
        { type: "instance.ready", payload: { runId: run.id, nodeKey: "target", nodeId: "target", parentFrameKey: "root", instancePath: [] } },
        { type: "instance.failed", payload: { nodeKey: "target", error: { reason: "failed" } } },
      ]);
      const seeded = throwingSchedulerStore(initial.scheduler).loadRunSnapshot(run.id);
      const corrupt = structuredClone(seeded.projection);
      corrupt.frames.root!.status = "ready";
      const db = new DatabaseSync(runtimeDatabasePath(workspace));
      try {
        db.prepare("UPDATE scheduler_frames SET status = 'ready' WHERE run_id = ? AND frame_key = 'root'").run(run.id);
        db.prepare("UPDATE scheduler_projection_checkpoints SET event_sequence = ?, projection_json = ? WHERE run_id = ?")
          .run(seeded.version, JSON.stringify(corrupt), run.id);
      } finally {
        db.close();
      }
      initial.close();

      const reopened = await openRuntimeStore(workspace);
      try {
        const before = throwingSchedulerStore(reopened.scheduler).loadRunSnapshot(run.id);
        const eventCount = reopened.getRun(run.id)?.eventCount;
        expect(() => reopened.scheduler.tryRetry({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "retry:non-runnable-ancestor",
          target: "target",
        })).toThrow("Retry target 'target' has non-runnable ancestor frame 'root' in status 'ready'.");
        expect(throwingSchedulerStore(reopened.scheduler).loadRunSnapshot(run.id).version).toBe(before.version);
        expect(reopened.getRun(run.id)?.eventCount).toBe(eventCount);
      } finally {
        reopened.scheduler.releaseRun(claim);
        reopened.close();
      }
    });
  });

  it("atomically commits pending failure propagation with an accepted retry", async () => {
    await withPendingParallelFailure("scheduler-retry-atomic-acceptance", async ({ workspace, store, runId, claim, targetKey }) => {
      const before = throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId);
      const retried = throwingSchedulerStore(store.scheduler).retry({
        runId,
        ownerEpoch: claim.ownerEpoch,
        idempotencyKey: "retry:atomic-acceptance",
        target: targetKey,
      });

      expect(retried.projection.instances[targetKey]).toMatchObject({ status: "ready", statusReason: "retry" });
      expect(retried.projection.run.status).toBe("pending");
      const db = new DatabaseSync(runtimeDatabasePath(workspace), { readOnly: true });
      try {
        expect(db.prepare("SELECT type FROM run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence").all(runId, before.version))
          .toEqual([
            { type: "frame.failed" },
            { type: "group.member_failed" },
            { type: "group.failed" },
            { type: "frame.failed" },
            { type: "frame.failed" },
            { type: "instance.retry_requested" },
            { type: "group.member_retry_requested" },
          ]);
        expect(db.prepare("SELECT event_count FROM scheduler_commits WHERE run_id = ? AND idempotency_key = ?").get(runId, "retry:atomic-acceptance"))
          .toEqual({ event_count: 7 });
      } finally {
        db.close();
      }
    });
  });

  it("rejects through the public control boundary without committing pending derived events", async () => {
    await withPendingParallelFailure("scheduler-retry-public-atomic-rejection", async ({ store, runId, claim }) => {
      const before = throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId);
      const eventCount = store.getRun(runId)?.eventCount;

      const result = applySchedulerControlIntent(store, {
        requestId: "retry:missing",
        runId,
        type: "retry",
        target: "missing",
      }, claim.ownerEpoch);

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toMatchObject({
          type: "missing-retry-target",
          runId,
          targetKey: "missing",
        });
      }
      expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId).version).toBe(before.version);
      expect(store.getRun(runId)?.eventCount).toBe(eventCount);
    });
  });

  it("rebuilds historical terminal runs that already contain targeted-retry events", async () => {
    await withRuntimeWorkspace("scheduler-retry-historical-terminal-replay", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const initial = await openRuntimeStore(workspace);
      const run = await admitRunForTest(initial, { prepared, input: { ready: true }, cwd: workspace });
      const claim = initial.scheduler.claimRun(run.id, "historical-retry-owner", 60_000);
      if (!claim) throw new Error(`Run '${run.id}' could not be claimed.`);
      appendEvents(initial, run.id, claim, [
        { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
        { type: "instance.ready", payload: { runId: run.id, nodeKey: "old-target", nodeId: "old-target", parentFrameKey: "root", instancePath: [] } },
        { type: "instance.failed", payload: { nodeKey: "old-target", error: { reason: "old_failure" } } },
        { type: "frame.completed", payload: { frameKey: "root", result: { ok: true } } },
        { type: "instance.retry_requested", payload: { nodeKey: "old-target" } },
      ]);
      initial.scheduler.releaseRun(claim);
      initial.close();

      const reopened = await openRuntimeStore(workspace);
      try {
        const rebuilt = throwingSchedulerStore(reopened.scheduler).loadRunSnapshot(run.id).projection;
        expect(rebuilt.run.status).toBe("completed");
        expect(rebuilt.instances["old-target"]).toMatchObject({ status: "ready", statusReason: "retry" });
      } finally {
        reopened.close();
      }
    });
  });
});

async function withClaimedRun(
  name: string,
  fn: (input: { workspace: string; store: RuntimeStore; runId: string; claim: RunOwnerClaim }) => Promise<void>,
): Promise<void> {
  await withRuntimeWorkspace(name, async workspace => {
    const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
    const store = await openRuntimeStore(workspace);
    try {
      const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
      const claim = store.scheduler.claimRun(run.id, "retry-eligibility-owner", 60_000);
      if (!claim) throw new Error(`Run '${run.id}' could not be claimed.`);
      await fn({ workspace, store, runId: run.id, claim });
    } finally {
      store.close();
    }
  });
}

async function withPendingParallelFailure(
  name: string,
  fn: (input: { workspace: string; store: RuntimeStore; runId: string; claim: RunOwnerClaim; targetKey: string }) => Promise<void>,
): Promise<void> {
  await withRuntimeWorkspace(name, async workspace => {
    const prepared = await prepareSyntheticWorkflow(workspace, atomicRetryWorkflow());
    const store = await openRuntimeStore(workspace);
    const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
    const claim = store.scheduler.claimRun(run.id, "atomic-retry-owner", 60_000);
    if (!claim) throw new Error(`Run '${run.id}' could not be claimed.`);
    try {
      const frozen = store.getFrozenRun(run.id);
      if (!frozen) throw new Error(`Run '${run.id}' has no frozen workflow.`);
      const admitted = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id);
      const materialized = throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
        runId: run.id,
        expectedVersion: admitted.version,
        ownerEpoch: claim.ownerEpoch,
        idempotencyKey: "atomic-retry:bootstrap",
        events: bootstrapRootEvents(run.id, frozen.ir, frozenRunScope(frozen)),
      });
      const target = Object.values(materialized.projection.instances).find(instance => instance.nodeId === "target");
      const sibling = Object.values(materialized.projection.instances).find(instance => instance.nodeId === "sibling");
      if (!target || !sibling) throw new Error("Atomic retry workflow did not materialize both task instances.");
      const siblingCompleted = throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
        runId: run.id,
        expectedVersion: materialized.version,
        ownerEpoch: claim.ownerEpoch,
        idempotencyKey: "atomic-retry:sibling-completed",
        events: [{ type: "instance.completed", payload: { nodeKey: sibling.nodeKey, output: { ok: true } } }],
      });
      const propagated = settleFrozenRunTransitions({ store, runId: run.id, ownerEpoch: claim.ownerEpoch });
      if (propagated.version <= siblingCompleted.version) throw new Error("Sibling completion did not propagate.");
      throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
        runId: run.id,
        expectedVersion: propagated.version,
        ownerEpoch: claim.ownerEpoch,
        idempotencyKey: "atomic-retry:target-failed",
        events: [{ type: "instance.failed", payload: { nodeKey: target.nodeKey, error: { reason: "boom" } } }],
      });
      await fn({ workspace, store, runId: run.id, claim, targetKey: target.nodeKey });
    } finally {
      store.scheduler.releaseRun(claim);
      store.close();
    }
  });
}

async function withPendingNestedParallelFailure(
  name: string,
  fn: (input: {
    workspace: string;
    store: RuntimeStore;
    runId: string;
    claim: RunOwnerClaim;
    targetKey: string;
    outerMemberKey: string;
  }) => Promise<void>,
): Promise<void> {
  await withRuntimeWorkspace(name, async workspace => {
    const prepared = await prepareSyntheticWorkflow(workspace, nestedAtomicRetryWorkflow());
    const store = await openRuntimeStore(workspace);
    const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
    const claim = store.scheduler.claimRun(run.id, "nested-atomic-retry-owner", 60_000);
    if (!claim) throw new Error(`Run '${run.id}' could not be claimed.`);
    try {
      const frozen = store.getFrozenRun(run.id);
      if (!frozen) throw new Error(`Run '${run.id}' has no frozen workflow.`);
      const admitted = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id);
      const materialized = throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
        runId: run.id,
        expectedVersion: admitted.version,
        ownerEpoch: claim.ownerEpoch,
        idempotencyKey: "nested-atomic-retry:bootstrap",
        events: bootstrapRootEvents(run.id, frozen.ir, frozenRunScope(frozen)),
      });
      const target = Object.values(materialized.projection.instances)
        .find(instance => instance.nodeId === "target");
      const innerSibling = Object.values(materialized.projection.instances)
        .find(instance => instance.nodeId === "inner_sibling");
      const outerSibling = Object.values(materialized.projection.instances)
        .find(instance => instance.nodeId === "outer_sibling");
      if (!target || !innerSibling || !outerSibling) {
        throw new Error("Nested retry workflow did not materialize all task instances.");
      }
      const scheduler = throwingSchedulerStore(store.scheduler);
      const targetAttempt = scheduler.startAttempt({
        runId: run.id,
        nodeKey: target.nodeKey,
        nodeId: target.nodeId,
        ownerEpoch: claim.ownerEpoch,
        expectedVersion: materialized.version,
        idempotencyKey: "nested-atomic-retry:target-start",
      });
      const innerSiblingAttempt = scheduler.startAttempt({
        runId: run.id,
        nodeKey: innerSibling.nodeKey,
        nodeId: innerSibling.nodeId,
        ownerEpoch: claim.ownerEpoch,
        expectedVersion: targetAttempt.snapshot.version,
        idempotencyKey: "nested-atomic-retry:inner-sibling-start",
      });
      const outerSiblingAttempt = scheduler.startAttempt({
        runId: run.id,
        nodeKey: outerSibling.nodeKey,
        nodeId: outerSibling.nodeId,
        ownerEpoch: claim.ownerEpoch,
        expectedVersion: innerSiblingAttempt.snapshot.version,
        idempotencyKey: "nested-atomic-retry:outer-sibling-start",
      });
      scheduler.commitAttemptResult({
        runId: run.id,
        attemptId: innerSiblingAttempt.attemptId,
        ownerEpoch: claim.ownerEpoch,
        result: { status: "completed", output: { ok: true } },
        idempotencyKey: "nested-atomic-retry:inner-sibling-completed",
      });
      const siblingsCompleted = scheduler.commitAttemptResult({
        runId: run.id,
        attemptId: outerSiblingAttempt.attemptId,
        ownerEpoch: claim.ownerEpoch,
        result: { status: "completed", output: { ok: true } },
        idempotencyKey: "nested-atomic-retry:outer-sibling-completed",
      });
      const propagated = settleFrozenRunTransitions({
        store,
        runId: run.id,
        ownerEpoch: claim.ownerEpoch,
      });
      if (propagated.version <= siblingsCompleted.version) {
        throw new Error("Nested sibling completion did not propagate.");
      }
      const targetMemberKey = propagated.projection.instances[target.nodeKey]?.parentFrameKey;
      const innerFrameKey = targetMemberKey
        ? propagated.projection.frames[targetMemberKey]?.parentFrameKey
        : undefined;
      const outerMemberKey = innerFrameKey
        ? propagated.projection.frames[innerFrameKey]?.parentFrameKey
        : undefined;
      if (!targetMemberKey || !outerMemberKey || !propagated.projection.groupMembers[outerMemberKey]) {
        throw new Error("Nested retry workflow did not expose its ancestor memberships.");
      }
      scheduler.commitAttemptResult({
        runId: run.id,
        attemptId: targetAttempt.attemptId,
        ownerEpoch: claim.ownerEpoch,
        idempotencyKey: "nested-atomic-retry:target-failed",
        result: { status: "failed", reason: "boom", error: { reason: "boom" } },
      });
      await fn({
        workspace,
        store,
        runId: run.id,
        claim,
        targetKey: target.nodeKey,
        outerMemberKey,
      });
    } finally {
      store.scheduler.releaseRun(claim);
      store.close();
    }
  });
}

function appendEvents(store: RuntimeStore, runId: string, claim: RunOwnerClaim, events: SchedulerEvent[]): void {
  const before = throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId);
  throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
    runId,
    expectedVersion: before.version,
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey: `seed:${runId}`,
    events,
  });
}

function expectRejectedWithoutMutation(
  store: RuntimeStore,
  runId: string,
  claim: RunOwnerClaim,
  target: string,
): void {
  const before = throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId);
  const eventCount = store.getRun(runId)?.eventCount;

  const result = store.scheduler.tryRetry({
    runId,
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey: `retry:${runId}:${target}`,
    target,
  });

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error).toMatchObject({ type: "invalid-retry-target", runId, targetKey: target });
  }
  expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId).version).toBe(before.version);
  expect(store.getRun(runId)?.eventCount).toBe(eventCount);
}

function completedRaceEvents(runId: string, rootStatus: "completed" | "failed"): SchedulerEvent[] {
  return [
    { type: "frame.started", payload: { runId, frameKey: "root", frameKind: "root" } },
    { type: "frame.started", payload: { runId, frameKey: "race", frameKind: "node", parentFrameKey: "root", nodeKey: "race", nodeId: "race", instancePath: [{ kind: "node", nodeId: "race" }], strategy: "race" } },
    { type: "group.started", payload: { runId, groupKey: "race", nodeKey: "race", nodeId: "race", kind: "parallel", strategy: "race" } },
    { type: "frame.started", payload: { runId, frameKey: "race.loser", frameKind: "branch", parentFrameKey: "race", instancePath: [{ kind: "branch", nodeId: "race", branchId: "loser" }] } },
    { type: "group.member_ready", payload: { runId, groupKey: "race", memberKey: "race.loser", childFrameKey: "race.loser", memberKind: "branch", branchId: "loser", readinessSequence: 1 } },
    { type: "instance.ready", payload: { runId, nodeKey: "race.loser.task", nodeId: "loser_task", parentFrameKey: "race.loser", instancePath: [{ kind: "branch", nodeId: "race", branchId: "loser" }, { kind: "node", nodeId: "loser_task" }] } },
    { type: "instance.failed", payload: { nodeKey: "race.loser.task", error: { reason: "loser_failed" } } },
    { type: "frame.failed", payload: { frameKey: "race.loser", error: { reason: "loser_failed" } } },
    { type: "group.member_failed", payload: { memberKey: "race.loser", error: { reason: "loser_failed" } } },
    { type: "frame.started", payload: { runId, frameKey: "race.winner", frameKind: "branch", parentFrameKey: "race", instancePath: [{ kind: "branch", nodeId: "race", branchId: "winner" }] } },
    { type: "group.member_ready", payload: { runId, groupKey: "race", memberKey: "race.winner", childFrameKey: "race.winner", memberKind: "branch", branchId: "winner", readinessSequence: 2 } },
    { type: "frame.completed", payload: { frameKey: "race.winner", result: { ok: true } } },
    { type: "group.member_completed", payload: { memberKey: "race.winner", completionSequence: 3, output: { ok: true } } },
    { type: "group.completed", payload: { groupKey: "race", result: { acceptedMemberKeys: ["race.winner"] } } },
    { type: "frame.completed", payload: { frameKey: "race", result: { ok: true } } },
    rootStatus === "completed"
      ? { type: "frame.completed", payload: { frameKey: "root", result: { ok: true } } }
      : { type: "frame.failed", payload: { frameKey: "root", error: { reason: "downstream_failed" } } },
  ];
}

function canceledRunEvents(runId: string): SchedulerEvent[] {
  return [
    { type: "frame.started", payload: { runId, frameKey: "root", frameKind: "root" } },
    { type: "instance.ready", payload: { runId, nodeKey: "race.loser.task", nodeId: "loser_task", parentFrameKey: "root", instancePath: [{ kind: "node", nodeId: "loser_task" }] } },
    { type: "instance.failed", payload: { nodeKey: "race.loser.task", error: { reason: "failed_before_cancel" } } },
    { type: "frame.cancelled", payload: { frameKey: "root", cancelReason: "operator_cancelled" } },
  ];
}

function multiFailedAllEvents(runId: string): SchedulerEvent[] {
  return [
    { type: "frame.started", payload: { runId, frameKey: "root", frameKind: "root" } },
    { type: "frame.started", payload: { runId, frameKey: "all", frameKind: "node", parentFrameKey: "root", nodeKey: "all", nodeId: "all", instancePath: [{ kind: "node", nodeId: "all" }], strategy: "all" } },
    { type: "group.started", payload: { runId, groupKey: "all", nodeKey: "all", nodeId: "all", kind: "parallel", strategy: "all" } },
    ...failedAllMemberEvents(runId, "left", 1),
    ...failedAllMemberEvents(runId, "right", 2),
    { type: "group.failed", payload: { groupKey: "all", error: { reason: "member_failed" } } },
    { type: "frame.failed", payload: { frameKey: "all", error: { reason: "member_failed" } } },
    { type: "frame.failed", payload: { frameKey: "root", error: { reason: "member_failed" } } },
  ];
}

function failedAllMemberEvents(runId: string, branchId: "left" | "right", readinessSequence: number): SchedulerEvent[] {
  const frameKey = `all.${branchId}`;
  const nodeKey = `${frameKey}.task`;
  return [
    { type: "frame.started", payload: { runId, frameKey, frameKind: "branch", parentFrameKey: "all", instancePath: [{ kind: "branch", nodeId: "all", branchId }] } },
    { type: "group.member_ready", payload: { runId, groupKey: "all", memberKey: frameKey, childFrameKey: frameKey, memberKind: "branch", branchId, readinessSequence } },
    { type: "instance.ready", payload: { runId, nodeKey, nodeId: `${branchId}_task`, parentFrameKey: frameKey, instancePath: [{ kind: "branch", nodeId: "all", branchId }, { kind: "node", nodeId: `${branchId}_task` }] } },
    { type: "instance.failed", payload: { nodeKey, error: { reason: `${branchId}_failed` } } },
    { type: "frame.failed", payload: { frameKey, error: { reason: `${branchId}_failed` } } },
    { type: "group.member_failed", payload: { memberKey: frameKey, error: { reason: `${branchId}_failed` } } },
  ];
}

function hiddenFailedDependencyEvents(runId: string, quorumCount?: number): SchedulerEvent[] {
  return [
    { type: "frame.started", payload: { runId, frameKey: "root", frameKind: "root" } },
    { type: "frame.started", payload: { runId, frameKey: "outer", frameKind: "node", parentFrameKey: "root", nodeKey: "outer", nodeId: "outer", strategy: "all" } },
    { type: "group.started", payload: { runId, groupKey: "outer", nodeKey: "outer", nodeId: "outer", kind: "parallel", strategy: "all" } },
    { type: "frame.started", payload: { runId, frameKey: "outer.left", frameKind: "branch", parentFrameKey: "outer" } },
    { type: "group.member_ready", payload: { runId, groupKey: "outer", memberKey: "outer.left", childFrameKey: "outer.left", memberKind: "branch", branchId: "left", readinessSequence: 1 } },
    { type: "instance.ready", payload: { runId, nodeKey: "outer.left.task", nodeId: "left_task", parentFrameKey: "outer.left", instancePath: [] } },
    { type: "instance.failed", payload: { nodeKey: "outer.left.task", error: { reason: "target_failed" } } },
    { type: "frame.failed", payload: { frameKey: "outer.left", error: { reason: "target_failed" } } },
    { type: "group.member_failed", payload: { memberKey: "outer.left", error: { reason: "target_failed" } } },
    { type: "frame.started", payload: { runId, frameKey: "outer.right", frameKind: "branch", parentFrameKey: "outer" } },
    { type: "group.member_ready", payload: { runId, groupKey: "outer", memberKey: "outer.right", childFrameKey: "outer.right", memberKind: "branch", branchId: "right", readinessSequence: 2 } },
    {
      type: "frame.started",
      payload: {
        runId,
        frameKey: "inner",
        frameKind: "node",
        parentFrameKey: "outer.right",
        nodeKey: "inner",
        nodeId: "inner",
        strategy: quorumCount === undefined ? "all" : "quorum",
      },
    },
    quorumCount === undefined
      ? {
          type: "group.started",
          payload: {
            runId,
            groupKey: "inner",
            nodeKey: "inner",
            nodeId: "inner",
            kind: "parallel",
            strategy: "all",
          },
        }
      : {
          type: "group.started",
          payload: {
            runId,
            groupKey: "inner",
            nodeKey: "inner",
            nodeId: "inner",
            kind: "fanout",
            strategy: "quorum",
            quorumCount,
          },
        },
    {
      type: "frame.started",
      payload: {
        runId,
        frameKey: "inner.failed",
        frameKind: quorumCount === undefined ? "branch" : "fanout_item",
        parentFrameKey: "inner",
      },
    },
    {
      type: "group.member_ready",
      payload: quorumCount === undefined
        ? { runId, groupKey: "inner", memberKey: "inner.failed", childFrameKey: "inner.failed", memberKind: "branch", branchId: "failed", readinessSequence: 3 }
        : { runId, groupKey: "inner", memberKey: "inner.failed", childFrameKey: "inner.failed", memberKind: "fanout_item", itemIndex: 0, item: null, readinessSequence: 3 },
    },
    { type: "instance.ready", payload: { runId, nodeKey: "inner.failed.task", nodeId: "failed_task", parentFrameKey: "inner.failed", instancePath: [] } },
    { type: "instance.failed", payload: { nodeKey: "inner.failed.task", error: { reason: "independent_failure" } } },
    { type: "frame.failed", payload: { frameKey: "inner.failed", error: { reason: "independent_failure" } } },
    { type: "group.member_failed", payload: { memberKey: "inner.failed", error: { reason: "independent_failure" } } },
    {
      type: "frame.started",
      payload: {
        runId,
        frameKey: "inner.pending",
        frameKind: quorumCount === undefined ? "branch" : "fanout_item",
        parentFrameKey: "inner",
      },
    },
    {
      type: "group.member_ready",
      payload: quorumCount === undefined
        ? { runId, groupKey: "inner", memberKey: "inner.pending", childFrameKey: "inner.pending", memberKind: "branch", branchId: "pending", readinessSequence: 4 }
        : { runId, groupKey: "inner", memberKey: "inner.pending", childFrameKey: "inner.pending", memberKind: "fanout_item", itemIndex: 1, item: null, readinessSequence: 4 },
    },
    { type: "group.member_cancelled", payload: { memberKey: "inner.pending", cancelReason: "parent_failed" } },
    { type: "group.cancelled", payload: { groupKey: "inner", cancelReason: "parent_failed" } },
    { type: "frame.cancelled", payload: { frameKey: "inner.pending", cancelReason: "parent_failed" } },
    { type: "frame.cancelled", payload: { frameKey: "inner", cancelReason: "parent_failed" } },
    { type: "frame.cancelled", payload: { frameKey: "outer.right", cancelReason: "parent_failed" } },
    { type: "group.member_cancelled", payload: { memberKey: "outer.right", cancelReason: "parent_failed" } },
    { type: "group.failed", payload: { groupKey: "outer", error: { reason: "member_failed" } } },
    { type: "frame.failed", payload: { frameKey: "outer", error: { reason: "member_failed" } } },
    { type: "frame.failed", payload: { frameKey: "root", error: { reason: "member_failed" } } },
  ];
}

function pausedFailedTargetEvents(runId: string): SchedulerEvent[] {
  return [
    { type: "frame.started", payload: { runId, frameKey: "root", frameKind: "root" } },
    { type: "instance.ready", payload: { runId, nodeKey: "target", nodeId: "target", parentFrameKey: "root", instancePath: [] } },
    { type: "instance.failed", payload: { nodeKey: "target", error: { reason: "failed" } } },
    { type: "control.paused", payload: {} },
  ];
}

function expressionResolutionFailureEvents(runId: string): SchedulerEvent[] {
  return [
    { type: "frame.started", payload: { runId, frameKey: "root", frameKind: "root" } },
    { type: "instance.ready", payload: { runId, nodeKey: "target", nodeId: "target", parentFrameKey: "root", instancePath: [] } },
    { type: "instance.failed", payload: { nodeKey: "target", error: { reason: "invalid_timeout" }, statusReason: "expression_resolution_failed" } },
    { type: "frame.failed", payload: { frameKey: "root", error: { reason: "invalid_timeout" } } },
  ];
}

function retryableFailedTargetEvents(runId: string): SchedulerEvent[] {
  return [
    { type: "frame.started", payload: { runId, frameKey: "root", frameKind: "root" } },
    { type: "instance.ready", payload: { runId, nodeKey: "target", nodeId: "target", parentFrameKey: "root", instancePath: [] } },
    { type: "instance.failed", payload: { nodeKey: "target", error: { reason: "failed" } } },
    { type: "frame.failed", payload: { frameKey: "root", error: { reason: "failed" } } },
  ];
}

function atomicRetryWorkflow() {
  return defineWorkflow({ name: "scheduler-atomic-targeted-retry" }).build(({ step }) => {
    const result = step("parallel").parallel({
      strategy: "all",
      branches: {
        target() {
          const target = step("target").task({ input: {}, exec: async () => ({ ok: true }) });
          return { ok: target.output.ok };
        },
        sibling() {
          const sibling = step("sibling").task({ input: {}, exec: async () => ({ ok: true }) });
          return { ok: sibling.output.ok };
        },
      },
    });
    return { result: result.output };
  });
}

function nestedAtomicRetryWorkflow() {
  return defineWorkflow({ name: "scheduler-nested-atomic-targeted-retry" }).build(({ step }) => {
    const result = step("outer").parallel({
      strategy: "all",
      branches: {
        left() {
          const inner = step("inner").parallel({
            strategy: "all",
            branches: {
              target() {
                const target = step("target").task({ input: {}, exec: async () => ({ ok: true }) });
                return { ok: target.output.ok };
              },
              sibling() {
                const sibling = step("inner_sibling").task({ input: {}, exec: async () => ({ ok: true }) });
                return { ok: sibling.output.ok };
              },
            },
          });
          return { result: inner.output };
        },
        right() {
          const sibling = step("outer_sibling").task({ input: {}, exec: async () => ({ ok: true }) });
          return { ok: sibling.output.ok };
        },
      },
    });
    return { result: result.output };
  });
}

function rootIdWorkflow() {
  return defineWorkflow({ name: "scheduler-root-id-collision" }).build(({ step }) => {
    const root = step("root").task({ input: {}, exec: async () => ({ ok: true }) });
    return { ok: root.output.ok };
  });
}
