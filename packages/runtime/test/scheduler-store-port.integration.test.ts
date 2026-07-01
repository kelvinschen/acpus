import { describe, expect, it } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { join } from "node:path";
import { openRuntimeStore, type RuntimeStore } from "../src/store/store.js";
import type { RunOwnerClaim } from "../src/scheduler/store-port.js";
import { prepareSyntheticWorkflow, validWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";

describe("scheduler store port", () => {
  it("claims run ownership, appends scheduler events, and rebuilds snapshots", async () => {
    await withRuntimeWorkspace("scheduler-store-port", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000);
        expect(claim).toMatchObject({ runId: run.id, ownerId: "owner-a", ownerEpoch: 1 });
        expect(store.scheduler.claimRun(run.id, "owner-b", 60_000)).toBeUndefined();

        const snapshot = store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: 1,
          ownerEpoch: claim!.ownerEpoch,
          idempotencyKey: "scheduler:event",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "require_ready~1", nodeId: "require_ready", instancePath: [{ kind: "node", nodeId: "require_ready" }], parentFrameKey: "root", readinessSequence: 1 } },
          ],
        });

        expect(snapshot.version).toBe(3);
        expect(snapshot.projection.frames.root).toMatchObject({ status: "running" });
        expect(snapshot.projection.instances["require_ready~1"]).toMatchObject({ status: "ready", nodeId: "require_ready" });
        expect(dbScalar(workspace, "SELECT status FROM node_instances WHERE run_id = ? AND node_key = ?", run.id, "require_ready~1")).toBe("ready");

        const replay = store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: 1,
          ownerEpoch: claim!.ownerEpoch,
          idempotencyKey: "scheduler:event",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "require_ready~1", nodeId: "require_ready", instancePath: [{ kind: "node", nodeId: "require_ready" }], parentFrameKey: "root", readinessSequence: 1 } },
          ],
        });
        expect(replay.version).toBe(snapshot.version);
        expect(() => store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: 1,
          ownerEpoch: claim!.ownerEpoch,
          idempotencyKey: "scheduler:event",
          events: [{ type: "control.paused", payload: { reason: "conflict" } }],
        })).toThrow("conflicts");

        const eventCount = dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ?", run.id);
        expect(() => store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: snapshot.version,
          ownerEpoch: claim!.ownerEpoch,
          idempotencyKey: "scheduler:invalid-transition",
          events: [{ type: "frame.completed", payload: { frameKey: "missing" } }],
        })).toThrow("Unknown frame");
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ?", run.id)).toBe(eventCount);

        expect(() => store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: 1,
          ownerEpoch: claim!.ownerEpoch,
          idempotencyKey: "scheduler:stale-version",
          events: [{ type: "control.paused", payload: { reason: "test" } }],
        })).toThrow("version mismatch");

        expect(store.scheduler.releaseRun(claim!)).toBe(true);
        expect(store.scheduler.claimRun(run.id, "owner-b", 60_000)).toMatchObject({ ownerId: "owner-b", ownerEpoch: 2 });
      } finally {
        store.close();
      }
    });
  });

  it("does not release a run lease for the wrong owner or stale owner epoch", async () => {
    await withRuntimeWorkspace("scheduler-store-release-safety", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const first = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;

        expect(store.scheduler.releaseRun({ ...first, ownerId: "wrong-owner" })).toBe(false);
        expect(store.scheduler.claimRun(run.id, "owner-b", 60_000)).toBeUndefined();
        expect(store.scheduler.releaseRun(first)).toBe(true);
        const second = store.scheduler.claimRun(run.id, "owner-b", 60_000)!;
        expect(second).toMatchObject({ ownerEpoch: 2 });

        expect(store.scheduler.releaseRun(first)).toBe(false);
        expect(store.scheduler.claimRun(run.id, "owner-c", 60_000)).toBeUndefined();
        expect(store.scheduler.releaseRun(second)).toBe(true);
        expect(store.scheduler.claimRun(run.id, "owner-c", 60_000)).toMatchObject({ ownerEpoch: 3 });
      } finally {
        store.close();
      }
    });
  });

  it("ignores old runtime events whose type names overlap scheduler events", async () => {
    await withRuntimeWorkspace("scheduler-store-legacy-event-overlap", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        writeLegacyEvent(workspace, run.id, "signal.awaiting", "require_ready~1", {});

        const snapshot = store.scheduler.loadRunSnapshot(run.id);
        expect(snapshot.projection.signalWaits).toEqual({});
      } finally {
        store.close();
      }
    });
  });

  it("does not treat append idempotency keys as string prefixes", async () => {
    await withRuntimeWorkspace("scheduler-store-idempotency-prefix", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;

        const first = store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: 1,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "scheduler:event:child",
          events: [{ type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } }],
        });
        const second = store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: first.version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "scheduler:event",
          events: [{ type: "control.paused", payload: { reason: "test" } }],
        });

        expect(second.version).toBe(first.version + 1);
        expect(second.projection.run.status).toBe("paused");
      } finally {
        store.close();
      }
    });
  });

  it("bridges pause and resume to public run status before root materialization", async () => {
    await withRuntimeWorkspace("scheduler-store-public-empty-pause-resume", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;

        expect(store.scheduler.pauseRun({ runId: run.id, ownerEpoch: claim.ownerEpoch, idempotencyKey: "public:pause" }).projection.run.status).toBe("paused");
        expect(store.getRun(run.id)).toMatchObject({ status: "paused" });

        expect(store.scheduler.resumeRun({ runId: run.id, ownerEpoch: claim.ownerEpoch, idempotencyKey: "public:resume" }).projection.run.status).toBe("pending");
        expect(store.getRun(run.id)).toMatchObject({ status: "pending" });
      } finally {
        store.close();
      }
    });
  });

  it("bridges scheduler terminal events to public events once with mixed event sequencing", async () => {
    await withRuntimeWorkspace("scheduler-store-public-terminal-sequence", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;

        const completed = store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: 1,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "public:terminal",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
            { type: "frame.completed", payload: { frameKey: "root", result: { ok: true }, terminalReason: "root_completed" } },
          ],
        });

        expect(completed.version).toBe(4);
        expect(store.getRun(run.id)).toMatchObject({ status: "completed", output: { ok: true } });
        expect(dbRows(workspace, "SELECT sequence, type FROM run_events WHERE run_id = ? ORDER BY sequence", run.id)).toEqual([
          { sequence: 1, type: "run.admitted" },
          { sequence: 2, type: "frame.started" },
          { sequence: 3, type: "frame.completed" },
          { sequence: 4, type: "run.completed" },
        ]);

        expect(store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: 1,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "public:terminal",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
            { type: "frame.completed", payload: { frameKey: "root", result: { ok: true }, terminalReason: "root_completed" } },
          ],
        }).version).toBe(4);
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ? AND type = 'run.completed'", run.id)).toBe(1);
      } finally {
        store.close();
      }
    });
  });

  it("bridges scheduler run-level retry back to a clean public pending run", async () => {
    await withRuntimeWorkspace("scheduler-store-run-retry", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;

        store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: 1,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "public:fail-before-retry",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root", scope: { require_ready: "require_ready~1" } } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "require_ready~1", nodeId: "require_ready", instancePath: [{ kind: "node", nodeId: "require_ready" }], parentFrameKey: "root", readinessSequence: 1 } },
            { type: "instance.failed", payload: { nodeKey: "require_ready~1", error: { reason: "bad" } } },
            { type: "frame.failed", payload: { frameKey: "root", error: { reason: "bad" }, terminalReason: "root_failed" } },
          ],
        });

        expect(store.getRun(run.id)).toMatchObject({ status: "failed" });
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM node_states WHERE run_id = ?", run.id)).toBeGreaterThan(0);

        const retried = store.scheduler.retryRun({ runId: run.id, ownerEpoch: claim.ownerEpoch, idempotencyKey: "public:run-retry" });

        expect(retried.projection).toMatchObject({ run: { status: "pending", paused: false }, frames: {}, instances: {} });
        expect(store.getRun(run.id)).toMatchObject({ status: "pending" });
        expect(store.getRun(run.id)?.output).toBeUndefined();
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM scheduler_frames WHERE run_id = ?", run.id)).toBe(0);
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM node_instances WHERE run_id = ?", run.id)).toBe(0);
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM node_states WHERE run_id = ?", run.id)).toBe(0);
        expect(() => store.scheduler.retryRun({ runId: run.id, ownerEpoch: claim.ownerEpoch, idempotencyKey: "public:run-retry-again" })).toThrow("Cannot retry run from pending.");
      } finally {
        store.close();
      }
    });
  });

  it("bridges scheduler node retry out of a failed public run", async () => {
    await withRuntimeWorkspace("scheduler-store-node-retry-failed-run", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;

        store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: 1,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "public:fail-before-node-retry",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root", scope: { require_ready: "require_ready~1" } } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "require_ready~1", nodeId: "require_ready", instancePath: [{ kind: "node", nodeId: "require_ready" }], parentFrameKey: "root", readinessSequence: 1 } },
            { type: "instance.failed", payload: { nodeKey: "require_ready~1", error: { reason: "bad" } } },
            { type: "frame.failed", payload: { frameKey: "root", error: { reason: "bad" }, terminalReason: "root_failed" } },
          ],
        });

        expect(store.getRun(run.id)).toMatchObject({ status: "failed" });

        const retried = store.scheduler.retry({
          runId: run.id,
          nodeKey: "require_ready~1",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "public:node-retry",
        });

        expect(retried.projection.run).toMatchObject({ status: "pending", paused: false });
        expect(retried.projection.frames.root).toMatchObject({ status: "running" });
        expect(retried.projection.instances["require_ready~1"]).toMatchObject({ status: "ready", statusReason: "retry" });
        expect(store.getRun(run.id)).toMatchObject({ status: "pending" });
      } finally {
        store.close();
      }
    });
  });

  it("reopens parent group member when retrying a failed leaf inside a multi-node branch", async () => {
    await withRuntimeWorkspace("scheduler-store-node-retry-parent-member", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;

        store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: 1,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "public:fail-branch-leaf-before-retry",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root", scope: { leaf: "leaf~1" } } },
            { type: "frame.started", payload: { runId: run.id, frameKey: "parallel~1", frameKind: "node", parentFrameKey: "root", nodeKey: "parallel~1", nodeId: "parallel", strategy: "all" } },
            { type: "group.started", payload: { runId: run.id, groupKey: "parallel~1", nodeKey: "parallel~1", nodeId: "parallel", kind: "parallel", strategy: "all" } },
            { type: "group.member_ready", payload: { runId: run.id, groupKey: "parallel~1", memberKey: "branch~left", memberKind: "branch", branchId: "left", readinessSequence: 1 } },
            { type: "frame.started", payload: { runId: run.id, frameKey: "branch~left", frameKind: "branch", parentFrameKey: "parallel~1", nodeId: "parallel", strategy: "all", scope: { leaf: "leaf~1" } } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "leaf~1", nodeId: "leaf", instancePath: [{ kind: "branch", nodeId: "parallel", branchId: "left" }, { kind: "node", nodeId: "leaf" }], parentFrameKey: "branch~left", readinessSequence: 1 } },
            { type: "instance.failed", payload: { nodeKey: "leaf~1", error: { reason: "bad" } } },
            { type: "frame.failed", payload: { frameKey: "branch~left", error: { reason: "bad" }, terminalReason: "node_failed" } },
            { type: "group.member_failed", payload: { memberKey: "branch~left", error: { reason: "bad" } } },
            { type: "group.failed", payload: { groupKey: "parallel~1", error: { reason: "bad" } } },
            { type: "frame.failed", payload: { frameKey: "parallel~1", error: { reason: "bad" }, terminalReason: "group_failed" } },
            { type: "frame.failed", payload: { frameKey: "root", error: { reason: "bad" }, terminalReason: "group_failed" } },
          ],
        });

        expect(store.getRun(run.id)).toMatchObject({ status: "failed" });

        const retried = store.scheduler.retry({
          runId: run.id,
          nodeKey: "leaf~1",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "public:branch-leaf-retry",
        });

        expect(retried.projection.run).toMatchObject({ status: "pending", paused: false });
        expect(retried.projection.frames.root).toMatchObject({ status: "running" });
        expect(retried.projection.frames["parallel~1"]).toMatchObject({ status: "running" });
        expect(retried.projection.frames["branch~left"]).toMatchObject({ status: "running" });
        expect(retried.projection.groups["parallel~1"]).toMatchObject({ status: "running" });
        expect(retried.projection.groupMembers["branch~left"]).toMatchObject({ status: "ready" });
        expect(retried.projection.instances["leaf~1"]).toMatchObject({ status: "ready", statusReason: "retry" });
        expect(store.getRun(run.id)).toMatchObject({ status: "pending" });
      } finally {
        store.close();
      }
    });
  });

  it("does not overwrite an already public-terminal run from scheduler bridge", async () => {
    await withRuntimeWorkspace("scheduler-store-public-terminal-monotonic", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        store.completeRun({ runId: run.id, output: { old: true }, nodes: {} });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const snapshot = store.scheduler.loadRunSnapshot(run.id);

        store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: snapshot.version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "public:late-terminal",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
            { type: "frame.failed", payload: { frameKey: "root", error: { reason: "late" }, terminalReason: "late" } },
          ],
        });

        expect(store.getRun(run.id)).toMatchObject({ status: "completed", output: { old: true } });
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ? AND type = 'run.completed'", run.id)).toBe(1);
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ? AND type = 'run.failed'", run.id)).toBe(0);
      } finally {
        store.close();
      }
    });
  });

  it("records attempts durably and rejects stale owner commits", async () => {
    await withRuntimeWorkspace("scheduler-store-attempts", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const first = store.scheduler.claimRun(run.id, "owner-a", 60_000);
        readyNode(store, run.id, first!, "attempt-ready-node");
        const attempt = store.scheduler.startAttempt({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          ownerEpoch: first!.ownerEpoch,
          idempotencyKey: "attempt:start",
        });
        expect(attempt).toMatchObject({ attemptNo: 1 });
        expect(store.scheduler.startAttempt({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          ownerEpoch: first!.ownerEpoch,
          idempotencyKey: "attempt:start",
        })).toEqual(attempt);
        expect(() => store.scheduler.startAttempt({
          runId: run.id,
          nodeKey: "other~1",
          nodeId: "other",
          ownerEpoch: first!.ownerEpoch,
          idempotencyKey: "attempt:start",
        })).toThrow("conflicts");
        expect(dbScalar(workspace, "SELECT status FROM node_attempts WHERE attempt_id = ?", attempt.attemptId)).toBe("started");
        expect(() => store.scheduler.markExpiredOwnerAttemptsSuperseded(run.id, first!.ownerEpoch)).toThrow("still active");

        const db = new DatabaseSync(join(workspace, ".acpus", "state", "runtime.db"));
        try {
          db.prepare("UPDATE run_leases SET lease_expires_at = ? WHERE run_id = ?").run(new Date(Date.now() - 1_000).toISOString(), run.id);
        } finally {
          db.close();
        }

        const second = store.scheduler.claimRun(run.id, "owner-b", 60_000);
        expect(second).toMatchObject({ ownerEpoch: 2 });
        expect(() => store.scheduler.commitAttemptResult({
          runId: run.id,
          attemptId: attempt.attemptId,
          ownerEpoch: first!.ownerEpoch,
          result: { status: "completed", output: { ok: true } },
          idempotencyKey: "attempt:late",
        })).toThrow("owner epoch is not active");

        const superseded = store.scheduler.markExpiredOwnerAttemptsSuperseded(run.id, first!.ownerEpoch);
        expect(superseded.projection.attempts[attempt.attemptId]).toMatchObject({ status: "superseded" });
        expect(dbScalar(workspace, "SELECT status FROM node_attempts WHERE attempt_id = ?", attempt.attemptId)).toBe("superseded");
      } finally {
        store.close();
      }
    });
  });

  it("rejects heartbeat after the current owner lease has expired", async () => {
    await withRuntimeWorkspace("scheduler-store-expired-heartbeat", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const db = new DatabaseSync(join(workspace, ".acpus", "state", "runtime.db"));
        try {
          db.prepare("UPDATE run_leases SET lease_expires_at = ? WHERE run_id = ?").run(new Date(Date.now() - 1_000).toISOString(), run.id);
        } finally {
          db.close();
        }

        expect(store.scheduler.heartbeatRun(claim, 60_000)).toBe(false);
        expect(store.scheduler.claimRun(run.id, "owner-b", 60_000)).toMatchObject({ ownerEpoch: 2 });
      } finally {
        store.close();
      }
    });
  });

  it("pauses by cancelling started attempts and requeueing active work", async () => {
    await withRuntimeWorkspace("scheduler-store-pause-active", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        readyGroupNode(store, run.id, claim, "pause-ready-group-node");
        const attempt = store.scheduler.startAttempt({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "pause:attempt:start",
        });

        const paused = store.scheduler.pauseRun({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          reason: "user",
          idempotencyKey: "pause:run",
        });

        expect(paused.projection.run).toMatchObject({ status: "paused", paused: true });
        expect(paused.projection.attempts[attempt.attemptId]).toMatchObject({ status: "cancelled", cancelReason: "paused" });
        expect(paused.projection.instances["require_ready~1"]).toMatchObject({ status: "ready", readinessSequence: 1, statusReason: "paused" });
        expect(paused.projection.groupMembers["require_ready~1"]).toMatchObject({ status: "ready", readinessSequence: 1 });
        expect(store.scheduler.pauseRun({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          reason: "user",
          idempotencyKey: "pause:run",
        }).version).toBe(paused.version);
        expect(() => store.scheduler.startAttempt({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "pause:attempt:blocked",
        })).toThrow("is paused");

        const eventCount = dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ?", run.id);
        expect(() => store.scheduler.commitAttemptResult({
          runId: run.id,
          attemptId: attempt.attemptId,
          ownerEpoch: claim.ownerEpoch,
          result: { status: "completed", output: { late: true } },
          idempotencyKey: "pause:attempt:late",
        })).toThrow("already cancelled");
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ?", run.id)).toBe(eventCount);

        const resumed = store.scheduler.resumeRun({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "pause:resume",
        });
        expect(resumed.projection.run).toMatchObject({ status: "pending", paused: false });
        expect(store.scheduler.resumeRun({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "pause:resume",
        }).version).toBe(resumed.version);
        const restarted = store.scheduler.startAttempt({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "pause:attempt:restart",
        });
        expect(restarted).toMatchObject({ attemptNo: 2 });
        const restartedSnapshot = store.scheduler.loadRunSnapshot(run.id);
        expect(restartedSnapshot.projection.instances["require_ready~1"]).toMatchObject({ status: "running" });
        expect(restartedSnapshot.projection.groupMembers["require_ready~1"]).toMatchObject({ status: "running" });
      } finally {
        store.close();
      }
    });
  });

  it("retries failed dynamic instances through scheduler events", async () => {
    await withRuntimeWorkspace("scheduler-store-retry", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const snapshot = store.scheduler.loadRunSnapshot(run.id);
        store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: snapshot.version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "retry:failed-state",
          events: [
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "require_ready~1", nodeId: "require_ready", instancePath: [{ kind: "node", nodeId: "require_ready" }], readinessSequence: 1 } },
            { type: "instance.failed", payload: { nodeKey: "require_ready~1", error: { reason: "boom" }, statusReason: "terminal" } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "other~1", nodeId: "other", instancePath: [{ kind: "node", nodeId: "other" }], readinessSequence: 2 } },
            { type: "instance.failed", payload: { nodeKey: "other~1", error: { reason: "boom" }, statusReason: "terminal" } },
            { type: "group.started", payload: { runId: run.id, groupKey: "parallel~1", nodeKey: "parallel~1", nodeId: "parallel", kind: "parallel", strategy: "all" } },
            { type: "group.member_ready", payload: { runId: run.id, groupKey: "parallel~1", memberKey: "require_ready~1", memberKind: "branch", branchId: "left", readinessSequence: 1 } },
            { type: "group.member_failed", payload: { memberKey: "require_ready~1", error: { reason: "boom" } } },
            { type: "group.member_ready", payload: { runId: run.id, groupKey: "parallel~1", memberKey: "other~1", memberKind: "branch", branchId: "right", readinessSequence: 2 } },
          ],
        });

        const retried = store.scheduler.retry({
          runId: run.id,
          nodeKey: "require_ready~1",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "retry:node",
        });
        expect(retried.projection.instances["require_ready~1"]).toMatchObject({ status: "ready", statusReason: "retry" });
        expect(dbRow(workspace, "SELECT status, error_json FROM node_instances WHERE run_id = ? AND node_key = ?", run.id, "require_ready~1")).toMatchObject({
          status: "ready",
          error_json: null,
        });
        expect(retried.projection.groupMembers["require_ready~1"]).toMatchObject({ status: "ready" });
        expect(store.scheduler.retry({
          runId: run.id,
          nodeKey: "require_ready~1",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "retry:node",
        }).version).toBe(retried.version);
        expect(() => store.scheduler.retry({
          runId: run.id,
          nodeKey: "require_ready~1",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "retry:node-again",
        })).toThrow("cannot be retried from ready");
        expect(() => store.scheduler.retry({
          runId: run.id,
          nodeKey: "other~1",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "retry:node",
        })).toThrow("Group member 'other~1' cannot be retried from ready");
      } finally {
        store.close();
      }
    });
  });

  it("commits attempt results idempotently through reducer projection rows", async () => {
    await withRuntimeWorkspace("scheduler-store-attempt-results", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        readyNode(store, run.id, claim, "attempt-cancel-ready-node");
        const attempt = store.scheduler.startAttempt({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "attempt:cancel:start",
        });

        const snapshot = store.scheduler.commitAttemptResult({
          runId: run.id,
          attemptId: attempt.attemptId,
          ownerEpoch: claim.ownerEpoch,
          result: { status: "cancelled", reason: "race_lost" },
          idempotencyKey: "attempt:cancel:commit",
        });
        expect(snapshot.projection.attempts[attempt.attemptId]).toMatchObject({ status: "cancelled", cancelReason: "race_lost" });
        expect(dbScalar(workspace, "SELECT cancel_reason FROM node_attempts WHERE attempt_id = ?", attempt.attemptId)).toBe("race_lost");

        const replay = store.scheduler.commitAttemptResult({
          runId: run.id,
          attemptId: attempt.attemptId,
          ownerEpoch: claim.ownerEpoch,
          result: { status: "cancelled", reason: "race_lost" },
          idempotencyKey: "attempt:cancel:commit",
        });
        expect(replay.version).toBe(snapshot.version);
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE idempotency_key = ?", "attempt:cancel:commit")).toBe(1);
        const firstTimestamps = dbRow(workspace, "SELECT started_at, finished_at FROM node_attempts WHERE attempt_id = ?", attempt.attemptId);
        const advanced = store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: snapshot.version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "scheduler:after-attempt",
          events: [{ type: "control.paused", payload: { reason: "test" } }],
        });
        expect(advanced.version).toBe(snapshot.version + 1);
        expect(dbRow(workspace, "SELECT started_at, finished_at FROM node_attempts WHERE attempt_id = ?", attempt.attemptId)).toEqual(firstTimestamps);
        expect(() => store.scheduler.commitAttemptResult({
          runId: run.id,
          attemptId: attempt.attemptId,
          ownerEpoch: claim.ownerEpoch,
          result: { status: "cancelled", reason: "paused" },
          idempotencyKey: "attempt:cancel:commit",
        })).toThrow("conflicts");
      } finally {
        store.close();
      }
    });
  });

  it("rejects stale result commits for already cancelled attempts without appending events", async () => {
    await withRuntimeWorkspace("scheduler-store-stale-cancelled-commit", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        readyNode(store, run.id, claim, "attempt-cancelled-ready-node");
        const attempt = store.scheduler.startAttempt({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "attempt:stale:start",
        });
        const snapshot = store.scheduler.loadRunSnapshot(run.id);
        store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: snapshot.version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "attempt:stale:derived-cancel",
          events: [
            { type: "attempt.cancelled", payload: { attemptId: attempt.attemptId, cancelReason: "race_lost" } },
            { type: "instance.cancelled", payload: { nodeKey: "require_ready~1", cancelReason: "race_lost" } },
          ],
        });
        const eventCount = dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ?", run.id);

        expect(() => store.scheduler.commitAttemptResult({
          runId: run.id,
          attemptId: attempt.attemptId,
          ownerEpoch: claim.ownerEpoch,
          result: { status: "completed", output: { late: true } },
          idempotencyKey: "attempt:stale:late",
        })).toThrow("already cancelled");
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ?", run.id)).toBe(eventCount);
      } finally {
        store.close();
      }
    });
  });

  it("consumes signal waits idempotently through scheduler events", async () => {
    await withRuntimeWorkspace("scheduler-store-signal-consume", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        awaitingSignal(store, run.id, claim, "signal-awaiting");

        const consumed = store.scheduler.consumeSignal({
          runId: run.id,
          nodeKey: "approve~1",
          ownerEpoch: claim.ownerEpoch,
          payload: { ok: true },
          commandIdempotencyKey: "signal-command",
          idempotencyKey: "signal:consume",
        });

        expect(consumed.projection.signalWaits["approve~1"]).toMatchObject({
          status: "consumed",
          payload: { ok: true },
          commandIdempotencyKey: "signal-command",
        });
        expect(consumed.projection.instances["approve~1"]).toMatchObject({
          status: "completed",
          output: { ok: true },
        });
        const signalRow = dbRow(workspace, "SELECT status, payload_json, command_idempotency_key FROM signal_waits WHERE run_id = ? AND node_key = ?", run.id, "approve~1");
        expect(signalRow).toMatchObject({
          status: "consumed",
          command_idempotency_key: "signal-command",
        });
        expect(JSON.parse(String(signalRow?.payload_json))).toEqual({ ok: true });

        const replay = store.scheduler.consumeSignal({
          runId: run.id,
          nodeKey: "approve~1",
          ownerEpoch: claim.ownerEpoch,
          payload: { ok: true },
          commandIdempotencyKey: "signal-command",
          idempotencyKey: "signal:consume",
        });
        expect(replay.version).toBe(consumed.version);

        expect(() => store.scheduler.consumeSignal({
          runId: run.id,
          nodeKey: "approve~1",
          ownerEpoch: claim.ownerEpoch,
          payload: { ok: false },
          commandIdempotencyKey: "signal-command",
          idempotencyKey: "signal:consume",
        })).toThrow("conflicts");
        expect(() => store.scheduler.consumeSignal({
          runId: run.id,
          nodeKey: "approve~1",
          ownerEpoch: claim.ownerEpoch,
          payload: { ok: false },
          commandIdempotencyKey: "other-command",
          idempotencyKey: "signal:consume:other",
        })).toThrow("already consumed a different payload");
        store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: replay.version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "signal:pause-after-consume",
          events: [{ type: "control.paused", payload: { reason: "user" } }],
        });
        expect(store.scheduler.consumeSignal({
          runId: run.id,
          nodeKey: "approve~1",
          ownerEpoch: claim.ownerEpoch,
          payload: { ok: true },
          commandIdempotencyKey: "signal-command",
          idempotencyKey: "signal:consume:paused-replay",
        }).projection.run.status).toBe("paused");
      } finally {
        store.close();
      }
    });
  });

  it("replays signal consumption for running group members", async () => {
    await withRuntimeWorkspace("scheduler-store-signal-group-member-consume", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        awaitingGroupSignal(store, run.id, claim, "signal-group-awaiting");

        const consumed = store.scheduler.consumeSignal({
          runId: run.id,
          nodeKey: "approve~1",
          ownerEpoch: claim.ownerEpoch,
          payload: { ok: true },
          commandIdempotencyKey: "signal-command",
          idempotencyKey: "signal:group:consume",
        });

        expect(consumed.projection.groupMembers["approve~1"]).toMatchObject({
          status: "completed",
          completionSequence: consumed.version,
          output: { ok: true },
        });
        expect(store.scheduler.consumeSignal({
          runId: run.id,
          nodeKey: "approve~1",
          ownerEpoch: claim.ownerEpoch,
          payload: { ok: true },
          commandIdempotencyKey: "signal-command",
          idempotencyKey: "signal:group:consume",
        }).version).toBe(consumed.version);
        expect(store.scheduler.consumeSignal({
          runId: run.id,
          nodeKey: "approve~1",
          ownerEpoch: claim.ownerEpoch,
          payload: { ok: true },
          commandIdempotencyKey: "signal-command",
          idempotencyKey: "signal:group:consume:duplicate-command",
        }).version).toBe(consumed.version);
      } finally {
        store.close();
      }
    });
  });

  it("rejects signal consumption after timeout without appending events", async () => {
    await withRuntimeWorkspace("scheduler-store-signal-timeout-race", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        awaitingSignal(store, run.id, claim, "signal-timeout-awaiting");
        const snapshot = store.scheduler.loadRunSnapshot(run.id);
        store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: snapshot.version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "signal:timeout",
          events: [
            { type: "signal.timed_out", payload: { nodeKey: "approve~1", terminalReason: "signal_timeout" } },
            { type: "instance.failed", payload: { nodeKey: "approve~1", error: { reason: "signal_timeout" }, statusReason: "signal_timeout" } },
          ],
        });
        const eventCount = dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ?", run.id);

        expect(() => store.scheduler.consumeSignal({
          runId: run.id,
          nodeKey: "approve~1",
          ownerEpoch: claim.ownerEpoch,
          payload: { ok: true },
          commandIdempotencyKey: "late-signal-command",
          idempotencyKey: "signal:consume:late",
        })).toThrow("already timed_out");
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ?", run.id)).toBe(eventCount);
      } finally {
        store.close();
      }
    });
  });

  it("rejects signal consumption while paused", async () => {
    await withRuntimeWorkspace("scheduler-store-signal-paused", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        awaitingSignal(store, run.id, claim, "signal-paused-awaiting");
        const snapshot = store.scheduler.loadRunSnapshot(run.id);
        store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: snapshot.version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "signal-paused:pause",
          events: [{ type: "control.paused", payload: { reason: "user" } }],
        });
        const eventCount = dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ?", run.id);

        expect(() => store.scheduler.consumeSignal({
          runId: run.id,
          nodeKey: "approve~1",
          ownerEpoch: claim.ownerEpoch,
          payload: { ok: true },
          commandIdempotencyKey: "paused-signal-command",
          idempotencyKey: "signal-paused:consume",
        })).toThrow("is paused");
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ?", run.id)).toBe(eventCount);
      } finally {
        store.close();
      }
    });
  });
});

function readyNode(store: RuntimeStore, runId: string, claim: RunOwnerClaim, idempotencyKey: string): void {
  const snapshot = store.scheduler.loadRunSnapshot(runId);
  store.scheduler.appendSchedulerEvents({
    runId,
    expectedVersion: snapshot.version,
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey,
    events: [
      { type: "instance.ready", payload: { runId, nodeKey: "require_ready~1", nodeId: "require_ready", instancePath: [{ kind: "node", nodeId: "require_ready" }], readinessSequence: 1 } },
    ],
  });
}

function readyGroupNode(store: RuntimeStore, runId: string, claim: RunOwnerClaim, idempotencyKey: string): void {
  const snapshot = store.scheduler.loadRunSnapshot(runId);
  store.scheduler.appendSchedulerEvents({
    runId,
    expectedVersion: snapshot.version,
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey,
    events: [
      { type: "group.started", payload: { runId, groupKey: "parallel~1", nodeKey: "parallel~1", nodeId: "parallel", kind: "parallel", strategy: "all" } },
      { type: "group.member_ready", payload: { runId, groupKey: "parallel~1", memberKey: "require_ready~1", memberKind: "branch", branchId: "left", readinessSequence: 1 } },
      { type: "instance.ready", payload: { runId, nodeKey: "require_ready~1", nodeId: "require_ready", instancePath: [{ kind: "branch", nodeId: "parallel", branchId: "left" }, { kind: "node", nodeId: "require_ready" }], readinessSequence: 1 } },
    ],
  });
}

function awaitingSignal(store: RuntimeStore, runId: string, claim: RunOwnerClaim, idempotencyKey: string): void {
  const snapshot = store.scheduler.loadRunSnapshot(runId);
  store.scheduler.appendSchedulerEvents({
    runId,
    expectedVersion: snapshot.version,
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey,
    events: [
      { type: "instance.ready", payload: { runId, nodeKey: "approve~1", nodeId: "approve", instancePath: [{ kind: "node", nodeId: "approve" }], readinessSequence: 1 } },
      { type: "instance.awaiting", payload: { nodeKey: "approve~1", statusReason: "signal" } },
      { type: "signal.awaiting", payload: { runId, nodeKey: "approve~1", nodeId: "approve" } },
    ],
  });
}

function awaitingGroupSignal(store: RuntimeStore, runId: string, claim: RunOwnerClaim, idempotencyKey: string): void {
  const snapshot = store.scheduler.loadRunSnapshot(runId);
  store.scheduler.appendSchedulerEvents({
    runId,
    expectedVersion: snapshot.version,
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey,
    events: [
      { type: "group.started", payload: { runId, groupKey: "parallel~1", nodeKey: "parallel~1", nodeId: "parallel", kind: "parallel", strategy: "all" } },
      { type: "group.member_ready", payload: { runId, groupKey: "parallel~1", memberKey: "approve~1", memberKind: "branch", branchId: "approve", readinessSequence: 1 } },
      { type: "group.member_started", payload: { memberKey: "approve~1" } },
      { type: "instance.ready", payload: { runId, nodeKey: "approve~1", nodeId: "approve", instancePath: [{ kind: "branch", nodeId: "parallel", branchId: "approve" }, { kind: "node", nodeId: "approve" }], readinessSequence: 1 } },
      { type: "instance.awaiting", payload: { nodeKey: "approve~1", statusReason: "signal" } },
      { type: "signal.awaiting", payload: { runId, nodeKey: "approve~1", nodeId: "approve" } },
    ],
  });
}

function dbScalar(workspace: string, sql: string, ...params: SQLInputValue[]): unknown {
  const row = dbRow(workspace, sql, ...params);
  return row ? Object.values(row)[0] : undefined;
}

function dbRow(workspace: string, sql: string, ...params: SQLInputValue[]): Record<string, unknown> | undefined {
  const db = new DatabaseSync(join(workspace, ".acpus", "state", "runtime.db"), { readOnly: true });
  try {
    return db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  } finally {
    db.close();
  }
}

function dbRows(workspace: string, sql: string, ...params: SQLInputValue[]): Array<Record<string, unknown>> {
  const db = new DatabaseSync(join(workspace, ".acpus", "state", "runtime.db"), { readOnly: true });
  try {
    return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function writeLegacyEvent(workspace: string, runId: string, type: string, nodeKey: string, payload: object): void {
  const db = new DatabaseSync(join(workspace, ".acpus", "state", "runtime.db"));
  try {
    const sequence = db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS count FROM run_events WHERE run_id = ?").get(runId) as { count: number };
    db.prepare(`
      INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(runId, sequence.count, type, nodeKey, JSON.stringify(payload), new Date().toISOString(), `legacy:${runId}:${type}`);
  } finally {
    db.close();
  }
}
