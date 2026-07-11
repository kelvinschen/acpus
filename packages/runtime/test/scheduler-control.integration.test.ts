import { defineWorkflow } from "@acpus/core";
import { describe, expect, it } from "vitest";
import { appendNode, deriveInstanceKey } from "../src/scheduler/identity.js";
import { advanceFrozenRun } from "../src/scheduler/runtime-runner.js";
import type { SchedulerEvent } from "../src/scheduler/events.js";
import { openRuntimeStore, type RuntimeStore } from "../src/store/store.js";
import { prepareSyntheticWorkflow, signalWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";
import { throwingSchedulerStore } from "./support/scheduler-store.js";
import { applySchedulerControlIntent } from "./support/scheduler.js";

describe("scheduler control intents", () => {
  it("pauses, resumes, and advances an admitted run", async () => {
    await withRuntimeWorkspace("scheduler-control-intent-resume", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, rootTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });

        await expect(applySchedulerControlIntent(workspace, store, {
          requestId: `pause:${run.id}`,
          runId: run.id,
          type: "pause",
        }, { ownerId: "owner-a" })).resolves.toMatchObject({
          snapshot: { projection: { run: { status: "paused" } } },
        });

        const resumed = await applySchedulerControlIntent(workspace, store, {
          requestId: `resume:${run.id}`,
          runId: run.id,
          type: "resume",
        }, { ownerId: "owner-b" });

        const nodeKey = deriveInstanceKey(appendNode([], "root_task"));
        expect(resumed.advanced).toMatchObject({ status: "completed", started: 1, completed: 1 });
        expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection.instances[nodeKey]).toMatchObject({ status: "completed", output: { ok: true } });
      } finally {
        store.close();
      }
    });
  });

  it("does not consume signal waits when payload validation fails", async () => {
    await withRuntimeWorkspace("scheduler-control-intent-signal-validation", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, signalWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const nodeKey = deriveInstanceKey(appendNode([], "approve"));
        await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store })).resolves.toMatchObject({ status: "awaiting" });

        await expect(applySchedulerControlIntent(workspace, store, {
          requestId: `signal:${run.id}:invalid`,
          runId: run.id,
          type: "signal",
          node: "approve",
          payload: { ok: "yes" },
          commandIdempotencyKey: `signal:${run.id}:invalid`,
        }, { ownerId: "owner-b" })).rejects.toThrow("Signal payload does not match schema");

        expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection.signalWaits[nodeKey]).toMatchObject({ status: "awaiting" });

        await expect(applySchedulerControlIntent(workspace, store, {
          requestId: `signal:${run.id}:valid`,
          runId: run.id,
          type: "signal",
          node: "approve",
          payload: { ok: true },
          commandIdempotencyKey: `signal:${run.id}:valid`,
        }, { ownerId: "owner-c" })).resolves.toMatchObject({
          advanced: { status: "completed" },
        });
      } finally {
        store.close();
      }
    });
  });

  it("reports lease loss without mutating scheduler state", async () => {
    await withRuntimeWorkspace("scheduler-control-intent-lease-loss", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, signalWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 30_000);
        expect(claim).toBeDefined();

        const result = await applySchedulerControlIntent(workspace, store, {
          requestId: `cancel:${run.id}`,
          runId: run.id,
          type: "cancel",
        }, { ownerId: "owner-b" });

        expect(result.advanced).toMatchObject({ status: "lease_lost" });
        expect(result.snapshot.projection.run.status).toBe("pending");
        if (claim) store.scheduler.releaseRun(claim);
      } finally {
        store.close();
      }
    });
  });

  it("treats already resumed and already canceled run controls as applied", async () => {
    await withRuntimeWorkspace("scheduler-control-intent-already-applied", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, signalWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });

        const alreadyResumed = await applySchedulerControlIntent(workspace, store, {
          requestId: `resume:${run.id}:already`,
          runId: run.id,
          type: "resume",
        }, { ownerId: "owner-a" });
        expect(alreadyResumed.snapshot.projection.run.status).toBe("pending");
        expect(alreadyResumed.advanced).toMatchObject({ status: "awaiting" });

        const canceled = await applySchedulerControlIntent(workspace, store, {
          requestId: `cancel:${run.id}:first`,
          runId: run.id,
          type: "cancel",
        }, { ownerId: "owner-b", advance: false });
        expect(canceled.snapshot.projection.run.status).toBe("canceled");

        const eventCount = store.getRun(run.id)?.eventCount;
        const secondCancel = await applySchedulerControlIntent(workspace, store, {
          requestId: `cancel:${run.id}:second`,
          runId: run.id,
          type: "cancel",
        }, { ownerId: "owner-c", advance: false });
        expect(secondCancel.snapshot.projection.run.status).toBe("canceled");
        expect(store.getRun(run.id)?.eventCount).toBe(eventCount);
      } finally {
        store.close();
      }
    });
  });

  it("replays a retry request by its authored target after the resolved instance changes state", async () => {
    await withRuntimeWorkspace("scheduler-control-intent-retry-alias", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, rootTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const nodeKey = seedControlTarget(store, run.id, "root_task", "failed");
        const intent = {
          requestId: `retry-alias:${run.id}`,
          runId: run.id,
          type: "retry" as const,
          target: "root_task",
        };

        const first = await applySchedulerControlIntent(workspace, store, intent, { ownerId: "retry-owner-a", advance: false });
        expect(first.snapshot.projection.instances[nodeKey]).toMatchObject({ status: "ready", statusReason: "retry" });
        expect(controlEventCount(store, run.id, "instance.retry_requested")).toBe(1);
        appendControlCandidates(store, run.id, "root_task", "failed", "retry-replay");
        appendControlCandidates(store, run.id, "other_retry_target", "failed", "retry-conflict");

        const replay = await applySchedulerControlIntent(workspace, store, intent, { ownerId: "retry-owner-b", advance: false });
        expect(replay.snapshot.projection.instances[nodeKey]).toMatchObject({ status: "ready", statusReason: "retry" });
        expect(controlEventCount(store, run.id, "instance.retry_requested")).toBe(1);

        await expect(applySchedulerControlIntent(workspace, store, {
          ...intent,
          target: "other_retry_target",
        }, { ownerId: "retry-owner-c", advance: false })).rejects.toMatchObject({
          failure: { type: "idempotency-conflict", idempotencyKey: `scheduler:control:${intent.requestId}`, runId: run.id },
        });
        expect(controlEventCount(store, run.id, "instance.retry_requested")).toBe(1);
      } finally {
        store.close();
      }
    });
  });

  it("replays a cancel request by its authored target after the resolved instance becomes terminal", async () => {
    await withRuntimeWorkspace("scheduler-control-intent-cancel-alias", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, rootTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const nodeKey = seedControlTarget(store, run.id, "root_task", "ready");
        const intent = {
          requestId: `cancel-alias:${run.id}`,
          runId: run.id,
          type: "cancel" as const,
          target: "root_task",
        };

        const first = await applySchedulerControlIntent(workspace, store, intent, { ownerId: "cancel-owner-a", advance: false });
        expect(first.snapshot.projection.instances[nodeKey]).toMatchObject({ status: "cancelled", statusReason: "operator_cancelled" });
        expect(controlEventCount(store, run.id, "instance.cancelled")).toBe(1);
        appendControlCandidates(store, run.id, "root_task", "ready", "cancel-replay");
        appendControlCandidates(store, run.id, "other_cancel_target", "ready", "cancel-conflict");

        const replay = await applySchedulerControlIntent(workspace, store, intent, { ownerId: "cancel-owner-b", advance: false });
        expect(replay.snapshot.projection.instances[nodeKey]).toMatchObject({ status: "cancelled", statusReason: "operator_cancelled" });
        expect(controlEventCount(store, run.id, "instance.cancelled")).toBe(1);

        await expect(applySchedulerControlIntent(workspace, store, {
          ...intent,
          target: "other_cancel_target",
        }, { ownerId: "cancel-owner-c", advance: false })).rejects.toMatchObject({
          failure: { type: "idempotency-conflict", idempotencyKey: `scheduler:control:${intent.requestId}`, runId: run.id },
        });
        expect(controlEventCount(store, run.id, "instance.cancelled")).toBe(1);
      } finally {
        store.close();
      }
    });
  });

  it("distinguishes the explicit root retry alias from an absent run retry target", async () => {
    await withRuntimeWorkspace("scheduler-control-intent-root-retry-alias", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, rootTaskWorkflow("root"));
      const store = await openRuntimeStore(workspace);
      try {
        const targetedRun = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const targetedNodeKey = seedControlTarget(store, targetedRun.id, "root", "failed");
        const targeted = await applySchedulerControlIntent(workspace, store, {
          requestId: `retry-root-alias:${targetedRun.id}`,
          runId: targetedRun.id,
          type: "retry",
          target: "root",
        }, { ownerId: "retry-root-alias", advance: false });

        expect(targeted.snapshot.projection.instances[targetedNodeKey]).toMatchObject({ status: "ready", statusReason: "retry" });
        expect(targeted.snapshot.projection.frames.root).toMatchObject({ status: "running" });

        const runRetry = await store.admitRun({ prepared, input: {}, cwd: workspace });
        seedControlTarget(store, runRetry.id, "root", "failed");
        const retriedRun = await applySchedulerControlIntent(workspace, store, {
          requestId: `retry-run:${runRetry.id}`,
          runId: runRetry.id,
          type: "retry",
        }, { ownerId: "retry-run", advance: false });

        expect(retriedRun.snapshot.projection).toMatchObject({ run: { status: "pending" }, frames: {}, instances: {} });
      } finally {
        store.close();
      }
    });
  });

  it("distinguishes the explicit root cancel alias from an absent run cancel target", async () => {
    await withRuntimeWorkspace("scheduler-control-intent-root-cancel-alias", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, rootTaskWorkflow("root"));
      const store = await openRuntimeStore(workspace);
      try {
        const targetedRun = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const targetedNodeKey = seedControlTarget(store, targetedRun.id, "root", "ready");
        const targeted = await applySchedulerControlIntent(workspace, store, {
          requestId: `cancel-root-alias:${targetedRun.id}`,
          runId: targetedRun.id,
          type: "cancel",
          target: "root",
        }, { ownerId: "cancel-root-alias", advance: false });

        expect(targeted.snapshot.projection.instances[targetedNodeKey]).toMatchObject({ status: "cancelled", statusReason: "operator_cancelled" });
        expect(targeted.snapshot.projection.frames.root).toMatchObject({ status: "running" });
        expect(targeted.snapshot.projection.run.status).not.toBe("canceled");

        const runCancel = await store.admitRun({ prepared, input: {}, cwd: workspace });
        seedControlTarget(store, runCancel.id, "root", "ready");
        const canceledRun = await applySchedulerControlIntent(workspace, store, {
          requestId: `cancel-run:${runCancel.id}`,
          runId: runCancel.id,
          type: "cancel",
        }, { ownerId: "cancel-run", advance: false });

        expect(canceledRun.snapshot.projection.run.status).toBe("canceled");
        expect(canceledRun.snapshot.projection.frames.root).toMatchObject({ status: "cancelled" });
      } finally {
        store.close();
      }
    });
  });
});

function seedControlTarget(store: RuntimeStore, runId: string, nodeId: string, status: "ready" | "failed"): string {
  const claim = store.scheduler.claimRun(runId, `seed-${status}`, 60_000);
  if (!claim) throw new Error(`Run '${runId}' could not be claimed for control test setup.`);
  const instancePath = appendNode([], nodeId);
  const nodeKey = deriveInstanceKey(instancePath);
  const events: SchedulerEvent[] = [
    { type: "frame.started", payload: { runId, frameKey: "root", frameKind: "root" } },
    { type: "instance.ready", payload: { runId, nodeKey, nodeId, instancePath, parentFrameKey: "root", readinessSequence: 1 } },
  ];
  if (status === "failed") events.push({ type: "instance.failed", payload: { nodeKey, error: { reason: "test" }, statusReason: "terminal" } });
  throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
    runId,
    expectedVersion: throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId).version,
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey: `seed-${status}:${runId}`,
    events,
  });
  if (!store.scheduler.releaseRun(claim)) throw new Error(`Run '${runId}' control test setup claim was not released.`);
  return nodeKey;
}

function appendControlCandidates(store: RuntimeStore, runId: string, nodeId: string, status: "ready" | "failed", id: string): void {
  const claim = store.scheduler.claimRun(runId, `seed-${id}`, 60_000);
  if (!claim) throw new Error(`Run '${runId}' could not be claimed for control candidate setup.`);
  try {
    const events: SchedulerEvent[] = [];
    for (let index = 0; index < 2; index += 1) {
      const instancePath = appendNode([{ kind: "fanout", nodeId: `${id}_items`, itemIndex: index }], nodeId);
      const nodeKey = deriveInstanceKey(instancePath);
      events.push({ type: "instance.ready", payload: { runId, nodeKey, nodeId, instancePath, parentFrameKey: "root", readinessSequence: index + 10 } });
      if (status === "failed") events.push({ type: "instance.failed", payload: { nodeKey, error: { reason: "test" }, statusReason: "terminal" } });
    }
    throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
      runId,
      expectedVersion: throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId).version,
      ownerEpoch: claim.ownerEpoch,
      idempotencyKey: `seed-candidates:${id}:${runId}`,
      events,
    });
  } finally {
    store.scheduler.releaseRun(claim);
  }
}

function controlEventCount(store: RuntimeStore, runId: string, type: string): number {
  return store.getCommittedRuntimeEventsAfter(runId, 0).filter(event => event.type === type).length;
}

function rootTaskWorkflow(nodeId = "root_task") {
  return defineWorkflow({
    name: `scheduler-control-${nodeId}-task`,
  }).build(({ step }) => {
    const task = step(nodeId).task({
      input: {}, exec: async () => ({ ok: true }),
    });
    return { ok: task.output.ok };
  });
}
