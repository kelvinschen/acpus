import { admitRunForTest } from "./support/runtime-store.js";
import { DatabaseSync } from "node:sqlite";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vitest";
import { advanceRun as advanceRunEffect, type NodeExecutor } from "../src/scheduler/advance.js";
import type { AttemptCommitInput } from "../src/scheduler/store-port.js";
import { advanceRun } from "./support/effect-scheduler.js";
import { openRuntimeStoreAdapter } from "../src/store/store.js";
import { prepareSyntheticWorkflow, runtimeDatabasePath, scopedRuntimeWorkspace, validWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";
import { throwingSchedulerStore } from "./support/scheduler-store.js";
import { completed } from "./support/scheduler.js";

describe("durable scheduler advance with store", () => {
  it("resumes an interrupted race by committing winner and loser cancellation from projection", async () => {
    await withRuntimeWorkspace("scheduler-advance-store-race", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      const calls: string[] = [];
      const executor = nodeExecutor(context => {
          calls.push(context.nodeKey);
          return completed();
      });
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const setupOwner = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).version,
          ownerEpoch: setupOwner.ownerEpoch,
          idempotencyKey: "setup-race",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "race", frameKind: "node", nodeKey: "race", nodeId: "race", strategy: "race" } },
            { type: "group.started", payload: { runId: run.id, groupKey: "race", nodeKey: "race", nodeId: "race", kind: "parallel", strategy: "race" } },
            { type: "group.member_ready", payload: { runId: run.id, groupKey: "race", memberKey: "winner", memberKind: "branch", branchId: "winner", readinessSequence: 1 } },
            { type: "group.member_started", payload: { memberKey: "winner" } },
            { type: "group.member_completed", payload: { memberKey: "winner", completionSequence: 1, output: { ok: true } } },
            { type: "group.member_ready", payload: { runId: run.id, groupKey: "race", memberKey: "loser", memberKind: "branch", branchId: "loser", readinessSequence: 2 } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "loser", nodeId: "loser", instancePath: [{ kind: "branch", nodeId: "race", branchId: "loser" }, { kind: "node", nodeId: "loser" }], readinessSequence: 2 } },
          ],
        });
        expireLease(workspace, run.id);

        await expect(advanceRun({
          runId: run.id,
          ownerId: "owner-b",
          store: store.scheduler,
          executor,
        })).resolves.toMatchObject({ started: 0 });

        const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
        expect(calls).toEqual([]);
        expect(projection.groups.race).toMatchObject({ status: "completed" });
        expect(projection.groupMembers.loser).toMatchObject({ status: "cancelled", terminalReason: "race_lost" });
        expect(projection.instances.loser).toMatchObject({ status: "cancelled", statusReason: "race_lost" });
      } finally {
        store.close();
      }
    });
  });

  it("resumes an interrupted quorum fanout by accepting durable completion order", async () => {
    await withRuntimeWorkspace("scheduler-advance-store-quorum", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const setupOwner = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).version,
          ownerEpoch: setupOwner.ownerEpoch,
          idempotencyKey: "setup-quorum",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "items", frameKind: "node", nodeKey: "items", nodeId: "items", strategy: "quorum" } },
            { type: "group.started", payload: { runId: run.id, groupKey: "items", nodeKey: "items", nodeId: "items", kind: "fanout", strategy: "quorum", quorumCount: 2 } },
            { type: "group.member_ready", payload: { runId: run.id, groupKey: "items", memberKey: "items[0]", memberKind: "fanout_item", itemIndex: 0, item: 0, readinessSequence: 1 } },
            { type: "group.member_started", payload: { memberKey: "items[0]" } },
            { type: "group.member_completed", payload: { memberKey: "items[0]", completionSequence: 20, output: { item: 0 } } },
            { type: "group.member_ready", payload: { runId: run.id, groupKey: "items", memberKey: "items[1]", memberKind: "fanout_item", itemIndex: 1, item: 1, readinessSequence: 2 } },
            { type: "group.member_started", payload: { memberKey: "items[1]" } },
            { type: "group.member_completed", payload: { memberKey: "items[1]", completionSequence: 10, output: { item: 1 } } },
            { type: "group.member_ready", payload: { runId: run.id, groupKey: "items", memberKey: "items[2]", memberKind: "fanout_item", itemIndex: 2, item: 2, readinessSequence: 3 } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "items[2]", nodeId: "item", instancePath: [{ kind: "fanout", nodeId: "items", itemIndex: 2 }, { kind: "node", nodeId: "item" }], readinessSequence: 3 } },
          ],
        });
        expireLease(workspace, run.id);

        await advanceRun({
          runId: run.id,
          ownerId: "owner-b",
          store: store.scheduler,
          executor: nodeExecutor(() => completed()),
        });

        const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
        expect(projection.groups.items).toMatchObject({
          status: "completed",
          result: { acceptedMemberKeys: ["items[1]", "items[0]"] },
        });
        expect(projection.groupMembers["items[2]"]).toMatchObject({ status: "cancelled", terminalReason: "quorum_reached" });
        expect(projection.instances["items[2]"]).toMatchObject({ status: "cancelled", statusReason: "quorum_reached" });
      } finally {
        store.close();
      }
    });
  });

  it("updates direct group member lifecycle from real leaf completion", async () => {
    await withRuntimeWorkspace("scheduler-advance-store-member-lifecycle", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      const calls: string[] = [];
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const setupOwner = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).version,
          ownerEpoch: setupOwner.ownerEpoch,
          idempotencyKey: "setup-member-lifecycle",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "all", frameKind: "node", nodeKey: "all", nodeId: "all", strategy: "all" } },
            { type: "group.started", payload: { runId: run.id, groupKey: "all", nodeKey: "all", nodeId: "all", kind: "parallel", strategy: "all" } },
            { type: "group.member_ready", payload: { runId: run.id, groupKey: "all", memberKey: "leaf", memberKind: "branch", branchId: "leaf", readinessSequence: 1 } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "leaf", nodeId: "leaf", instancePath: [{ kind: "branch", nodeId: "all", branchId: "leaf" }, { kind: "node", nodeId: "leaf" }], readinessSequence: 1 } },
          ],
        });
        expireLease(workspace, run.id);

        await advanceRun({
          runId: run.id,
          ownerId: "owner-b",
          store: store.scheduler,
          executor: nodeExecutor(context => {
              calls.push(context.nodeKey);
              return completed({ ok: true });
          }),
        });

        const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
        expect(calls).toEqual(["leaf"]);
        expect(projection.groupMembers.leaf).toMatchObject({ status: "completed", output: { ok: true } });
        expect(projection.groups.all).toMatchObject({ status: "completed", result: { acceptedMemberKeys: ["leaf"] } });
      } finally {
        store.close();
      }
    });
  });

  it("supersedes expired-owner attempts before a recovered owner advances", async () => {
    await withRuntimeWorkspace("scheduler-advance-store-recovery", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      const calls: string[] = [];
      const oldAttemptStatusesAtExecution: string[] = [];
      let activeExecutors = 0;
      let peakExecutors = 0;
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const oldOwner = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).version,
          ownerEpoch: oldOwner.ownerEpoch,
          idempotencyKey: "setup-recovery-ready",
          events: [
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "old", nodeId: "old", instancePath: [{ kind: "node", nodeId: "old" }], readinessSequence: 1 } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "new", nodeId: "new", instancePath: [{ kind: "node", nodeId: "new" }], readinessSequence: 2 } },
          ],
        });
        const oldAttempt = throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "old",
          nodeId: "old",
          ownerEpoch: oldOwner.ownerEpoch,
          idempotencyKey: "old-attempt-start",
        });
        expireLease(workspace, run.id);

        await advanceRun({
          runId: run.id,
          ownerId: "owner-b",
          store: store.scheduler,
          maxLeafConcurrency: 1,
          executor: nodeExecutor(async context => {
              calls.push(context.nodeKey);
              activeExecutors += 1;
              peakExecutors = Math.max(peakExecutors, activeExecutors);
              try {
                oldAttemptStatusesAtExecution.push(
                  throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection.attempts[oldAttempt.attemptId]?.status ?? "missing",
                );
                await Promise.resolve();
                return completed();
              } finally {
                activeExecutors -= 1;
              }
          }),
        });

        const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
        expect(projection.attempts[oldAttempt.attemptId]).toMatchObject({ status: "superseded" });
        expect(calls).toEqual(["old", "new"]);
        expect(oldAttemptStatusesAtExecution).toEqual(["superseded", "superseded"]);
        expect(peakExecutors).toBe(1);
        expect(Object.values(projection.attempts).filter(attempt => attempt.nodeKey === "old").map(attempt => attempt.attemptNo).sort()).toEqual([1, 2]);

        const eventsDb = new DatabaseSync(runtimeDatabasePath(workspace));
        try {
          const attemptEvents = eventsDb.prepare(`
            SELECT sequence, type, payload_json
            FROM run_events
            WHERE run_id = ? AND type IN ('attempt.started', 'attempt.superseded')
            ORDER BY sequence
          `).all(run.id) as Array<{ sequence: number; type: string; payload_json: string }>;
          const supersededSequence = attemptEvents.find(event =>
            event.type === "attempt.superseded"
            && (JSON.parse(event.payload_json) as { payload: { attemptId?: string } }).payload.attemptId === oldAttempt.attemptId
          )?.sequence;
          const replacementSequence = attemptEvents.find(event => {
            if (event.type !== "attempt.started") return false;
            const { payload } = JSON.parse(event.payload_json) as { payload: { nodeKey?: string; attemptNo?: number } };
            return payload.nodeKey === "old" && payload.attemptNo === 2;
          })?.sequence;
          expect(supersededSequence).toBeDefined();
          expect(replacementSequence).toBeGreaterThan(supersededSequence!);
        } finally {
          eventsDb.close();
        }
        expect(() => throwingSchedulerStore(store.scheduler).commitAttemptResult({
          runId: run.id,
          attemptId: oldAttempt.attemptId,
          ownerEpoch: oldOwner.ownerEpoch,
          result: { status: "completed", output: { late: true } },
          idempotencyKey: "old-attempt-late",
        })).toThrow("owner epoch is not active");
      } finally {
        store.close();
      }
    });
  });

  it("times out expired old-owner attempts before superseding recovery", async () => {
    await withRuntimeWorkspace("scheduler-advance-store-recovery-timeout", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      const calls: string[] = [];
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const oldOwner = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).version,
          ownerEpoch: oldOwner.ownerEpoch,
          idempotencyKey: "setup-recovery-timeout-ready",
          events: [
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "old", nodeId: "old", instancePath: [{ kind: "node", nodeId: "old" }], readinessSequence: 1 } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "new", nodeId: "new", instancePath: [{ kind: "node", nodeId: "new" }], readinessSequence: 2 } },
          ],
        });
        const oldAttempt = throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "old",
          nodeId: "old",
          ownerEpoch: oldOwner.ownerEpoch,
          deadlineAt: "2026-06-30T00:00:00.000Z",
          idempotencyKey: "old-timeout-attempt-start",
        });
        expireLease(workspace, run.id);

        await advanceRun({
          runId: run.id,
          ownerId: "owner-b",
          store: store.scheduler,
          executor: nodeExecutor(context => {
              calls.push(context.nodeKey);
              return completed();
          }),
        });

        const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
        expect(projection.attempts[oldAttempt.attemptId]).toMatchObject({ status: "timed_out" });
        expect(projection.instances.old).toMatchObject({ status: "failed", statusReason: "timed_out" });
        expect(calls).toEqual(["new"]);
      } finally {
        store.close();
      }
    });
  });

  it("times out expired durable signal waits before returning awaiting", async () => {
    await withRuntimeWorkspace("scheduler-advance-store-signal-timeout", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const owner = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).version,
          ownerEpoch: owner.ownerEpoch,
          idempotencyKey: "setup-signal-timeout",
          events: [
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "approve", nodeId: "approve", instancePath: [{ kind: "node", nodeId: "approve" }], readinessSequence: 1 } },
            { type: "instance.awaiting", payload: { nodeKey: "approve", statusReason: "signal" } },
            { type: "signal.awaiting", payload: { runId: run.id, nodeKey: "approve", nodeId: "approve", deadlineAt: "2026-06-30T00:00:00.000Z" } },
          ],
        });
        expireLease(workspace, run.id);

        await advanceRun({
          runId: run.id,
          ownerId: "owner-b",
          store: store.scheduler,
          executor: nodeExecutor(() => completed()),
        });

        const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
        expect(projection.signalWaits.approve).toMatchObject({ status: "timed_out", terminalReason: "signal_timeout" });
        expect(projection.instances.approve).toMatchObject({ status: "failed", statusReason: "signal_timeout" });
      } finally {
        store.close();
      }
    });
  });

  effectIt.effect("polls an active uncoordinated executor only at the 250ms fallback cadence", () => Effect.gen(function* () {
      const workspace = yield* scopedRuntimeWorkspace("scheduler-advance-store-active-poll");
      const prepared = yield* Effect.promise(() => prepareSyntheticWorkflow(workspace, validWorkflow()));
      const store = yield* Effect.acquireRelease(
        Effect.promise(() => openRuntimeStoreAdapter(workspace)),
        store => Effect.sync(() => store.close()),
      );
      const releaseExecutor = yield* Deferred.make<void>();
      const pumpReady = yield* Deferred.make<void>();
      const originalLoad = store.scheduler.tryLoadRunSnapshot.bind(store.scheduler);
      let snapshotReads = 0;
      store.scheduler.tryLoadRunSnapshot = runId => {
        snapshotReads += 1;
        return originalLoad(runId);
      };
        const run = yield* Effect.promise(() => admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace }));
        const setupOwner = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).version,
          ownerEpoch: setupOwner.ownerEpoch,
          idempotencyKey: "setup-active-poll",
          events: [
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "slow", nodeId: "slow", instancePath: [{ kind: "node", nodeId: "slow" }], readinessSequence: 1 } },
          ],
        });
        expireLease(workspace, run.id);

        const advancing = yield* Effect.forkChild(advanceRunEffect({
          runId: run.id,
          ownerId: "owner-b",
          store: store.scheduler,
          executor: {
            execute: () => Deferred.await(releaseExecutor).pipe(Effect.as(completed())),
          },
          onCheckpoint: snapshot => Object.values(snapshot.projection.attempts).some(attempt => attempt.status === "started")
            ? Deferred.succeed(pumpReady, undefined).pipe(Effect.asVoid)
            : Effect.void,
        }));
        yield* Deferred.await(pumpReady);
        const readsAtStart = snapshotReads;
        yield* TestClock.adjust(249);
        expect(snapshotReads - readsAtStart).toBe(0);
        yield* TestClock.adjust(1);
        expect(snapshotReads - readsAtStart).toBe(1);
        yield* Deferred.succeed(releaseExecutor, undefined);
        yield* Fiber.join(advancing);
  }));

  it("renews ownership before each derived transition batch", async () => {
    await withRuntimeWorkspace("scheduler-advance-store-derived-heartbeat", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      const originalHeartbeat = store.scheduler.heartbeatRun.bind(store.scheduler);
      const originalAppend = store.scheduler.tryAppendSchedulerEvents.bind(store.scheduler);
      let renewedSinceAppend = false;
      const derivedBatchRenewals: boolean[] = [];
      store.scheduler.heartbeatRun = (...args) => {
        const renewed = originalHeartbeat(...args);
        renewedSinceAppend ||= renewed;
        return renewed;
      };
      store.scheduler.tryAppendSchedulerEvents = input => {
        if (input.idempotencyKey.startsWith("scheduler:derived:")) {
          derivedBatchRenewals.push(renewedSinceAppend);
          renewedSinceAppend = false;
        }
        return originalAppend(input);
      };
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        await expect(advanceRun({
          runId: run.id,
          ownerId: "owner",
          store: store.scheduler,
          leaseMs: 60_000,
          executor: { execute: () => Effect.die(new Error("derived-only run must not execute a leaf")) },
          bootstrap: snapshot => snapshot.projection.frames.root ? [] : [{
            type: "frame.started",
            payload: { runId: run.id, frameKey: "root", frameKind: "root", scope: {} },
          }],
          materialize: snapshot => {
            const child = snapshot.projection.frames.child;
            if (!child) return [{
              type: "frame.started",
              payload: { runId: run.id, frameKey: "child", frameKind: "node", parentFrameKey: "root", nodeKey: "child", nodeId: "child", scope: {} },
            }];
            if (child.status === "running") return [{ type: "frame.completed", payload: { frameKey: "child", result: { ok: true } } }];
            if (snapshot.projection.frames.root?.status === "running") return [{ type: "frame.completed", payload: { frameKey: "root", result: { ok: true } } }];
            return [];
          },
        })).resolves.toMatchObject({ status: "completed" });
        expect(derivedBatchRenewals).toEqual([true, true, true]);
      } finally {
        store.close();
      }
    });
  });
});

function expireLease(workspace: string, runId: string): void {
  const db = new DatabaseSync(runtimeDatabasePath(workspace));
  try {
    db.prepare("UPDATE run_leases SET lease_expires_at = ? WHERE run_id = ?").run(new Date(Date.now() - 1_000).toISOString(), runId);
  } finally {
    db.close();
  }
}

function nodeExecutor(
  execute: (context: Parameters<NodeExecutor["execute"]>[0]) =>
    | AttemptCommitInput["result"]
    | Promise<AttemptCommitInput["result"]>,
): NodeExecutor {
  return { execute: context => Effect.promise(() => Promise.resolve(execute(context))) };
}
