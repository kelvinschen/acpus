import * as Result from "effect/Result";
import { admitRunForTest } from "./support/runtime-store.js";
import { createHash } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { openRuntimeStoreAdapter } from "../src/store/store.js";
import { prepareSyntheticWorkflow, runtimeDatabasePath, validWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";
import { captureSchedulerCall, throwingSchedulerStore } from "./support/scheduler-store.js";
import { dbRow, dbRun, dbScalar } from "./support/store-port-fixtures.js";

describe("scheduler store controls, idempotency, and public projection", () => {
  it("does not treat append idempotency keys as string prefixes", async () => {
    await withRuntimeWorkspace("scheduler-store-idempotency-prefix", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;

        const first = throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: 1,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "scheduler:event:child",
          events: [{ type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } }],
        });
        const second = throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: first.version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "scheduler:event",
          events: [{ type: "control.paused", payload: {} }],
        });

        expect(second.version).toBe(first.version + 1);
        expect(second.projection.run.status).toBe("paused");
      } finally {
        store.close();
      }
    });
  });

  it("replays only the same scheduler control for an intent idempotency key", async () => {
    await withRuntimeWorkspace("scheduler-store-control-idempotency-conflict", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const paused = throwingSchedulerStore(store.scheduler).pauseRun({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "control:same-key",
        });

        expect(throwingSchedulerStore(store.scheduler).pauseRun({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "control:same-key",
        }).version).toBe(paused.version);
        expect(Result.getOrThrow(Result.flip(captureSchedulerCall(() => store.scheduler.tryResumeRun({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "control:same-key",
        }))))).toMatchObject({
          type: "idempotency-conflict",
          idempotencyKey: "control:same-key",
          runId: run.id,
        });
        expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection.run.status).toBe("paused");
      } finally {
        store.close();
      }
    });
  });

  it("scopes scheduler control intent keys to each run", async () => {
    await withRuntimeWorkspace("scheduler-store-control-idempotency-run-scope", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      try {
        const firstRun = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const secondRun = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const firstClaim = store.scheduler.claimRun(firstRun.id, "owner-a", 60_000)!;
        const secondClaim = store.scheduler.claimRun(secondRun.id, "owner-b", 60_000)!;
        const idempotencyKey = "control:shared-across-runs";

        const firstPaused = throwingSchedulerStore(store.scheduler).pauseRun({
          runId: firstRun.id,
          ownerEpoch: firstClaim.ownerEpoch,
          idempotencyKey,
        });
        const secondPaused = throwingSchedulerStore(store.scheduler).pauseRun({
          runId: secondRun.id,
          ownerEpoch: secondClaim.ownerEpoch,
          idempotencyKey,
        });

        expect(firstPaused.projection.run.status).toBe("paused");
        expect(secondPaused.projection.run.status).toBe("paused");
        expect(throwingSchedulerStore(store.scheduler).pauseRun({
          runId: firstRun.id,
          ownerEpoch: firstClaim.ownerEpoch,
          idempotencyKey,
        }).version).toBe(firstPaused.version);
        expect(throwingSchedulerStore(store.scheduler).pauseRun({
          runId: secondRun.id,
          ownerEpoch: secondClaim.ownerEpoch,
          idempotencyKey,
        }).version).toBe(secondPaused.version);
        expect(dbRows(workspace, `
          SELECT run_id, event_count, intent_digest IS NOT NULL AS has_intent
          FROM scheduler_commits
          WHERE idempotency_key = ?
          ORDER BY run_id
        `, idempotencyKey)).toEqual([
          { run_id: firstRun.id, event_count: 1, has_intent: 1 },
          { run_id: secondRun.id, event_count: 1, has_intent: 1 },
        ].sort((left, right) => left.run_id.localeCompare(right.run_id)));
      } finally {
        store.close();
      }
    });
  });

  it("durably records successful no-op control intents", async () => {
    await withRuntimeWorkspace("scheduler-store-no-op-control-idempotency", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      try {
        const resumeRun = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const pauseRun = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const cancelRun = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const resumeClaim = store.scheduler.claimRun(resumeRun.id, "resume-owner", 60_000)!;
        const pauseClaim = store.scheduler.claimRun(pauseRun.id, "pause-owner", 60_000)!;
        const cancelClaim = store.scheduler.claimRun(cancelRun.id, "cancel-owner", 60_000)!;

        const resumeEventCount = dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ?", resumeRun.id);
        const resumed = throwingSchedulerStore(store.scheduler).resumeRun({
          runId: resumeRun.id,
          ownerEpoch: resumeClaim.ownerEpoch,
          idempotencyKey: "control:no-op:resume",
        });
        expect(resumed).toMatchObject({ version: 1, projection: { run: { status: "pending" } } });
        expect(throwingSchedulerStore(store.scheduler).resumeRun({
          runId: resumeRun.id,
          ownerEpoch: resumeClaim.ownerEpoch,
          idempotencyKey: "control:no-op:resume",
        }).version).toBe(resumed.version);
        expect(Result.getOrThrow(Result.flip(captureSchedulerCall(() => store.scheduler.tryPauseRun({
          runId: resumeRun.id,
          ownerEpoch: resumeClaim.ownerEpoch,
          idempotencyKey: "control:no-op:resume",
        }))))).toMatchObject({ type: "idempotency-conflict", runId: resumeRun.id });
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ?", resumeRun.id)).toBe(resumeEventCount);

        const paused = throwingSchedulerStore(store.scheduler).pauseRun({
          runId: pauseRun.id,
          ownerEpoch: pauseClaim.ownerEpoch,
          idempotencyKey: "control:pause:initial",
        });
        const pauseEventCount = dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ?", pauseRun.id);
        const pausedAgain = throwingSchedulerStore(store.scheduler).pauseRun({
          runId: pauseRun.id,
          ownerEpoch: pauseClaim.ownerEpoch,
          idempotencyKey: "control:no-op:pause",
        });
        expect(pausedAgain.version).toBe(paused.version);
        expect(pausedAgain.projection.run.status).toBe("paused");
        expect(throwingSchedulerStore(store.scheduler).pauseRun({
          runId: pauseRun.id,
          ownerEpoch: pauseClaim.ownerEpoch,
          idempotencyKey: "control:no-op:pause",
        }).version).toBe(pausedAgain.version);
        expect(Result.getOrThrow(Result.flip(captureSchedulerCall(() => store.scheduler.tryResumeRun({
          runId: pauseRun.id,
          ownerEpoch: pauseClaim.ownerEpoch,
          idempotencyKey: "control:no-op:pause",
        }))))).toMatchObject({ type: "idempotency-conflict", runId: pauseRun.id });
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ?", pauseRun.id)).toBe(pauseEventCount);

        const canceled = throwingSchedulerStore(store.scheduler).cancel({
          runId: cancelRun.id,
          ownerEpoch: cancelClaim.ownerEpoch,
          idempotencyKey: "control:cancel:initial",
        });
        const cancelEventCount = dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ?", cancelRun.id);
        const canceledAgain = throwingSchedulerStore(store.scheduler).cancel({
          runId: cancelRun.id,
          ownerEpoch: cancelClaim.ownerEpoch,
          idempotencyKey: "control:no-op:cancel",
        });
        expect(canceledAgain.version).toBe(canceled.version);
        expect(canceledAgain.projection.run.status).toBe("canceled");
        expect(throwingSchedulerStore(store.scheduler).cancel({
          runId: cancelRun.id,
          ownerEpoch: cancelClaim.ownerEpoch,
          idempotencyKey: "control:no-op:cancel",
        }).version).toBe(canceledAgain.version);
        expect(Result.getOrThrow(Result.flip(captureSchedulerCall(() => store.scheduler.tryCancel({
          runId: cancelRun.id,
          ownerEpoch: cancelClaim.ownerEpoch,
          target: "root",
          idempotencyKey: "control:no-op:cancel",
        }))))).toMatchObject({ type: "idempotency-conflict", runId: cancelRun.id });
        expect(Result.getOrThrow(Result.flip(captureSchedulerCall(() => store.scheduler.tryCancel({
          runId: cancelRun.id,
          ownerEpoch: cancelClaim.ownerEpoch,
          target: "missing",
          idempotencyKey: "control:no-op:cancel",
        }))))).toMatchObject({ type: "idempotency-conflict", runId: cancelRun.id });
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ?", cancelRun.id)).toBe(cancelEventCount);

        const emptyEventDigest = createHash("sha256").update("[]\n").digest("hex");
        expect(dbRows(workspace, `
          SELECT run_id, idempotency_key, event_count, event_digest, intent_digest
          FROM scheduler_commits
          WHERE idempotency_key LIKE 'control:no-op:%'
          ORDER BY idempotency_key
        `)).toEqual([
          { run_id: cancelRun.id, idempotency_key: "control:no-op:cancel", event_count: 0, event_digest: emptyEventDigest, intent_digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
          { run_id: pauseRun.id, idempotency_key: "control:no-op:pause", event_count: 0, event_digest: emptyEventDigest, intent_digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
          { run_id: resumeRun.id, idempotency_key: "control:no-op:resume", event_count: 0, event_digest: emptyEventDigest, intent_digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
        ]);
      } finally {
        store.close();
      }
    });
  });

  it("rolls back a no-op control intent when its owner epoch is inactive", async () => {
    await withRuntimeWorkspace("scheduler-store-no-op-control-owner-fence", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const version = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).version;
        const eventCount = dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ?", run.id);
        expect(store.scheduler.releaseRun(claim)).toBe(true);

        expect(Result.getOrThrow(Result.flip(captureSchedulerCall(() => store.scheduler.tryResumeRun({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "control:no-op:inactive-owner",
        }))))).toMatchObject({
          type: "owner-epoch-inactive",
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
        });
        expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).version).toBe(version);
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ?", run.id)).toBe(eventCount);
        expect(dbRow(workspace, "SELECT event_count FROM scheduler_commits WHERE run_id = ? AND idempotency_key = ?", run.id, "control:no-op:inactive-owner")).toBeUndefined();
      } finally {
        store.close();
      }
    });
  });

  it("bridges pause and resume to public run status before root materialization", async () => {
    await withRuntimeWorkspace("scheduler-store-public-empty-pause-resume", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;

        expect(throwingSchedulerStore(store.scheduler).pauseRun({ runId: run.id, ownerEpoch: claim.ownerEpoch, idempotencyKey: "public:pause" }).projection.run.status).toBe("paused");
        expect(store.getRun(run.id)).toMatchObject({ status: "paused" });

        expect(throwingSchedulerStore(store.scheduler).resumeRun({ runId: run.id, ownerEpoch: claim.ownerEpoch, idempotencyKey: "public:resume" }).projection.run.status).toBe("pending");
        expect(store.getRun(run.id)).toMatchObject({ status: "pending" });
      } finally {
        store.close();
      }
    });
  });

  it("bridges scheduler terminal events to public events once with mixed event sequencing", async () => {
    await withRuntimeWorkspace("scheduler-store-public-terminal-sequence", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;

        const completed = throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
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

        expect(throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
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

  it("replaces static public node placeholders with dynamic scheduler rows", async () => {
    await withRuntimeWorkspace("scheduler-store-public-dynamic-node-bridge", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM node_states WHERE run_id = ? AND node_key = 'require_ready'", run.id)).toBe(1);

        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "public:dynamic-node-bridge",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root", scope: { require_ready: "require_ready~1" } } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "require_ready~1", nodeId: "require_ready", instancePath: [{ kind: "node", nodeId: "require_ready" }], parentFrameKey: "root", readinessSequence: 1 } },
          ],
        });

        expect(dbRows(workspace, "SELECT node_key, node_id, status FROM node_states WHERE run_id = ? AND node_id = 'require_ready' ORDER BY node_key", run.id)).toEqual([
          { node_key: "require_ready~1", node_id: "require_ready", status: "ready" },
        ]);
      } finally {
        store.close();
      }
    });
  });

  it("bridges scheduler node retry out of a failed public run", async () => {
    await withRuntimeWorkspace("scheduler-store-node-retry-failed-run", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;

        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
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
        setSchedulerEventTypesCreatedAt(workspace, run.id, ["frame.started", "instance.ready", "instance.failed", "frame.failed"], "2026-01-01T00:00:00.000Z");

        const retried = throwingSchedulerStore(store.scheduler).retry({
          runId: run.id,
          target: "require_ready~1",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "public:node-retry",
        });

        expect(retried.projection.run).toMatchObject({ status: "pending", paused: false });
        expect(retried.projection.frames.root).toMatchObject({ status: "running" });
        expect(retried.projection.instances["require_ready~1"]).toMatchObject({ status: "ready", statusReason: "retry" });
        expect(store.getRun(run.id)).toMatchObject({ status: "running" });
        const retryCreatedAt = dbScalar(workspace, "SELECT created_at FROM run_events WHERE run_id = ? AND type = 'instance.retry_requested'", run.id);
        expect(dbRow(workspace, "SELECT created_at FROM node_instances WHERE run_id = ? AND node_key = 'require_ready~1'", run.id)).toEqual({ created_at: retryCreatedAt });

        const completed = throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: retried.version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "public:complete-node-retry",
          events: [
            { type: "instance.started", payload: { nodeKey: "require_ready~1" } },
            { type: "instance.completed", payload: { nodeKey: "require_ready~1", output: { ready: true } } },
            { type: "frame.completed", payload: { frameKey: "root", result: { ready: true }, terminalReason: "root_completed" } },
          ],
        });

        expect(completed.projection.instances["require_ready~1"]).toMatchObject({ status: "completed", output: { ready: true } });
        expect(completed.projection.instances["require_ready~1"]?.statusReason).toBeUndefined();
        expect(store.getRun(run.id)?.dynamic?.nodeInstances.find(node => node.nodeKey === "require_ready~1")?.statusReason).toBeUndefined();

        dbRun(workspace, "UPDATE node_instances SET status_reason = 'retry' WHERE run_id = ? AND node_key = ?", run.id, "require_ready~1");
        expect(store.getRun(run.id)?.dynamic?.nodeInstances.find(node => node.nodeKey === "require_ready~1")?.statusReason).toBeUndefined();
      } finally {
        store.close();
      }
    });
  });

  it.each([
    {
      label: "instance target",
      target: "target",
      targetEventType: "instance.retry_requested",
      retriedMemberKeys: ["inner.left", "outer.left"],
      dependencyMemberKeys: ["inner.second", "inner.third", "outer.right"],
    },
    {
      label: "frame target",
      target: "inner",
      targetEventType: "frame.retry_requested",
      retriedMemberKeys: ["outer.left"],
      dependencyMemberKeys: ["outer.right"],
    },
  ])("requeues parent-failed siblings deterministically for a $label", async ({ target, targetEventType, retriedMemberKeys, dependencyMemberKeys }) => {
    await withRuntimeWorkspace(`scheduler-store-${target}-retry-completion-closure`, async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const failed = throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: 1,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "retry-closure:failed-state",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
            { type: "frame.started", payload: { runId: run.id, frameKey: "outer", frameKind: "node", parentFrameKey: "root", nodeKey: "outer", nodeId: "outer", strategy: "all" } },
            { type: "group.started", payload: { runId: run.id, groupKey: "outer", nodeKey: "outer", nodeId: "outer", kind: "parallel", strategy: "all" } },
            { type: "frame.started", payload: { runId: run.id, frameKey: "outer.left", frameKind: "branch", parentFrameKey: "outer" } },
            { type: "group.member_ready", payload: { runId: run.id, groupKey: "outer", memberKey: "outer.left", childFrameKey: "outer.left", memberKind: "branch", branchId: "left", readinessSequence: 1 } },
            { type: "frame.started", payload: { runId: run.id, frameKey: "inner", frameKind: "node", parentFrameKey: "outer.left", nodeKey: "inner", nodeId: "inner", strategy: "all" } },
            { type: "group.started", payload: { runId: run.id, groupKey: "inner", nodeKey: "inner", nodeId: "inner", kind: "parallel", strategy: "all" } },
            { type: "frame.started", payload: { runId: run.id, frameKey: "inner.left", frameKind: "branch", parentFrameKey: "inner" } },
            { type: "group.member_ready", payload: { runId: run.id, groupKey: "inner", memberKey: "inner.left", childFrameKey: "inner.left", memberKind: "branch", branchId: "left", readinessSequence: 1 } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "target", nodeId: "target", parentFrameKey: "inner.left", instancePath: [{ kind: "node", nodeId: "outer" }, { kind: "branch", nodeId: "outer", branchId: "left" }, { kind: "node", nodeId: "inner" }, { kind: "branch", nodeId: "inner", branchId: "left" }, { kind: "node", nodeId: "target" }], readinessSequence: 1 } },
            { type: "instance.failed", payload: { nodeKey: "target", error: { reason: "boom" } } },
            { type: "frame.failed", payload: { frameKey: "inner.left", error: { reason: "boom" } } },
            { type: "group.member_failed", payload: { memberKey: "inner.left", error: { reason: "boom" } } },

            { type: "frame.started", payload: { runId: run.id, frameKey: "inner.third", frameKind: "branch", parentFrameKey: "inner" } },
            { type: "group.member_ready", payload: { runId: run.id, groupKey: "inner", memberKey: "inner.third", childFrameKey: "inner.third", memberKind: "branch", branchId: "third", readinessSequence: 3 } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "inner.third.task", nodeId: "task", parentFrameKey: "inner.third", instancePath: [{ kind: "node", nodeId: "inner" }, { kind: "branch", nodeId: "inner", branchId: "third" }, { kind: "node", nodeId: "task" }] } },
            { type: "group.member_cancelled", payload: { memberKey: "inner.third", cancelReason: "parent_failed" } },
            { type: "instance.cancelled", payload: { nodeKey: "inner.third.task", cancelReason: "parent_failed" } },
            { type: "frame.cancelled", payload: { frameKey: "inner.third", cancelReason: "parent_failed" } },
            { type: "frame.started", payload: { runId: run.id, frameKey: "inner.second", frameKind: "branch", parentFrameKey: "inner" } },
            { type: "group.member_ready", payload: { runId: run.id, groupKey: "inner", memberKey: "inner.second", childFrameKey: "inner.second", memberKind: "branch", branchId: "second", readinessSequence: 2 } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "inner.second.task", nodeId: "task", parentFrameKey: "inner.second", instancePath: [{ kind: "node", nodeId: "inner" }, { kind: "branch", nodeId: "inner", branchId: "second" }, { kind: "node", nodeId: "task" }] } },
            { type: "group.member_cancelled", payload: { memberKey: "inner.second", cancelReason: "parent_failed" } },
            { type: "instance.cancelled", payload: { nodeKey: "inner.second.task", cancelReason: "parent_failed" } },
            { type: "frame.cancelled", payload: { frameKey: "inner.second", cancelReason: "parent_failed" } },
            { type: "group.failed", payload: { groupKey: "inner", error: { reason: "boom" } } },
            { type: "frame.failed", payload: { frameKey: "inner", error: { reason: "boom" } } },
            { type: "frame.failed", payload: { frameKey: "outer.left", error: { reason: "boom" } } },
            { type: "group.member_failed", payload: { memberKey: "outer.left", error: { reason: "boom" } } },

            { type: "frame.started", payload: { runId: run.id, frameKey: "outer.right", frameKind: "branch", parentFrameKey: "outer" } },
            { type: "group.member_ready", payload: { runId: run.id, groupKey: "outer", memberKey: "outer.right", childFrameKey: "outer.right", memberKind: "branch", branchId: "right", readinessSequence: 2 } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "outer.right.task", nodeId: "task", parentFrameKey: "outer.right", instancePath: [{ kind: "node", nodeId: "outer" }, { kind: "branch", nodeId: "outer", branchId: "right" }, { kind: "node", nodeId: "task" }] } },
            { type: "group.member_cancelled", payload: { memberKey: "outer.right", cancelReason: "parent_failed" } },
            { type: "instance.cancelled", payload: { nodeKey: "outer.right.task", cancelReason: "parent_failed" } },
            { type: "frame.cancelled", payload: { frameKey: "outer.right", cancelReason: "parent_failed" } },
            { type: "group.failed", payload: { groupKey: "outer", error: { reason: "boom" } } },
            { type: "frame.failed", payload: { frameKey: "outer", error: { reason: "boom" } } },
            { type: "frame.failed", payload: { frameKey: "root", error: { reason: "boom" } } },
          ],
        });

        const retried = throwingSchedulerStore(store.scheduler).retry({
          runId: run.id,
          target,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: `retry-closure:${target}`,
        });

        expect(dbRows(workspace, `
          SELECT type,
                 json_extract(payload_json, '$.payload.memberKey') AS member_key
          FROM run_events
          WHERE run_id = ?
            AND sequence > ?
            AND type = 'group.member_retry_requested'
          ORDER BY sequence
        `, run.id, failed.version)).toEqual(retriedMemberKeys.map(member_key => ({
          type: "group.member_retry_requested",
          member_key,
        })));
        expect(dbRow(workspace, `
          SELECT json_extract(payload_json, '$.payload.retryDependencyMemberKeys') AS dependency_member_keys
          FROM run_events
          WHERE run_id = ?
            AND sequence > ?
            AND type = ?
        `, run.id, failed.version, targetEventType)).toEqual({
          dependency_member_keys: JSON.stringify(dependencyMemberKeys),
        });
        expect(dbScalar(workspace, `
          SELECT COUNT(*)
          FROM run_events
          WHERE run_id = ?
            AND sequence > ?
            AND type = 'group.member_requeued'
        `, run.id, failed.version)).toBe(0);
        expect(retried.projection.groupMembers["outer.right"]).toMatchObject({ status: "ready", readinessSequence: 2 });
        expect(retried.projection.instances["outer.right.task"]).toMatchObject({ status: "ready" });
        if (target === "target") {
          expect(retried.projection.instances.target).toMatchObject({ status: "ready", statusReason: "retry" });
          expect(retried.projection.groupMembers["inner.second"]).toMatchObject({ status: "ready", readinessSequence: 2 });
          expect(retried.projection.groupMembers["inner.third"]).toMatchObject({ status: "ready", readinessSequence: 3 });
          expect(retried.projection.instances["inner.second.task"]).toMatchObject({ status: "ready" });
          expect(retried.projection.instances["inner.third.task"]).toMatchObject({ status: "ready" });
        } else {
          expect(retried.projection.frames.inner).toBeUndefined();
          expect(retried.projection.groups.inner).toBeUndefined();
          expect(retried.projection.instances.target).toBeUndefined();
        }
        expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection.groupMembers["outer.right"])
          .toMatchObject({ status: "ready", readinessSequence: 2 });
      } finally {
        store.close();
      }
    });
  });
});

function dbRows(workspace: string, sql: string, ...params: SQLInputValue[]): Array<Record<string, unknown>> {
  const db = new DatabaseSync(runtimeDatabasePath(workspace), { readOnly: true });
  try {
    return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function setSchedulerEventTypesCreatedAt(workspace: string, runId: string, types: string[], createdAt: string): void {
  const db = new DatabaseSync(runtimeDatabasePath(workspace));
  try {
    const placeholders = types.map(() => "?").join(", ");
    db.prepare(`UPDATE run_events SET created_at = ? WHERE run_id = ? AND type IN (${placeholders})`).run(createdAt, runId, ...types);
  } finally {
    db.close();
  }
}
