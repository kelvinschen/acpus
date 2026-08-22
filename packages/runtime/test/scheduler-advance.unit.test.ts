import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "@effect/vitest";
import type { JsonValue } from "@acpus/expression/ir";
import { advanceRun as advanceRunEffect, type NodeAttemptContext, type NodeExecutor, type SchedulerExecutionStore } from "../src/scheduler/advance.js";
import { advanceRun } from "./support/effect-scheduler.js";
import type { SchedulerEvent } from "../src/scheduler/events.js";
import { SchedulerStoreException, type AttemptCommitInput, type AttemptStartInput, type AttemptStartResult, type RunOwnerClaim, type SchedulerCommit, type SchedulerRecoveryInput, type SchedulerSnapshot, type SchedulerStoreError } from "../src/scheduler/store-port.js";
import { applySchedulerEvents, createSchedulerProjection } from "../src/scheduler/transitions.js";
import type { InstancePath } from "../src/scheduler/types.js";
import { createVersionedWakeup } from "../src/scheduler/wakeup.js";
import { completed } from "./support/scheduler.js";

describe("scheduler advance loop", () => {
  it("applies bootstrap events once before scheduling", async () => {
    const store = new MemorySchedulerStore([]);
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

  it("reloads a stale admission plan without invoking the executor", async () => {
    const store = new StaleAdmissionSchedulerStore([ready("work", 1)]);
    const calls: string[] = [];

    const result = await advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      executor: executor(context => {
        calls.push(context.nodeKey);
        return completed();
      }),
    });

    expect(result).toMatchObject({ status: "paused", started: 0 });
    expect(store.startCalls).toBe(1);
    expect(calls).toEqual([]);
  });

  it("refills a free slot before an unrelated slow attempt settles", async () => {
    const store = new MemorySchedulerStore([
      ready("slow", 1),
      ready("short", 2),
      ready("next", 3),
    ]);
    const calls: string[] = [];
    let releaseSlow!: () => void;
    let slowReleased = false;
    const slow = new Promise<void>(resolve => {
      releaseSlow = () => {
        slowReleased = true;
        resolve();
      };
    });

    const advancing = advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      maxLeafConcurrency: 2,
      executor: executor(async context => {
        calls.push(context.nodeKey);
        if (context.nodeKey === "slow") await slow;
        return completed();
      }),
    });

    try {
      await waitUntil(() => calls.includes("next"));
      expect(calls).toEqual(["slow", "short", "next"]);
      expect(slowReleased).toBe(false);
    } finally {
      releaseSlow();
    }
    await expect(advancing).resolves.toMatchObject({ started: 3, completed: 3 });
  });

  it("keeps a durably cancelled but unsettled executor in the physical cap", async () => {
    const store = new MemorySchedulerStore([ready("stuck", 1), ready("next", 2)]);
    const wakeup = createVersionedWakeup();
    const calls: string[] = [];
    let releaseStuck!: () => void;
    let markCancellationObserved!: () => void;
    const stuck = new Promise<void>(resolve => {
      releaseStuck = resolve;
    });
    const cancellationObserved = new Promise<void>(resolve => {
      markCancellationObserved = resolve;
    });
    const advancing = advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      wakeup,
      maxLeafConcurrency: 1,
      onCheckpoint: snapshot => Effect.sync(() => {
        if (snapshot.projection.instances.stuck?.status === "cancelled") markCancellationObserved();
      }),
      executor: executor(context => {
        calls.push(context.nodeKey);
        if (context.nodeKey === "stuck") {
          return Effect.never.pipe(
            Effect.onInterrupt(() => Effect.promise(() => stuck)),
          );
        }
        return completed();
      }),
    });

    await waitUntil(() => calls.length === 1);
    const snapshot = store.loadRunSnapshot("run_1");
    const attempt = Object.values(snapshot.projection.attempts).find(candidate => candidate.nodeKey === "stuck")!;
    store.appendSchedulerEvents({
      runId: "run_1",
      ownerEpoch: 1,
      expectedVersion: snapshot.version,
      idempotencyKey: "cancel-stuck",
      events: [
        { type: "attempt.cancelled", payload: { attemptId: attempt.attemptId, cancelReason: "parent_failed" } },
        { type: "instance.cancelled", payload: { nodeKey: "stuck", cancelReason: "parent_failed" } },
      ],
    });
    wakeup.wake();
    await cancellationObserved;
    expect(calls).toEqual(["stuck"]);

    releaseStuck();
    await waitUntil(() => calls.includes("next"));
    await expect(advancing).resolves.toMatchObject({ started: 2, completed: 1, cancelled: 1 });
  });

  it("waits for a fenced session executor to settle while admitting an unrelated session", async () => {
    const store = new MemorySchedulerStore([ready("shared", 1), ready("other", 2)]);
    const wakeup = createVersionedWakeup();
    const calls: string[] = [];
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>(resolve => {
      releaseCleanup = resolve;
    });
    let markOtherStarted!: () => void;
    const otherStarted = new Promise<void>(resolve => {
      markOtherStarted = resolve;
    });
    let sharedCalls = 0;
    const advancing = advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      wakeup,
      maxLeafConcurrency: 2,
      executorResourceFor: instance => instance.nodeKey === "shared" ? "agent-session:shared" : `agent-session:${instance.nodeKey}`,
      executor: executor(context => {
        calls.push(context.nodeKey);
        if (context.nodeKey !== "shared") {
          markOtherStarted();
          return completed();
        }
        sharedCalls += 1;
        if (sharedCalls > 1) return completed();
        const snapshot = store.loadRunSnapshot("run_1");
        store.appendSchedulerEvents({
          runId: "run_1",
          ownerEpoch: 1,
          expectedVersion: snapshot.version,
          idempotencyKey: "fence-shared",
          events: [
            { type: "attempt.superseded", payload: { attemptId: context.attemptId, cancelReason: "superseded" } },
            { type: "instance.requeued", payload: { nodeKey: context.nodeKey, reason: "superseded", readinessSequence: 1 } },
          ],
        });
        wakeup.wake();
        return Effect.never.pipe(
          Effect.onInterrupt(() => Effect.promise(() => cleanup)),
        );
      }),
    });

    try {
      await otherStarted;
      expect(calls).toEqual(["shared", "other"]);
    } finally {
      releaseCleanup();
    }
    await expect(advancing).resolves.toMatchObject({ started: 3, completed: 2, cancelled: 1 });
    expect(calls).toEqual(["shared", "other", "shared"]);
  });

  it("admits a Signal wait while the run leaf cap is full", async () => {
    const store = new MemorySchedulerStore([ready("slow", 1), ready("approval", 2, "signal")]);
    let releaseSlow!: () => void;
    const slow = new Promise<void>(resolve => {
      releaseSlow = resolve;
    });
    const advancing = advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      maxLeafConcurrency: 1,
      signalNodeIds: new Set(["signal"]),
      awaitableEventsFor: instance => [
        { type: "instance.awaiting", payload: { nodeKey: instance.nodeKey, statusReason: "signal" } },
        { type: "signal.awaiting", payload: { runId: "run_1", nodeKey: instance.nodeKey, nodeId: instance.nodeId } },
      ],
      executor: executor(async () => {
        await slow;
        return completed();
      }),
    });

    await waitUntil(() => store.loadRunSnapshot("run_1").projection.instances.approval?.status === "awaiting");
    const concurrent = store.loadRunSnapshot("run_1").projection;
    expect(concurrent.attempts.attempt_1).toMatchObject({ status: "started" });
    expect(concurrent.signalWaits.approval).toMatchObject({ status: "awaiting" });
    releaseSlow();
    await expect(advancing).resolves.toMatchObject({ status: "awaiting", started: 1, completed: 1 });
  });

  it.effect("wakes for a Signal deadline while an unrelated executor is still active", () => Effect.gen(function* () {
    yield* TestClock.setTime(new Date("2026-07-01T00:00:00.000Z").getTime());
    const store = new MemorySchedulerStore([ready("slow", 1), ready("approval", 2, "signal")]);
    const advancing = yield* Effect.forkChild(advanceRunEffect({
        runId: "run_1",
        ownerId: "owner-a",
        store,
        maxLeafConcurrency: 1,
        signalNodeIds: new Set(["signal"]),
        awaitableEventsFor: (instance, _projection, now) => [
          { type: "instance.awaiting", payload: { nodeKey: instance.nodeKey, statusReason: "signal" } },
          { type: "signal.awaiting", payload: { runId: "run_1", nodeKey: instance.nodeKey, nodeId: instance.nodeId, deadlineAt: new Date(now.getTime() + 1_000).toISOString() } },
        ],
        executor: executor(() => Effect.sleep(2_000).pipe(Effect.as(completed()))),
      }));

    yield* Effect.yieldNow;
    expect(store.loadRunSnapshot("run_1").projection.signalWaits.approval).toMatchObject({ status: "awaiting" });
    yield* TestClock.adjust(1_000);
    expect(store.loadRunSnapshot("run_1").projection.signalWaits.approval).toMatchObject({ status: "timed_out" });
    expect(store.loadRunSnapshot("run_1").projection.attempts.attempt_1).toMatchObject({ status: "started" });
    yield* TestClock.adjust(1_000);
    expect(yield* Fiber.join(advancing)).toMatchObject({ status: "idle", started: 1, completed: 1 });
  }));

  it.effect("wakes for an active attempt deadline using the nearest durable timer", () => Effect.gen(function* () {
    yield* TestClock.setTime(new Date("2026-07-01T00:00:00.000Z").getTime());
    const store = new MemorySchedulerStore([ready("work", 1)]);
    const advancing = yield* Effect.forkChild(advanceRunEffect({
        runId: "run_1",
        ownerId: "owner-a",
        store,
        deadlineAtFor: (_instance, _projection, now) => Result.succeed(new Date(now.getTime() + 1_000)),
        executor: executor(() => Effect.never),
      }));

    yield* Effect.yieldNow;
    expect(store.loadRunSnapshot("run_1").projection.attempts.attempt_1).toMatchObject({ status: "started" });

    yield* TestClock.adjust(1_000);
    expect(yield* Fiber.join(advancing)).toMatchObject({ status: "idle", started: 1, failed: 1 });
    expect(store.loadRunSnapshot("run_1").projection.attempts.attempt_1).toMatchObject({ status: "timed_out" });
  }));

  it("fails custom executor attempts when output is not workflow-admissible", async () => {
    const store = new MemorySchedulerStore([ready("bad", 1)]);

    const result = await advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      executor: executor(() => completed({ when: new Date() } as unknown as JsonValue)),
    });

    expect(result).toMatchObject({ status: "idle", started: 1, failed: 1 });
    expect(store.loadRunSnapshot("run_1").projection.instances.bad).toMatchObject({
      status: "failed",
      error: { reason: "Node 'bad' output is not workflow-admissible: $.when is Date." },
    });
  });

  it("propagates an unexpected executor rejection without committing a workflow failure", async () => {
    const store = new MemorySchedulerStore([ready("broken", 1)]);
    const sentinel = { type: "invariant", message: "executor invariant failed" };

    await expect(advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      executor: { execute: () => Effect.die(sentinel) },
    })).rejects.toBe(sentinel);

    expect(store.loadRunSnapshot("run_1").projection.instances.broken).toMatchObject({ status: "running" });
    expect(store.loadRunSnapshot("run_1").projection.attempts.attempt_1).toMatchObject({ status: "started" });
    expect(store.releaseCount).toBe(1);
  });

  it("preserves execution and lease-release failures in the final Cause", async () => {
    const store = new MemorySchedulerStore([ready("broken", 1)]);
    const executionFailure = { type: "executor-invariant" };
    const releaseFailure = { type: "release-invariant" };
    store.releaseFailure = releaseFailure;
    const exit = await Effect.runPromiseExit(advanceRunEffect({
        runId: "run_1",
        ownerId: "owner-a",
        store,
        executor: { execute: () => Effect.die(executionFailure) },
      }));

    expect(exit).toEqual(Exit.failCause(Cause.combine(
      Cause.die(executionFailure),
      Cause.die(releaseFailure),
    )));
    expect(store.loadRunSnapshot("run_1").projection.instances.broken).toMatchObject({ status: "running" });
  });

  it("returns paused, awaiting, and lease-lost summaries without starting work", async () => {
    const paused = new MemorySchedulerStore([{ type: "control.paused", payload: {} }, ready("blocked", 1)]);
    const awaiting = new MemorySchedulerStore([{ type: "signal.awaiting", payload: { runId: "awaiting", nodeKey: "approve", nodeId: "approve" } }]);
    const leaseLost = new MemorySchedulerStore([ready("work", 1)]);
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

  it("does not treat an orphan awaiting instance as a durable wake source", async () => {
    const store = new MemorySchedulerStore([
      ready("orphan", 1),
      { type: "instance.awaiting", payload: { nodeKey: "orphan", statusReason: "signal" } },
    ]);

    await expect(advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      executor: executor(() => completed()),
    })).resolves.toMatchObject({ status: "idle", started: 0 });
  });

  it.effect("does not admit work after its owning Fiber is interrupted at a checkpoint", () => Effect.gen(function* () {
    const store = new MemorySchedulerStore([ready("work", 1)]);
    const calls: string[] = [];
    let checkpoints = 0;
    const reached = yield* Deferred.make<void>();

    const advancing = yield* Effect.forkChild(advanceRunEffect({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      onCheckpoint: () => Effect.gen(function* () {
        checkpoints += 1;
        if (checkpoints !== 2) return;
        yield* Deferred.succeed(reached, undefined);
        yield* Effect.never;
      }),
      executor: executor(context => {
        calls.push(context.nodeKey);
        return completed();
      }),
    }));

    yield* Deferred.await(reached);
    yield* Fiber.interrupt(advancing);
    const exit = yield* Fiber.await(advancing);
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(calls).toEqual([]);
    expect(store.releaseCount).toBe(1);
  }));

  it("aborts active work when pause requeues the running instance", async () => {
    const store = new MemorySchedulerStore([ready("work", 1)]);
    const wakeup = createVersionedWakeup();
    let aborted = false;

    const result = await advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      wakeup,
      executor: executor(() => {
        setTimeout(() => {
          store.pauseRun({ runId: "run_1", ownerEpoch: 1, idempotencyKey: "pause-active" });
          wakeup.wake();
        }, 0);
        return Effect.never.pipe(
          Effect.onInterrupt(() => Effect.sync(() => {
            aborted = true;
          })),
        );
      }),
    });

    expect(aborted).toBe(true);
    expect(result).toMatchObject({ status: "paused", started: 1, cancelled: 1 });
  });

  it.effect("renews the run lease while leaf work is active", () => Effect.gen(function* () {
    const store = new MemorySchedulerStore([ready("work", 1)]);

    const advancing = yield* Effect.forkChild(advanceRunEffect({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      leaseMs: 3_000,
      executor: executor(() => Effect.sleep(2_500).pipe(Effect.as(completed()))),
    }));

    yield* Effect.yieldNow;
    expect(store.heartbeatCount).toBe(0);
    yield* TestClock.adjust(1_000);
    expect(store.heartbeatCount).toBe(1);
    yield* TestClock.adjust(1_000);
    expect(store.heartbeatCount).toBe(2);
    yield* TestClock.adjust(500);
    const result = yield* Fiber.join(advancing);
    expect(result).toMatchObject({ status: "idle", started: 1, completed: 1 });
    expect(store.heartbeatCount).toBeGreaterThanOrEqual(2);
  }));

  it.effect("does not drain derived transitions after heartbeat lease loss", () => Effect.gen(function* () {
    const store = new MemorySchedulerStore([ready("work", 1)]);
    store.failHeartbeatAfter = 0;

    const advancing = yield* Effect.forkChild(advanceRunEffect({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      leaseMs: 3_000,
      executor: executor(() => Effect.never),
      materialize: () => {
        if (store.heartbeatCount > 1) throw new Error("materialize called after lease loss");
        return [];
      },
    }));

    yield* Effect.yieldNow;
    yield* TestClock.adjust(1_000);
    const result = yield* Fiber.join(advancing);
    expect(result).toMatchObject({ status: "lease_lost", started: 1 });
  }));

  it.effect("treats a heartbeat defect as lease loss and interrupts active work", () => Effect.gen(function* () {
    const store = new MemorySchedulerStore([ready("work", 1)]);
    store.heartbeatFailure = new Error("heartbeat failed");
    let interrupted = false;

    const advancing = yield* Effect.forkChild(advanceRunEffect({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      leaseMs: 3_000,
      executor: executor(() => Effect.never.pipe(
        Effect.onInterrupt(() => Effect.sync(() => {
          interrupted = true;
        })),
      )),
    }));

    yield* Effect.yieldNow;
    yield* TestClock.adjust(1_000);
    const result = yield* Fiber.join(advancing);

    expect(interrupted).toBe(true);
    expect(result).toMatchObject({ status: "lease_lost", started: 1 });
    expect(store.releaseCount).toBe(1);
  }));

  it("continues beyond 1000 progressing derived batches and yields cooperatively", async () => {
    const store = new CachedProjectionSchedulerStore([
      { type: "frame.started", payload: { runId: "run_1", frameKey: "loop", frameKind: "loop" } },
      { type: "frame.loop_advanced", payload: { frameKey: "loop", iter: 0, state: 0, transition: { state: 1, stop: false } } },
    ]);
    let yielded = false;
    setImmediate(() => {
      yielded = true;
    });

    const result = await advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      executor: executor(() => completed()),
      materialize: snapshot => {
        const iteration = snapshot.projection.frames.loop?.loop?.iter;
        if (iteration === undefined || iteration >= 1_001) return [];
        const next = iteration + 1;
        return [{
          type: "frame.loop_advanced",
          payload: { frameKey: "loop", iter: next, state: next, transition: { state: next + 1, stop: false } },
        }];
      },
    });

    expect(result).toMatchObject({ status: "idle", started: 0 });
    expect(store.loadRunSnapshot("run_1").projection.frames.loop?.loop?.iter).toBe(1_001);
    expect(yielded).toBe(true);
  });

  it("reloads after a wake arrives during a derived-drain yield", async () => {
    const store = new MemorySchedulerStore([
      { type: "frame.started", payload: { runId: "run_1", frameKey: "loop", frameKind: "loop" } },
      { type: "frame.loop_advanced", payload: { frameKey: "loop", iter: 0, state: 0, transition: { state: 1, stop: false } } },
      ready("seed", 1),
    ]);
    const wakeup = createVersionedWakeup();
    const calls: string[] = [];
    setImmediate(() => {
      const snapshot = store.loadRunSnapshot("run_1");
      store.appendSchedulerEvents({
        runId: "run_1",
        expectedVersion: snapshot.version,
        ownerEpoch: 1,
        idempotencyKey: "ready-after-yield",
        events: [ready("after-yield", 1)],
      });
      wakeup.wake();
    });

    const result = await advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      wakeup,
      executor: executor(context => {
        calls.push(context.nodeKey);
        return completed();
      }),
      materialize: snapshot => {
        if (snapshot.projection.instances.seed?.status !== "completed") return [];
        const iteration = snapshot.projection.frames.loop?.loop?.iter;
        if (iteration === undefined || iteration >= 256) return [];
        const next = iteration + 1;
        return [{
          type: "frame.loop_advanced",
          payload: { frameKey: "loop", iter: next, state: next, transition: { state: next + 1, stop: false } },
        }];
      },
    });

    expect(result).toMatchObject({ status: "idle", started: 2, completed: 2 });
    expect(calls).toEqual(["seed", "after-yield"]);
  });

  it.effect("interrupts a long derived drain at its cooperative checkpoint", () => Effect.gen(function* () {
    const store = new CachedProjectionSchedulerStore([
      { type: "frame.started", payload: { runId: "run_1", frameKey: "loop", frameKind: "loop" } },
      { type: "frame.loop_advanced", payload: { frameKey: "loop", iter: 0, state: 0, transition: { state: 1, stop: false } } },
      ready("work", 1),
    ]);
    let aborted = false;
    let checkpointBlocked = false;
    const reached = yield* Deferred.make<void>();

    const advancing = yield* Effect.forkChild(advanceRunEffect({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      executor: executor(() => {
        return Effect.never.pipe(
          Effect.onInterrupt(() => Effect.sync(() => {
            aborted = true;
          })),
        );
      }),
      onCheckpoint: snapshot => {
        const iteration = snapshot.projection.frames.loop?.loop?.iter ?? 0;
        if (checkpointBlocked || snapshot.projection.attempts.attempt_1?.status !== "started" || iteration < 64) {
          return Effect.void;
        }
        checkpointBlocked = true;
        return Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never));
      },
      materialize: snapshot => {
        if (snapshot.projection.attempts.attempt_1?.status !== "started") return [];
        const iteration = snapshot.projection.frames.loop?.loop?.iter;
        if (iteration === undefined || iteration >= 1_001) return [];
        const next = iteration + 1;
        return [{
          type: "frame.loop_advanced",
          payload: { frameKey: "loop", iter: next, state: next, transition: { state: next + 1, stop: false } },
        }];
      },
    }));

    yield* Deferred.await(reached);
    yield* Fiber.interrupt(advancing);
    const exit = yield* Fiber.await(advancing);
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(aborted).toBe(true);
    const iteration = store.loadRunSnapshot("run_1").projection.frames.loop?.loop?.iter;
    expect(iteration).toBeGreaterThanOrEqual(64);
    expect(iteration).toBeLessThanOrEqual(256);
    expect(store.releaseCount).toBe(1);
  }));

  it("waits for executor cleanup when its owning Fiber is interrupted inside a derived drain", async () => {
    const store = new CachedProjectionSchedulerStore([
      { type: "frame.started", payload: { runId: "run_1", frameKey: "loop", frameKind: "loop" } },
      { type: "frame.loop_advanced", payload: { frameKey: "loop", iter: 0, state: 0, transition: { state: 1, stop: false } } },
      ready("work", 1),
    ]);
    let markAborted!: () => void;
    let finishCleanup!: () => void;
    const aborted = new Promise<void>(resolve => {
      markAborted = resolve;
    });
    const cleanup = new Promise<void>(resolve => {
      finishCleanup = resolve;
    });
    let markExecutorStarted!: () => void;
    const executorStarted = new Promise<void>(resolve => {
      markExecutorStarted = resolve;
    });
    let markDrainReached!: () => void;
    const drainReached = new Promise<void>(resolve => {
      markDrainReached = resolve;
    });
    let checkpointBlocked = false;
    let settled = false;
    const advancing = Effect.runFork(advanceRunEffect({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      executor: executor(() => Effect.sync(markExecutorStarted).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Effect.sync(markAborted).pipe(
          Effect.andThen(Effect.promise(() => cleanup)),
        )),
      )),
      onCheckpoint: snapshot => {
        const iteration = snapshot.projection.frames.loop?.loop?.iter ?? 0;
        if (checkpointBlocked || snapshot.projection.attempts.attempt_1?.status !== "started" || iteration < 1) {
          return Effect.void;
        }
        checkpointBlocked = true;
        return Effect.sync(markDrainReached).pipe(Effect.andThen(Effect.never));
      },
      materialize: snapshot => {
        if (snapshot.projection.attempts.attempt_1?.status !== "started") return [];
        const iteration = snapshot.projection.frames.loop?.loop?.iter;
        if (iteration === undefined || iteration >= 1_001) return [];
        const next = iteration + 1;
        return [{
          type: "frame.loop_advanced",
          payload: { frameKey: "loop", iter: next, state: next, transition: { state: next + 1, stop: false } },
        }];
      },
    }));

    await executorStarted;
    await drainReached;
    const interruption = Effect.runPromise(Fiber.interrupt(advancing).pipe(
      Effect.andThen(Fiber.await(advancing)),
    )).then(exit => {
      settled = true;
      return exit;
    });

    await aborted;
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(store.releaseCount).toBe(0);
    finishCleanup();
    const exit = await interruption;
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(store.releaseCount).toBe(1);
  });

  it("holds the owner lease until an aborted executor finishes cleanup after a scheduler failure", async () => {
    const store = new MemorySchedulerStore([ready("work", 1)]);
    const wakeup = createVersionedWakeup();
    let markAborted!: () => void;
    let finishCleanup!: () => void;
    const aborted = new Promise<void>(resolve => {
      markAborted = resolve;
    });
    const cleanup = new Promise<void>(resolve => {
      finishCleanup = resolve;
    });
    let executorStarted = false;
    const advancing = advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      wakeup,
      executor: executor(() => Effect.sync(() => {
        executorStarted = true;
        wakeup.wake();
      }).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Effect.sync(markAborted).pipe(
          Effect.andThen(Effect.promise(() => cleanup)),
        )),
      )),
      materialize: snapshot => {
        if (executorStarted && snapshot.projection.attempts.attempt_1?.status === "started") throw new Error("materialization failed");
        return [];
      },
    });
    const failure = advancing.catch(error => error);

    await aborted;
    expect(store.releaseCount).toBe(0);
    finishCleanup();
    await expect(failure).resolves.toEqual(new Error("materialization failed"));
    expect(store.releaseCount).toBe(1);
  });

  it("waits for owned executor cleanup after the owner lease is lost", async () => {
    const store = new MemorySchedulerStore([
      { type: "frame.started", payload: { runId: "run_1", frameKey: "loop", frameKind: "loop" } },
      { type: "frame.loop_advanced", payload: { frameKey: "loop", iter: 0, state: 0, transition: { state: 1, stop: false } } },
      ready("work", 1),
    ]);
    store.failHeartbeatAfter = 0;
    const wakeup = createVersionedWakeup();
    let markAborted!: () => void;
    let finishCleanup!: () => void;
    const aborted = new Promise<void>(resolve => {
      markAborted = resolve;
    });
    const cleanup = new Promise<void>(resolve => {
      finishCleanup = resolve;
    });
    let executorStarted = false;
    let settled = false;
    const advancing = advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      wakeup,
      executor: executor(() => Effect.sync(() => {
        executorStarted = true;
        wakeup.wake();
      }).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Effect.sync(markAborted).pipe(
          Effect.andThen(Effect.promise(() => cleanup)),
        )),
      )),
      materialize: snapshot => executorStarted && snapshot.projection.attempts.attempt_1?.status === "started"
        ? [{ type: "frame.loop_advanced", payload: { frameKey: "loop", iter: 1, state: 1, transition: { state: 2, stop: false } } }]
        : [],
    }).then(result => {
      settled = true;
      return result;
    });

    await aborted;
    await Promise.resolve();
    expect(settled).toBe(false);
    finishCleanup();
    await expect(advancing).resolves.toMatchObject({ status: "lease_lost", started: 1 });
    expect(settled).toBe(true);
  });

  it("yields cooperatively across 1001 sequential synchronous leaves", async () => {
    const store = new CompactSequentialSchedulerStore([ready("work", 1)]);
    let yielded = false;
    let completedLeaves = 0;
    setImmediate(() => {
      yielded = true;
    });

    const result = await advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      maxLeafConcurrency: 1,
      executor: executor(() => {
        completedLeaves += 1;
        return completed();
      }),
      materialize: snapshot => {
        if (completedLeaves === 0 || completedLeaves >= 1_001 || snapshot.projection.instances.work) return [];
        return [ready("work", completedLeaves + 1)];
      },
    });

    expect(result).toMatchObject({ status: "idle", started: 1_001, completed: 1_001 });
    expect(completedLeaves).toBe(1_001);
    expect(yielded).toBe(true);
  });

  it("marks paused requeued work as pause_resume when it restarts", async () => {
    const store = new MemorySchedulerStore([ready("work", 1)]);
    const wakeup = createVersionedWakeup();
    const reasons: Array<NodeAttemptContext["attemptStartReason"]> = [];
    let shouldPause = true;

    const nodeExecutor = executor(context => {
      reasons.push(context.attemptStartReason);
      if (!shouldPause) return completed({ ok: true });
      shouldPause = false;
      return Effect.suspend(() => {
        setTimeout(() => {
          store.pauseRun({ runId: "run_1", ownerEpoch: 1, idempotencyKey: "pause-active" });
          wakeup.wake();
        }, 0);
        return Effect.never;
      });
    });

    await expect(advanceRun({ runId: "run_1", ownerId: "owner-a", store, wakeup, executor: nodeExecutor })).resolves.toMatchObject({ status: "paused", started: 1, cancelled: 1 });
    store.resumeRun({ runId: "run_1" });
    await expect(advanceRun({ runId: "run_1", ownerId: "owner-b", store, executor: nodeExecutor })).resolves.toMatchObject({ status: "idle", started: 1, completed: 1 });

    expect(reasons).toEqual([undefined, "pause_resume"]);
  });

  it("uses a fresh store snapshot on each advance call", async () => {
    const store = new MemorySchedulerStore([ready("one", 1)]);
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
    const store = new MemorySchedulerStore([ready("work", 1)]);
    store.failCommits = true;

    await expect(advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      executor: executor(() => completed()),
    })).resolves.toMatchObject({ status: "lease_lost", started: 1 });
  });

  it("supersedes started attempts from expired owners before scheduling", async () => {
    const store = new MemorySchedulerStore([
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
    const store = new MemorySchedulerStore([
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
    });

    const projection = store.loadRunSnapshot("run_1").projection;
    expect(projection.attempts.old_attempt).toMatchObject({ status: "timed_out" });
    expect(projection.instances.old).toMatchObject({ status: "failed", statusReason: "timed_out" });
  });

  it("drains expired attempt deadlines before returning idle", async () => {
    const store = new MemorySchedulerStore([
      ready("work", 1),
      { type: "instance.started", payload: { nodeKey: "work" } },
      { type: "attempt.started", payload: { runId: "run_1", attemptId: "attempt_1", nodeKey: "work", nodeId: "work", attemptNo: 1, ownerEpoch: 1, deadlineAt: "2026-06-30T00:00:00.000Z" } },
    ]);

    const result = await advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      executor: executor(() => completed()),
    });

    const projection = store.loadRunSnapshot("run_1").projection;
    expect(result).toMatchObject({ status: "idle", started: 0 });
    expect(projection.attempts.attempt_1).toMatchObject({ status: "timed_out", terminalReason: "timed_out" });
    expect(projection.instances.work).toMatchObject({ status: "failed", statusReason: "timed_out" });
  });

  it("treats late commits after durable timeout as stale terminal results", async () => {
    const store = new MemorySchedulerStore([ready("work", 1)]);
    store.throwTimedOutCommits = true;

    await expect(advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      executor: executor(() => completed({ late: true })),
    })).resolves.toMatchObject({ status: "idle", started: 1, failed: 1 });
  });

  it("drains group cancellation before overlapping attempt timeouts", async () => {
    const store = new MemorySchedulerStore([
      { type: "frame.started", payload: { runId: "run_1", frameKey: "race", frameKind: "node", nodeKey: "race", nodeId: "race", strategy: "race" } },
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
    });

    const projection = store.loadRunSnapshot("run_1").projection;
    expect(projection.attempts.loser_attempt).toMatchObject({ status: "cancelled", cancelReason: "race_lost" });
    expect(projection.instances.loser).toMatchObject({ status: "cancelled", statusReason: "race_lost" });
    expect(projection.groupMembers.loser).toMatchObject({ status: "cancelled", terminalReason: "race_lost" });
  });

  it("drains group terminal events before starting loser work", async () => {
    const store = new MemorySchedulerStore([
      { type: "frame.started", payload: { runId: "run_1", frameKey: "race", frameKind: "node", nodeKey: "race", nodeId: "race", strategy: "race" } },
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
    });

    const projection = store.loadRunSnapshot("run_1").projection;
    expect(calls).toEqual([]);
    expect(projection.groups.race).toMatchObject({ status: "completed" });
    expect(projection.groupMembers.loser).toMatchObject({ status: "cancelled", terminalReason: "race_lost" });
  });

  it("aborts active race losers after a winner commits", async () => {
    const store = new MemorySchedulerStore([
      { type: "frame.started", payload: { runId: "run_1", frameKey: "race", frameKind: "node", nodeKey: "race", nodeId: "race", strategy: "race" } },
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
        return Effect.suspend(() => {
          markLoserStarted();
          return Effect.never.pipe(
            Effect.onInterrupt(() => Effect.sync(() => {
              loserAborted = true;
            })),
          );
        });
      }),
    });

    const projection = store.loadRunSnapshot("run_1").projection;
    expect(loserAborted).toBe(true);
    expect(projection.groupMembers.winner).toMatchObject({ status: "completed" });
    expect(projection.groupMembers.loser).toMatchObject({ status: "cancelled", terminalReason: "race_lost" });
  });

  it("leaves a failed leaf and its group failed without an explicit retry", async () => {
    const store = new MemorySchedulerStore([
      { type: "frame.started", payload: { runId: "run_1", frameKey: "all", frameKind: "node", nodeKey: "all", nodeId: "all", strategy: "all" } },
      { type: "group.started", payload: { runId: "run_1", groupKey: "all", nodeKey: "all", nodeId: "all", kind: "parallel", strategy: "all" } },
      { type: "group.member_ready", payload: { runId: "run_1", groupKey: "all", memberKey: "work", memberKind: "branch", branchId: "left", readinessSequence: 1 } },
      ready("work", 1),
    ]);
    let calls = 0;
    const input = {
      runId: "run_1",
      ownerId: "owner-a",
      store,
      executor: executor(() => {
        calls += 1;
        return { status: "failed" as const, reason: "transient" };
      }),
    };

    await expect(advanceRun(input)).resolves.toMatchObject({ status: "idle", started: 1, failed: 1 });
    const projection = store.loadRunSnapshot("run_1").projection;
    expect(projection.instances.work).toMatchObject({ status: "failed" });
    expect(projection.groupMembers.work).toMatchObject({ status: "failed" });
    expect(projection.groups.all).toMatchObject({ status: "failed" });
    await expect(advanceRun(input)).resolves.toMatchObject({ status: "idle", started: 0 });
    expect(calls).toBe(1);
  });

  it("does not start recovered work while paused", async () => {
    const store = new MemorySchedulerStore([
      { type: "control.paused", payload: {} },
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
    expect(projection.attempts.old_attempt).toMatchObject({ status: "superseded" });
    expect(projection.instances.new).toMatchObject({ status: "ready" });
  });

  it("stores derived attempt deadlines before executor work starts", async () => {
    const store = new MemorySchedulerStore([ready("work", 1)]);
    let authoredAt: Date | undefined;

    await expect(advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      deadlineAtFor: (_instance, _projection, now) => {
        authoredAt = now;
        return Result.succeed(new Date(now.getTime() + 5_000));
      },
      executor: executor(() => completed({ ok: true })),
    })).resolves.toMatchObject({ status: "idle", started: 1, completed: 1 });

    const attempt = Object.values(store.loadRunSnapshot("run_1").projection.attempts).find(attempt => attempt.nodeKey === "work");
    expect(attempt).toMatchObject({
      status: "completed",
      deadlineAt: new Date(authoredAt!.getTime() + 5_000).toISOString(),
    });
  });

  it("commits deadline derivation failures without invoking the executor", async () => {
    const store = new MemorySchedulerStore([ready("work", 1)]);
    let executed = false;
    const error = { reason: "expression_resolution_failed", type: "constraint", field: "Task node 'work' timeout" };

    await expect(advanceRun({
      runId: "run_1",
      ownerId: "owner-a",
      store,
      deadlineAtFor: () => Result.fail({ status: "failed", reason: "unsupported deadline", error }),
      executor: executor(() => {
        executed = true;
        return completed();
      }),
    })).resolves.toMatchObject({ status: "idle", started: 1, failed: 1 });

    expect(executed).toBe(false);
    const attempt = Object.values(store.loadRunSnapshot("run_1").projection.attempts).find(attempt => attempt.nodeKey === "work");
    expect(attempt).toMatchObject({ status: "failed", error });
  });
});

class MemorySchedulerStore implements SchedulerExecutionStore {
  claimable = true;
  heartbeatCount = 0;
  failHeartbeatAfter: number | undefined;
  heartbeatFailure: unknown = undefined;
  failCommits = false;
  throwTimedOutCommits = false;
  loadCount = 0;
  releaseCount = 0;
  releaseFailure: unknown = undefined;
  private events: SchedulerEvent[];
  private attemptNo = 0;
  private claim: RunOwnerClaim | undefined;

  constructor(events: SchedulerEvent[]) {
    this.events = events;
    this.attemptNo = Math.max(0, ...events.flatMap(event => event.type === "attempt.started" ? [event.payload.attemptNo] : []));
  }

  claimRun(runId: string, ownerId: string, leaseMs: number): RunOwnerClaim | undefined {
    if (!this.claimable) return undefined;
    this.claim = { runId, ownerId, ownerEpoch: 1, leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString() };
    return this.claim;
  }

  heartbeatRun(): boolean {
    this.heartbeatCount += 1;
    if (this.heartbeatFailure !== undefined) throw this.heartbeatFailure;
    return this.claimable && (this.failHeartbeatAfter === undefined || this.heartbeatCount <= this.failHeartbeatAfter);
  }

  releaseRun(claim: RunOwnerClaim): boolean {
    if (this.releaseFailure !== undefined) throw this.releaseFailure;
    if (this.claim?.ownerEpoch !== claim.ownerEpoch) return false;
    this.claim = undefined;
    this.releaseCount += 1;
    return true;
  }

  tryLoadRunSnapshot(runId: string): SchedulerSnapshot {
    return this.loadRunSnapshot(runId);
  }

  loadRunSnapshot(runId: string): SchedulerSnapshot {
    this.loadCount += 1;
    return {
      runId,
      version: this.events.length,
      projection: applySchedulerEvents(createSchedulerProjection(runId), this.events),
    };
  }

  tryAppendSchedulerEvents(commit: SchedulerCommit): SchedulerSnapshot {
    return this.appendSchedulerEvents(commit);
  }

  appendSchedulerEvents(commit: SchedulerCommit): SchedulerSnapshot {
    if (commit.expectedVersion !== this.events.length) throwStoreError({ type: "version-mismatch", runId: commit.runId, expectedVersion: commit.expectedVersion, actualVersion: this.events.length, message: "version mismatch" });
    this.events.push(...commit.events);
    return this.loadRunSnapshot(commit.runId);
  }

  tryStartAttempt(input: AttemptStartInput): AttemptStartResult {
    return this.startAttempt(input);
  }

  startAttempt(input: AttemptStartInput): AttemptStartResult {
    if (input.expectedVersion !== this.events.length) throwStoreError({ type: "version-mismatch", runId: input.runId, expectedVersion: input.expectedVersion, actualVersion: this.events.length, message: "version mismatch" });
    if (this.loadRunSnapshot(input.runId).projection.run.status === "paused") throwStoreError({ type: "run-paused", runId: input.runId, message: `Run '${input.runId}' is paused.` });
    this.attemptNo += 1;
    const attemptId = `attempt_${this.attemptNo}`;
    const member = this.loadRunSnapshot(input.runId).projection.groupMembers[input.nodeKey];
    this.events.push(
      { type: "instance.started", payload: { nodeKey: input.nodeKey } },
      ...(member?.status === "ready" ? [{ type: "group.member_started", payload: { memberKey: member.memberKey } } satisfies SchedulerEvent] : []),
      { type: "attempt.started", payload: { runId: input.runId, attemptId, nodeKey: input.nodeKey, nodeId: input.nodeId, attemptNo: this.attemptNo, ownerEpoch: input.ownerEpoch, ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }) } },
    );
    return { attemptId, attemptNo: this.attemptNo, snapshot: this.loadRunSnapshot(input.runId), disposition: "started" };
  }

  tryCommitAttemptResult(input: AttemptCommitInput): SchedulerSnapshot {
    return this.commitAttemptResult(input);
  }

  commitAttemptResult(input: AttemptCommitInput): SchedulerSnapshot {
    if (this.failCommits) throwStoreError({ type: "owner-epoch-inactive", runId: "run_1", ownerEpoch: input.ownerEpoch, message: "Run 'run_1' scheduler owner epoch is not active." });
    if (this.throwTimedOutCommits) throwStoreError({ type: "terminal-attempt", attemptId: input.attemptId, status: "timed_out", message: `Attempt '${input.attemptId}' is already timed_out.` });
    const projection = this.loadRunSnapshot(input.runId).projection;
    const attempt = projection.attempts[input.attemptId];
    if (!attempt) throwStoreError({ type: "attempt-not-found", attemptId: input.attemptId, message: `Attempt '${input.attemptId}' was not found.` });
    if (attempt.status !== "started") throwStoreError({ type: "terminal-attempt", attemptId: input.attemptId, status: attempt.status, message: `Attempt '${input.attemptId}' is already ${attempt.status}.` });
    const member = projection.groupMembers[attempt.nodeKey];
    this.events.push(...attemptResultEvents(input, attempt.nodeKey, member?.status === "running" ? member.memberKey : undefined));
    return this.loadRunSnapshot(input.runId);
  }

  pauseRun(input: { runId: string; ownerEpoch: number; idempotencyKey: string }): SchedulerSnapshot {
    const snapshot = this.loadRunSnapshot(input.runId);
    if (snapshot.projection.run.status === "paused") return snapshot;
    const events: SchedulerEvent[] = [
      { type: "control.paused", payload: {} },
    ];
    for (const attempt of Object.values(snapshot.projection.attempts).filter(attempt => attempt.status === "started")) {
      const instance = snapshot.projection.instances[attempt.nodeKey];
      events.push({ type: "attempt.cancelled", payload: { attemptId: attempt.attemptId, cancelReason: "paused" } });
      if (instance?.status === "running" || instance?.status === "awaiting") {
        events.push({ type: "instance.requeued", payload: { nodeKey: instance.nodeKey, reason: "paused", ...(instance.readinessSequence === undefined ? {} : { readinessSequence: instance.readinessSequence }) } });
      }
    }
    this.events.push(...events);
    return this.loadRunSnapshot(input.runId);
  }

  resumeRun(input: { runId: string }): SchedulerSnapshot {
    this.events.push({ type: "control.resumed", payload: {} });
    return this.loadRunSnapshot(input.runId);
  }

  tryMarkExpiredOwnerAttemptsSuperseded(input: SchedulerRecoveryInput): SchedulerSnapshot {
    return this.markExpiredOwnerAttemptsSuperseded(input);
  }

  markExpiredOwnerAttemptsSuperseded(input: SchedulerRecoveryInput): SchedulerSnapshot {
    const projection = this.loadRunSnapshot(input.runId).projection;
    for (const attempt of Object.values(projection.attempts)) {
      if (attempt.status === "started" && attempt.ownerEpoch === input.expiredOwnerEpoch) this.events.push({ type: "attempt.superseded", payload: { attemptId: attempt.attemptId, cancelReason: "superseded" } });
    }
    return this.loadRunSnapshot(input.runId);
  }
}

class CachedProjectionSchedulerStore extends MemorySchedulerStore {
  private snapshot: SchedulerSnapshot;
  private cachedAttemptNo: number;

  constructor(events: SchedulerEvent[]) {
    super([]);
    this.cachedAttemptNo = Math.max(0, ...events.flatMap(event => event.type === "attempt.started" ? [event.payload.attemptNo] : []));
    this.snapshot = {
      runId: "run_1",
      version: events.length,
      projection: applySchedulerEvents(createSchedulerProjection("run_1"), events),
    };
  }

  override tryLoadRunSnapshot(runId: string): SchedulerSnapshot {
    return this.loadRunSnapshot(runId);
  }

  override loadRunSnapshot(_runId: string): SchedulerSnapshot {
    this.loadCount += 1;
    return this.snapshot;
  }

  override tryAppendSchedulerEvents(commit: SchedulerCommit): SchedulerSnapshot {
    return this.appendSchedulerEvents(commit);
  }

  override appendSchedulerEvents(commit: SchedulerCommit): SchedulerSnapshot {
    if (commit.expectedVersion !== this.snapshot.version) {
      throwStoreError({ type: "version-mismatch", runId: commit.runId, expectedVersion: commit.expectedVersion, actualVersion: this.snapshot.version, message: "version mismatch" });
    }
    this.snapshot = {
      runId: commit.runId,
      version: this.snapshot.version + commit.events.length,
      projection: applySchedulerEvents(this.snapshot.projection, commit.events),
    };
    return this.snapshot;
  }

  override tryStartAttempt(input: AttemptStartInput): AttemptStartResult {
    return this.startAttempt(input);
  }

  override startAttempt(input: AttemptStartInput): AttemptStartResult {
    if (input.expectedVersion !== this.snapshot.version) {
      throwStoreError({ type: "version-mismatch", runId: input.runId, expectedVersion: input.expectedVersion, actualVersion: this.snapshot.version, message: "version mismatch" });
    }
    if (this.snapshot.projection.run.status === "paused") throwStoreError({ type: "run-paused", runId: input.runId, message: `Run '${input.runId}' is paused.` });
    this.cachedAttemptNo += 1;
    const attemptId = `attempt_${this.cachedAttemptNo}`;
    const member = this.snapshot.projection.groupMembers[input.nodeKey];
    const snapshot = this.appendSchedulerEvents({
      runId: input.runId,
      expectedVersion: input.expectedVersion,
      ownerEpoch: input.ownerEpoch,
      idempotencyKey: input.idempotencyKey,
      events: [
        { type: "instance.started", payload: { nodeKey: input.nodeKey } },
        ...(member?.status === "ready" ? [{ type: "group.member_started", payload: { memberKey: member.memberKey } } satisfies SchedulerEvent] : []),
        { type: "attempt.started", payload: { runId: input.runId, attemptId, nodeKey: input.nodeKey, nodeId: input.nodeId, attemptNo: this.cachedAttemptNo, ownerEpoch: input.ownerEpoch, ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }) } },
      ],
    });
    return { attemptId, attemptNo: this.cachedAttemptNo, snapshot, disposition: "started" };
  }

  override tryCommitAttemptResult(input: AttemptCommitInput): SchedulerSnapshot {
    return this.commitAttemptResult(input);
  }

  override commitAttemptResult(input: AttemptCommitInput): SchedulerSnapshot {
    const attempt = this.snapshot.projection.attempts[input.attemptId];
    if (!attempt) throwStoreError({ type: "attempt-not-found", attemptId: input.attemptId, message: `Attempt '${input.attemptId}' was not found.` });
    if (attempt.status !== "started") throwStoreError({ type: "terminal-attempt", attemptId: input.attemptId, status: attempt.status, message: `Attempt '${input.attemptId}' is already ${attempt.status}.` });
    const member = this.snapshot.projection.groupMembers[attempt.nodeKey];
    return this.appendSchedulerEvents({
      runId: input.runId,
      expectedVersion: this.snapshot.version,
      ownerEpoch: input.ownerEpoch,
      idempotencyKey: input.idempotencyKey,
      events: attemptResultEvents(input, attempt.nodeKey, member?.status === "running" ? member.memberKey : undefined),
    });
  }
}

class CompactSequentialSchedulerStore extends CachedProjectionSchedulerStore {
  override commitAttemptResult(input: AttemptCommitInput): SchedulerSnapshot {
    const nodeKey = this.loadRunSnapshot(input.runId).projection.attempts[input.attemptId]?.nodeKey;
    const snapshot = super.commitAttemptResult(input);
    delete snapshot.projection.attempts[input.attemptId];
    if (nodeKey) delete snapshot.projection.instances[nodeKey];
    return snapshot;
  }
}

class StaleAdmissionSchedulerStore extends MemorySchedulerStore {
  startCalls = 0;

  override tryStartAttempt(input: AttemptStartInput): AttemptStartResult {
    this.startCalls += 1;
    this.pauseRun({ runId: input.runId, ownerEpoch: input.ownerEpoch, idempotencyKey: "pause-before-start" });
    const actualVersion = this.loadRunSnapshot(input.runId).version;
    return throwStoreError({
      type: "version-mismatch",
      runId: input.runId,
      expectedVersion: input.expectedVersion,
      actualVersion,
      message: "version mismatch",
    });
  }
}

function throwStoreError(error: SchedulerStoreError): never {
  throw new SchedulerStoreException(error);
}

function executor(run: (context: NodeAttemptContext) => AttemptCommitInput["result"] | Promise<AttemptCommitInput["result"]> | Effect.Effect<AttemptCommitInput["result"]>): NodeExecutor {
  return {
    execute: context => Effect.suspend(() => {
      const result = run(context);
      return Effect.isEffect(result) ? result : Effect.promise(() => Promise.resolve(result));
    }),
  };
}

function ready(nodeKey: string, readinessSequence: number, nodeId = nodeKey): SchedulerEvent {
  return {
    type: "instance.ready",
    payload: {
      runId: "run_1",
      nodeKey,
      nodeId,
      instancePath: [{ kind: "node", nodeId }] satisfies InstancePath,
      readinessSequence,
    },
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error("condition was not met");
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
  const error = input.result.error ?? { reason: input.result.reason };
  return [
    { type: input.result.status === "timed_out" ? "attempt.timed_out" : "attempt.failed", payload: { attemptId: input.attemptId, error } },
    { type: "instance.failed", payload: { nodeKey, error, ...(input.result.status === "timed_out" ? { statusReason: "timed_out" } : {}) } },
    ...(memberKey ? [{ type: "group.member_failed", payload: { memberKey, error, terminalReason: input.result.status === "timed_out" ? "timed_out" : input.result.reason } } satisfies SchedulerEvent] : []),
  ];
}
