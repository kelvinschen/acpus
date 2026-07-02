import { defineWorkflow, z } from "@acpus/core";
import { describe, expect, it } from "vitest";
import { appendBranch, appendFanoutItem, appendNode, deriveInstanceKey } from "../src/scheduler/identity.js";
import { applySchedulerControlCommand } from "../src/scheduler/control.js";
import { advanceFrozenRun } from "../src/scheduler/runtime-runner.js";
import { openRuntimeStore } from "../src/store/store.js";
import { prepareSyntheticWorkflow, signalWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";

describe("scheduler control command adapter", () => {
  it("pauses, resumes, and re-drives an admitted frozen root task", async () => {
    await withRuntimeWorkspace("scheduler-control-resume", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, rootTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const pause = store.submitCommand({ runId: run.id, type: "pause", payload: { reason: "test" }, idempotencyKey: `pause:${run.id}` });

        await expect(applySchedulerControlCommand(workspace, store, pause, { ownerId: "owner-a" })).resolves.toMatchObject({
          snapshot: { projection: { run: { status: "paused" } } },
        });

        const resume = store.submitCommand({ runId: run.id, type: "resume", idempotencyKey: `resume:${run.id}` });
        const nodeKey = deriveInstanceKey(appendNode([], "root_task"));
        const applied = await applySchedulerControlCommand(workspace, store, resume, { ownerId: "owner-b" });

        expect(applied.advanced).toMatchObject({ status: "completed", started: 1, completed: 1 });
        expect(store.getCommand(pause.id)).toMatchObject({ status: "applied" });
        expect(store.getCommand(resume.id)).toMatchObject({ status: "applied" });
        expect(store.scheduler.loadRunSnapshot(run.id).projection.instances[nodeKey]).toMatchObject({ status: "completed", output: { ok: true } });
      } finally {
        store.close();
      }
    });
  });

  it("does not start the next root node while paused between sequential nodes", async () => {
    await withRuntimeWorkspace("scheduler-control-sequence-pause", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, sequentialRootTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const firstKey = deriveInstanceKey(appendNode([], "first_task"));
        const secondKey = deriveInstanceKey(appendNode([], "second_task"));

        await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store })).resolves.toMatchObject({ status: "idle", started: 1, completed: 1 });
        expect(store.scheduler.loadRunSnapshot(run.id).projection.instances[firstKey]).toMatchObject({ status: "completed" });
        expect(store.scheduler.loadRunSnapshot(run.id).projection.instances[secondKey]).toMatchObject({ status: "ready" });

        const pause = store.submitCommand({ runId: run.id, type: "pause", payload: { reason: "between-nodes" }, idempotencyKey: `pause:${run.id}:between` });
        await expect(applySchedulerControlCommand(workspace, store, pause, { ownerId: "owner-b" })).resolves.toMatchObject({
          snapshot: { projection: { run: { status: "paused" } } },
        });

        await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-c", store })).resolves.toMatchObject({ status: "paused", started: 0 });
        expect(store.scheduler.loadRunSnapshot(run.id).projection.instances[secondKey]).toMatchObject({ status: "ready" });

        const resume = store.submitCommand({ runId: run.id, type: "resume", idempotencyKey: `resume:${run.id}:between` });
        const resumed = await applySchedulerControlCommand(workspace, store, resume, { ownerId: "owner-d" });
        expect(resumed.advanced).toMatchObject({ status: "completed", started: 1, completed: 1 });
        expect(store.scheduler.loadRunSnapshot(run.id).projection.instances[secondKey]).toMatchObject({ status: "completed", output: { value: "first-second" } });
      } finally {
        store.close();
      }
    });
  });

  it("does not materialize the next root node while paused", async () => {
    await withRuntimeWorkspace("scheduler-control-sequence-pause-before-materialize", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, sequentialRootTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const firstKey = deriveInstanceKey(appendNode([], "first_task"));
        const secondKey = deriveInstanceKey(appendNode([], "second_task"));
        const claim = store.scheduler.claimRun(run.id, "bootstrap", 60_000)!;
        store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: store.scheduler.loadRunSnapshot(run.id).version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "pause-before-materialize-bootstrap",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root", scope: { first_task: firstKey } } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: firstKey, nodeId: "first_task", instancePath: appendNode([], "first_task"), parentFrameKey: "root", readinessSequence: 1 } },
            { type: "instance.completed", payload: { nodeKey: firstKey, output: { value: "first" } } },
          ],
        });
        store.scheduler.releaseRun(claim);

        const pause = store.submitCommand({ runId: run.id, type: "pause", payload: { reason: "before-materialize" }, idempotencyKey: `pause:${run.id}:before-materialize` });
        await expect(applySchedulerControlCommand(workspace, store, pause, { ownerId: "owner-a" })).resolves.toMatchObject({
          snapshot: { projection: { run: { status: "paused" } } },
        });

        await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-b", store })).resolves.toMatchObject({ status: "paused", started: 0 });
        expect(store.scheduler.loadRunSnapshot(run.id).projection.instances[secondKey]).toBeUndefined();

        const resume = store.submitCommand({ runId: run.id, type: "resume", idempotencyKey: `resume:${run.id}:before-materialize` });
        await expect(applySchedulerControlCommand(workspace, store, resume, { ownerId: "owner-c" })).resolves.toMatchObject({
          advanced: { status: "completed", started: 1, completed: 1 },
        });
        expect(store.scheduler.loadRunSnapshot(run.id).projection.instances[secondKey]).toMatchObject({ status: "completed", output: { value: "first-second" } });
      } finally {
        store.close();
      }
    });
  });

  it("leaves a scheduler control command pending when the run lease is busy", async () => {
    await withRuntimeWorkspace("scheduler-control-lease-busy", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, rootTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "active-owner", 60_000)!;
        const command = store.submitCommand({ runId: run.id, type: "pause", idempotencyKey: `pause:${run.id}` });

        await expect(applySchedulerControlCommand(workspace, store, command, { ownerId: "control-owner" })).resolves.toMatchObject({
          advanced: { status: "lease_lost" },
        });
        expect(store.getCommand(command.id)).toMatchObject({ status: "pending" });
        expect(store.scheduler.loadRunSnapshot(run.id).projection.run.status).toBe("pending");

        store.scheduler.releaseRun(claim);
      } finally {
        store.close();
      }
    });
  });

  it("consumes a durable signal command against a dynamic node key", async () => {
    await withRuntimeWorkspace("scheduler-control-signal", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, signalWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const nodeKey = deriveInstanceKey(appendNode([], "approve"));
        const claim = store.scheduler.claimRun(run.id, "bootstrap", 60_000)!;
        store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: store.scheduler.loadRunSnapshot(run.id).version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "signal-bootstrap",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root", scope: { approve: nodeKey } } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey, nodeId: "approve", instancePath: appendNode([], "approve"), parentFrameKey: "root", readinessSequence: 1 } },
            { type: "instance.awaiting", payload: { nodeKey, statusReason: "signal" } },
            { type: "signal.awaiting", payload: { runId: run.id, nodeKey, nodeId: "approve" } },
          ],
        });
        store.scheduler.releaseRun(claim);

        const command = store.submitCommand({ runId: run.id, type: "signal", payload: { node: nodeKey, payload: { ok: true } }, idempotencyKey: `signal:${run.id}:${nodeKey}` });
        const applied = await applySchedulerControlCommand(workspace, store, command, { ownerId: "owner-a", advance: false });

        const projection = applied.snapshot.projection;
        expect(applied.advanced).toBeUndefined();
        expect(projection.signalWaits[nodeKey]).toMatchObject({ status: "consumed", payload: { ok: true } });
        expect(projection.instances[nodeKey]).toMatchObject({ status: "completed", output: { ok: true } });
        expect(store.getCommand(command.id)).toMatchObject({ status: "applied" });
      } finally {
        store.close();
      }
    });
  });

  it("resolves a unique static signal alias to the awaiting dynamic node key", async () => {
    await withRuntimeWorkspace("scheduler-control-signal-static-alias", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, signalWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const nodeKey = deriveInstanceKey(appendNode([], "approve"));
        const claim = store.scheduler.claimRun(run.id, "bootstrap", 60_000)!;
        store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: store.scheduler.loadRunSnapshot(run.id).version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "signal-static-bootstrap",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root", scope: { approve: nodeKey } } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey, nodeId: "approve", instancePath: appendNode([], "approve"), parentFrameKey: "root", readinessSequence: 1 } },
            { type: "instance.awaiting", payload: { nodeKey, statusReason: "signal" } },
            { type: "signal.awaiting", payload: { runId: run.id, nodeKey, nodeId: "approve" } },
          ],
        });
        store.scheduler.releaseRun(claim);

        const command = store.submitCommand({ runId: run.id, type: "signal", payload: { node: "approve", payload: { ok: true } }, idempotencyKey: `signal:${run.id}:approve` });
        const applied = await applySchedulerControlCommand(workspace, store, command, { ownerId: "owner-a", advance: false });

        expect(applied.snapshot.projection.signalWaits[nodeKey]).toMatchObject({ status: "consumed", payload: { ok: true } });
        expect(applied.snapshot.projection.instances[nodeKey]).toMatchObject({ status: "completed", output: { ok: true } });
      } finally {
        store.close();
      }
    });
  });

  it("rejects ambiguous static signal aliases with candidate dynamic keys", async () => {
    await withRuntimeWorkspace("scheduler-control-signal-ambiguous-alias", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, rootTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const firstKey = deriveInstanceKey(appendNode(appendFanoutItem([], "items", "a", 0), "approve"));
        const secondKey = deriveInstanceKey(appendNode(appendFanoutItem([], "items", "b", 1), "approve"));
        const claim = store.scheduler.claimRun(run.id, "bootstrap", 60_000)!;
        store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: store.scheduler.loadRunSnapshot(run.id).version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "signal-ambiguous-bootstrap",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: firstKey, nodeId: "approve", instancePath: appendNode(appendFanoutItem([], "items", "a", 0), "approve"), parentFrameKey: "root", readinessSequence: 1 } },
            { type: "instance.awaiting", payload: { nodeKey: firstKey, statusReason: "signal" } },
            { type: "signal.awaiting", payload: { runId: run.id, nodeKey: firstKey, nodeId: "approve" } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: secondKey, nodeId: "approve", instancePath: appendNode(appendFanoutItem([], "items", "b", 1), "approve"), parentFrameKey: "root", readinessSequence: 2 } },
            { type: "instance.awaiting", payload: { nodeKey: secondKey, statusReason: "signal" } },
            { type: "signal.awaiting", payload: { runId: run.id, nodeKey: secondKey, nodeId: "approve" } },
          ],
        });
        store.scheduler.releaseRun(claim);

        const command = store.submitCommand({ runId: run.id, type: "signal", payload: { node: "approve", payload: { ok: true } }, idempotencyKey: `signal:${run.id}:approve` });
        await expect(applySchedulerControlCommand(workspace, store, command, { ownerId: "owner-a", advance: false }))
          .rejects.toThrow(`Candidate nodeKeys: ${[firstKey, secondKey].sort().join(", ")}`);
        expect(store.getCommand(command.id)).toMatchObject({ status: "failed" });
      } finally {
        store.close();
      }
    });
  });

  it("rejects missing signal targets without mutating scheduler state", async () => {
    await withRuntimeWorkspace("scheduler-control-signal-missing-target", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, rootTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const command = store.submitCommand({ runId: run.id, type: "signal", payload: { node: "missing", payload: { ok: true } }, idempotencyKey: `signal:${run.id}:missing` });

        await expect(applySchedulerControlCommand(workspace, store, command, { ownerId: "owner-a", advance: false }))
          .rejects.toThrow(`Scheduler signal command '${command.id}' target 'missing' was not found.`);
        expect(store.getCommand(command.id)).toMatchObject({ status: "failed" });
        expect(store.scheduler.loadRunSnapshot(run.id).projection.signalWaits).toEqual({});
      } finally {
        store.close();
      }
    });
  });

  it("rejects invalid durable signal payloads without consuming the signal wait", async () => {
    await withRuntimeWorkspace("scheduler-control-signal-invalid-payload", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, signalWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const nodeKey = deriveInstanceKey(appendNode([], "approve"));
        const claim = store.scheduler.claimRun(run.id, "bootstrap", 60_000)!;
        store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: store.scheduler.loadRunSnapshot(run.id).version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "signal-invalid-bootstrap",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root", scope: { approve: nodeKey } } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey, nodeId: "approve", instancePath: appendNode([], "approve"), parentFrameKey: "root", readinessSequence: 1 } },
            { type: "instance.awaiting", payload: { nodeKey, statusReason: "signal" } },
            { type: "signal.awaiting", payload: { runId: run.id, nodeKey, nodeId: "approve" } },
          ],
        });
        store.scheduler.releaseRun(claim);

        const invalid = store.submitCommand({ runId: run.id, type: "signal", payload: { node: nodeKey, payload: { ok: "yes" } }, idempotencyKey: `signal:${run.id}:${nodeKey}:invalid` });
        await expect(applySchedulerControlCommand(workspace, store, invalid, { ownerId: "owner-a", advance: false }))
          .rejects.toThrow("Signal payload does not match schema");
        expect(store.getCommand(invalid.id)).toMatchObject({ status: "failed" });
        expect(store.scheduler.loadRunSnapshot(run.id).projection.signalWaits[nodeKey]).toMatchObject({ status: "awaiting" });
        expect(store.scheduler.loadRunSnapshot(run.id).projection.instances[nodeKey]).toMatchObject({ status: "awaiting" });

        const valid = store.submitCommand({ runId: run.id, type: "signal", payload: { node: nodeKey, payload: { ok: true } }, idempotencyKey: `signal:${run.id}:${nodeKey}:valid` });
        const applied = await applySchedulerControlCommand(workspace, store, valid, { ownerId: "owner-b", advance: false });
        expect(applied.snapshot.projection.signalWaits[nodeKey]).toMatchObject({ status: "consumed", payload: { ok: true } });
        expect(applied.snapshot.projection.instances[nodeKey]).toMatchObject({ status: "completed", output: { ok: true } });
      } finally {
        store.close();
      }
    });
  });

  it("replays a recovered signal command after the wait was already consumed", async () => {
    await withRuntimeWorkspace("scheduler-control-signal-recovered-replay", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, signalWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const nodeKey = deriveInstanceKey(appendNode([], "approve"));
        const claim = store.scheduler.claimRun(run.id, "bootstrap", 60_000)!;
        store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: store.scheduler.loadRunSnapshot(run.id).version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "signal-recovered-bootstrap",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root", scope: { approve: nodeKey } } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey, nodeId: "approve", instancePath: appendNode([], "approve"), parentFrameKey: "root", readinessSequence: 1 } },
            { type: "instance.awaiting", payload: { nodeKey, statusReason: "signal" } },
            { type: "signal.awaiting", payload: { runId: run.id, nodeKey, nodeId: "approve" } },
          ],
        });
        store.scheduler.releaseRun(claim);

        const command = store.submitCommand({ runId: run.id, type: "signal", payload: { node: "approve", payload: { ok: true } }, idempotencyKey: `signal:${run.id}:approve:recovered` });
        const signalClaim = store.scheduler.claimRun(run.id, "crash-window", 60_000)!;
        store.scheduler.consumeSignal({
          runId: run.id,
          nodeKey,
          ownerEpoch: signalClaim.ownerEpoch,
          payload: { ok: true },
          commandIdempotencyKey: command.idempotencyKey,
          idempotencyKey: `scheduler:control:${command.id}`,
        });
        store.scheduler.releaseRun(signalClaim);

        const recovered = await applySchedulerControlCommand(workspace, store, command, { ownerId: "owner-a", advance: false });
        expect(recovered.snapshot.projection.signalWaits[nodeKey]).toMatchObject({ status: "consumed", payload: { ok: true } });
        expect(store.getCommand(command.id)).toMatchObject({ status: "applied" });
      } finally {
        store.close();
      }
    });
  });

  it("ignores non-awaiting signal waits when resolving a static alias", async () => {
    await withRuntimeWorkspace("scheduler-control-signal-static-alias-status-filter", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, signalWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const consumedKey = deriveInstanceKey(appendNode(appendFanoutItem([], "items", "done", 0), "approve"));
        const awaitingKey = deriveInstanceKey(appendNode(appendFanoutItem([], "items", "open", 1), "approve"));
        const claim = store.scheduler.claimRun(run.id, "bootstrap", 60_000)!;
        store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: store.scheduler.loadRunSnapshot(run.id).version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "signal-status-filter-bootstrap",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: consumedKey, nodeId: "approve", instancePath: appendNode(appendFanoutItem([], "items", "done", 0), "approve"), parentFrameKey: "root", readinessSequence: 1 } },
            { type: "instance.awaiting", payload: { nodeKey: consumedKey, statusReason: "signal" } },
            { type: "signal.awaiting", payload: { runId: run.id, nodeKey: consumedKey, nodeId: "approve" } },
            { type: "signal.consumed", payload: { nodeKey: consumedKey, payload: { ok: false }, commandIdempotencyKey: "consumed" } },
            { type: "instance.completed", payload: { nodeKey: consumedKey, output: { ok: false } } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: awaitingKey, nodeId: "approve", instancePath: appendNode(appendFanoutItem([], "items", "open", 1), "approve"), parentFrameKey: "root", readinessSequence: 2 } },
            { type: "instance.awaiting", payload: { nodeKey: awaitingKey, statusReason: "signal" } },
            { type: "signal.awaiting", payload: { runId: run.id, nodeKey: awaitingKey, nodeId: "approve" } },
          ],
        });
        store.scheduler.releaseRun(claim);

        const command = store.submitCommand({ runId: run.id, type: "signal", payload: { node: "approve", payload: { ok: true } }, idempotencyKey: `signal:${run.id}:approve:status-filter` });
        const applied = await applySchedulerControlCommand(workspace, store, command, { ownerId: "owner-a", advance: false });

        expect(applied.snapshot.projection.signalWaits[consumedKey]).toMatchObject({ status: "consumed", payload: { ok: false } });
        expect(applied.snapshot.projection.signalWaits[awaitingKey]).toMatchObject({ status: "consumed", payload: { ok: true } });
        expect(applied.snapshot.projection.instances[awaitingKey]).toMatchObject({ status: "completed", output: { ok: true } });
      } finally {
        store.close();
      }
    });
  });

  it("retries a failed dynamic instance without requiring a static-node command path", async () => {
    await withRuntimeWorkspace("scheduler-control-retry", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, rootTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const nodeKey = deriveInstanceKey(appendNode([], "root_task"));
        const claim = store.scheduler.claimRun(run.id, "bootstrap", 60_000)!;
        store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: store.scheduler.loadRunSnapshot(run.id).version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "failed-bootstrap",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root", scope: { root_task: nodeKey } } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey, nodeId: "root_task", instancePath: appendNode([], "root_task"), parentFrameKey: "root", readinessSequence: 1 } },
            { type: "instance.failed", payload: { nodeKey, error: { message: "boom" } } },
          ],
        });
        store.scheduler.releaseRun(claim);

        const command = store.submitCommand({ runId: run.id, type: "retry", payload: { target: nodeKey }, idempotencyKey: `retry:${run.id}:${nodeKey}` });
        const applied = await applySchedulerControlCommand(workspace, store, command, { ownerId: "owner-a", advance: false });

        expect(applied.snapshot.projection.instances[nodeKey]).toMatchObject({ status: "ready", statusReason: "retry" });
        expect(store.getCommand(command.id)).toMatchObject({ status: "applied" });
      } finally {
        store.close();
      }
    });
  });

  it("resolves a unique static retry alias to the failed dynamic node key", async () => {
    await withRuntimeWorkspace("scheduler-control-retry-static-alias", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, rootTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const nodeKey = deriveInstanceKey(appendNode([], "root_task"));
        const claim = store.scheduler.claimRun(run.id, "bootstrap", 60_000)!;
        store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: store.scheduler.loadRunSnapshot(run.id).version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "failed-static-bootstrap",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root", scope: { root_task: nodeKey } } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey, nodeId: "root_task", instancePath: appendNode([], "root_task"), parentFrameKey: "root", readinessSequence: 1 } },
            { type: "instance.failed", payload: { nodeKey, error: { message: "boom" } } },
          ],
        });
        store.scheduler.releaseRun(claim);

        const command = store.submitCommand({ runId: run.id, type: "retry", payload: { target: "root_task" }, idempotencyKey: `retry:${run.id}:root_task` });
        const applied = await applySchedulerControlCommand(workspace, store, command, { ownerId: "owner-a", advance: false });

        expect(applied.snapshot.projection.instances[nodeKey]).toMatchObject({ status: "ready", statusReason: "retry" });
      } finally {
        store.close();
      }
    });
  });

  it("resolves a unique static retry alias to a failed composite frame key", async () => {
    await withRuntimeWorkspace("scheduler-control-retry-frame-static-alias", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, rootTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const frameKey = deriveInstanceKey(appendNode([], "choose"));
        const branchKey = deriveInstanceKey(appendBranch([], "choose", "then"));
        const claim = store.scheduler.claimRun(run.id, "bootstrap", 60_000)!;
        store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: store.scheduler.loadRunSnapshot(run.id).version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "failed-frame-static-bootstrap",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
            { type: "frame.started", payload: { runId: run.id, frameKey, frameKind: "node", nodeKey: frameKey, nodeId: "choose", parentFrameKey: "root", instancePath: appendNode([], "choose") } },
            { type: "branch.decided", payload: { frameKey, branchId: "then" } },
            { type: "frame.started", payload: { runId: run.id, frameKey: branchKey, frameKind: "branch", nodeId: "choose", parentFrameKey: frameKey, instancePath: appendBranch([], "choose", "then") } },
            { type: "frame.failed", payload: { frameKey: branchKey, error: { reason: "boom" } } },
            { type: "frame.failed", payload: { frameKey, error: { reason: "boom" } } },
            { type: "frame.failed", payload: { frameKey: "root", error: { reason: "boom" } } },
          ],
        });
        store.scheduler.releaseRun(claim);

        const command = store.submitCommand({ runId: run.id, type: "retry", payload: { target: "choose" }, idempotencyKey: `retry:${run.id}:choose` });
        const applied = await applySchedulerControlCommand(workspace, store, command, { ownerId: "owner-a", advance: false });

        expect(applied.snapshot.projection.frames[frameKey]).toBeUndefined();
        expect(applied.snapshot.projection.frames[branchKey]).toBeUndefined();
        expect(applied.snapshot.projection.branchDecisions[frameKey]).toBeUndefined();
      } finally {
        store.close();
      }
    });
  });

  it("replays a recovered static retry command after its frame subtree was cleared", async () => {
    await withRuntimeWorkspace("scheduler-control-retry-recovered-replay", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, rootTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const frameKey = deriveInstanceKey(appendNode([], "choose"));
        const branchKey = deriveInstanceKey(appendBranch([], "choose", "then"));
        const claim = store.scheduler.claimRun(run.id, "bootstrap", 60_000)!;
        store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: store.scheduler.loadRunSnapshot(run.id).version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "failed-frame-recovered-bootstrap",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
            { type: "frame.started", payload: { runId: run.id, frameKey, frameKind: "node", nodeKey: frameKey, nodeId: "choose", parentFrameKey: "root", instancePath: appendNode([], "choose") } },
            { type: "branch.decided", payload: { frameKey, branchId: "then" } },
            { type: "frame.started", payload: { runId: run.id, frameKey: branchKey, frameKind: "branch", nodeId: "choose", parentFrameKey: frameKey, instancePath: appendBranch([], "choose", "then") } },
            { type: "frame.failed", payload: { frameKey: branchKey, error: { reason: "boom" } } },
            { type: "frame.failed", payload: { frameKey, error: { reason: "boom" } } },
            { type: "frame.failed", payload: { frameKey: "root", error: { reason: "boom" } } },
          ],
        });
        store.scheduler.releaseRun(claim);

        const command = store.submitCommand({ runId: run.id, type: "retry", payload: { target: "choose" }, idempotencyKey: `retry:${run.id}:choose:recovered` });
        const retryClaim = store.scheduler.claimRun(run.id, "crash-window", 60_000)!;
        store.scheduler.retry({ runId: run.id, ownerEpoch: retryClaim.ownerEpoch, idempotencyKey: `scheduler:control:${command.id}`, targetKey: frameKey });
        store.scheduler.releaseRun(retryClaim);

        const recovered = await applySchedulerControlCommand(workspace, store, command, { ownerId: "owner-a", advance: false });
        expect(recovered.snapshot.projection.frames[frameKey]).toBeUndefined();
        expect(store.getCommand(command.id)).toMatchObject({ status: "applied" });
      } finally {
        store.close();
      }
    });
  });

  it("rejects ambiguous static retry aliases with candidate dynamic keys", async () => {
    await withRuntimeWorkspace("scheduler-control-retry-ambiguous-alias", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, rootTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const firstKey = deriveInstanceKey(appendNode(appendFanoutItem([], "items", "a", 0), "item_task"));
        const secondKey = deriveInstanceKey(appendNode(appendFanoutItem([], "items", "b", 1), "item_task"));
        const claim = store.scheduler.claimRun(run.id, "bootstrap", 60_000)!;
        store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: store.scheduler.loadRunSnapshot(run.id).version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "failed-ambiguous-bootstrap",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: firstKey, nodeId: "item_task", instancePath: appendNode(appendFanoutItem([], "items", "a", 0), "item_task"), parentFrameKey: "root", readinessSequence: 1 } },
            { type: "instance.failed", payload: { nodeKey: firstKey, error: { message: "first" } } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: secondKey, nodeId: "item_task", instancePath: appendNode(appendFanoutItem([], "items", "b", 1), "item_task"), parentFrameKey: "root", readinessSequence: 2 } },
            { type: "instance.failed", payload: { nodeKey: secondKey, error: { message: "second" } } },
          ],
        });
        store.scheduler.releaseRun(claim);

        const command = store.submitCommand({ runId: run.id, type: "retry", payload: { target: "item_task" }, idempotencyKey: `retry:${run.id}:item_task` });
        await expect(applySchedulerControlCommand(workspace, store, command, { ownerId: "owner-a", advance: false }))
          .rejects.toThrow(`Candidate target keys: ${[firstKey, secondKey].sort().join(", ")}`);
        expect(store.getCommand(command.id)).toMatchObject({ status: "failed" });
      } finally {
        store.close();
      }
    });
  });

  it("rejects missing retry targets without mutating scheduler state", async () => {
    await withRuntimeWorkspace("scheduler-control-retry-missing-target", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, rootTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const command = store.submitCommand({ runId: run.id, type: "retry", payload: { target: "missing" }, idempotencyKey: `retry:${run.id}:missing` });

        await expect(applySchedulerControlCommand(workspace, store, command, { ownerId: "owner-a", advance: false }))
          .rejects.toThrow("Retry target 'missing' was not found.");
        expect(store.getCommand(command.id)).toMatchObject({ status: "failed" });
        expect(store.scheduler.loadRunSnapshot(run.id).projection.instances).toEqual({});
      } finally {
        store.close();
      }
    });
  });

  it("ignores non-failed node instances when resolving a static retry alias", async () => {
    await withRuntimeWorkspace("scheduler-control-retry-static-alias-status-filter", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, rootTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const completedKey = deriveInstanceKey(appendNode(appendFanoutItem([], "items", "done", 0), "item_task"));
        const failedKey = deriveInstanceKey(appendNode(appendFanoutItem([], "items", "failed", 1), "item_task"));
        const claim = store.scheduler.claimRun(run.id, "bootstrap", 60_000)!;
        store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: store.scheduler.loadRunSnapshot(run.id).version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "retry-status-filter-bootstrap",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: completedKey, nodeId: "item_task", instancePath: appendNode(appendFanoutItem([], "items", "done", 0), "item_task"), parentFrameKey: "root", readinessSequence: 1 } },
            { type: "instance.completed", payload: { nodeKey: completedKey, output: { ok: true } } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: failedKey, nodeId: "item_task", instancePath: appendNode(appendFanoutItem([], "items", "failed", 1), "item_task"), parentFrameKey: "root", readinessSequence: 2 } },
            { type: "instance.failed", payload: { nodeKey: failedKey, error: { message: "boom" } } },
          ],
        });
        store.scheduler.releaseRun(claim);

        const command = store.submitCommand({ runId: run.id, type: "retry", payload: { target: "item_task" }, idempotencyKey: `retry:${run.id}:item_task:status-filter` });
        const applied = await applySchedulerControlCommand(workspace, store, command, { ownerId: "owner-a", advance: false });

        expect(applied.snapshot.projection.instances[completedKey]).toMatchObject({ status: "completed" });
        expect(applied.snapshot.projection.instances[failedKey]).toMatchObject({ status: "ready", statusReason: "retry" });
      } finally {
        store.close();
      }
    });
  });

  it("applies a durable run cancel command", async () => {
    await withRuntimeWorkspace("scheduler-control-cancel-run", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, rootTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const nodeKey = deriveInstanceKey(appendNode([], "root_task"));
        const claim = store.scheduler.claimRun(run.id, "bootstrap", 60_000)!;
        store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: store.scheduler.loadRunSnapshot(run.id).version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "cancel-run-bootstrap",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root", scope: { root_task: nodeKey } } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey, nodeId: "root_task", instancePath: appendNode([], "root_task"), parentFrameKey: "root", readinessSequence: 1 } },
          ],
        });
        store.scheduler.releaseRun(claim);

        const command = store.submitCommand({ runId: run.id, type: "cancel", idempotencyKey: `cancel:${run.id}` });
        const applied = await applySchedulerControlCommand(workspace, store, command, { ownerId: "owner-a", advance: false });

        expect(applied.snapshot.projection.run.status).toBe("canceled");
        expect(applied.snapshot.projection.instances[nodeKey]).toMatchObject({ status: "cancelled", statusReason: "operator_cancelled" });
        expect(store.getCommand(command.id)).toMatchObject({ status: "applied" });
        expect(store.getRun(run.id)).toMatchObject({ status: "canceled" });
      } finally {
        store.close();
      }
    });
  });

  it("resolves a unique static cancel alias to a non-terminal dynamic target", async () => {
    await withRuntimeWorkspace("scheduler-control-cancel-static-alias", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, rootTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const liveKey = deriveInstanceKey(appendNode(appendFanoutItem([], "items", "live", 0), "item_task"));
        const doneKey = deriveInstanceKey(appendNode(appendFanoutItem([], "items", "done", 1), "item_task"));
        const claim = store.scheduler.claimRun(run.id, "bootstrap", 60_000)!;
        store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: store.scheduler.loadRunSnapshot(run.id).version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "cancel-static-bootstrap",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: liveKey, nodeId: "item_task", instancePath: appendNode(appendFanoutItem([], "items", "live", 0), "item_task"), parentFrameKey: "root", readinessSequence: 1 } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: doneKey, nodeId: "item_task", instancePath: appendNode(appendFanoutItem([], "items", "done", 1), "item_task"), parentFrameKey: "root", readinessSequence: 2 } },
            { type: "instance.completed", payload: { nodeKey: doneKey, output: { ok: true } } },
          ],
        });
        store.scheduler.releaseRun(claim);

        const command = store.submitCommand({ runId: run.id, type: "cancel", payload: { target: "item_task" }, idempotencyKey: `cancel:${run.id}:item_task` });
        const applied = await applySchedulerControlCommand(workspace, store, command, { ownerId: "owner-a", advance: false });

        expect(applied.snapshot.projection.instances[liveKey]).toMatchObject({ status: "cancelled", statusReason: "operator_cancelled" });
        expect(applied.snapshot.projection.instances[doneKey]).toMatchObject({ status: "completed" });
        expect(applied.snapshot.projection.run.status).toBe("pending");
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
    step("root_task").task({
      outputSchema: z.object({ ok: z.boolean() }),
      run: {
        input: {},
        exec: async () => ({ ok: true }),
      },
    });
    return {};
  });
}

function sequentialRootTaskWorkflow() {
  return defineWorkflow({
    name: "scheduler-control-root-sequence",
  }).build(({ step }) => {
    const first = step("first_task").task({
      outputSchema: z.object({ value: z.string() }),
      run: { input: {}, exec: async () => ({ value: "first" }) },
    });
    const second = step("second_task").task({
      outputSchema: z.object({ value: z.string() }),
      run: {
        input: { value: first.output.value },
        exec: async ({ input }) => ({ value: `${input.value}-second` }),
      },
    });
    return { final: second.output.value };
  });
}
