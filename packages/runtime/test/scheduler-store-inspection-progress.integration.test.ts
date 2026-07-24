import { admitRunForTest } from "./support/runtime-store.js";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { openRuntimeStore } from "../src/store/store.js";
import { prepareSyntheticWorkflow, runtimeDatabasePath, validWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";
import { throwingSchedulerStore } from "./support/scheduler-store.js";
import { awaitingSignal, dbRow, dbRun, dbScalar, readyNode } from "./support/store-port-fixtures.js";

describe("scheduler store inspection, progress, and validation", () => {
  it("reads inspection events, projection, and cursors from one store snapshot", async () => {
    await withRuntimeWorkspace("scheduler-store-inspection-read", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const admitted = store.readRunInspection(run.id, 0);
        expect(admitted.cursor).toEqual({ eventSequence: 1, progressVersion: 0 });
        expect(admitted.events.map(event => event.sequence)).toEqual([1]);
        expect(admitted.run?.eventCount).toBe(1);

        const claim = store.scheduler.claimRun(run.id, "inspection-reader", 60_000)!;
        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: 1,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "inspection-read:ready",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "require_ready~1", nodeId: "require_ready", instancePath: [{ kind: "node", nodeId: "require_ready" }], parentFrameKey: "root", readinessSequence: 1 } },
          ],
        });
        const attempt = throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "inspection-read:attempt",
        });

        const advanced = store.readRunInspection(run.id, admitted.cursor.eventSequence);
        expect(advanced.events.map(event => event.sequence)).toEqual([2, 3, 4, 5]);
        expect(advanced.cursor).toEqual({ eventSequence: 5, progressVersion: 0 });
        expect(advanced.run?.dynamic?.version).toBe(5);
        expect(advanced.run?.dynamic?.nodeInstances).toEqual(expect.arrayContaining([
          expect.objectContaining({ nodeKey: "require_ready~1", status: "running" }),
        ]));

        store.writeNodeProgress({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
          ownerEpoch: claim.ownerEpoch,
          kind: "agent",
          status: "running",
          context: { used: 10, size: 100 },
        });
        const progressed = store.readRunInspection(run.id, advanced.cursor.eventSequence);
        expect(progressed.events).toEqual([]);
        expect(progressed.cursor).toEqual({ eventSequence: 5, progressVersion: 1 });
        expect(progressed.run?.dynamic?.progress).toEqual(expect.arrayContaining([
          expect.objectContaining({ nodeKey: "require_ready~1", context: { used: 10, size: 100 } }),
        ]));
      } finally {
        store.close();
      }
    });
  });

  it("keeps inspection event counts and cursor aligned during concurrent commits", async () => {
    await withRuntimeWorkspace("scheduler-store-inspection-concurrent-read", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const databasePath = runtimeDatabasePath(workspace);
        const worker = new Worker(`
          const { parentPort, workerData } = require("node:worker_threads");
          const { DatabaseSync } = require("node:sqlite");
          parentPort.once("message", () => {
            const db = new DatabaseSync(workerData.databasePath);
            db.exec("PRAGMA busy_timeout = 5000");
            const insert = db.prepare("INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key) VALUES (?, ?, 'run.paused', NULL, '{}', ?, ?)");
            const wait = new Int32Array(new SharedArrayBuffer(4));
            for (let sequence = 2; sequence <= 101; sequence += 1) {
              insert.run(workerData.runId, sequence, new Date().toISOString(), "inspection-concurrent:" + sequence);
              Atomics.wait(wait, 0, 0, 1);
            }
            db.close();
            parentPort.postMessage("done");
          });
          parentPort.postMessage("ready");
        `, { eval: true, workerData: { databasePath, runId: run.id } });
        const ready = await new Promise<string>((resolve, reject) => {
          worker.once("message", resolve);
          worker.once("error", reject);
        });
        expect(ready).toBe("ready");
        let done = false;
        const completed = new Promise<void>((resolve, reject) => {
          worker.on("message", message => {
            if (message === "done") {
              done = true;
              resolve();
            }
          });
          worker.once("error", reject);
        });
        worker.postMessage("start");
        const observed = new Set<number>();
        while (!done) {
          const read = store.readRunInspection(run.id, 0);
          observed.add(read.cursor.eventSequence);
          expect(read.run?.eventCount).toBe(read.cursor.eventSequence);
          expect(read.events).toHaveLength(read.cursor.eventSequence);
          expect(read.events.at(-1)?.sequence).toBe(read.cursor.eventSequence);
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        await completed;
        expect(observed.size).toBeGreaterThan(1);
        expect(store.readRunInspection(run.id, 0).cursor.eventSequence).toBe(101);
      } finally {
        store.close();
      }
    });
  });

  it("claims run ownership, appends scheduler events, and rebuilds snapshots", async () => {
    await withRuntimeWorkspace("scheduler-store-port", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000);
        expect(claim).toMatchObject({ runId: run.id, ownerId: "owner-a", ownerEpoch: 1 });
        expect(store.scheduler.claimRun(run.id, "owner-b", 60_000)).toBeUndefined();

        const snapshot = throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
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
        expect(dbRow(workspace, "SELECT event_count, intent_digest FROM scheduler_commits WHERE run_id = ? AND idempotency_key = ?", run.id, "scheduler:event"))
          .toEqual({ event_count: 2, intent_digest: null });

        const duplicate = throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: 1,
          ownerEpoch: claim!.ownerEpoch,
          idempotencyKey: "scheduler:event",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "require_ready~1", nodeId: "require_ready", instancePath: [{ kind: "node", nodeId: "require_ready" }], parentFrameKey: "root", readinessSequence: 1 } },
          ],
        });
        expect(duplicate.version).toBe(snapshot.version);
        expect(() => throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: 1,
          ownerEpoch: claim!.ownerEpoch,
          idempotencyKey: "scheduler:event",
          events: [{ type: "control.paused", payload: {} }],
        })).toThrow("conflicts");

        const eventCount = dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ?", run.id);
        expect(() => throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: snapshot.version,
          ownerEpoch: claim!.ownerEpoch,
          idempotencyKey: "scheduler:invalid-transition",
          events: [{ type: "frame.completed", payload: { frameKey: "missing" } }],
        })).toThrow("Unknown frame");
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ?", run.id)).toBe(eventCount);

        expect(() => throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: 1,
          ownerEpoch: claim!.ownerEpoch,
          idempotencyKey: "scheduler:stale-version",
          events: [{ type: "control.paused", payload: {} }],
        })).toThrow("version mismatch");

        const commitCount = dbScalar(workspace, "SELECT COUNT(*) FROM scheduler_commits WHERE run_id = ?", run.id);
        expect(throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: snapshot.version,
          ownerEpoch: claim!.ownerEpoch,
          idempotencyKey: "scheduler:empty",
          events: [],
        }).version).toBe(snapshot.version);
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM scheduler_commits WHERE run_id = ?", run.id)).toBe(commitCount);
        expect(dbRow(workspace, "SELECT event_count FROM scheduler_commits WHERE run_id = ? AND idempotency_key = ?", run.id, "scheduler:empty")).toBeUndefined();

        expect(store.scheduler.releaseRun(claim!)).toBe(true);
        expect(store.scheduler.claimRun(run.id, "owner-b", 60_000)).toMatchObject({ ownerId: "owner-b", ownerEpoch: 2 });
      } finally {
        store.close();
      }
    });
  });

  it("stores latest node progress without changing scheduler event version", async () => {
    await withRuntimeWorkspace("scheduler-store-node-progress", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        readyNode(store, run.id, claim, "node-progress:ready");
        const attempt = throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "node-progress:attempt",
        });
        const schedulerVersion = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).version;
        const eventCount = dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ?", run.id);

        store.writeNodeProgress({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
          ownerEpoch: claim.ownerEpoch,
          kind: "agent",
          status: "running",
          output: { tail: "hel", totalBytes: 3, truncated: false },
          context: { used: 80, size: 200 },
          tokenUsage: { inputTokens: 10 },
          tools: { totalToolCallCount: 0, lastCalls: [] },
        });
        store.writeNodeProgress({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
          ownerEpoch: claim.ownerEpoch,
          kind: "agent",
          status: "running",
          message: "still running",
          output: { tail: "hello", totalBytes: 5, truncated: false },
          context: { used: 90, size: 200 },
          tokenUsage: { inputTokens: 10, outputTokens: 2 },
          tools: { totalToolCallCount: 1, lastCalls: [{ toolName: "Bash", status: "running" }] },
        });

        const details = store.getRun(run.id);
        expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).version).toBe(schedulerVersion);
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ?", run.id)).toBe(eventCount);
        expect(details?.progressVersion).toBe(2);
        expect(details?.progressUpdatedAt).toEqual(expect.any(String));
        expect(details?.dynamic?.version).toBe(schedulerVersion);
        expect(details?.dynamic?.progressVersion).toBe(2);
        expect(details?.dynamic?.progress).toEqual([
          expect.objectContaining({
            nodeKey: "require_ready~1",
            nodeId: "require_ready",
            attemptId: attempt.attemptId,
            attemptNo: attempt.attemptNo,
            kind: "agent",
            status: "running",
            message: "still running",
            output: { tail: "hello", totalBytes: 5, truncated: false },
            context: { used: 90, size: 200 },
            tokenUsage: { inputTokens: 10, outputTokens: 2 },
            tools: { totalToolCallCount: 1, lastCalls: [{ toolName: "Bash", status: "running" }] },
            updatedAt: expect.any(String),
          }),
        ]);
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM node_progress WHERE run_id = ?", run.id)).toBe(1);
      } finally {
        store.close();
      }
    });
  });

  it("ignores progress from attempts that are not running", async () => {
    await withRuntimeWorkspace("scheduler-store-node-progress-stale-attempt", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        store.writeNodeProgress({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          attemptId: "attempt_missing",
          attemptNo: 1,
          ownerEpoch: 1,
          kind: "agent",
          status: "running",
          message: "late",
        });

        expect(store.getRun(run.id)?.progressVersion).toBe(0);
        expect(store.getRun(run.id)?.dynamic?.progress ?? []).toEqual([]);
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM node_progress WHERE run_id = ?", run.id)).toBe(0);
      } finally {
        store.close();
      }
    });
  });

  it("ignores late progress from a terminal attempt after retry starts a newer attempt", async () => {
    await withRuntimeWorkspace("scheduler-store-node-progress-late-attempt", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        readyNode(store, run.id, claim, "late-progress:ready");
        const first = throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "late-progress:first",
        });
        store.writeNodeProgress({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          attemptId: first.attemptId,
          attemptNo: first.attemptNo,
          ownerEpoch: claim.ownerEpoch,
          kind: "agent",
          status: "running",
          message: "first",
        });
        throwingSchedulerStore(store.scheduler).commitAttemptResult({
          runId: run.id,
          attemptId: first.attemptId,
          ownerEpoch: claim.ownerEpoch,
          result: { status: "failed", reason: "retryable" },
          idempotencyKey: "late-progress:first-failed",
        });
        throwingSchedulerStore(store.scheduler).retry({
          runId: run.id,
          target: "require_ready~1",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "late-progress:retry",
        });
        const second = throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "late-progress:second",
        });
        expect(store.getRun(run.id)?.progressVersion).toBe(2);
        expect(store.getRun(run.id)?.dynamic?.progress ?? []).toEqual([]);
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM node_progress WHERE run_id = ?", run.id)).toBe(0);
        store.writeNodeProgress({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          attemptId: second.attemptId,
          attemptNo: second.attemptNo,
          ownerEpoch: claim.ownerEpoch,
          kind: "agent",
          status: "running",
          message: "second",
        });
        const progressVersion = store.getRun(run.id)?.progressVersion;

        store.writeNodeProgress({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          attemptId: first.attemptId,
          attemptNo: first.attemptNo,
          ownerEpoch: claim.ownerEpoch,
          kind: "agent",
          status: "running",
          message: "late first",
        });

        expect(store.getRun(run.id)?.progressVersion).toBe(progressVersion);
        expect(store.getRun(run.id)?.dynamic?.progress).toEqual([
          expect.objectContaining({
            attemptId: second.attemptId,
            attemptNo: second.attemptNo,
            message: "second",
          }),
        ]);
      } finally {
        store.close();
      }
    });
  });

  it("does not let running progress overwrite terminal progress for the same attempt", async () => {
    await withRuntimeWorkspace("scheduler-store-node-progress-terminal-precedence", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        readyNode(store, run.id, claim, "terminal-progress:ready");
        const attempt = throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "terminal-progress:attempt",
        });
        store.writeNodeProgress({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
          ownerEpoch: claim.ownerEpoch,
          kind: "agent",
          status: "completed",
          message: "done",
        });
        const progressVersion = store.getRun(run.id)?.progressVersion;

        store.writeNodeProgress({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
          ownerEpoch: claim.ownerEpoch,
          kind: "agent",
          status: "running",
          message: "late running",
        });

        expect(store.getRun(run.id)?.progressVersion).toBe(progressVersion);
        expect(store.getRun(run.id)?.dynamic?.progress).toEqual([
          expect.objectContaining({
            status: "completed",
            message: "done",
          }),
        ]);
      } finally {
        store.close();
      }
    });
  });

  it("returns typed results for recoverable store-port failures", async () => {
    await withRuntimeWorkspace("scheduler-store-port-typed-errors", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const missing = store.scheduler.tryLoadRunSnapshot("run_missing");
        expect(missing.isErr()).toBe(true);
        if (missing.isOk()) throw new Error("expected run-not-found");
        expect(missing.error).toMatchObject({ type: "run-not-found", runId: "run_missing" });

        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const mismatch = store.scheduler.tryAppendSchedulerEvents({
          runId: run.id,
          expectedVersion: 99,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "scheduler:mismatch",
          events: [{ type: "control.paused", payload: {} }],
        });

        expect(mismatch.isErr()).toBe(true);
        if (mismatch.isOk()) throw new Error("expected version mismatch");
        expect(mismatch.error).toMatchObject({
          type: "version-mismatch",
          runId: run.id,
          expectedVersion: 99,
          actualVersion: 1,
        });

        const alreadyResumed = store.scheduler.tryResumeRun({ runId: run.id, ownerEpoch: claim.ownerEpoch, idempotencyKey: "typed:resume" });
        expect(alreadyResumed.isOk()).toBe(true);
        if (alreadyResumed.isErr()) throw new Error("expected already-resumed success");
        expect(alreadyResumed.value.projection.run.status).toBe("pending");

        const invalidRunRetry = store.scheduler.tryRetryRun({ runId: run.id, ownerEpoch: claim.ownerEpoch, idempotencyKey: "typed:run-retry" });
        expect(invalidRunRetry.isErr()).toBe(true);
        if (invalidRunRetry.isOk()) throw new Error("expected invalid run retry target");
        expect(invalidRunRetry.error).toMatchObject({ type: "invalid-retry-target", runId: run.id, status: "pending" });

        readyNode(store, run.id, claim, "typed:ready");
        const appendConflict = store.scheduler.tryAppendSchedulerEvents({
          runId: run.id,
          expectedVersion: throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "typed:ready",
          events: [{ type: "control.paused", payload: {} }],
        });
        expect(appendConflict.isErr()).toBe(true);
        if (appendConflict.isOk()) throw new Error("expected append idempotency conflict");
        expect(appendConflict.error).toMatchObject({ type: "idempotency-conflict", idempotencyKey: "typed:ready", runId: run.id });

        const invalidNodeRetry = store.scheduler.tryRetry({ runId: run.id, target: "require_ready~1", ownerEpoch: claim.ownerEpoch, idempotencyKey: "typed:node-retry" });
        expect(invalidNodeRetry.isErr()).toBe(true);
        if (invalidNodeRetry.isOk()) throw new Error("expected invalid node retry target");
        expect(invalidNodeRetry.error).toMatchObject({ type: "invalid-retry-target", runId: run.id, targetKey: "require_ready~1", status: "ready" });

        const missingRetry = store.scheduler.tryRetry({ runId: run.id, target: "missing~1", ownerEpoch: claim.ownerEpoch, idempotencyKey: "typed:missing-retry" });
        expect(missingRetry.isErr()).toBe(true);
        if (missingRetry.isOk()) throw new Error("expected missing retry target");
        expect(missingRetry.error).toMatchObject({ type: "missing-retry-target", runId: run.id, targetKey: "missing~1" });

        const signalMissing = store.scheduler.tryConsumeSignal({
          runId: run.id,
          nodeKey: "approve~1",
          ownerEpoch: claim.ownerEpoch,
          payload: { ok: true },
          commandIdempotencyKey: "typed:signal-command",
          idempotencyKey: "typed:signal",
        });
        expect(signalMissing.isErr()).toBe(true);
        if (signalMissing.isOk()) throw new Error("expected missing signal wait");
        expect(signalMissing.error).toMatchObject({ type: "signal-wait-not-found", runId: run.id, nodeKey: "approve~1" });

        const attempt = throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "typed:attempt:start",
        });
        const startConflict = store.scheduler.tryStartAttempt({
          runId: run.id,
          nodeKey: "other~1",
          nodeId: "other",
          ownerEpoch: claim.ownerEpoch,
          expectedVersion: attempt.snapshot.version,
          idempotencyKey: "typed:attempt:start",
        });
        expect(startConflict.isErr()).toBe(true);
        if (startConflict.isOk()) throw new Error("expected attempt start idempotency conflict");
        expect(startConflict.error).toMatchObject({ type: "idempotency-conflict", idempotencyKey: "typed:attempt:start", runId: run.id });

        const paused = throwingSchedulerStore(store.scheduler).pauseRun({ runId: run.id, ownerEpoch: claim.ownerEpoch, idempotencyKey: "typed:pause" });
        const pausedStart = store.scheduler.tryStartAttempt({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          ownerEpoch: claim.ownerEpoch,
          expectedVersion: paused.version,
          idempotencyKey: "typed:attempt:paused",
        });
        expect(pausedStart.isErr()).toBe(true);
        if (pausedStart.isOk()) throw new Error("expected paused start failure");
        expect(pausedStart.error).toMatchObject({ type: "run-paused", runId: run.id });

        const terminal = store.scheduler.tryCommitAttemptResult({
          runId: run.id,
          attemptId: attempt.attemptId,
          ownerEpoch: claim.ownerEpoch,
          result: { status: "completed", output: { ok: true } },
          idempotencyKey: "typed:attempt:late-commit",
        });
        expect(terminal.isErr()).toBe(true);
        if (terminal.isOk()) throw new Error("expected terminal attempt failure");
        expect(terminal.error).toMatchObject({ type: "terminal-attempt", attemptId: attempt.attemptId, status: "cancelled" });
      } finally {
        store.close();
      }
    });
  });

  it("keeps a consumed wait without a persisted payload on the typed terminal path", async () => {
    await withRuntimeWorkspace("scheduler-store-consumed-payload-absence", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        awaitingSignal(store, run.id, claim, "typed:signal-awaiting");
        const sequence = Number(dbScalar(workspace, "SELECT COALESCE(MAX(sequence), 0) + 1 FROM run_events WHERE run_id = ?", run.id));
        dbRun(workspace, `
          INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
          VALUES (?, ?, 'signal.consumed', 'approve~1', ?, ?, ?)
        `, run.id, sequence, JSON.stringify({
          schedulerEventVersion: 1,
          payload: { nodeKey: "approve~1", commandIdempotencyKey: "typed:signal-command" },
        }), new Date().toISOString(), "typed:signal-consumed-without-payload");

        const result = store.scheduler.tryConsumeSignal({
          runId: run.id,
          nodeKey: "approve~1",
          ownerEpoch: claim.ownerEpoch,
          payload: { ok: true },
          commandIdempotencyKey: "typed:signal-command",
          idempotencyKey: "typed:signal-duplicate",
        });

        expect(result.isErr()).toBe(true);
        if (result.isOk()) throw new Error("expected terminal signal wait");
        expect(result.error).toEqual({
          type: "signal-wait-terminal",
          runId: run.id,
          nodeKey: "approve~1",
          status: "consumed",
          message: "Signal wait 'approve~1' has already consumed a different payload.",
        });
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
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
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

  it("rejects malformed scheduler event envelopes on the normal load path", async () => {
    await withRuntimeWorkspace("scheduler-store-malformed-event-envelope", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const fresh = store.getRun(run.id);
        expect(fresh).toBeDefined();
        expect(fresh).not.toHaveProperty("dynamic");
        writeMalformedSchedulerEvent(workspace, run.id, "signal.awaiting", "require_ready~1");

        const snapshotError = captureError(() => throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id));
        const runError = captureError(() => store.getRun(run.id));
        expect(snapshotError.message).toBe("Scheduler event 'signal.awaiting' has an invalid scheduler envelope.");
        expect(runError.constructor).toBe(snapshotError.constructor);
        expect(runError.message).toBe(snapshotError.message);
      } finally {
        store.close();
      }
    });
  });

  it.each(["attempt.started", "signal.awaiting"])("rejects malformed persisted deadlines in %s events", async eventType => {
    await withRuntimeWorkspace(`scheduler-store-malformed-${eventType.replace(".", "-")}-deadline`, async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        writeSchedulerEventPayload(workspace, run.id, eventType, "require_ready~1", { deadlineAt: "not-a-deadline" });

        expect(() => throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id))
          .toThrow(`Scheduler event '${eventType}' has an invalid persisted deadline.`);
      } finally {
        store.close();
      }
    });
  });

  it("surfaces corrupted attempt and signal deadline projection rows", async () => {
    await withRuntimeWorkspace("scheduler-store-corrupted-deadline-rows", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        readyNode(store, run.id, claim, "corrupted-deadline:ready");
        const attempt = throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          ownerEpoch: claim.ownerEpoch,
          deadlineAt: "2026-07-10T00:00:00.000Z",
          idempotencyKey: "corrupted-deadline:attempt",
        });
        dbRun(workspace, "UPDATE node_attempts SET deadline_at = 'not-a-deadline' WHERE attempt_id = ?", attempt.attemptId);
        expect(() => store.getRun(run.id)).toThrow(`Attempt '${attempt.attemptId}' has invalid persisted deadline "not-a-deadline".`);

        awaitingSignal(store, run.id, claim, "corrupted-deadline:signal", { deadlineAt: "2026-07-10T00:00:00.000Z" });
        dbRun(workspace, "UPDATE signal_waits SET deadline_at = 'not-a-deadline' WHERE run_id = ? AND node_key = 'approve~1'", run.id);
        expect(() => store.listDaemonWork(new Date("2026-07-10T00:00:01.000Z")))
          .toThrow(`Signal wait '${run.id}:approve~1' has invalid persisted deadline "not-a-deadline".`);
      } finally {
        store.close();
      }
    });
  });
});

function writeMalformedSchedulerEvent(workspace: string, runId: string, type: string, nodeKey: string): void {
  const db = new DatabaseSync(runtimeDatabasePath(workspace));
  try {
    const sequence = db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS count FROM run_events WHERE run_id = ?").get(runId) as { count: number };
    db.prepare(`
      INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(runId, sequence.count, type, nodeKey, JSON.stringify({ payload: null }), new Date().toISOString(), `malformed:${runId}:${type}`);
  } finally {
    db.close();
  }
}

function writeSchedulerEventPayload(workspace: string, runId: string, type: string, nodeKey: string, payload: Record<string, unknown>): void {
  const db = new DatabaseSync(runtimeDatabasePath(workspace));
  try {
    const sequence = db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS count FROM run_events WHERE run_id = ?").get(runId) as { count: number };
    db.prepare(`
      INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(runId, sequence.count, type, nodeKey, JSON.stringify({ schedulerEventVersion: 1, payload }), new Date().toISOString(), `payload:${runId}:${type}`);
  } finally {
    db.close();
  }
}

function captureError(action: () => unknown): Error {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof Error)) throw new Error("Expected action to throw an Error.");
  return caught;
}
