import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { openRuntimeStore, type RuntimeStore } from "../src/store/store.js";
import { getRunInspection } from "../src/inspection/use-cases.js";
import { deriveInstanceKey } from "../src/scheduler/identity.js";
import type { RunOwnerClaim } from "../src/scheduler/store-port.js";
import { stableJson } from "../src/stable-json.js";
import { prepareSyntheticWorkflow, timedSignalWorkflow, validWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";
import { throwingSchedulerStore } from "./support/scheduler-store.js";

describe("scheduler store port", () => {
  it("reads inspection events, projection, and cursors from one store snapshot", async () => {
    await withRuntimeWorkspace("scheduler-store-inspection-read", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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

        const advanced = store.readRunInspection(run.id, admitted.cursor.eventSequence);
        expect(advanced.events.map(event => event.sequence)).toEqual([2, 3]);
        expect(advanced.cursor).toEqual({ eventSequence: 3, progressVersion: 0 });
        expect(advanced.run?.dynamic?.version).toBe(3);
        expect(advanced.run?.dynamic?.nodeInstances).toEqual(expect.arrayContaining([
          expect.objectContaining({ nodeKey: "require_ready~1", status: "ready" }),
        ]));

        store.writeNodeProgress({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          kind: "agent",
          status: "running",
          context: { used: 10, size: 100 },
        });
        const progressed = store.readRunInspection(run.id, advanced.cursor.eventSequence);
        expect(progressed.events).toEqual([]);
        expect(progressed.cursor).toEqual({ eventSequence: 3, progressVersion: 1 });
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
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const databasePath = join(workspace, ".acpus", ".local", "state", "runtime.db");
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
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        store.writeNodeProgress({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          attemptId: "attempt_missing",
          attemptNo: 1,
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
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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

        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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
          idempotencyKey: "typed:attempt:start",
        });
        expect(startConflict.isErr()).toBe(true);
        if (startConflict.isOk()) throw new Error("expected attempt start idempotency conflict");
        expect(startConflict.error).toMatchObject({ type: "idempotency-conflict", idempotencyKey: "typed:attempt:start", runId: run.id });

        throwingSchedulerStore(store.scheduler).pauseRun({ runId: run.id, ownerEpoch: claim.ownerEpoch, idempotencyKey: "typed:pause" });
        const pausedStart = store.scheduler.tryStartAttempt({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          ownerEpoch: claim.ownerEpoch,
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
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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

  it("rejects malformed scheduler event envelopes on the normal load path", async () => {
    await withRuntimeWorkspace("scheduler-store-malformed-event-envelope", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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

  it("does not treat append idempotency keys as string prefixes", async () => {
    await withRuntimeWorkspace("scheduler-store-idempotency-prefix", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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
        expect(store.scheduler.tryResumeRun({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "control:same-key",
        })._unsafeUnwrapErr()).toMatchObject({
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
      const store = await openRuntimeStore(workspace);
      try {
        const firstRun = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const secondRun = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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
      const store = await openRuntimeStore(workspace);
      try {
        const resumeRun = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const pauseRun = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const cancelRun = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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
        expect(store.scheduler.tryPauseRun({
          runId: resumeRun.id,
          ownerEpoch: resumeClaim.ownerEpoch,
          idempotencyKey: "control:no-op:resume",
        })._unsafeUnwrapErr()).toMatchObject({ type: "idempotency-conflict", runId: resumeRun.id });
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
        expect(store.scheduler.tryResumeRun({
          runId: pauseRun.id,
          ownerEpoch: pauseClaim.ownerEpoch,
          idempotencyKey: "control:no-op:pause",
        })._unsafeUnwrapErr()).toMatchObject({ type: "idempotency-conflict", runId: pauseRun.id });
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
        expect(store.scheduler.tryCancel({
          runId: cancelRun.id,
          ownerEpoch: cancelClaim.ownerEpoch,
          target: "root",
          idempotencyKey: "control:no-op:cancel",
        })._unsafeUnwrapErr()).toMatchObject({ type: "idempotency-conflict", runId: cancelRun.id });
        expect(store.scheduler.tryCancel({
          runId: cancelRun.id,
          ownerEpoch: cancelClaim.ownerEpoch,
          target: "missing",
          idempotencyKey: "control:no-op:cancel",
        })._unsafeUnwrapErr()).toMatchObject({ type: "idempotency-conflict", runId: cancelRun.id });
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
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const version = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).version;
        const eventCount = dbScalar(workspace, "SELECT COUNT(*) FROM run_events WHERE run_id = ?", run.id);
        expect(store.scheduler.releaseRun(claim)).toBe(true);

        expect(store.scheduler.tryResumeRun({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "control:no-op:inactive-owner",
        })._unsafeUnwrapErr()).toMatchObject({
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
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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

  it("bridges active scheduler work to public running status", async () => {
    await withRuntimeWorkspace("scheduler-store-public-running-status", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;

        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "public:running-root",
          events: [{ type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } }],
        });
        expect(store.getRun(run.id)).toMatchObject({ status: "running" });

        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "public:running-ready-instance",
          events: [{ type: "instance.ready", payload: { runId: run.id, nodeKey: "left~1", nodeId: "left", parentFrameKey: "root", instancePath: [{ kind: "node", nodeId: "left" }], readinessSequence: 1 } }],
        });
        expect(store.getRun(run.id)).toMatchObject({ status: "running" });
      } finally {
        store.close();
      }
    });
  });

  it("cancels a run before root materialization", async () => {
    await withRuntimeWorkspace("scheduler-store-cancel-before-root", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;

        const canceled = throwingSchedulerStore(store.scheduler).cancel({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "cancel:before-root",
        });

        expect(canceled.projection.run).toMatchObject({ status: "canceled", paused: false });
        expect(canceled.projection.frames.root).toMatchObject({ status: "cancelled", terminalReason: "operator_cancelled" });
        expect(store.getRun(run.id)).toMatchObject({ status: "canceled" });
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
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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

  it("bridges scheduler run-level retry back to a clean public pending run", async () => {
    await withRuntimeWorkspace("scheduler-store-run-retry", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;

        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
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

        const retried = throwingSchedulerStore(store.scheduler).retryRun({ runId: run.id, ownerEpoch: claim.ownerEpoch, idempotencyKey: "public:run-retry" });

        expect(retried.projection).toMatchObject({ run: { status: "pending", paused: false }, frames: {}, instances: {} });
        expect(store.getRun(run.id)).toMatchObject({ status: "pending" });
        expect(store.getRun(run.id)?.output).toBeUndefined();
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM scheduler_frames WHERE run_id = ?", run.id)).toBe(0);
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM node_instances WHERE run_id = ?", run.id)).toBe(0);
        expect(dbScalar(workspace, "SELECT COUNT(*) FROM node_states WHERE run_id = ?", run.id)).toBe(0);
        expect(() => throwingSchedulerStore(store.scheduler).retryRun({ runId: run.id, ownerEpoch: claim.ownerEpoch, idempotencyKey: "public:run-retry-again" })).toThrow("Cannot retry run from pending.");
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
        const inspected = await getRunInspection(workspace, { runId: run.id, mode: "target", target: "require_ready~1" });
        expect(inspected.isOk() && inspected.value.kind === "target"
          ? inspected.value.instances.find(node => node.nodeKey === "require_ready~1")?.statusReason
          : "inspection failed").toBeUndefined();
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

        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
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

        const retried = throwingSchedulerStore(store.scheduler).retry({
          runId: run.id,
          target: "leaf~1",
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
        expect(store.getRun(run.id)).toMatchObject({ status: "running" });
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
        const attempt = throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          ownerEpoch: first!.ownerEpoch,
          idempotencyKey: "attempt:start",
        });
        expect(attempt).toMatchObject({ attemptNo: 1 });
        expect(throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          ownerEpoch: first!.ownerEpoch,
          idempotencyKey: "attempt:start",
        })).toEqual(attempt);
        expect(() => throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "other~1",
          nodeId: "other",
          ownerEpoch: first!.ownerEpoch,
          idempotencyKey: "attempt:start",
        })).toThrow("conflicts");
        expect(dbScalar(workspace, "SELECT status FROM node_attempts WHERE attempt_id = ?", attempt.attemptId)).toBe("started");
        expect(() => throwingSchedulerStore(store.scheduler).markExpiredOwnerAttemptsSuperseded(run.id, first!.ownerEpoch)).toThrow("still active");

        const db = new DatabaseSync(join(workspace, ".acpus", ".local", "state", "runtime.db"));
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

        const superseded = throwingSchedulerStore(store.scheduler).markExpiredOwnerAttemptsSuperseded(run.id, first!.ownerEpoch);
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
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const db = new DatabaseSync(join(workspace, ".acpus", ".local", "state", "runtime.db"));
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
        expect(paused.projection.groupMembers["require_ready~1"]).toMatchObject({ status: "ready", readinessSequence: 1 });
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
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const snapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id);
        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: snapshot.version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "retry:failed-state",
          events: [
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "require_ready~1", nodeId: "require_ready", instancePath: [{ kind: "node", nodeId: "require_ready" }], readinessSequence: 1 } },
            { type: "instance.failed", payload: { nodeKey: "require_ready~1", error: { reason: "boom" }, statusReason: "terminal" } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "other~1", nodeId: "other", instancePath: [{ kind: "node", nodeId: "other" }], readinessSequence: 2 } },
            { type: "instance.failed", payload: { nodeKey: "other~1", error: { reason: "boom" }, statusReason: "terminal" } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "other~2", nodeId: "other", instancePath: [{ kind: "fanout", nodeId: "items", itemIndex: 1 }, { kind: "node", nodeId: "other" }], readinessSequence: 3 } },
            { type: "instance.failed", payload: { nodeKey: "other~2", error: { reason: "boom" }, statusReason: "terminal" } },
            { type: "group.started", payload: { runId: run.id, groupKey: "parallel~1", nodeKey: "parallel~1", nodeId: "parallel", kind: "parallel", strategy: "all" } },
            { type: "group.member_ready", payload: { runId: run.id, groupKey: "parallel~1", memberKey: "require_ready~1", memberKind: "branch", branchId: "left", readinessSequence: 1 } },
            { type: "group.member_failed", payload: { memberKey: "require_ready~1", error: { reason: "boom" } } },
            { type: "group.member_ready", payload: { runId: run.id, groupKey: "parallel~1", memberKey: "other~1", memberKind: "branch", branchId: "right", readinessSequence: 2 } },
          ],
        });

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
        expect(retried.projection.groupMembers["require_ready~1"]).toMatchObject({ status: "ready" });
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
        })).toThrow("cannot be retried from ready");
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
        expect(() => throwingSchedulerStore(store.scheduler).retry({
          runId: run.id,
          target: "other~1",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "retry:other",
        })).toThrow("Group member 'other~1' cannot be retried from ready");
      } finally {
        store.close();
      }
    });
  });

  it("retries failed composite frames through scheduler events", async () => {
    await withRuntimeWorkspace("scheduler-store-frame-retry", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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

  it("consumes signal waits idempotently through scheduler events", async () => {
    await withRuntimeWorkspace("scheduler-store-signal-consume", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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
        const duplicateWithFreshCommand = throwingSchedulerStore(store.scheduler).consumeSignal({
          runId: run.id,
          nodeKey: "approve~1",
          ownerEpoch: claim.ownerEpoch,
          payload: { ok: true },
          commandIdempotencyKey: "other-command",
          idempotencyKey: "signal:consume:other",
        });
        expect(duplicateWithFreshCommand.version).toBe(consumed.version);

        expect(() => throwingSchedulerStore(store.scheduler).consumeSignal({
          runId: run.id,
          nodeKey: "approve~1",
          ownerEpoch: claim.ownerEpoch,
          payload: { ok: false },
          commandIdempotencyKey: "signal-command",
          idempotencyKey: "signal:consume",
        })).toThrow("already consumed a different payload");
        expect(() => throwingSchedulerStore(store.scheduler).consumeSignal({
          runId: run.id,
          nodeKey: "approve~1",
          ownerEpoch: claim.ownerEpoch,
          payload: { ok: false },
          commandIdempotencyKey: "other-command",
          idempotencyKey: "signal:consume:other",
        })).toThrow("already consumed a different payload");
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
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
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
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
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

function readyNode(store: RuntimeStore, runId: string, claim: RunOwnerClaim, idempotencyKey: string): void {
  const snapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId);
  throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
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

function awaitingSignal(store: RuntimeStore, runId: string, claim: RunOwnerClaim, idempotencyKey: string, signal: { deadlineAt?: string; timeoutMessage?: string } = {}): void {
  const snapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId);
  throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
    runId,
    expectedVersion: snapshot.version,
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey,
    events: [
      { type: "instance.ready", payload: { runId, nodeKey: "approve~1", nodeId: "approve", instancePath: [{ kind: "node", nodeId: "approve" }], readinessSequence: 1 } },
      { type: "instance.awaiting", payload: { nodeKey: "approve~1", statusReason: "signal" } },
      { type: "signal.awaiting", payload: { runId, nodeKey: "approve~1", nodeId: "approve", ...signal } },
    ],
  });
}

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

function dbScalar(workspace: string, sql: string, ...params: SQLInputValue[]): unknown {
  const row = dbRow(workspace, sql, ...params);
  return row ? Object.values(row)[0] : undefined;
}

function dbRow(workspace: string, sql: string, ...params: SQLInputValue[]): Record<string, unknown> | undefined {
  const db = new DatabaseSync(join(workspace, ".acpus", ".local", "state", "runtime.db"), { readOnly: true });
  try {
    return db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  } finally {
    db.close();
  }
}

function dbRows(workspace: string, sql: string, ...params: SQLInputValue[]): Array<Record<string, unknown>> {
  const db = new DatabaseSync(join(workspace, ".acpus", ".local", "state", "runtime.db"), { readOnly: true });
  try {
    return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function dbRun(workspace: string, sql: string, ...params: SQLInputValue[]): void {
  const db = new DatabaseSync(join(workspace, ".acpus", ".local", "state", "runtime.db"));
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

function setSchedulerEventTypesCreatedAt(workspace: string, runId: string, types: string[], createdAt: string): void {
  const db = new DatabaseSync(join(workspace, ".acpus", ".local", "state", "runtime.db"));
  try {
    const placeholders = types.map(() => "?").join(", ");
    db.prepare(`UPDATE run_events SET created_at = ? WHERE run_id = ? AND type IN (${placeholders})`).run(createdAt, runId, ...types);
  } finally {
    db.close();
  }
}

function writeMalformedSchedulerEvent(workspace: string, runId: string, type: string, nodeKey: string): void {
  const db = new DatabaseSync(join(workspace, ".acpus", ".local", "state", "runtime.db"));
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
  const db = new DatabaseSync(join(workspace, ".acpus", ".local", "state", "runtime.db"));
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
