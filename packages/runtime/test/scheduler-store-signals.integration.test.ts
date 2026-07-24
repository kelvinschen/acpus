import { admitRunForTest } from "./support/runtime-store.js";
import { describe, expect, it } from "vitest";
import { openRuntimeStore, type RuntimeStore } from "../src/store/store.js";
import { deriveInstanceKey } from "../src/scheduler/identity.js";
import type { RunOwnerClaim } from "../src/scheduler/store-port.js";
import { stableJson } from "../src/stable-json.js";
import { prepareSyntheticWorkflow, timedSignalWorkflow, validWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";
import { throwingSchedulerStore } from "./support/scheduler-store.js";
import { awaitingSignal, dbRow, dbScalar } from "./support/store-port-fixtures.js";

describe("scheduler store signals and timeout settlement", () => {
  it("consumes signal waits idempotently through scheduler events", async () => {
    await withRuntimeWorkspace("scheduler-store-signal-consume", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        awaitingSignal(store, run.id, claim, "signal-awaiting");

        const consumed = throwingSchedulerStore(store.scheduler).consumeSignal({
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
        const signalRow = dbRow(workspace, "SELECT status, payload_json FROM signal_waits WHERE run_id = ? AND node_key = ?", run.id, "approve~1");
        const payloadJson = `${stableJson({ ok: true })}\n`;
        expect(signalRow).toEqual({
          status: "consumed",
          payload_json: payloadJson,
        });
        expect(JSON.parse(String(signalRow?.payload_json))).toEqual({ ok: true });

        const duplicate = throwingSchedulerStore(store.scheduler).consumeSignal({
          runId: run.id,
          nodeKey: "approve~1",
          ownerEpoch: claim.ownerEpoch,
          payload: { ok: true },
          commandIdempotencyKey: "signal-command",
          idempotencyKey: "signal:consume",
        });
        expect(duplicate.version).toBe(consumed.version);
        const replayWithFreshRequest = throwingSchedulerStore(store.scheduler).consumeSignal({
          runId: run.id,
          nodeKey: "approve~1",
          ownerEpoch: claim.ownerEpoch,
          payload: { ok: true },
          commandIdempotencyKey: "signal-command",
          idempotencyKey: "signal:consume:replay",
        });
        expect(replayWithFreshRequest.version).toBe(consumed.version);
        expect(dbRow(workspace, "SELECT event_count, intent_digest IS NOT NULL AS has_intent FROM scheduler_commits WHERE run_id = ? AND idempotency_key = ?", run.id, "signal:consume:replay"))
          .toEqual({ event_count: 0, has_intent: 1 });

        expect(() => throwingSchedulerStore(store.scheduler).consumeSignal({
          runId: run.id,
          nodeKey: "approve~1",
          ownerEpoch: claim.ownerEpoch,
          payload: { ok: true },
          commandIdempotencyKey: "other-command",
          idempotencyKey: "signal:consume:other",
        })).toThrow("already consumed by a different command");

        expect(() => throwingSchedulerStore(store.scheduler).consumeSignal({
          runId: run.id,
          nodeKey: "approve~1",
          ownerEpoch: claim.ownerEpoch,
          payload: { ok: false },
          commandIdempotencyKey: "signal-command",
          idempotencyKey: "signal:consume",
        })).toThrow("conflicts with a different control");
        expect(() => throwingSchedulerStore(store.scheduler).consumeSignal({
          runId: run.id,
          nodeKey: "approve~1",
          ownerEpoch: claim.ownerEpoch,
          payload: { ok: false },
          commandIdempotencyKey: "signal-command",
          idempotencyKey: "signal:consume:replay",
        })).toThrow("conflicts with a different control");
        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: duplicate.version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "signal:pause-after-consume",
          events: [{ type: "control.paused", payload: {} }],
        });
        expect(throwingSchedulerStore(store.scheduler).consumeSignal({
          runId: run.id,
          nodeKey: "approve~1",
          ownerEpoch: claim.ownerEpoch,
          payload: { ok: true },
          commandIdempotencyKey: "signal-command",
          idempotencyKey: "signal:consume:paused-duplicate",
        }).projection.run.status).toBe("paused");
      } finally {
        store.close();
      }
    });
  });

  it("applies duplicate signal consumption for running group members", async () => {
    await withRuntimeWorkspace("scheduler-store-signal-group-member-consume", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        awaitingGroupSignal(store, run.id, claim, "signal-group-awaiting");

        const consumed = throwingSchedulerStore(store.scheduler).consumeSignal({
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
        expect(throwingSchedulerStore(store.scheduler).consumeSignal({
          runId: run.id,
          nodeKey: "approve~1",
          ownerEpoch: claim.ownerEpoch,
          payload: { ok: true },
          commandIdempotencyKey: "signal-command",
          idempotencyKey: "signal:group:consume",
        }).version).toBe(consumed.version);
        expect(throwingSchedulerStore(store.scheduler).consumeSignal({
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
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        awaitingSignal(store, run.id, claim, "signal-timeout-awaiting");
        const snapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id);
        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
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

        expect(() => throwingSchedulerStore(store.scheduler).consumeSignal({
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

  it("drops a terminal signal wait when retrying the failed signal node", async () => {
    await withRuntimeWorkspace("scheduler-store-signal-timeout-retry", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        awaitingSignal(store, run.id, claim, "signal-retry-awaiting");
        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "signal-retry:timeout",
          events: [
            { type: "signal.timed_out", payload: { nodeKey: "approve~1", terminalReason: "signal_timeout" } },
            { type: "instance.failed", payload: { nodeKey: "approve~1", error: { reason: "signal_timeout" }, statusReason: "signal_timeout" } },
          ],
        });

        const retried = throwingSchedulerStore(store.scheduler).retry({
          runId: run.id,
          target: "approve~1",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "signal-retry:node",
        });

        expect(retried.projection.instances["approve~1"]).toMatchObject({ status: "ready", statusReason: "retry" });
        expect(retried.projection.signalWaits["approve~1"]).toBeUndefined();
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM signal_waits WHERE run_id = ? AND node_key = ?", run.id, "approve~1")).toBe(0);
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
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        awaitingSignal(store, run.id, claim, "signal-paused-awaiting");
        const snapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id);
        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: snapshot.version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "signal-paused:pause",
          events: [{ type: "control.paused", payload: {} }],
        });
        const eventCount = dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ?", run.id);

        expect(() => throwingSchedulerStore(store.scheduler).consumeSignal({
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

  it("freezes and resumes signal timeout deadlines while paused", async () => {
    await withRuntimeWorkspace("scheduler-store-signal-timeout-pause-resume", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        awaitingSignal(store, run.id, claim, "signal-timeout-pause-awaiting", {
          deadlineAt: "2026-07-01T00:00:05.000Z",
          timeoutMessage: "Approval timed out",
        });

        const paused = throwingSchedulerStore(store.scheduler).pauseRun({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "signal-timeout:pause",
          now: new Date("2026-07-01T00:00:01.000Z"),
        });
        expect(paused.projection.signalWaits["approve~1"]).toMatchObject({
          status: "awaiting",
          timeoutMessage: "Approval timed out",
          timeoutRemainingMs: 4_000,
        });
        expect(paused.projection.signalWaits["approve~1"]?.deadlineAt).toBeUndefined();

        const resumed = throwingSchedulerStore(store.scheduler).resumeRun({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "signal-timeout:resume",
          now: new Date("2026-07-01T00:00:10.000Z"),
        });
        expect(resumed.projection.signalWaits["approve~1"]).toMatchObject({
          status: "awaiting",
          deadlineAt: "2026-07-01T00:00:14.000Z",
          timeoutMessage: "Approval timed out",
        });
        expect(resumed.projection.signalWaits["approve~1"]?.timeoutRemainingMs).toBeUndefined();
      } finally {
        store.close();
      }
    });
  });

  it("rejects an out-of-range resumed signal deadline atomically", async () => {
    await withRuntimeWorkspace("scheduler-store-signal-timeout-resume-range", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        awaitingSignal(store, run.id, claim, "signal-timeout-range-awaiting", {
          deadlineAt: "9999-12-31T23:59:59.999Z",
        });

        const paused = throwingSchedulerStore(store.scheduler).pauseRun({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "signal-timeout-range:pause",
          now: new Date(0),
        });
        const remainingMs = new Date("9999-12-31T23:59:59.999Z").getTime();
        expect(paused.projection.signalWaits["approve~1"]?.timeoutRemainingMs).toBe(remainingMs);
        const eventCount = dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ?", run.id);

        expect(store.scheduler.tryResumeRun({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "signal-timeout-range:resume",
          now: new Date(1),
        })._unsafeUnwrapErr()).toEqual({
          type: "deadline-out-of-range",
          runId: run.id,
          nodeKey: "approve~1",
          message: "Signal wait 'approve~1' remaining timeout cannot be represented as a persisted deadline.",
        });

        const after = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id);
        expect(after.version).toBe(paused.version);
        expect(after.projection.run.status).toBe("paused");
        expect(after.projection.signalWaits["approve~1"]?.timeoutRemainingMs).toBe(remainingMs);
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ?", run.id)).toBe(eventCount);
      } finally {
        store.close();
      }
    });
  });

  it("times out overdue signal waits before consuming late payloads", async () => {
    await withRuntimeWorkspace("scheduler-store-signal-timeout-before-consume", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, timedSignalWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const nodeKey = awaitingRootSignal(store, run.id, claim, "signal-timeout-late-awaiting", {
          deadlineAt: "2026-07-01T00:00:00.000Z",
        });

        expect(() => throwingSchedulerStore(store.scheduler).consumeSignal({
          runId: run.id,
          nodeKey,
          ownerEpoch: claim.ownerEpoch,
          payload: { ok: true },
          commandIdempotencyKey: "late-signal-command",
          idempotencyKey: "signal-timeout:late-consume",
          now: new Date("2026-07-01T00:00:01.000Z"),
        })).toThrow("already timed_out");

        const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
        expect(projection.signalWaits[nodeKey]).toMatchObject({ status: "timed_out", terminalReason: "signal_timeout" });
        expect(projection.instances[nodeKey]).toMatchObject({ status: "failed", statusReason: "signal_timeout" });
        expect(projection.frames.root).toMatchObject({ status: "failed", terminalReason: "signal_timeout" });
        expect(store.getRun(run.id)).toMatchObject({ status: "failed" });
      } finally {
        store.close();
      }
    });
  });

  it("settles overdue signal timeouts before applying pause", async () => {
    await withRuntimeWorkspace("scheduler-store-signal-timeout-before-pause", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, timedSignalWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const nodeKey = awaitingRootSignal(store, run.id, claim, "signal-timeout-pause-awaiting", {
          deadlineAt: "2026-07-01T00:00:00.000Z",
        });

        expect(() => throwingSchedulerStore(store.scheduler).pauseRun({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "signal-timeout:late-pause",
          now: new Date("2026-07-01T00:00:01.000Z"),
        })).toThrow("Cannot pause failed run.");

        const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
        expect(projection.signalWaits[nodeKey]).toMatchObject({ status: "timed_out", terminalReason: "signal_timeout" });
        expect(projection.frames.root).toMatchObject({ status: "failed", terminalReason: "signal_timeout" });
        expect(store.getRun(run.id)).toMatchObject({ status: "failed" });
      } finally {
        store.close();
      }
    });
  });
});

function awaitingRootSignal(store: RuntimeStore, runId: string, claim: RunOwnerClaim, idempotencyKey: string, signal: { deadlineAt?: string; timeoutMessage?: string } = {}): string {
  const snapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId);
  const nodeKey = deriveInstanceKey([{ kind: "node", nodeId: "approve" }]);
  throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
    runId,
    expectedVersion: snapshot.version,
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey,
    events: [
      { type: "frame.started", payload: { runId, frameKey: "root", frameKind: "root", scope: { approve: nodeKey } } },
      { type: "instance.ready", payload: { runId, nodeKey, nodeId: "approve", instancePath: [{ kind: "node", nodeId: "approve" }], parentFrameKey: "root", readinessSequence: 1 } },
      { type: "instance.awaiting", payload: { nodeKey, statusReason: "signal" } },
      { type: "signal.awaiting", payload: { runId, nodeKey, nodeId: "approve", ...signal } },
    ],
  });
  return nodeKey;
}

function awaitingGroupSignal(store: RuntimeStore, runId: string, claim: RunOwnerClaim, idempotencyKey: string): void {
  const snapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId);
  throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
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
