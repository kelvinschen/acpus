import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { makeNodeProcessHost } from "@acpus/owned-process";
import {
  advanceFrozenRun,
  failingExpressionCallbackWorkflow,
  failingRootAssertWorkflow,
  holdFirstTaskAttempt,
  rootIfSequentialTaskWorkflow,
  rootIfTaskWorkflow,
  rootParallelTaskWorkflow,
  rootSignalWorkflow,
  rootSwitchSequentialTaskWorkflow,
  rootTimedSignalWorkflow,
  sequentialRootParallelWorkflow,
  sequentialRootTaskWorkflow,
  signalWakeRefillWorkflow,
  taskMocks,
} from "./support/scheduler-runtime-runner.js";
import { admitRunForTest } from "./support/runtime-store.js";
import { describe, expect, it, vi } from "vitest";
import { advanceRun } from "./support/effect-scheduler.js";
import { appendBranch, appendNode, deriveInstanceKey } from "../src/scheduler/identity.js";
import { bootstrapRootEvents, continueRootEvents } from "../src/scheduler/materialize.js";
import { createRuntimeRunScheduler } from "../src/scheduler/runtime-runner.js";
import { openRuntimeStoreAdapter } from "../src/store/store.js";
import { loadAgentHostPolicy } from "../src/configuration.js";
import { prepareSyntheticWorkflow, runtimeRow, withRuntimeWorkspace } from "./support/runtime-harness.js";
import { throwingSchedulerStore } from "./support/scheduler-store.js";
import { applySchedulerControlIntent } from "./support/scheduler.js";

describe("runtime scheduler runner", () => {
  it("bridges scheduler root failure to the public run projection", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-public-failed", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, failingRootAssertWorkflow());
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });

          await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store })).resolves.toMatchObject({ status: "failed" });

          expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection.frames.root).toMatchObject({ status: "failed" });
          expect(store.getRun(run.id)).toMatchObject({ status: "failed" });
          expect(store.getRun(run.id)?.output).toBeUndefined();
          expect(runtimeRow(workspace, "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type = 'run.failed'", run.id)).toMatchObject({ count: 1 });
        } finally {
          store.close();
        }
      });
    });

  it("bridges expression callback evaluation failures to the public run projection", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-expression-callback-failed", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, failingExpressionCallbackWorkflow());
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });

          await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store })).resolves.toMatchObject({ status: "failed" });

          const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(projection.frames.root).toMatchObject({
            status: "failed",
            error: expect.objectContaining({
              reason: "expression_failed",
              message: expect.stringContaining("lift(...) expected JSON-compatible values."),
            }),
          });
          expect(store.getRun(run.id)).toMatchObject({ status: "failed" });
          expect(store.getRun(run.id)?.output).toBeUndefined();
        } finally {
          store.close();
        }
      });
    });

  it("bridges scheduler signal awaiting and completion to the public run projection", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-public-signal", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, rootSignalWorkflow());
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
          const nodeKey = deriveInstanceKey(appendNode([], "approve"));

          await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store })).resolves.toMatchObject({ status: "awaiting", started: 0 });
          expect(store.getRun(run.id)).toMatchObject({ status: "awaiting" });

          const applied = await applySchedulerControlIntent(workspace, store, {
            requestId: `signal:${run.id}:approve`,
            runId: run.id,
            type: "signal",
            node: "approve",
            payload: { ok: true },
            commandIdempotencyKey: `signal:${run.id}:approve`,
          }, { ownerId: "owner-b" });

          expect(applied.advanced).toMatchObject({ status: "completed" });
          expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection.instances[nodeKey]).toMatchObject({ status: "completed", output: { ok: true } });
          expect(store.getRun(run.id)).toMatchObject({ status: "completed", output: { ok: true } });
          expect(runtimeRow(workspace, "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type = 'run.completed'", run.id)).toMatchObject({ count: 1 });
        } finally {
          store.close();
        }
      });
    });

  it("persists signal timeout deadlines from frozen workflow metadata", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-signal-timeout-deadline", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, rootTimedSignalWorkflow());
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: { timeout: "5s", prompt: "Approve release?", timeoutMessage: "Approval timed out" }, cwd: workspace });
          const nodeKey = deriveInstanceKey(appendNode([], "approve"));
          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));

          await expect(advanceFrozenRun({
            cwd: workspace,
            runId: run.id,
            ownerId: "owner-a",
            store,
          })).resolves.toMatchObject({ status: "awaiting" });

          expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection.signalWaits[nodeKey]).toMatchObject({
            status: "awaiting",
            deadlineAt: "2026-07-01T00:00:05.000Z",
            renderedPrompt: "Approve release?",
            timeoutMessage: "Approval timed out",
          });
          expect(runtimeRow(workspace, "SELECT deadline_at, timeout_message FROM signal_waits WHERE run_id = ? AND node_key = ?", run.id, nodeKey)).toMatchObject({
            deadline_at: "2026-07-01T00:00:05.000Z",
            timeout_message: "Approval timed out",
          });
        } finally {
          vi.useRealTimers();
          store.close();
        }
      });
    });

  it("fails an unrepresentable signal deadline as a constraint", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-signal-deadline-range", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, rootTimedSignalWorkflow());
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, {
            prepared,
            input: { timeout: String(Number.MAX_SAFE_INTEGER), prompt: "Approve release?", timeoutMessage: "Approval timed out" },
            cwd: workspace,
          });
          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));

          await expect(advanceFrozenRun({
            cwd: workspace,
            runId: run.id,
            ownerId: "owner-a",
            store,
          })).resolves.toMatchObject({ status: "failed", started: 0 });

          const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(Object.values(projection.instances)[0]).toMatchObject({
            status: "failed",
            statusReason: "expression_resolution_failed",
            error: {
              reason: "expression_resolution_failed",
              type: "constraint",
              field: "Signal node 'approve' timeout",
              expected: "duration with a representable persisted deadline",
            },
          });
          expect(Object.values(projection.attempts)).toHaveLength(0);
          expect(Object.values(projection.signalWaits)).toHaveLength(0);
        } finally {
          vi.useRealTimers();
          store.close();
        }
      });
    });

  it("rejects an internal idle checkpoint at the production RunExecution boundary", async () => {
      await withRuntimeWorkspace("scheduler-run-execution-idle-invariant", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, sequentialRootTaskWorkflow());
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
          const execution = createRuntimeRunScheduler({
            processes: makeNodeProcessHost(),
            cwd: workspace,
            store,
            maxLeafConcurrency: 0,
            agentHostPolicy: loadAgentHostPolicy(process.env),
          }).start({ runId: run.id, ownerId: "owner-a" });
          const result = Effect.runPromise(execution.result);

          await expect(Effect.runPromise(execution.ownerEpoch)).resolves.toBe(1);
          await expect(result).rejects.toThrow("became non-terminal without active work or a durable wake source");
          expect(store.scheduler.claimRun(run.id, "owner-b", 60_000)).toMatchObject({ ownerEpoch: 2 });
        } finally {
          store.close();
        }
      });
    });

  it("resolves an undefined owner epoch when another live owner holds the run", async () => {
      await withRuntimeWorkspace("scheduler-run-execution-unclaimed-owner", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, sequentialRootTaskWorkflow());
        const store = await openRuntimeStoreAdapter(workspace);
        let owner: ReturnType<typeof store.scheduler.claimRun>;
        try {
          const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
          owner = store.scheduler.claimRun(run.id, "owner-a", 60_000);
          if (!owner) throw new Error("expected setup owner claim");
          const execution = createRuntimeRunScheduler({
            processes: makeNodeProcessHost(),
            cwd: workspace,
            store,
            maxLeafConcurrency: 1,
            agentHostPolicy: loadAgentHostPolicy(process.env),
          }).start({ runId: run.id, ownerId: "owner-b" });
          const result = Effect.runPromise(execution.result);

          await expect(Effect.runPromise(execution.ownerEpoch)).resolves.toBeUndefined();
          expect(Result.getOrThrow((await result))).toMatchObject({ status: "lease_lost" });
        } finally {
          if (owner) store.scheduler.releaseRun(owner);
          store.close();
        }
      });
    });

  it("refills a signaled branch after a durable wake while another task is still active", async () => {
      await withRuntimeWorkspace("scheduler-run-execution-signal-wake-refill", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, signalWakeRefillWorkflow());
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
          const signalKey = deriveInstanceKey(appendNode(appendBranch([], "work", "signaled"), "approve"));
          const longTaskKey = deriveInstanceKey(appendNode(appendBranch([], "work", "long"), "long_task"));
          const afterSignalTaskKey = deriveInstanceKey(appendNode(appendBranch([], "work", "signaled"), "after_signal_task"));
          const controlled = holdFirstTaskAttempt();
          const execution = createRuntimeRunScheduler({
            processes: makeNodeProcessHost(),
            cwd: workspace,
            store,
            maxLeafConcurrency: 2,
            agentHostPolicy: loadAgentHostPolicy(process.env),
          }).start({ runId: run.id, ownerId: "owner-a" });
          const resultFiber = Effect.runFork(execution.result);
          const result = Effect.runPromise(Fiber.join(resultFiber));

          try {
            const ownerEpoch = await Effect.runPromise(execution.ownerEpoch);
            if (ownerEpoch === undefined) throw new Error("expected scheduler owner claim");
            expect(ownerEpoch).toBe(1);
            await vi.waitFor(() => {
              expect(taskMocks.runTaskAttempt).toHaveBeenCalledTimes(1);
              expect(taskMocks.runTaskAttempt.mock.calls[0]?.[0].nodeId).toBe("long_task");
              expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection.signalWaits[signalKey]).toMatchObject({ status: "awaiting" });
            }, { interval: 1 });

            const consumed = throwingSchedulerStore(store.scheduler).consumeSignal({
              runId: run.id,
              nodeKey: signalKey,
              ownerEpoch,
              payload: { ok: true },
              commandIdempotencyKey: `signal:${run.id}:approve`,
              idempotencyKey: `signal:${run.id}:approve`,
            });
            expect(consumed.projection.signalWaits[signalKey]).toMatchObject({ status: "consumed", payload: { ok: true } });

            execution.wake();
            await vi.waitFor(() => {
              expect(taskMocks.runTaskAttempt).toHaveBeenCalledTimes(2);
              expect(taskMocks.runTaskAttempt.mock.calls[1]?.[0].nodeId).toBe("after_signal_task");
            }, { interval: 1 });

            const refilled = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
            expect(refilled.instances[longTaskKey]).toMatchObject({ status: "running" });
            expect(controlled.peak()).toBe(2);

            controlled.releaseFirst();
            expect(Result.getOrThrow((await result))).toMatchObject({ status: "completed", started: 2, completed: 2 });
            expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection.instances[afterSignalTaskKey]).toMatchObject({
              status: "completed",
              output: { value: "approved" },
            });
          } finally {
            controlled.releaseFirst();
            resultFiber.interruptUnsafe();
            await result.catch(() => undefined);
          }
        } finally {
          store.close();
        }
      });
    });

  it("advances root tasks sequentially and rebuilds prior output scope", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-sequence", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, sequentialRootTaskWorkflow());
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
          const firstKey = deriveInstanceKey(appendNode([], "first_task"));
          const secondKey = deriveInstanceKey(appendNode([], "second_task"));

          const summary = await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store });
          const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(summary).toMatchObject({ status: "completed", started: 2, completed: 2 });
          expect(projection.instances[firstKey]).toMatchObject({ status: "completed", output: { value: "first" } });
          expect(projection.instances[secondKey]).toMatchObject({ status: "completed", output: { value: "first-second" } });
          expect(projection.frames.root).toMatchObject({ status: "completed", result: { final: "first-second" } });
        } finally {
          store.close();
        }
      });
    });

  it("advances root assert and if branch decisions durably", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-if", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, rootIfTaskWorkflow());
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: { shouldRun: true }, cwd: workspace });
          const assertKey = deriveInstanceKey(appendNode([], "require_run"));
          const ifKey = deriveInstanceKey(appendNode([], "gate"));
          const branchKey = deriveInstanceKey(appendBranch([], "gate", "then"));
          const branchTaskKey = deriveInstanceKey(appendNode(appendBranch([], "gate", "then"), "then_task"));
          const finalKey = deriveInstanceKey(appendNode([], "final_task"));

          const summary = await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store });
          const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(summary).toMatchObject({ status: "completed", started: 2, completed: 2 });
          expect(projection.frames[assertKey]).toMatchObject({ status: "completed", result: {} });
          expect(projection.branchDecisions[ifKey]).toBe("then");
          expect(projection.instances[branchTaskKey]).toMatchObject({ status: "completed", output: { value: "then" } });
          expect(projection.frames[branchKey]).toMatchObject({ status: "completed", result: { value: "then" } });
          expect(projection.frames[ifKey]).toMatchObject({ status: "completed", result: { value: "then" } });
          expect(projection.instances[finalKey]).toMatchObject({ status: "completed", output: { final: "then-final" } });
          expect(projection.frames.root).toMatchObject({ status: "completed", result: { final: "then-final" } });
        } finally {
          store.close();
        }
      });
    });

  it("recreates and advances a retried composite frame subtree", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-frame-retry-advance", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, rootIfTaskWorkflow());
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: { shouldRun: true }, cwd: workspace });
          const assertKey = deriveInstanceKey(appendNode([], "require_run"));
          const ifKey = deriveInstanceKey(appendNode([], "gate"));
          const branchKey = deriveInstanceKey(appendBranch([], "gate", "then"));
          const branchTaskKey = deriveInstanceKey(appendNode(appendBranch([], "gate", "then"), "then_task"));
          const finalKey = deriveInstanceKey(appendNode([], "final_task"));
          const claim = store.scheduler.claimRun(run.id, "bootstrap", 60_000)!;
          throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
            runId: run.id,
            expectedVersion: throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).version,
            ownerEpoch: claim.ownerEpoch,
            idempotencyKey: "frame-retry-bootstrap",
            events: [
              { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root", scope: { require_run: assertKey, gate: ifKey, final_task: finalKey } } },
              { type: "frame.started", payload: { runId: run.id, frameKey: assertKey, frameKind: "node", nodeKey: assertKey, nodeId: "require_run", parentFrameKey: "root", instancePath: appendNode([], "require_run") } },
              { type: "frame.completed", payload: { frameKey: assertKey, result: {}, terminalReason: "assert_passed" } },
              { type: "frame.started", payload: { runId: run.id, frameKey: ifKey, frameKind: "node", nodeKey: ifKey, nodeId: "gate", parentFrameKey: "root", instancePath: appendNode([], "gate") } },
              { type: "branch.decided", payload: { frameKey: ifKey, branchId: "then" } },
              { type: "frame.started", payload: { runId: run.id, frameKey: branchKey, frameKind: "branch", nodeId: "gate", parentFrameKey: ifKey, instancePath: appendBranch([], "gate", "then") } },
              { type: "frame.failed", payload: { frameKey: branchKey, error: { reason: "boom" } } },
              { type: "frame.failed", payload: { frameKey: ifKey, error: { reason: "boom" } } },
              { type: "frame.failed", payload: { frameKey: "root", error: { reason: "boom" } } },
            ],
          });
          store.scheduler.releaseRun(claim);

          const applied = await applySchedulerControlIntent(workspace, store, {
            requestId: `retry:${run.id}:gate`,
            runId: run.id,
            type: "retry",
            target: "gate",
          }, { ownerId: "owner-a" });

          expect(applied.advanced).toMatchObject({ status: "completed", started: 2, completed: 2 });
          const afterRetryAdvance = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(afterRetryAdvance.branchDecisions[ifKey]).toBe("then");
          expect(afterRetryAdvance.frames[ifKey]).toMatchObject({ status: "completed", result: { value: "then" } });
          expect(afterRetryAdvance.instances[branchTaskKey]).toMatchObject({ status: "completed", output: { value: "then" } });
          expect(afterRetryAdvance.instances[finalKey]).toMatchObject({ status: "completed", output: { final: "then-final" } });
          expect(afterRetryAdvance.frames.root).toMatchObject({ status: "completed", result: { final: "then-final" } });
          expect(store.getRun(run.id)).toMatchObject({ status: "completed", output: { final: "then-final" } });
        } finally {
          store.close();
        }
      });
    });

  it("advances sequential leaf nodes inside a selected root if branch", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-if-sequence", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, rootIfSequentialTaskWorkflow());
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: { shouldRun: true }, cwd: workspace });
          const ifKey = deriveInstanceKey(appendNode([], "gate"));
          const branchKey = deriveInstanceKey(appendBranch([], "gate", "then"));
          const firstKey = deriveInstanceKey(appendNode(appendBranch([], "gate", "then"), "then_first"));
          const secondKey = deriveInstanceKey(appendNode(appendBranch([], "gate", "then"), "then_second"));
          const finalKey = deriveInstanceKey(appendNode([], "final_task"));

          const summary = await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store });
          const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(summary).toMatchObject({ status: "completed", started: 3, completed: 3 });
          expect(projection.instances[firstKey]).toMatchObject({ status: "completed", output: { value: "first" } });
          expect(projection.instances[secondKey]).toMatchObject({ status: "completed", output: { value: "first-second" } });
          expect(projection.frames[branchKey]).toMatchObject({ status: "completed", result: { value: "first-second" } });
          expect(projection.frames[ifKey]).toMatchObject({ status: "completed", result: { value: "first-second" } });
          expect(projection.instances[finalKey]).toMatchObject({ status: "completed", output: { final: "first-second-final" } });
          expect(projection.frames.root).toMatchObject({ status: "completed", result: { final: "first-second-final" } });
        } finally {
          store.close();
        }
      });
    });

  it("advances sequential leaf nodes inside a selected root switch case", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-switch-sequence", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, rootSwitchSequentialTaskWorkflow());
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: { mode: "case" }, cwd: workspace });
          const switchKey = deriveInstanceKey(appendNode([], "route"));
          const branchKey = deriveInstanceKey(appendBranch([], "route", "case:0"));
          const firstKey = deriveInstanceKey(appendNode(appendBranch([], "route", "case:0"), "case_first"));
          const secondKey = deriveInstanceKey(appendNode(appendBranch([], "route", "case:0"), "case_second"));

          const summary = await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store });
          const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(summary).toMatchObject({ status: "completed", started: 2, completed: 2 });
          expect(projection.branchDecisions[switchKey]).toBe("case:0");
          expect(projection.instances[firstKey]).toMatchObject({ status: "completed", output: { value: "case" } });
          expect(projection.instances[secondKey]).toMatchObject({ status: "completed", output: { value: "case-second" } });
          expect(projection.frames[branchKey]).toMatchObject({ status: "completed", result: { value: "case-second" } });
          expect(projection.frames[switchKey]).toMatchObject({ status: "completed", result: { value: "case-second" } });
          expect(projection.frames.root).toMatchObject({ status: "completed", result: { value: "case-second" } });
        } finally {
          store.close();
        }
      });
    });

  it("resumes root if from a durable branch decision after reopening the store", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-if-resume", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, rootIfTaskWorkflow());
        const firstStore = await openRuntimeStoreAdapter(workspace);
        let runId = "";
        const ifKey = deriveInstanceKey(appendNode([], "gate"));
        const branchKey = deriveInstanceKey(appendBranch([], "gate", "then"));
        const branchTaskKey = deriveInstanceKey(appendNode(appendBranch([], "gate", "then"), "then_task"));
        const finalKey = deriveInstanceKey(appendNode([], "final_task"));
        try {
          const run = await admitRunForTest(firstStore, { prepared, input: { shouldRun: true }, cwd: workspace });
          runId = run.id;
          const frozen = firstStore.getFrozenRun(runId);
          if (!frozen) throw new Error("expected frozen workflow");
          const scope = { input: frozen.input, nodes: {}, meta: frozen.meta, fanout: {}, loop: {} };

          await expect(advanceRun({
            runId,
            ownerId: "owner-a",
            store: firstStore.scheduler,
            maxLeafConcurrency: 0,
            executor: { execute: () => Effect.die(new Error("checkpoint setup must not execute leaves")) },
            bootstrap: snapshot => snapshot.projection.frames.root ? [] : bootstrapRootEvents(runId, frozen.ir, scope),
            materialize: snapshot => continueRootEvents(frozen.ir, snapshot.projection, scope),
          })).resolves.toMatchObject({ status: "idle", started: 0, completed: 0 });

          const projection = throwingSchedulerStore(firstStore.scheduler).loadRunSnapshot(runId).projection;
          expect(projection.branchDecisions[ifKey]).toBe("then");
          expect(projection.frames[branchKey]).toMatchObject({ status: "running" });
          expect(projection.frames[ifKey]).toMatchObject({ status: "running" });
          expect(projection.instances[branchTaskKey]).toMatchObject({ status: "ready" });
          expect(projection.instances[finalKey]).toBeUndefined();
          expect(JSON.parse(String(runtimeRow(workspace, "SELECT instance_path_json FROM scheduler_frames WHERE run_id = ? AND frame_key = ?", runId, ifKey)?.instance_path_json))).toEqual([{ kind: "node", nodeId: "gate" }]);
          expect(JSON.parse(String(runtimeRow(workspace, "SELECT instance_path_json FROM scheduler_frames WHERE run_id = ? AND frame_key = ?", runId, branchKey)?.instance_path_json))).toEqual([{ kind: "branch", nodeId: "gate", branchId: "then" }]);
        } finally {
          firstStore.close();
        }

        const resumedStore = await openRuntimeStoreAdapter(workspace);
        try {
          await expect(advanceFrozenRun({ cwd: workspace, runId, ownerId: "owner-b", store: resumedStore })).resolves.toMatchObject({ status: "completed", started: 2, completed: 2 });
          const recovered = throwingSchedulerStore(resumedStore.scheduler).loadRunSnapshot(runId).projection;
          expect(recovered.branchDecisions[ifKey]).toBe("then");
          expect(recovered.instances[branchTaskKey]).toMatchObject({ status: "completed", output: { value: "then" } });
          expect(recovered.frames[branchKey]).toMatchObject({ status: "completed", result: { value: "then" } });
          expect(recovered.frames[ifKey]).toMatchObject({ status: "completed", result: { value: "then" } });
          expect(recovered.instances[finalKey]).toMatchObject({ status: "completed", output: { final: "then-final" } });
          expect(recovered.frames.root).toMatchObject({ status: "completed", result: { final: "then-final" } });
        } finally {
          resumedStore.close();
        }
      });
    });

  it("evaluates later root parallel outputs with prior root scope", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-sequence-parallel", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, sequentialRootParallelWorkflow());
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
          const prepareKey = deriveInstanceKey(appendNode([], "prepare_task"));
          const parallelKey = deriveInstanceKey(appendNode([], "combine"));

          await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store })).resolves.toMatchObject({ status: "completed", started: 3, completed: 3 });
          const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(projection.instances[prepareKey]).toMatchObject({ status: "completed", output: { prefix: "root" } });
          expect(projection.frames[parallelKey]).toMatchObject({
            status: "completed",
            result: {
              left: { value: "root-left", rootPrefix: "root" },
              right: { value: "root-right", rootPrefix: "root" },
            },
          });
          expect(projection.frames.root).toMatchObject({ status: "completed", result: { finalValue: "root-left", finalPrefix: "root" } });
        } finally {
          store.close();
        }
      });
    });

  it("keeps root parallel physical execution within maxConcurrency", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-parallel-max-concurrency", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, rootParallelTaskWorkflow({ dynamicMaxConcurrency: true }));
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: { maxConcurrency: 1 }, cwd: workspace });
          const controlled = holdFirstTaskAttempt();
          const advancing = advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store });
          await vi.waitFor(() => expect(taskMocks.runTaskAttempt).toHaveBeenCalledTimes(1));
          controlled.releaseFirst();

          await expect(advancing).resolves.toMatchObject({ status: "completed", started: 2, completed: 2 });
          const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(controlled.peak()).toBe(1);
          expect(taskMocks.runTaskAttempt).toHaveBeenCalledTimes(2);
          expect(Object.values(projection.instances).filter(instance => instance.status === "completed")).toHaveLength(2);
          expect(Object.values(projection.groups)[0]).toMatchObject({ status: "completed", maxConcurrency: 1 });
        } finally {
          store.close();
        }
      });
    });
});
