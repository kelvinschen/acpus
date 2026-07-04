import { defineWorkflow } from "@acpus/core";
import { describe, expect, it } from "vitest";
import { applySchedulerControlIntent } from "../src/scheduler/control.js";
import { appendNode, deriveInstanceKey } from "../src/scheduler/identity.js";
import { advanceFrozenRun } from "../src/scheduler/runtime-runner.js";
import { openRuntimeStore } from "../src/store/store.js";
import { prepareSyntheticWorkflow, signalWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";

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
          reason: "test",
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
        expect(store.scheduler.loadRunSnapshot(run.id).projection.instances[nodeKey]).toMatchObject({ status: "completed", output: { ok: true } });
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

        expect(store.scheduler.loadRunSnapshot(run.id).projection.signalWaits[nodeKey]).toMatchObject({ status: "awaiting" });

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
});

function rootTaskWorkflow() {
  return defineWorkflow({
    name: "scheduler-control-root-task",
  }).build(({ step }) => {
    const task = step("root_task").task({
      run: { input: {}, exec: async () => ({ ok: true }) },
    });
    return { ok: task.output.ok };
  });
}
