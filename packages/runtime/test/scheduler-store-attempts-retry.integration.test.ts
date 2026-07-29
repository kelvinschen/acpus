import { admitRunForTest } from "./support/runtime-store.js";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import * as occurrenceRefs from "../src/scheduler/occurrence-ref.js";
import { openRuntimeStore, type RuntimeStore } from "../src/store/store.js";
import type { RunOwnerClaim } from "../src/scheduler/store-port.js";
import { prepareSyntheticWorkflow, runtimeDatabasePath, validWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";
import { throwingSchedulerStore } from "./support/scheduler-store.js";
import { dbRow, dbScalar, readyNode } from "./support/store-port-fixtures.js";

describe("scheduler store attempts, retry, and result commits", () => {
  it("records attempts durably and rejects stale owner commits", async () => {
    await withRuntimeWorkspace("scheduler-store-attempts", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const first = store.scheduler.claimRun(run.id, "owner-a", 60_000);
        readyNode(store, run.id, first!, "attempt-ready-node");
        const admissionVersion = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).version;
        const attempt = throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          ownerEpoch: first!.ownerEpoch,
          expectedVersion: admissionVersion,
          idempotencyKey: "attempt:start",
        });
        expect(attempt).toMatchObject({ attemptNo: 1 });
        const replay = throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          ownerEpoch: first!.ownerEpoch,
          expectedVersion: admissionVersion,
          idempotencyKey: "attempt:start",
        });
        expect(replay).toMatchObject({
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
          disposition: "existing",
        });
        expect(replay.snapshot).toEqual(attempt.snapshot);
        expect(() => throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "other~1",
          nodeId: "other",
          ownerEpoch: first!.ownerEpoch,
          expectedVersion: admissionVersion,
          idempotencyKey: "attempt:start",
        })).toThrow("conflicts");
        expect(dbScalar(workspace, "SELECT status FROM node_attempts WHERE attempt_id = ?", attempt.attemptId)).toBe("started");
        expect(() => throwingSchedulerStore(store.scheduler).markExpiredOwnerAttemptsSuperseded({
          runId: run.id,
          currentOwnerEpoch: first!.ownerEpoch,
          expiredOwnerEpoch: first!.ownerEpoch,
          expectedVersion: attempt.snapshot.version,
        })).toThrow("still active");

        const db = new DatabaseSync(runtimeDatabasePath(workspace));
        try {
          db.prepare("UPDATE run_leases SET lease_expires_at = ? WHERE run_id = ?").run(new Date(Date.now() - 1_000).toISOString(), run.id);
        } finally {
          db.close();
        }

        const second = store.scheduler.claimRun(run.id, "owner-b", 60_000);
        expect(second).toMatchObject({ ownerEpoch: 2 });
        expect(() => throwingSchedulerStore(store.scheduler).commitAttemptResult({
          runId: run.id,
          attemptId: attempt.attemptId,
          ownerEpoch: first!.ownerEpoch,
          result: { status: "completed", output: { ok: true } },
          idempotencyKey: "attempt:late",
        })).toThrow("owner epoch is not active");

        const superseded = throwingSchedulerStore(store.scheduler).markExpiredOwnerAttemptsSuperseded({
          runId: run.id,
          currentOwnerEpoch: second!.ownerEpoch,
          expiredOwnerEpoch: first!.ownerEpoch,
          expectedVersion: throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).version,
        });
        expect(superseded.projection.attempts[attempt.attemptId]).toMatchObject({ status: "superseded" });
        expect(dbScalar(workspace, "SELECT status FROM node_attempts WHERE attempt_id = ?", attempt.attemptId)).toBe("superseded");
      } finally {
        store.close();
      }
    });
  });

  it("persists attempt timings from their committed scheduler events", async () => {
    await withRuntimeWorkspace("scheduler-store-attempt-timings", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        readyNode(store, run.id, claim, "attempt-timing-ready");
        const attempt = throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "attempt:timing:start",
        });
        throwingSchedulerStore(store.scheduler).commitAttemptResult({
          runId: run.id,
          attemptId: attempt.attemptId,
          ownerEpoch: claim.ownerEpoch,
          result: { status: "completed", output: { ok: true } },
          idempotencyKey: "attempt:timing:complete",
        });

        const startedAt = dbScalar(workspace, "SELECT created_at FROM run_events WHERE run_id = ? AND type = 'attempt.started'", run.id);
        const finishedAt = dbScalar(workspace, "SELECT created_at FROM run_events WHERE run_id = ? AND type = 'attempt.completed'", run.id);

        expect(dbRow(workspace, "SELECT started_at, finished_at FROM node_attempts WHERE attempt_id = ?", attempt.attemptId)).toEqual({
          started_at: startedAt,
          finished_at: finishedAt,
        });
        const dynamicAttempt = store.getRun(run.id)?.dynamic?.attempts.find(row => row.attemptId === attempt.attemptId);
        expect(dynamicAttempt).toMatchObject({ startedAt, finishedAt });
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
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const db = new DatabaseSync(runtimeDatabasePath(workspace));
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
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        readyGroupNode(store, run.id, claim, "pause-ready-group-node");
        const attempt = throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "pause:attempt:start",
        });

        const paused = throwingSchedulerStore(store.scheduler).pauseRun({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "pause:run",
        });

        expect(paused.projection.run).toMatchObject({ status: "paused", paused: true });
        expect(paused.projection.attempts[attempt.attemptId]).toMatchObject({ status: "cancelled", cancelReason: "paused" });
        expect(paused.projection.instances["require_ready~1"]).toMatchObject({ status: "ready", readinessSequence: 1, statusReason: "paused" });
        expect(paused.projection.groupMembers["require_ready~1"]).toMatchObject({ status: "running", readinessSequence: 1 });
        expect(throwingSchedulerStore(store.scheduler).pauseRun({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "pause:run",
        }).version).toBe(paused.version);
        expect(() => throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "pause:attempt:blocked",
        })).toThrow("is paused");

        const eventCount = dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ?", run.id);
        expect(() => throwingSchedulerStore(store.scheduler).commitAttemptResult({
          runId: run.id,
          attemptId: attempt.attemptId,
          ownerEpoch: claim.ownerEpoch,
          result: { status: "completed", output: { late: true } },
          idempotencyKey: "pause:attempt:late",
        })).toThrow("already cancelled");
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ?", run.id)).toBe(eventCount);

        const resumed = throwingSchedulerStore(store.scheduler).resumeRun({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "pause:resume",
        });
        expect(resumed.projection.run).toMatchObject({ status: "pending", paused: false });
        expect(throwingSchedulerStore(store.scheduler).resumeRun({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "pause:resume",
        }).version).toBe(resumed.version);
        const restarted = throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "pause:attempt:restart",
        });
        expect(restarted).toMatchObject({ attemptNo: 2 });
        const restartedSnapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id);
        expect(restartedSnapshot.projection.instances["require_ready~1"]).toMatchObject({ status: "running" });
        expect(restartedSnapshot.projection.groupMembers["require_ready~1"]).toMatchObject({ status: "running" });
      } finally {
        store.close();
      }
    });
  });

  it("resolves and replays retry aliases in the store", async () => {
    await withRuntimeWorkspace("scheduler-store-retry", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const snapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id);
        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: snapshot.version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "retry:failed-state",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "require_ready~1", nodeId: "require_ready", parentFrameKey: "root", instancePath: [{ kind: "node", nodeId: "require_ready" }], readinessSequence: 1 } },
            { type: "instance.failed", payload: { nodeKey: "require_ready~1", error: { reason: "boom" }, statusReason: "terminal" } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "other~1", nodeId: "other", parentFrameKey: "root", instancePath: [{ kind: "node", nodeId: "other" }], readinessSequence: 2 } },
            { type: "instance.failed", payload: { nodeKey: "other~1", error: { reason: "boom" }, statusReason: "terminal" } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "other~2", nodeId: "other", parentFrameKey: "root", instancePath: [{ kind: "fanout", nodeId: "items", itemIndex: 1 }, { kind: "node", nodeId: "other" }], readinessSequence: 3 } },
            { type: "instance.failed", payload: { nodeKey: "other~2", error: { reason: "boom" }, statusReason: "terminal" } },
            { type: "frame.failed", payload: { frameKey: "root", error: { reason: "boom" } } },
          ],
        });

        expect(() => throwingSchedulerStore(store.scheduler).retry({
          runId: run.id,
          target: "other",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "retry:other",
        })).toThrow("ambiguous");
        const retried = throwingSchedulerStore(store.scheduler).retry({
          runId: run.id,
          target: "require_ready",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "retry:node",
        });
        expect(retried.projection.instances["require_ready~1"]).toMatchObject({ status: "ready", statusReason: "retry" });
        expect(dbRow(workspace, "SELECT status, error_json FROM node_instances WHERE run_id = ? AND node_key = ?", run.id, "require_ready~1")).toMatchObject({
          status: "ready",
          error_json: null,
        });
        expect(throwingSchedulerStore(store.scheduler).retry({
          runId: run.id,
          target: "require_ready",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "retry:node",
        }).version).toBe(retried.version);
        expect(() => throwingSchedulerStore(store.scheduler).retry({
          runId: run.id,
          target: "require_ready~1",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "retry:node-again",
        })).toThrow("in a completed run");
        expect(store.scheduler.tryRetry({
          runId: run.id,
          target: "other",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "retry:node",
        })._unsafeUnwrapErr()).toMatchObject({
          type: "idempotency-conflict",
          idempotencyKey: "retry:node",
          runId: run.id,
        });
      } finally {
        store.close();
      }
    });
  });

  it.each(["retry", "cancel"] as const)(
    "revalidates a %s occurrence ref inside the SQLite mutation transaction",
    async control => {
      await withRuntimeWorkspace(`scheduler-store-${control}-occurrence-ref-transaction`, async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
        const store = await openRuntimeStore(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
          const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
          const path = [{ kind: "node" as const, nodeId: "require_ready" }];
          const snapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id);
          throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
            runId: run.id,
            expectedVersion: snapshot.version,
            ownerEpoch: claim.ownerEpoch,
            idempotencyKey: `${control}:occurrence-ref-state`,
            events: [
              { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
              {
                type: "instance.ready",
                payload: {
                  runId: run.id,
                  nodeKey: "require_ready~1",
                  nodeId: "require_ready",
                  parentFrameKey: "root",
                  instancePath: path,
                  readinessSequence: 1,
                },
              },
              ...(control === "retry"
                ? [
                    {
                      type: "instance.failed" as const,
                      payload: {
                        nodeKey: "require_ready~1",
                        error: { reason: "boom" },
                        statusReason: "terminal",
                      },
                    },
                    {
                      type: "frame.failed" as const,
                      payload: { frameKey: "root", error: { reason: "boom" } },
                    },
                  ]
                : []),
            ],
          });

          const db = (store.scheduler as unknown as { db: DatabaseSync }).db;
          const transactionStates: boolean[] = [];
          const resolveOccurrenceRef = occurrenceRefs.resolveOccurrenceRef;
          const resolveSpy = vi.spyOn(occurrenceRefs, "resolveOccurrenceRef").mockImplementation((...args) => {
            transactionStates.push(db.isTransaction);
            return resolveOccurrenceRef(...args);
          });
          try {
            const input = {
              runId: run.id,
              target: occurrenceRefs.deriveOccurrenceRef(path),
              ownerEpoch: claim.ownerEpoch,
              idempotencyKey: `${control}:occurrence-ref-control`,
            };
            const result = control === "retry"
              ? store.scheduler.tryRetry(input)
              : store.scheduler.tryCancel(input);
            expect(result.isOk()).toBe(true);
            expect(transactionStates).toContain(true);
          } finally {
            resolveSpy.mockRestore();
          }
        } finally {
          store.close();
        }
      });
    },
  );

  it("retries failed composite frames through scheduler events", async () => {
    await withRuntimeWorkspace("scheduler-store-frame-retry", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const snapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id);
        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: snapshot.version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "retry:frame-state",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
            { type: "frame.started", payload: { runId: run.id, frameKey: "choose~1", frameKind: "node", nodeKey: "choose~1", nodeId: "choose", parentFrameKey: "root", instancePath: [{ kind: "node", nodeId: "choose" }] } },
            { type: "branch.decided", payload: { frameKey: "choose~1", branchId: "then" } },
            { type: "frame.started", payload: { runId: run.id, frameKey: "choose.then~1", frameKind: "branch", nodeId: "choose", parentFrameKey: "choose~1", instancePath: [{ kind: "branch", nodeId: "choose", branchId: "then" }] } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "leaf~1", nodeId: "leaf", parentFrameKey: "choose.then~1", instancePath: [{ kind: "branch", nodeId: "choose", branchId: "then" }, { kind: "node", nodeId: "leaf" }] } },
            { type: "attempt.started", payload: { runId: run.id, attemptId: "attempt_leaf", nodeKey: "leaf~1", nodeId: "leaf", attemptNo: 1, ownerEpoch: claim.ownerEpoch } },
            { type: "attempt.failed", payload: { attemptId: "attempt_leaf", error: { reason: "boom" } } },
            { type: "instance.failed", payload: { nodeKey: "leaf~1", error: { reason: "boom" } } },
            { type: "frame.failed", payload: { frameKey: "choose.then~1", error: { reason: "boom" } } },
            { type: "frame.failed", payload: { frameKey: "choose~1", error: { reason: "boom" } } },
            { type: "frame.failed", payload: { frameKey: "root", error: { reason: "boom" } } },
          ],
        });

        const retried = throwingSchedulerStore(store.scheduler).retry({
          runId: run.id,
          target: "choose~1",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "retry:frame",
        });
        expect(retried.projection.run).toMatchObject({ status: "pending" });
        expect(retried.projection.frames.root).toMatchObject({ status: "running" });
        expect(retried.projection.frames["choose~1"]).toBeUndefined();
        expect(retried.projection.frames["choose.then~1"]).toBeUndefined();
        expect(retried.projection.instances["leaf~1"]).toBeUndefined();
        expect(retried.projection.branchDecisions["choose~1"]).toBeUndefined();
        expect(store.getRun(run.id)).toMatchObject({ status: "running" });
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM scheduler_frames WHERE run_id = ? AND frame_key = ?", run.id, "choose.then~1")).toBe(0);
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM node_instances WHERE run_id = ? AND node_key = ?", run.id, "leaf~1")).toBe(0);
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM node_attempts WHERE run_id = ? AND attempt_id = ?", run.id, "attempt_leaf")).toBe(0);
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM node_states WHERE run_id = ? AND node_key = ?", run.id, "leaf~1")).toBe(0);
      } finally {
        store.close();
      }
    });
  });

  it("cancels a run through scheduler events and bridges the public run status", async () => {
    await withRuntimeWorkspace("scheduler-store-cancel-run", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "cancel:run-state",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "require_ready~1", nodeId: "require_ready", instancePath: [{ kind: "node", nodeId: "require_ready" }], parentFrameKey: "root", readinessSequence: 1 } },
          ],
        });

        const canceled = throwingSchedulerStore(store.scheduler).cancel({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "cancel:run",
        });

        expect(canceled.projection.run).toMatchObject({ status: "canceled", paused: false });
        expect(canceled.projection.frames.root).toMatchObject({ status: "cancelled", terminalReason: "operator_cancelled" });
        expect(canceled.projection.instances["require_ready~1"]).toMatchObject({ status: "cancelled", statusReason: "operator_cancelled" });
        expect(store.getRun(run.id)).toMatchObject({ status: "canceled" });
        expect(dbScalar(workspace, "SELECT type FROM run_events WHERE run_id = ? AND type = 'run.canceled'", run.id)).toBe("run.canceled");
        expect(throwingSchedulerStore(store.scheduler).cancel({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "cancel:run",
        }).version).toBe(canceled.version);
      } finally {
        store.close();
      }
    });
  });

  it("resolves and replays cancel aliases without resetting unrelated work", async () => {
    await withRuntimeWorkspace("scheduler-store-cancel-target", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "cancel:target-state",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "left~1", nodeId: "left", instancePath: [{ kind: "node", nodeId: "left" }], parentFrameKey: "root", readinessSequence: 1 } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "right~1", nodeId: "right", instancePath: [{ kind: "node", nodeId: "right" }], parentFrameKey: "root", readinessSequence: 2 } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "right~2", nodeId: "right", instancePath: [{ kind: "fanout", nodeId: "items", itemIndex: 1 }, { kind: "node", nodeId: "right" }], parentFrameKey: "root", readinessSequence: 3 } },
          ],
        });

        const canceled = throwingSchedulerStore(store.scheduler).cancel({
          runId: run.id,
          target: "left",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "cancel:left",
        });

        expect(canceled.projection.run.status).toBe("pending");
        expect(canceled.projection.instances["left~1"]).toMatchObject({ status: "cancelled", statusReason: "operator_cancelled" });
        expect(canceled.projection.instances["right~1"]).toMatchObject({ status: "ready" });
        expect(store.getRun(run.id)).toMatchObject({ status: "running" });

        const withNewCandidates = throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: canceled.version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "cancel:target-new-candidates",
          events: [
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "left~2", nodeId: "left", instancePath: [{ kind: "fanout", nodeId: "items", itemIndex: 2 }, { kind: "node", nodeId: "left" }], parentFrameKey: "root", readinessSequence: 4 } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "left~3", nodeId: "left", instancePath: [{ kind: "fanout", nodeId: "items", itemIndex: 3 }, { kind: "node", nodeId: "left" }], parentFrameKey: "root", readinessSequence: 5 } },
          ],
        });
        expect(throwingSchedulerStore(store.scheduler).cancel({
          runId: run.id,
          target: "left",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "cancel:left",
        }).version).toBe(withNewCandidates.version);
        expect(store.scheduler.tryCancel({
          runId: run.id,
          target: "right",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "cancel:left",
        })._unsafeUnwrapErr()).toMatchObject({
          type: "idempotency-conflict",
          idempotencyKey: "cancel:left",
          runId: run.id,
        });
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ? AND type = 'instance.cancelled' AND node_key = 'left~1'", run.id)).toBe(1);
      } finally {
        store.close();
      }
    });
  });

  it("cancels the owning group member subtree for a grouped leaf target", async () => {
    await withRuntimeWorkspace("scheduler-store-cancel-grouped-leaf", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "cancel:grouped-leaf-state",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
            { type: "frame.started", payload: { runId: run.id, frameKey: "parallel~1", frameKind: "node", parentFrameKey: "root", nodeKey: "parallel~1", nodeId: "parallel", strategy: "all" } },
            { type: "group.started", payload: { runId: run.id, groupKey: "parallel~1", nodeKey: "parallel~1", nodeId: "parallel", kind: "parallel", strategy: "all" } },
            { type: "group.member_ready", payload: { runId: run.id, groupKey: "parallel~1", memberKey: "branch~left", memberKind: "branch", branchId: "left", childFrameKey: "branch~left", readinessSequence: 1 } },
            { type: "frame.started", payload: { runId: run.id, frameKey: "branch~left", frameKind: "branch", parentFrameKey: "parallel~1", nodeId: "parallel", strategy: "all" } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "leaf~1", nodeId: "leaf", instancePath: [{ kind: "branch", nodeId: "parallel", branchId: "left" }, { kind: "node", nodeId: "leaf" }], parentFrameKey: "branch~left", readinessSequence: 1 } },
          ],
        });

        const canceled = throwingSchedulerStore(store.scheduler).cancel({
          runId: run.id,
          target: "leaf~1",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "cancel:grouped-leaf",
        });

        expect(canceled.projection.instances["leaf~1"]).toMatchObject({ status: "cancelled", statusReason: "operator_cancelled" });
        expect(canceled.projection.groupMembers["branch~left"]).toMatchObject({ status: "cancelled", terminalReason: "operator_cancelled" });
        expect(canceled.projection.frames["branch~left"]).toMatchObject({ status: "cancelled", terminalReason: "operator_cancelled" });
        expect(canceled.projection.groups["parallel~1"]).toMatchObject({ status: "running" });
      } finally {
        store.close();
      }
    });
  });

  it("exposes group member completion sequence through public run details", async () => {
    await withRuntimeWorkspace("scheduler-store-group-member-order-read", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "public:group-member-order",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
            { type: "group.started", payload: { runId: run.id, groupKey: "parallel~1", nodeKey: "parallel~1", nodeId: "parallel", kind: "parallel", strategy: "race" } },
            { type: "group.member_ready", payload: { runId: run.id, groupKey: "parallel~1", memberKey: "left", memberKind: "branch", branchId: "left", readinessSequence: 1 } },
            { type: "group.member_completed", payload: { memberKey: "left", completionSequence: 7, output: { ok: true } } },
          ],
        });

        expect(store.getRun(run.id)?.dynamic?.groupMembers).toEqual([
          expect.objectContaining({ memberKey: "left", completionSequence: 7, status: "completed" }),
        ]);
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
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        readyNode(store, run.id, claim, "attempt-cancel-ready-node");
        const attempt = throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "attempt:cancel:start",
        });

        const snapshot = throwingSchedulerStore(store.scheduler).commitAttemptResult({
          runId: run.id,
          attemptId: attempt.attemptId,
          ownerEpoch: claim.ownerEpoch,
          result: { status: "cancelled", reason: "race_lost" },
          idempotencyKey: "attempt:cancel:commit",
        });
        expect(snapshot.projection.attempts[attempt.attemptId]).toMatchObject({ status: "cancelled", cancelReason: "race_lost" });
        expect(dbScalar(workspace, "SELECT cancel_reason FROM node_attempts WHERE attempt_id = ?", attempt.attemptId)).toBe("race_lost");

        const duplicate = throwingSchedulerStore(store.scheduler).commitAttemptResult({
          runId: run.id,
          attemptId: attempt.attemptId,
          ownerEpoch: claim.ownerEpoch,
          result: { status: "cancelled", reason: "race_lost" },
          idempotencyKey: "attempt:cancel:commit",
        });
        expect(duplicate.version).toBe(snapshot.version);
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE idempotency_key = ?", "attempt:cancel:commit")).toBe(1);
        const firstTimestamps = dbRow(workspace, "SELECT started_at, finished_at FROM node_attempts WHERE attempt_id = ?", attempt.attemptId);
        const advanced = throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: snapshot.version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "scheduler:after-attempt",
          events: [{ type: "control.paused", payload: {} }],
        });
        expect(advanced.version).toBe(snapshot.version + 1);
        expect(dbRow(workspace, "SELECT started_at, finished_at FROM node_attempts WHERE attempt_id = ?", attempt.attemptId)).toEqual(firstTimestamps);
        expect(() => throwingSchedulerStore(store.scheduler).commitAttemptResult({
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
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        readyNode(store, run.id, claim, "attempt-cancelled-ready-node");
        const attempt = throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "attempt:stale:start",
        });
        const snapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id);
        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
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

        expect(() => throwingSchedulerStore(store.scheduler).commitAttemptResult({
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
});

function readyGroupNode(store: RuntimeStore, runId: string, claim: RunOwnerClaim, idempotencyKey: string): void {
  const snapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId);
  throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
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
