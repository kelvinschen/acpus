import { describe, expect, it } from "vitest";
import type { JsonValue } from "@acpus/expression/ir";
import { advanceRun, completed, selectReadyInstances, type NodeAttemptContext, type NodeExecutor } from "../src/scheduler/advance.js";
import type { SchedulerEvent } from "../src/scheduler/events.js";
import type { AttemptCommitInput, AttemptStartInput, RunOwnerClaim, SchedulerCommit, SchedulerSnapshot, SchedulerStorePort } from "../src/scheduler/store-port.js";
import { applySchedulerEvents, createSchedulerProjection } from "../src/scheduler/transitions.js";
import type { InstancePath, NodeInstance, SchedulerProjection } from "../src/scheduler/types.js";

describe("scheduler advance loop", () => {
  it("applies bootstrap events once before scheduling", async () => {
    const store = new MemorySchedulerStore("run_1", []);
    const bootstrapVersions: number[] = [];
    const calls: string[] = [];

    await advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      bootstrap: snapshot => {
        bootstrapVersions.push(snapshot.version);
        return snapshot.projection.frames.root ? [] : [
          { type: "frame.started", payload: { runId: "run_1", frameKey: "root", frameKind: "root" } },
          ready("boot", 1),
        ];
      },
      executor: executor(context => {
        calls.push(context.nodeKey);
        return completed();
      }),
    });

    await advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      bootstrap: snapshot => {
        bootstrapVersions.push(snapshot.version);
        return snapshot.projection.frames.root ? [] : [
          { type: "frame.started", payload: { runId: "run_1", frameKey: "root", frameKind: "root" } },
          ready("boot", 1),
        ];
      },
      executor: executor(context => {
        calls.push(context.nodeKey);
        return completed();
      }),
    });

    expect(calls).toEqual(["boot"]);
    expect(bootstrapVersions[0]).toBe(0);
    expect(bootstrapVersions[1]).toBeGreaterThan(0);
  });

  it("selects ready instances by deterministic FIFO and respects the run-wide cap", async () => {
    const store = new MemorySchedulerStore("run_1", [
      ready("later", 2),
      ready("first", 1),
      ready("third", 3),
    ]);
    const calls: string[] = [];

    const result = await advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      executor: executor(context => {
        calls.push(context.nodeKey);
        return completed({ node: context.nodeKey });
      }),
      limiter: new TrackingLimiter(),
      maxLeafConcurrency: 2,
    });

    expect(result).toMatchObject({ status: "idle", started: 2, completed: 2 });
    expect(calls).toEqual(["first", "later"]);
    expect(store.loadCount).toBeGreaterThanOrEqual(2);
  });

  it("respects direct-member local concurrency caps before enqueueing work", () => {
    const projection = applySchedulerEvents(createSchedulerProjection("run_1"), [
      { type: "group.started", payload: { runId: "run_1", groupKey: "fanout", nodeKey: "fanout", nodeId: "fanout", kind: "fanout", strategy: "all" } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "fanout", memberKey: "item-0", memberKind: "fanout_item", readinessSequence: 1, itemIndex: 0 } },
      { type: "group.member_started", payload: { memberKey: "item-0" } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "fanout", memberKey: "item-1", memberKind: "fanout_item", readinessSequence: 2, itemIndex: 1 } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "fanout", memberKey: "item-2", memberKind: "fanout_item", readinessSequence: 3, itemIndex: 2 } },
      ready("item-1", 1),
      ready("item-2", 2),
    ]);

    expect(selectReadyInstances(
      projection,
      3,
      instance => projection.groupMembers[instance.nodeKey],
      () => 2,
    ).map(instance => instance.nodeKey)).toEqual(["item-1"]);
  });

  it("returns paused, awaiting, and lease-lost summaries without starting work", async () => {
    const paused = new MemorySchedulerStore("paused", [{ type: "control.paused", payload: { reason: "test" } }, ready("blocked", 1)]);
    const awaiting = new MemorySchedulerStore("awaiting", [{ type: "signal.awaiting", payload: { runId: "awaiting", nodeKey: "approve", nodeId: "approve" } }]);
    const leaseLost = new MemorySchedulerStore("lost", [ready("work", 1)]);
    leaseLost.claimable = false;
    const calls: string[] = [];
    const nodeExecutor = executor(context => {
      calls.push(context.nodeKey);
      return completed();
    });

    await expect(advanceRun({ runId: "paused", ownerId: "owner-a", store: paused, executor: nodeExecutor })).resolves.toMatchObject({ status: "paused", started: 0 });
    await expect(advanceRun({ runId: "awaiting", ownerId: "owner-a", store: awaiting, executor: nodeExecutor })).resolves.toMatchObject({ status: "awaiting", started: 0 });
    await expect(advanceRun({ runId: "lost", ownerId: "owner-a", store: leaseLost, executor: nodeExecutor })).resolves.toMatchObject({ status: "lease_lost", started: 0 });
    expect(calls).toEqual([]);
  });

  it("does not start selected work after a pause commits before attempt start", async () => {
    const store = new MemorySchedulerStore("run_1", [
      ready("first", 1),
      ready("second", 2),
    ]);
    const calls: string[] = [];

    const result = await advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      executor: executor(context => {
        calls.push(context.nodeKey);
        return completed({ node: context.nodeKey });
      }),
      limiter: new PausingSerialLimiter(() => store.pauseRun({ runId: "run_1", ownerEpoch: 1, idempotencyKey: "pause-between-starts" })),
      maxLeafConcurrency: 2,
    });

    expect(result).toMatchObject({ status: "paused", started: 1 });
    expect(calls).toEqual(["first"]);
  });

  it("aborts active work when pause requeues the running instance", async () => {
    const store = new MemorySchedulerStore("run_1", [ready("work", 1)]);
    let aborted = false;

    const result = await advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      executor: executor(context => new Promise(resolve => {
        setTimeout(() => {
          store.pauseRun({ runId: "run_1", ownerEpoch: 1, idempotencyKey: "pause-active" });
        }, 0);
        context.signal.addEventListener("abort", () => {
          aborted = true;
          resolve({ status: "cancelled", reason: "paused" });
        }, { once: true });
      })),
    });

    expect(aborted).toBe(true);
    expect(result).toMatchObject({ status: "paused", started: 1, cancelled: 1 });
  });

  it("uses a fresh store snapshot on each advance call", async () => {
    const store = new MemorySchedulerStore("run_1", [ready("one", 1)]);
    const calls: string[] = [];
    const nodeExecutor = executor(context => {
      calls.push(context.nodeKey);
      return completed();
    });

    await advanceRun({ runId: "run_1", ownerId: "owner-a", store, executor: nodeExecutor });
    store.appendSchedulerEvents({
      runId: "run_1",
      expectedVersion: store.loadRunSnapshot("run_1").version,
      ownerEpoch: 1,
      idempotencyKey: "ready-two",
      events: [ready("two", 2)],
    });
    await advanceRun({ runId: "run_1", ownerId: "owner-a", store, executor: nodeExecutor });

    expect(calls).toEqual(["one", "two"]);
  });

  it("reports lease loss when the store rejects a late attempt commit", async () => {
    const store = new MemorySchedulerStore("run_1", [ready("work", 1)]);
    store.failCommits = true;

    await expect(advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      executor: executor(() => completed()),
    })).resolves.toMatchObject({ status: "lease_lost", started: 1 });
  });

  it("supersedes started attempts from expired owners before scheduling", async () => {
    const store = new MemorySchedulerStore("run_1", [
      ready("old", 1),
      { type: "instance.started", payload: { nodeKey: "old" } },
      { type: "attempt.started", payload: { runId: "run_1", attemptId: "old_attempt", nodeKey: "old", nodeId: "old", attemptNo: 1, ownerEpoch: 9 } },
      ready("new", 2),
    ]);
    const calls: string[] = [];

    await advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      executor: executor(context => {
        calls.push(context.nodeKey);
        return completed();
      }),
    });

    const projection = store.loadRunSnapshot("run_1").projection;
    expect(projection.attempts.old_attempt).toMatchObject({ status: "superseded" });
    expect(calls).toEqual(["new"]);
  });

  it("times out expired old-owner attempts before recovery supersede", async () => {
    const store = new MemorySchedulerStore("run_1", [
      ready("old", 1),
      { type: "instance.started", payload: { nodeKey: "old" } },
      { type: "attempt.started", payload: { runId: "run_1", attemptId: "old_attempt", nodeKey: "old", nodeId: "old", attemptNo: 1, ownerEpoch: 9, deadlineAt: "2026-06-30T00:00:00.000Z" } },
      ready("new", 2),
    ]);

    await advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      executor: executor(() => completed()),
      now: () => new Date("2026-06-30T00:00:01.000Z"),
    });

    const projection = store.loadRunSnapshot("run_1").projection;
    expect(projection.attempts.old_attempt).toMatchObject({ status: "timed_out" });
    expect(projection.instances.old).toMatchObject({ status: "failed", statusReason: "timed_out" });
  });

  it("drains expired attempt deadlines before returning idle", async () => {
    const store = new MemorySchedulerStore("run_1", [
      ready("work", 1),
      { type: "instance.started", payload: { nodeKey: "work" } },
      { type: "attempt.started", payload: { runId: "run_1", attemptId: "attempt_1", nodeKey: "work", nodeId: "work", attemptNo: 1, ownerEpoch: 1, deadlineAt: "2026-06-30T00:00:00.000Z" } },
    ]);

    const result = await advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      executor: executor(() => completed()),
      now: () => new Date("2026-06-30T00:00:01.000Z"),
    });

    const projection = store.loadRunSnapshot("run_1").projection;
    expect(result).toMatchObject({ status: "idle", started: 0 });
    expect(projection.attempts.attempt_1).toMatchObject({ status: "timed_out", terminalReason: "timed_out" });
    expect(projection.instances.work).toMatchObject({ status: "failed", statusReason: "timed_out" });
  });

  it("treats late commits after durable timeout as stale terminal results", async () => {
    const store = new MemorySchedulerStore("run_1", [ready("work", 1)]);
    store.throwTimedOutCommits = true;

    await expect(advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      executor: executor(() => completed({ late: true })),
    })).resolves.toMatchObject({ status: "idle", started: 1, failed: 1 });
  });

  it("drains group cancellation before overlapping attempt timeouts", async () => {
    const store = new MemorySchedulerStore("run_1", [
      { type: "group.started", payload: { runId: "run_1", groupKey: "race", nodeKey: "race", nodeId: "race", kind: "parallel", strategy: "race" } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "race", memberKey: "winner", memberKind: "branch", branchId: "winner", readinessSequence: 1 } },
      { type: "group.member_started", payload: { memberKey: "winner" } },
      { type: "group.member_completed", payload: { memberKey: "winner", completionSequence: 1, output: { ok: true } } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "race", memberKey: "loser", memberKind: "branch", branchId: "loser", readinessSequence: 2 } },
      { type: "group.member_started", payload: { memberKey: "loser" } },
      ready("loser", 2),
      { type: "instance.started", payload: { nodeKey: "loser" } },
      { type: "attempt.started", payload: { runId: "run_1", attemptId: "loser_attempt", nodeKey: "loser", nodeId: "loser", attemptNo: 1, ownerEpoch: 1, deadlineAt: "2026-06-30T00:00:00.000Z" } },
    ]);

    await advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      executor: executor(() => completed()),
      now: () => new Date("2026-06-30T00:00:01.000Z"),
    });

    const projection = store.loadRunSnapshot("run_1").projection;
    expect(projection.attempts.loser_attempt).toMatchObject({ status: "cancelled", cancelReason: "race_lost" });
    expect(projection.instances.loser).toMatchObject({ status: "cancelled", statusReason: "race_lost" });
    expect(projection.groupMembers.loser).toMatchObject({ status: "cancelled", terminalReason: "race_lost" });
  });

  it("drains group terminal events before starting loser work", async () => {
    const store = new MemorySchedulerStore("run_1", [
      { type: "group.started", payload: { runId: "run_1", groupKey: "race", nodeKey: "race", nodeId: "race", kind: "parallel", strategy: "race" } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "race", memberKey: "winner", memberKind: "branch", branchId: "winner", readinessSequence: 1 } },
      { type: "group.member_started", payload: { memberKey: "winner" } },
      { type: "group.member_completed", payload: { memberKey: "winner", completionSequence: 1, output: { ok: true } } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "race", memberKey: "loser", memberKind: "branch", branchId: "loser", readinessSequence: 2 } },
      ready("loser", 2),
    ]);
    const calls: string[] = [];

    await advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      executor: executor(context => {
        calls.push(context.nodeKey);
        return completed();
      }),
      memberForInstance: (instance, projection) => projection.groupMembers[instance.nodeKey],
    });

    const projection = store.loadRunSnapshot("run_1").projection;
    expect(calls).toEqual([]);
    expect(projection.groups.race).toMatchObject({ status: "completed" });
    expect(projection.groupMembers.loser).toMatchObject({ status: "cancelled", terminalReason: "race_lost" });
  });

  it("aborts active race losers after a winner commits", async () => {
    const store = new MemorySchedulerStore("run_1", [
      { type: "group.started", payload: { runId: "run_1", groupKey: "race", nodeKey: "race", nodeId: "race", kind: "parallel", strategy: "race" } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "race", memberKey: "winner", memberKind: "branch", branchId: "winner", readinessSequence: 1 } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "race", memberKey: "loser", memberKind: "branch", branchId: "loser", readinessSequence: 2 } },
      ready("winner", 1),
      ready("loser", 2),
    ]);
    let loserAborted = false;
    let markLoserStarted!: () => void;
    const loserStarted = new Promise<void>(resolve => {
      markLoserStarted = resolve;
    });

    await advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      maxLeafConcurrency: 2,
      executor: executor(context => {
        if (context.nodeKey === "winner") return loserStarted.then(() => completed({ ok: true }));
        return new Promise(resolve => {
          markLoserStarted();
          context.signal.addEventListener("abort", () => {
            loserAborted = true;
            resolve({ status: "cancelled", reason: "race_lost" });
          }, { once: true });
        });
      }),
    });

    const projection = store.loadRunSnapshot("run_1").projection;
    expect(loserAborted).toBe(true);
    expect(projection.groupMembers.winner).toMatchObject({ status: "completed" });
    expect(projection.groupMembers.loser).toMatchObject({ status: "cancelled", terminalReason: "race_lost" });
  });

  it("requeues failed retryable instances before terminal group derivation", async () => {
    const store = new MemorySchedulerStore("run_1", [
      { type: "group.started", payload: { runId: "run_1", groupKey: "all", nodeKey: "all", nodeId: "all", kind: "parallel", strategy: "all" } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "all", memberKey: "work", memberKind: "branch", branchId: "left", readinessSequence: 1 } },
      ready("work", 1),
    ]);
    let calls = 0;
    const input = {
      runId: "run_1",
      ownerId: "owner-a",
      store,
      maxAttemptsFor: () => 2,
      executor: executor(() => {
        calls += 1;
        return calls === 1 ? { status: "failed", reason: "transient" } : completed({ ok: true });
      }),
    };

    await expect(advanceRun(input)).resolves.toMatchObject({ status: "idle", started: 1, failed: 1 });
    let projection = store.loadRunSnapshot("run_1").projection;
    expect(projection.instances.work).toMatchObject({ status: "ready", statusReason: "retry" });
    expect(projection.groupMembers.work).toMatchObject({ status: "ready" });
    expect(projection.groups.all).toMatchObject({ status: "running" });

    await expect(advanceRun(input)).resolves.toMatchObject({ status: "idle", started: 1, completed: 1 });
    projection = store.loadRunSnapshot("run_1").projection;
    expect(projection.instances.work).toMatchObject({ status: "completed", output: { ok: true } });
    expect(projection.groupMembers.work).toMatchObject({ status: "completed" });
  });

  it("does not requeue exhausted retryable instances", async () => {
    const store = new MemorySchedulerStore("run_1", [
      { type: "group.started", payload: { runId: "run_1", groupKey: "all", nodeKey: "all", nodeId: "all", kind: "parallel", strategy: "all" } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "all", memberKey: "work", memberKind: "branch", branchId: "left", readinessSequence: 1 } },
      ready("work", 1),
    ]);

    await expect(advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      maxAttemptsFor: () => 1,
      executor: executor(() => ({ status: "failed", reason: "terminal" })),
    })).resolves.toMatchObject({ status: "idle", started: 1, failed: 1 });

    const projection = store.loadRunSnapshot("run_1").projection;
    expect(projection.instances.work).toMatchObject({ status: "failed" });
    expect(projection.groupMembers.work).toMatchObject({ status: "failed" });
    expect(projection.groups.all).toMatchObject({ status: "failed" });
  });

  it("does not start recovered work while paused", async () => {
    const store = new MemorySchedulerStore("run_1", [
      { type: "control.paused", payload: { reason: "operator" } },
      ready("old", 1),
      { type: "instance.started", payload: { nodeKey: "old" } },
      { type: "attempt.started", payload: { runId: "run_1", attemptId: "old_attempt", nodeKey: "old", nodeId: "old", attemptNo: 1, ownerEpoch: 9 } },
      ready("new", 2),
    ]);
    const calls: string[] = [];

    await expect(advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      executor: executor(context => {
        calls.push(context.nodeKey);
        return completed();
      }),
    })).resolves.toMatchObject({ status: "paused", started: 0 });

    const projection = store.loadRunSnapshot("run_1").projection;
    expect(calls).toEqual([]);
    expect(projection.attempts.old_attempt).toMatchObject({ status: "started" });
    expect(projection.instances.new).toMatchObject({ status: "ready" });
  });

  it("does not spend failure retry budget on superseded attempts", async () => {
    const store = new MemorySchedulerStore("run_1", [
      ready("work", 1),
      { type: "instance.started", payload: { nodeKey: "work" } },
      { type: "attempt.started", payload: { runId: "run_1", attemptId: "attempt_superseded", nodeKey: "work", nodeId: "work", attemptNo: 1, ownerEpoch: 1 } },
      { type: "attempt.superseded", payload: { attemptId: "attempt_superseded", cancelReason: "superseded" } },
      { type: "instance.requeued", payload: { nodeKey: "work", reason: "superseded", readinessSequence: 1 } },
      { type: "instance.started", payload: { nodeKey: "work" } },
      { type: "attempt.started", payload: { runId: "run_1", attemptId: "attempt_failed", nodeKey: "work", nodeId: "work", attemptNo: 2, ownerEpoch: 2 } },
      { type: "attempt.failed", payload: { attemptId: "attempt_failed", error: { reason: "transient" } } },
      { type: "instance.failed", payload: { nodeKey: "work", error: { reason: "transient" } } },
    ]);

    await expect(advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      maxAttemptsFor: () => 2,
      executor: executor(() => completed({ ok: true })),
    })).resolves.toMatchObject({ status: "idle", started: 1, completed: 1 });

    const projection = store.loadRunSnapshot("run_1").projection;
    expect(projection.instances.work).toMatchObject({ status: "completed", output: { ok: true } });
    expect(Object.values(projection.attempts).filter(attempt => attempt.nodeKey === "work").map(attempt => attempt.status).sort()).toEqual(["completed", "failed", "superseded"]);
  });

  it("stores derived attempt deadlines before executor work starts", async () => {
    const store = new MemorySchedulerStore("run_1", [ready("work", 1)]);

    await expect(advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      now: () => new Date("2026-07-01T00:00:00.000Z"),
      deadlineAtFor: (_instance, _projection, now) => new Date(now.getTime() + 5_000),
      executor: executor(() => completed({ ok: true })),
    })).resolves.toMatchObject({ status: "idle", started: 1, completed: 1 });

    const attempt = Object.values(store.loadRunSnapshot("run_1").projection.attempts).find(attempt => attempt.nodeKey === "work");
    expect(attempt).toMatchObject({ status: "completed", deadlineAt: "2026-07-01T00:00:05.000Z" });
  });
});

class TrackingLimiter {
  active = 0;
  maxActive = 0;

  async add<T>(task: () => Promise<T>): Promise<T> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      return await task();
    } finally {
      this.active -= 1;
    }
  }

  async onIdle(): Promise<void> {}

  clear(): void {}
}

class PausingSerialLimiter {
  private chain = Promise.resolve();
  private completed = 0;

  constructor(private readonly pauseBeforeSecondTask: () => void) {}

  add<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      if (this.completed === 1) this.pauseBeforeSecondTask();
      const result = await task();
      this.completed += 1;
      return result;
    });
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async onIdle(): Promise<void> {
    await this.chain;
  }

  clear(): void {}
}

class MemorySchedulerStore implements SchedulerStorePort {
  claimable = true;
  failCommits = false;
  throwTimedOutCommits = false;
  loadCount = 0;
  private events: SchedulerEvent[];
  private attemptNo = 0;
  private claim: RunOwnerClaim | undefined;

  constructor(private readonly runId: string, events: SchedulerEvent[]) {
    this.events = events;
    this.attemptNo = Math.max(0, ...events.flatMap(event => event.type === "attempt.started" ? [event.payload.attemptNo] : []));
  }

  claimRun(runId: string, ownerId: string, leaseMs: number): RunOwnerClaim | undefined {
    if (!this.claimable) return undefined;
    this.claim = { runId, ownerId, ownerEpoch: 1, leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString() };
    return this.claim;
  }

  heartbeatRun(): boolean {
    return this.claimable;
  }

  releaseRun(claim: RunOwnerClaim): boolean {
    if (this.claim?.ownerEpoch !== claim.ownerEpoch) return false;
    this.claim = undefined;
    return true;
  }

  loadRunSnapshot(runId: string): SchedulerSnapshot {
    this.loadCount += 1;
    return {
      runId,
      version: this.events.length,
      projection: applySchedulerEvents(createSchedulerProjection(runId), this.events),
    };
  }

  appendSchedulerEvents(commit: SchedulerCommit): SchedulerSnapshot {
    if (commit.expectedVersion !== this.events.length) throw new Error("version mismatch");
    this.events.push(...commit.events);
    return this.loadRunSnapshot(commit.runId);
  }

  startAttempt(input: AttemptStartInput): { attemptId: string; attemptNo: number } {
    if (this.loadRunSnapshot(input.runId).projection.run.status === "paused") throw new Error(`Run '${input.runId}' is paused.`);
    this.attemptNo += 1;
    const attemptId = `attempt_${this.attemptNo}`;
    const member = this.loadRunSnapshot(input.runId).projection.groupMembers[input.nodeKey];
    this.events.push(
      { type: "instance.started", payload: { nodeKey: input.nodeKey } },
      ...(member?.status === "ready" ? [{ type: "group.member_started", payload: { memberKey: member.memberKey } } satisfies SchedulerEvent] : []),
      { type: "attempt.started", payload: { runId: input.runId, attemptId, nodeKey: input.nodeKey, nodeId: input.nodeId, attemptNo: this.attemptNo, ownerEpoch: input.ownerEpoch, ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }) } },
    );
    return { attemptId, attemptNo: this.attemptNo };
  }

  commitAttemptResult(input: AttemptCommitInput): SchedulerSnapshot {
    if (this.failCommits) throw new Error("Run 'run_1' scheduler owner epoch is not active.");
    if (this.throwTimedOutCommits) throw new Error(`Attempt '${input.attemptId}' is already timed_out.`);
    const projection = this.loadRunSnapshot(input.runId).projection;
    const attempt = projection.attempts[input.attemptId];
    if (!attempt) throw new Error(`Attempt '${input.attemptId}' was not found.`);
    if (attempt.status !== "started") throw new Error(`Attempt '${input.attemptId}' is already ${attempt.status}.`);
    const member = projection.groupMembers[attempt.nodeKey];
    this.events.push(...attemptResultEvents(input, attempt.nodeKey, member?.status === "running" ? member.memberKey : undefined));
    return this.loadRunSnapshot(input.runId);
  }

  consumeSignal(): SchedulerSnapshot {
    throw new Error("not implemented");
  }

  pauseRun(input: { runId: string; ownerEpoch: number; reason?: string; idempotencyKey: string }): SchedulerSnapshot {
    const snapshot = this.loadRunSnapshot(input.runId);
    if (snapshot.projection.run.status === "paused") return snapshot;
    const events: SchedulerEvent[] = [
      { type: "control.paused", payload: input.reason === undefined ? {} : { reason: input.reason } },
    ];
    for (const attempt of Object.values(snapshot.projection.attempts).filter(attempt => attempt.status === "started")) {
      const instance = snapshot.projection.instances[attempt.nodeKey];
      const member = snapshot.projection.groupMembers[attempt.nodeKey];
      events.push({ type: "attempt.cancelled", payload: { attemptId: attempt.attemptId, cancelReason: "paused" } });
      if (instance?.status === "running" || instance?.status === "awaiting") {
        events.push({ type: "instance.requeued", payload: { nodeKey: instance.nodeKey, reason: "paused", ...(instance.readinessSequence === undefined ? {} : { readinessSequence: instance.readinessSequence }) } });
      }
      if (member?.status === "running") {
        events.push({ type: "group.member_requeued", payload: { memberKey: member.memberKey, reason: "paused", readinessSequence: member.readinessSequence } });
      }
    }
    this.events.push(...events);
    return this.loadRunSnapshot(input.runId);
  }

  resumeRun(input: { runId: string }): SchedulerSnapshot {
    this.events.push({ type: "control.resumed", payload: {} });
    return this.loadRunSnapshot(input.runId);
  }

  retryRun(): SchedulerSnapshot {
    throw new Error("not implemented");
  }

  retry(): SchedulerSnapshot {
    throw new Error("not implemented");
  }

  markExpiredOwnerAttemptsSuperseded(runId: string): SchedulerSnapshot {
    const projection = this.loadRunSnapshot(runId).projection;
    for (const attempt of Object.values(projection.attempts)) {
      if (attempt.status === "started") this.events.push({ type: "attempt.superseded", payload: { attemptId: attempt.attemptId, cancelReason: "superseded" } });
    }
    return this.loadRunSnapshot(runId);
  }
}

function executor(run: (context: NodeAttemptContext) => AttemptCommitInput["result"] | Promise<AttemptCommitInput["result"]>): NodeExecutor {
  return { execute: context => Promise.resolve(run(context)) };
}

function ready(nodeKey: string, readinessSequence: number): SchedulerEvent {
  return {
    type: "instance.ready",
    payload: {
      runId: "run_1",
      nodeKey,
      nodeId: nodeKey,
      instancePath: [{ kind: "node", nodeId: nodeKey }] satisfies InstancePath,
      readinessSequence,
    },
  };
}

function attemptResultEvents(input: AttemptCommitInput, nodeKey: string, memberKey?: string): SchedulerEvent[] {
  if (input.result.status === "completed") {
    return [
      { type: "attempt.completed", payload: { attemptId: input.attemptId, ...(input.result.output === undefined ? {} : { result: input.result.output }) } },
      { type: "instance.completed", payload: { nodeKey, acceptedAttemptId: input.attemptId, ...(input.result.output === undefined ? {} : { output: input.result.output }) } },
      ...(memberKey ? [{ type: "group.member_completed", payload: { memberKey, completionSequence: input.attemptId.length, ...(input.result.output === undefined ? {} : { output: input.result.output }) } } satisfies SchedulerEvent] : []),
    ];
  }
  if (input.result.status === "cancelled") {
    return [
      { type: "attempt.cancelled", payload: { attemptId: input.attemptId, cancelReason: input.result.reason } },
      { type: "instance.cancelled", payload: { nodeKey, cancelReason: input.result.reason } },
      ...(memberKey ? [{ type: "group.member_cancelled", payload: { memberKey, cancelReason: input.result.reason } } satisfies SchedulerEvent] : []),
    ];
  }
  const error = { reason: input.result.reason } as Record<string, JsonValue>;
  return [
    { type: input.result.status === "timed_out" ? "attempt.timed_out" : "attempt.failed", payload: { attemptId: input.attemptId, error } },
    { type: "instance.failed", payload: { nodeKey, error, ...(input.result.status === "timed_out" ? { statusReason: "timed_out" } : {}) } },
    ...(memberKey ? [{ type: "group.member_failed", payload: { memberKey, error, terminalReason: input.result.status === "timed_out" ? "timed_out" : input.result.reason } } satisfies SchedulerEvent] : []),
  ];
}
