import { defineWorkflow, z } from "@acpus/core";
import { lift, template } from "@acpus/expression";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { advanceRun } from "../src/scheduler/advance.js";
import { appendBranch, appendFanoutItem, appendNode, deriveInstanceKey } from "../src/scheduler/identity.js";
import { bootstrapRootEvents, continueRootEvents } from "../src/scheduler/materialize.js";
import { advanceFrozenRun as advanceFrozenRunProduction } from "../src/scheduler/runtime-runner.js";
import type { TaskAttemptRunner } from "../src/execution/task-process.js";
import { openRuntimeStore } from "../src/store/store.js";
import { createInlineTaskAttemptHarness } from "./support/task-attempt-harness.js";
import { normalizeWorkflowInput } from "../src/admission/input.js";
import { prepareSyntheticWorkflow, runtimeRow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";
import { throwingSchedulerStore } from "./support/scheduler-store.js";
import { applySchedulerControlIntent } from "./support/scheduler.js";

const taskMocks = vi.hoisted(() => ({ runTaskAttempt: vi.fn<TaskAttemptRunner>() }));

vi.mock("../src/execution/task-process.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/execution/task-process.js")>(),
  runTaskAttempt: taskMocks.runTaskAttempt,
}));

let taskAttemptHarness = createInlineTaskAttemptHarness();
beforeEach(() => {
  taskAttemptHarness = createInlineTaskAttemptHarness();
  taskMocks.runTaskAttempt.mockReset().mockImplementation(input => taskAttemptHarness.runAttempt(input));
});
const advanceFrozenRun = advanceFrozenRunProduction;

describe("runtime scheduler runner", () => {
  it("bridges scheduler root failure to the public run projection", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-public-failed", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, failingRootAssertWorkflow());
        const store = await openRuntimeStore(workspace);
        try {
          const run = await store.admitRun({ prepared, input: {}, cwd: workspace });

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
        const store = await openRuntimeStore(workspace);
        try {
          const run = await store.admitRun({ prepared, input: {}, cwd: workspace });

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
        const store = await openRuntimeStore(workspace);
        try {
          const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
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
        const store = await openRuntimeStore(workspace);
        try {
          const run = await store.admitRun({ prepared, input: { timeout: "5s", prompt: "Approve release?", timeoutMessage: "Approval timed out" }, cwd: workspace });
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
        const store = await openRuntimeStore(workspace);
        try {
          const run = await store.admitRun({
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

  it("advances root tasks sequentially and rebuilds prior output scope", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-sequence", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, sequentialRootTaskWorkflow());
        const store = await openRuntimeStore(workspace);
        try {
          const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
          const firstKey = deriveInstanceKey(appendNode([], "first_task"));
          const secondKey = deriveInstanceKey(appendNode([], "second_task"));

          const first = await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store });
          const afterFirst = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(first).toMatchObject({ status: "idle", started: 1, completed: 1 });
          expect(afterFirst.instances[firstKey]).toMatchObject({ status: "completed", output: { value: "first" } });
          expect(afterFirst.instances[secondKey]).toMatchObject({ status: "ready", readinessSequence: 2 });
          expect(afterFirst.frames.root).toMatchObject({ status: "running" });

          const second = await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-b", store });
          const afterSecond = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(second).toMatchObject({ status: "completed", started: 1, completed: 1 });
          expect(afterSecond.instances[secondKey]).toMatchObject({ status: "completed", output: { value: "first-second" } });
          expect(afterSecond.frames.root).toMatchObject({ status: "completed", result: { final: "first-second" } });
        } finally {
          store.close();
        }
      });
    });

  it("advances root assert and if branch decisions durably", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-if", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, rootIfTaskWorkflow());
        const store = await openRuntimeStore(workspace);
        try {
          const run = await store.admitRun({ prepared, input: { shouldRun: true }, cwd: workspace });
          const assertKey = deriveInstanceKey(appendNode([], "require_run"));
          const ifKey = deriveInstanceKey(appendNode([], "gate"));
          const branchKey = deriveInstanceKey(appendBranch([], "gate", "then"));
          const branchTaskKey = deriveInstanceKey(appendNode(appendBranch([], "gate", "then"), "then_task"));
          const finalKey = deriveInstanceKey(appendNode([], "final_task"));

          const first = await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store });
          const afterFirst = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(first).toMatchObject({ status: "idle", started: 1, completed: 1 });
          expect(afterFirst.frames[assertKey]).toMatchObject({ status: "completed", result: {} });
          expect(afterFirst.branchDecisions[ifKey]).toBe("then");
          expect(afterFirst.instances[branchTaskKey]).toMatchObject({ status: "completed", output: { value: "then" } });
          expect(afterFirst.frames[branchKey]).toMatchObject({ status: "completed", result: { value: "then" } });
          expect(afterFirst.frames[ifKey]).toMatchObject({ status: "completed", result: { value: "then" } });
          expect(afterFirst.instances[finalKey]).toMatchObject({ status: "ready" });

          const second = await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-b", store });
          const afterSecond = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(second).toMatchObject({ status: "completed", started: 1, completed: 1 });
          expect(afterSecond.instances[finalKey]).toMatchObject({ status: "completed", output: { final: "then-final" } });
          expect(afterSecond.frames.root).toMatchObject({ status: "completed", result: { final: "then-final" } });
        } finally {
          store.close();
        }
      });
    });

  it("recreates and advances a retried composite frame subtree", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-frame-retry-advance", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, rootIfTaskWorkflow());
        const store = await openRuntimeStore(workspace);
        try {
          const run = await store.admitRun({ prepared, input: { shouldRun: true }, cwd: workspace });
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

          expect(applied.advanced).toMatchObject({ status: "idle", started: 1, completed: 1 });
          const afterRetryAdvance = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(afterRetryAdvance.branchDecisions[ifKey]).toBe("then");
          expect(afterRetryAdvance.frames[ifKey]).toMatchObject({ status: "completed", result: { value: "then" } });
          expect(afterRetryAdvance.instances[branchTaskKey]).toMatchObject({ status: "completed", output: { value: "then" } });
          expect(afterRetryAdvance.instances[finalKey]).toMatchObject({ status: "ready" });
          expect(store.getRun(run.id)).toMatchObject({ status: "running" });

          await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-b", store })).resolves.toMatchObject({ status: "completed" });
          expect(store.getRun(run.id)).toMatchObject({ status: "completed", output: { final: "then-final" } });
        } finally {
          store.close();
        }
      });
    });

  it("advances sequential leaf nodes inside a selected root if branch", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-if-sequence", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, rootIfSequentialTaskWorkflow());
        const store = await openRuntimeStore(workspace);
        try {
          const run = await store.admitRun({ prepared, input: { shouldRun: true }, cwd: workspace });
          const ifKey = deriveInstanceKey(appendNode([], "gate"));
          const branchKey = deriveInstanceKey(appendBranch([], "gate", "then"));
          const firstKey = deriveInstanceKey(appendNode(appendBranch([], "gate", "then"), "then_first"));
          const secondKey = deriveInstanceKey(appendNode(appendBranch([], "gate", "then"), "then_second"));
          const finalKey = deriveInstanceKey(appendNode([], "final_task"));

          const first = await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store });
          const afterFirst = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(first).toMatchObject({ status: "idle", started: 1, completed: 1 });
          expect(afterFirst.instances[firstKey]).toMatchObject({ status: "completed", output: { value: "first" } });
          expect(afterFirst.instances[secondKey]).toMatchObject({ status: "ready" });
          expect(afterFirst.frames[branchKey]).toMatchObject({ status: "running" });
          expect(afterFirst.frames[ifKey]).toMatchObject({ status: "running" });

          const second = await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-b", store });
          const afterSecond = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(second).toMatchObject({ status: "idle", started: 1, completed: 1 });
          expect(afterSecond.instances[secondKey]).toMatchObject({ status: "completed", output: { value: "first-second" } });
          expect(afterSecond.frames[branchKey]).toMatchObject({ status: "completed", result: { value: "first-second" } });
          expect(afterSecond.frames[ifKey]).toMatchObject({ status: "completed", result: { value: "first-second" } });
          expect(afterSecond.instances[finalKey]).toMatchObject({ status: "ready" });

          const final = await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-c", store });
          const afterFinal = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(final).toMatchObject({ status: "completed", started: 1, completed: 1 });
          expect(afterFinal.instances[finalKey]).toMatchObject({ status: "completed", output: { final: "first-second-final" } });
          expect(afterFinal.frames.root).toMatchObject({ status: "completed", result: { final: "first-second-final" } });
        } finally {
          store.close();
        }
      });
    });

  it("advances sequential leaf nodes inside a selected root switch case", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-switch-sequence", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, rootSwitchSequentialTaskWorkflow());
        const store = await openRuntimeStore(workspace);
        try {
          const run = await store.admitRun({ prepared, input: { mode: "case" }, cwd: workspace });
          const switchKey = deriveInstanceKey(appendNode([], "route"));
          const branchKey = deriveInstanceKey(appendBranch([], "route", "case:0"));
          const firstKey = deriveInstanceKey(appendNode(appendBranch([], "route", "case:0"), "case_first"));
          const secondKey = deriveInstanceKey(appendNode(appendBranch([], "route", "case:0"), "case_second"));

          await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store });
          const afterFirst = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(afterFirst.branchDecisions[switchKey]).toBe("case:0");
          expect(afterFirst.instances[firstKey]).toMatchObject({ status: "completed", output: { value: "case" } });
          expect(afterFirst.instances[secondKey]).toMatchObject({ status: "ready" });
          expect(afterFirst.frames[branchKey]).toMatchObject({ status: "running" });

          await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-b", store });
          const afterSecond = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(afterSecond.frames[branchKey]).toMatchObject({ status: "completed", result: { value: "case-second" } });
          expect(afterSecond.frames[switchKey]).toMatchObject({ status: "completed", result: { value: "case-second" } });
          expect(afterSecond.frames.root).toMatchObject({ status: "completed", result: { value: "case-second" } });
        } finally {
          store.close();
        }
      });
    });

  it("resumes root if from a durable branch decision after reopening the store", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-if-resume", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, rootIfTaskWorkflow());
        const firstStore = await openRuntimeStore(workspace);
        let runId = "";
        const ifKey = deriveInstanceKey(appendNode([], "gate"));
        const branchKey = deriveInstanceKey(appendBranch([], "gate", "then"));
        const branchTaskKey = deriveInstanceKey(appendNode(appendBranch([], "gate", "then"), "then_task"));
        const finalKey = deriveInstanceKey(appendNode([], "final_task"));
        try {
          const run = await firstStore.admitRun({ prepared, input: { shouldRun: true }, cwd: workspace });
          runId = run.id;
          const frozen = firstStore.getFrozenRun(runId);
          if (!frozen) throw new Error("expected frozen workflow");
          const scope = { input: frozen.input, nodes: {}, meta: frozen.meta, fanout: {}, loop: {} };

          await expect(advanceRun({
            runId,
            ownerId: "owner-a",
            store: firstStore.scheduler,
            maxLeafConcurrency: 0,
            executor: { async execute() { throw new Error("checkpoint setup must not execute leaves"); } },
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

        const resumedStore = await openRuntimeStore(workspace);
        try {
          await expect(advanceFrozenRun({ cwd: workspace, runId, ownerId: "owner-b", store: resumedStore })).resolves.toMatchObject({ status: "idle", started: 1, completed: 1 });
          const afterBranch = throwingSchedulerStore(resumedStore.scheduler).loadRunSnapshot(runId).projection;
          expect(afterBranch.branchDecisions[ifKey]).toBe("then");
          expect(afterBranch.instances[branchTaskKey]).toMatchObject({ status: "completed", output: { value: "then" } });
          expect(afterBranch.frames[branchKey]).toMatchObject({ status: "completed", result: { value: "then" } });
          expect(afterBranch.frames[ifKey]).toMatchObject({ status: "completed", result: { value: "then" } });
          expect(afterBranch.instances[finalKey]).toMatchObject({ status: "ready" });

          await expect(advanceFrozenRun({ cwd: workspace, runId, ownerId: "owner-c", store: resumedStore })).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });
          expect(throwingSchedulerStore(resumedStore.scheduler).loadRunSnapshot(runId).projection.frames.root).toMatchObject({ status: "completed", result: { final: "then-final" } });
        } finally {
          resumedStore.close();
        }
      });
    });

  it("bootstraps and advances first-leaf branches of a root parallel node", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-parallel", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, rootParallelTaskWorkflow());
        const store = await openRuntimeStore(workspace);
        try {
          const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
          const summary = await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store });

          const groupKey = deriveInstanceKey(appendNode([], "race"));
          const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(summary).toMatchObject({ status: "completed", started: 2, completed: 2 });
          expect(projection.run).toMatchObject({ status: "completed" });
          expect(projection.frames[groupKey]).toMatchObject({ status: "completed", result: { left: { value: "left" }, right: { value: "right" } } });
          expect(projection.groups[groupKey]).toMatchObject({ status: "completed", strategy: "all" });
          expect(Object.values(projection.groupMembers)
            .filter(member => member.memberKind === "branch")
            .map(member => member.branchId)
            .sort()).toEqual(["left", "right"]);
          expect(Object.values(projection.instances).filter(instance => instance.status === "completed").map(instance => instance.nodeId).sort()).toEqual(["left_task", "right_task"]);
        } finally {
          store.close();
        }
      });
    });

  it("evaluates later root parallel outputs with prior root scope", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-sequence-parallel", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, sequentialRootParallelWorkflow());
        const store = await openRuntimeStore(workspace);
        try {
          const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
          const prepareKey = deriveInstanceKey(appendNode([], "prepare_task"));
          const parallelKey = deriveInstanceKey(appendNode([], "combine"));

          await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store })).resolves.toMatchObject({ status: "idle", started: 1, completed: 1 });
          expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection.instances[prepareKey]).toMatchObject({ status: "completed", output: { prefix: "root" } });

          await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-b", store })).resolves.toMatchObject({ status: "completed", started: 2, completed: 2 });
          const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
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

  it("honors root parallel maxConcurrency across repeated frozen-run advances", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-parallel-max-concurrency", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, rootParallelTaskWorkflow({ dynamicMaxConcurrency: true }));
        const store = await openRuntimeStore(workspace);
        try {
          const run = await store.admitRun({ prepared, input: { maxConcurrency: 1 }, cwd: workspace });
          const first = await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store });
          const afterFirst = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(first).toMatchObject({ status: "idle", started: 1, completed: 1 });
          expect(Object.values(afterFirst.instances).filter(instance => instance.status === "completed")).toHaveLength(1);

          const second = await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-b", store });
          const afterSecond = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(second).toMatchObject({ status: "completed", started: 1, completed: 1 });
          expect(Object.values(afterSecond.instances).filter(instance => instance.status === "completed")).toHaveLength(2);
          expect(Object.values(afterSecond.groups)[0]).toMatchObject({ status: "completed", maxConcurrency: 1 });
        } finally {
          store.close();
        }
      });
    });

  it("bootstraps root fanout items with durable item scope for task inputs", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-fanout", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, rootFanoutTaskWorkflow());
        const store = await openRuntimeStore(workspace);
        try {
          const run = await store.admitRun({ prepared, input: { items: ["a", "b"] }, cwd: workspace });
          const summary = await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store });
          const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;

          expect(summary).toMatchObject({ status: "completed", started: 2, completed: 2 });
          expect(projection.frames[deriveInstanceKey(appendNode([], "items"))]).toMatchObject({
            status: "completed",
            result: [{ item: "a", index: 0 }, { item: "b", index: 1 }],
          });
          expect(Object.values(projection.groupMembers)
            .filter(member => member.memberKind === "fanout_item")
            .map(member => ({ item: member.item, itemIndex: member.itemIndex, status: member.status }))).toEqual([
            { item: "a", itemIndex: 0, status: "completed" },
            { item: "b", itemIndex: 1, status: "completed" },
          ]);
          expect(Object.values(projection.instances).map(instance => instance.output).sort((a, b) => String((a as { item: string }).item).localeCompare(String((b as { item: string }).item)))).toEqual([
            { item: "a", index: 0 },
            { item: "b", index: 1 },
          ]);
          const itemRow = runtimeRow(workspace, "SELECT item_json FROM group_members WHERE run_id = ? AND item_index = 0", run.id) as { item_json: string };
          expect(JSON.parse(itemRow.item_json)).toBe("a");
        } finally {
          store.close();
        }
      });
    });

  it("treats defaulted zero fanout concurrency as no local cap and keeps progressing", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-fanout-zero-concurrency", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, rootFanoutTaskWorkflow({ maxConcurrency: 0, dynamicLimits: true }));
        const store = await openRuntimeStore(workspace);
        try {
          const input = normalizeWorkflowInput(prepared.ir, { items: ["a", "b"] });
          const run = await store.admitRun({ prepared, input, cwd: workspace });
          const summary = await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store });
          const group = Object.values(throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection.groups)[0];

          expect(summary).toMatchObject({ status: "completed", started: 2, completed: 2 });
          expect(group).toMatchObject({ status: "completed" });
          expect(group).not.toHaveProperty("maxConcurrency");
        } finally {
          store.close();
        }
      });
    });

  it("rebuilds effective fanout limits and item scope after reopening the store", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-fanout-resume", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, rootFanoutTaskWorkflow({ strategy: "quorum", dynamicLimits: true }));
        const firstStore = await openRuntimeStore(workspace);
        let runId = "";
        try {
          const run = await firstStore.admitRun({ prepared, input: { items: ["a", "b", "c"], quorum: 2, parallelism: 1 }, cwd: workspace });
          runId = run.id;
          const first = await advanceFrozenRun({ cwd: workspace, runId, ownerId: "owner-a", store: firstStore });
          expect(first).toMatchObject({ status: "idle", started: 1, completed: 1 });
          expect(Object.values(throwingSchedulerStore(firstStore.scheduler).loadRunSnapshot(runId).projection.groups)[0]).toMatchObject({ quorumCount: 2, maxConcurrency: 1 });
        } finally {
          firstStore.close();
        }

        const resumedStore = await openRuntimeStore(workspace);
        try {
          const second = await advanceFrozenRun({ cwd: workspace, runId, ownerId: "owner-b", store: resumedStore });
          const projection = throwingSchedulerStore(resumedStore.scheduler).loadRunSnapshot(runId).projection;
          expect(second).toMatchObject({ status: "completed", started: 1, completed: 1 });
          expect(projection.run).toMatchObject({ status: "completed" });
          expect(Object.values(projection.groups)[0]).toMatchObject({ status: "completed", quorumCount: 2, maxConcurrency: 1 });
          expect(Object.values(projection.groupMembers).filter(member => member.status === "completed")).toHaveLength(2);
          expect(Object.values(projection.groupMembers).filter(member => member.status === "cancelled")).toHaveLength(1);
          expect(Object.values(projection.instances).filter(instance => instance.status === "completed").map(instance => instance.output).sort((a, b) => Number((a as { index: number }).index) - Number((b as { index: number }).index))).toEqual([
            { item: "a", index: 0 },
            { item: "b", index: 1 },
          ]);
        } finally {
          resumedStore.close();
        }
      });
    });

  it("honors root fanout quorum and maxConcurrency without running cancelled items", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-fanout-quorum", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, rootFanoutTaskWorkflow({ strategy: "quorum", dynamicLimits: true }));
        const store = await openRuntimeStore(workspace);
        try {
          const run = await store.admitRun({ prepared, input: { items: ["a", "b", "c"], quorum: 2, parallelism: 2 }, cwd: workspace });
          const summary = await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store });
          const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;

          expect(summary).toMatchObject({ status: "completed", started: 2, completed: 2 });
          const fanoutFrame = projection.frames[deriveInstanceKey(appendNode([], "items"))];
          expect(fanoutFrame).toMatchObject({ status: "completed" });
          expect(fanoutFrame?.result).toHaveLength(2);
          expect(fanoutFrame?.result).toEqual(expect.arrayContaining([
            { item: "a", index: 0 },
            { item: "b", index: 1 },
          ]));
          expect(Object.values(projection.groupMembers).filter(member => member.status === "completed")).toHaveLength(2);
          expect(Object.values(projection.groupMembers).filter(member => member.status === "cancelled")).toHaveLength(1);
          expect(Object.values(projection.instances).filter(instance => instance.status === "completed")).toHaveLength(2);
          expect(Object.values(projection.instances).filter(instance => instance.status === "cancelled")).toHaveLength(1);
          expect(Object.values(projection.groups)[0]).toMatchObject({ quorumCount: 2, maxConcurrency: 2 });
        } finally {
          store.close();
        }
      });
    });

  it("aborts active root fanout quorum losers", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-fanout-active-quorum", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, rootFanoutTaskWorkflow({ strategy: "quorum", count: 1, maxConcurrency: 2, abortItem: "slow" }));
        const store = await openRuntimeStore(workspace);
        try {
          const run = await store.admitRun({ prepared, input: { items: ["slow", "fast"] }, cwd: workspace });
          const summary = await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store });
          const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;

          expect(summary).toMatchObject({ status: "completed", started: 2, completed: 1, cancelled: 1 });
          expect(projection.run).toMatchObject({ status: "completed" });
          expect(Object.values(projection.groupMembers).filter(member => member.status === "completed")).toHaveLength(1);
          expect(Object.values(projection.groupMembers).filter(member => member.status === "cancelled")).toHaveLength(1);
          expect(Object.values(projection.attempts).filter(attempt => attempt.status === "cancelled")).toHaveLength(1);
          expect(Object.values(projection.instances).filter(instance => instance.status === "cancelled")).toHaveLength(1);
        } finally {
          store.close();
        }
      });
    });

  it("advances multi-node root parallel branches across repeated frozen-run drives", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-parallel-multi-node", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, multiNodeRootParallelWorkflow());
        const store = await openRuntimeStore(workspace);
        try {
          const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
          const parallelKey = deriveInstanceKey(appendNode([], "parallel"));
          const branchKey = deriveInstanceKey(appendBranch([], "parallel", "mixed"));

          await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store })).resolves.toMatchObject({ status: "idle", started: 1, completed: 1 });
          expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection.groupMembers[branchKey]).toMatchObject({ status: "running" });

          await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-b", store })).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });
          const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(projection.frames[branchKey]).toMatchObject({ status: "completed", result: { value: "second" } });
          expect(projection.groupMembers[branchKey]).toMatchObject({ status: "completed", output: { value: "second" } });
          expect(projection.frames[parallelKey]).toMatchObject({ status: "completed", result: { mixed: { value: "second" } } });
          expect(projection.frames.root).toMatchObject({ status: "completed" });
        } finally {
          store.close();
        }
      });
    });

  it("advances multi-node root fanout item bodies across repeated frozen-run drives", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-fanout-multi-node", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, multiNodeRootFanoutWorkflow());
        const store = await openRuntimeStore(workspace);
        try {
          const run = await store.admitRun({ prepared, input: { items: ["a", "b"] }, cwd: workspace });
          const fanoutKey = deriveInstanceKey(appendNode([], "items"));

          await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store })).resolves.toMatchObject({ status: "idle", started: 2, completed: 2 });
          expect(Object.values(throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection.groupMembers).every(member => member.status === "running")).toBe(true);

          await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-b", store })).resolves.toMatchObject({ status: "completed", started: 2, completed: 2 });
          const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(projection.frames[fanoutKey]).toMatchObject({
            status: "completed",
            result: [
              { item: "a", value: "a-second" },
              { item: "b", value: "b-second" },
            ],
          });
          expect(Object.values(projection.groupMembers).map(member => member.output)).toEqual([
            { item: "a", value: "a-second" },
            { item: "b", value: "b-second" },
          ]);
        } finally {
          store.close();
        }
      });
    });

  it("passes the configured per-run leaf ceiling into frozen-run scheduling", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-run-leaf-ceiling", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, multiNodeRootFanoutWorkflow());
        const store = await openRuntimeStore(workspace);
        try {
          const run = await store.admitRun({ prepared, input: { items: ["a", "b"] }, cwd: workspace });

          await expect(advanceFrozenRun({
            cwd: workspace,
            runId: run.id,
            ownerId: "owner-a",
            store,
            maxLeafConcurrency: 1,
          })).resolves.toMatchObject({ status: "idle", started: 1, completed: 1 });

          const firstNodes = Object.values(throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection.instances)
            .filter(instance => instance.nodeId === "first_task");
          expect(firstNodes.filter(instance => instance.status === "completed")).toHaveLength(1);
          expect(firstNodes.filter(instance => instance.status === "ready")).toHaveLength(1);
        } finally {
          store.close();
        }
      });
    });

  it("executes nested fanout items with ancestor scope and local concurrency", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-nested-fanout-scope", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, nestedFanoutInParallelWorkflow());
        const store = await openRuntimeStore(workspace);
        try {
          const run = await store.admitRun({ prepared, input: { items: ["a", "b"], parallelism: 1 }, cwd: workspace });
          const firstItemNodeKey = deriveInstanceKey(appendNode(appendFanoutItem(appendBranch([], "combine", "items"), "inner_items", 0), "inner_task"));
          const secondItemNodeKey = deriveInstanceKey(appendNode(appendFanoutItem(appendBranch([], "combine", "items"), "inner_items", 1), "inner_task"));

          await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store })).resolves.toMatchObject({ status: "idle", started: 1, completed: 1 });
          expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection.instances[firstItemNodeKey]).toMatchObject({ status: "ready" });
          expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection.instances[secondItemNodeKey]).toMatchObject({ status: "ready" });

          await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-b", store })).resolves.toMatchObject({ status: "idle", started: 1, completed: 1 });
          const afterFirstItem = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(Object.values(afterFirstItem.instances).filter(instance => instance.nodeId === "inner_task" && instance.status === "completed")).toHaveLength(1);
          expect(Object.values(afterFirstItem.instances).filter(instance => instance.nodeId === "inner_task" && instance.status === "ready")).toHaveLength(1);
          expect(afterFirstItem.instances[deriveInstanceKey(appendNode(appendBranch([], "combine", "sibling"), "sibling_task"))]).toMatchObject({ status: "ready" });

          await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-c", store })).resolves.toMatchObject({ status: "idle", started: 1, completed: 1 });
          await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-d", store })).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });
          const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(projection.frames.root).toMatchObject({
            status: "completed",
            result: {
              values: [{ value: "root-a-0" }, { value: "root-b-1" }],
              sibling: "root-sibling",
            },
          });
          const details = store.getRun(run.id);
          expect(details?.dynamic?.frames.find(frame => frame.frameKey === deriveInstanceKey(appendBranch([], "combine", "items")))).toMatchObject({
            frameKind: "branch",
            instancePath: appendBranch([], "combine", "items"),
          });
          expect(details?.dynamic?.nodeInstances.find(instance => instance.nodeKey === firstItemNodeKey)).toMatchObject({
            nodeId: "inner_task",
            instancePath: appendNode(appendFanoutItem(appendBranch([], "combine", "items"), "inner_items", 0), "inner_task"),
          });
          expect(details?.dynamic?.groupMembers.find(member => member.memberKey === deriveInstanceKey(appendFanoutItem(appendBranch([], "combine", "items"), "inner_items", 0)))).toMatchObject({
            childFrameKey: deriveInstanceKey(appendFanoutItem(appendBranch([], "combine", "items"), "inner_items", 0)),
          });
          expect(details?.dynamic?.groups).toEqual(expect.arrayContaining([
            expect.objectContaining({ nodeId: "combine", maxConcurrency: 1 }),
            expect.objectContaining({ nodeId: "inner_items", maxConcurrency: 1 }),
          ]));
        } finally {
          store.close();
        }
      });
    });

  it("counts awaiting signal members against nested local concurrency", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-signal-local-concurrency", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, parallelSignalConcurrencyWorkflow());
        const store = await openRuntimeStore(workspace);
        try {
          const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
          const gateKey = deriveInstanceKey(appendNode([], "gate"));
          const leftBranchKey = deriveInstanceKey(appendBranch([], "gate", "left"));
          const rightBranchKey = deriveInstanceKey(appendBranch([], "gate", "right"));
          const leftSignalKey = deriveInstanceKey(appendNode(appendBranch([], "gate", "left"), "left_signal"));
          const rightSignalKey = deriveInstanceKey(appendNode(appendBranch([], "gate", "right"), "right_signal"));

          await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store })).resolves.toMatchObject({ status: "awaiting", started: 0 });
          const awaiting = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(awaiting.instances[leftSignalKey]).toMatchObject({ status: "awaiting" });
          expect(awaiting.instances[rightSignalKey]).toMatchObject({ status: "ready" });
          expect(awaiting.groupMembers[leftBranchKey]).toMatchObject({ status: "running" });
          expect(awaiting.groupMembers[rightBranchKey]).toMatchObject({ status: "ready" });
          expect(awaiting.signalWaits[rightSignalKey]).toBeUndefined();

          await expect(applySchedulerControlIntent(workspace, store, {
            requestId: `signal:${run.id}:left`,
            runId: run.id,
            type: "signal",
            node: "left_signal",
            payload: { ok: true },
            commandIdempotencyKey: `signal:${run.id}:left`,
          }, { ownerId: "owner-b" })).resolves.toMatchObject({
            advanced: { status: "awaiting", started: 0 },
          });
          const rightAwaiting = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(rightAwaiting.instances[rightSignalKey]).toMatchObject({ status: "awaiting" });
          expect(rightAwaiting.groupMembers[rightBranchKey]).toMatchObject({ status: "running" });

          await expect(applySchedulerControlIntent(workspace, store, {
            requestId: `signal:${run.id}:right`,
            runId: run.id,
            type: "signal",
            node: "right_signal",
            payload: { ok: true },
            commandIdempotencyKey: `signal:${run.id}:right`,
          }, { ownerId: "owner-c" })).resolves.toMatchObject({
            advanced: { status: "completed", started: 0 },
          });
          expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection.frames[gateKey]).toMatchObject({ status: "completed" });
        } finally {
          store.close();
        }
      });
    });

  it("advances a root loop single-leaf task across repeated frozen-run drives", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-loop", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, rootLoopTaskWorkflow());
        const store = await openRuntimeStore(workspace);
        let runId = "";
        try {
          const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
          runId = run.id;
          const first = await advanceFrozenRun({ cwd: workspace, runId, ownerId: "owner-a", store });
          expect(first).toMatchObject({ status: "idle", started: 1, completed: 1 });
          expect(Object.values(throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId).projection.instances).filter(instance => instance.status === "ready")).toHaveLength(1);
        } finally {
          store.close();
        }

        const resumed = await openRuntimeStore(workspace);
        try {
          const second = await advanceFrozenRun({ cwd: workspace, runId, ownerId: "owner-b", store: resumed });
          const projection = throwingSchedulerStore(resumed.scheduler).loadRunSnapshot(runId).projection;
          const loopFrame = Object.values(projection.frames).find(frame => frame.frameKind === "loop");
          expect(second).toMatchObject({ status: "completed", started: 1, completed: 1 });
          expect(projection.frames.root).toMatchObject({ status: "completed" });
          expect(loopFrame).toMatchObject({
            status: "completed",
            result: { done: true, iter: 1 },
            terminalReason: "stopped",
            loop: {
              index: 1,
              round: 2,
              state: { done: true, iter: 1 },
              transition: { state: { done: true, iter: 1 }, stop: true },
            },
          });
          const persistedLoopFrame = resumed.getRun(runId)?.dynamic?.frames.find(frame => frame.frameKind === "loop");
          expect(persistedLoopFrame?.loop).toMatchObject({
            index: 1,
            round: 2,
            state: { done: true, iter: 1 },
            transition: { state: { done: true, iter: 1 }, stop: true },
          });
          expect(Object.values(projection.instances).filter(instance => instance.status === "completed").map(instance => instance.output)).toEqual([
            { done: false, rawIter: 0 },
            { done: true, rawIter: 1 },
          ]);
        } finally {
          resumed.close();
        }
      });
    });

  it("advances a root loop multi-node body across repeated frozen-run drives", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-loop-multi-node", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, multiNodeRootLoopWorkflow());
        const store = await openRuntimeStore(workspace);
        try {
          const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
          const loopKey = deriveInstanceKey(appendNode([], "retry"));

          await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store })).resolves.toMatchObject({ status: "idle", started: 1, completed: 1 });
          await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-b", store })).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });

          const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(projection.frames[loopKey]).toMatchObject({
            status: "completed",
            result: { done: true, value: "first-0-second-0" },
          });
          expect(Object.values(projection.frames).find(frame => frame.frameKind === "loop_iteration")).toMatchObject({
            status: "completed",
            result: { state: { done: true, value: "first-0-second-0" }, stop: true },
          });
        } finally {
          store.close();
        }
      });
    });
});

function failingRootAssertWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-failing-assert",
  }).build(({ step }) => {
    step("fail").assert({ condition: false });
    return {};
  });
}

function failingExpressionCallbackWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-failing-expression-callback",
  }).build(({ step }) => {
    step("fail").assert({ condition: lift(true, _value => new Date() as any) });
    return {};
  });
}

function rootSignalWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-signal",
  }).build(({ step }) => {
    const approval = step("approve").signal({
      outputSchema: z.object({ ok: z.boolean() }),
      prompt: "approve",
    });
    return { ok: approval.output.ok };
  });
}

function rootTimedSignalWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-signal-timeout",
    inputSchema: z.object({ timeout: z.string(), prompt: z.string(), timeoutMessage: z.string() }),
  }).build(({ input, step }) => {
    const approval = step("approve").signal({
      outputSchema: z.object({ ok: z.boolean() }),
      timeout: input.timeout,
      onTimeout: { message: input.timeoutMessage },
      prompt: input.prompt,
    });
    return { ok: approval.output.ok };
  });
}

function sequentialRootTaskWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-root-sequence",
  }).build(({ step }) => {
    const first = step("first_task").task({
      input: {}, exec: async () => ({ value: "first" }),
    });
    const second = step("second_task").task({
      input: { value: first.output.value },
      exec: async ({ input }) => ({ value: `${input.value}-second` }),
    });
    return { final: second.output.value };
  });
}

function rootIfTaskWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-root-if",
    inputSchema: z.object({ shouldRun: z.boolean() }),
  }).build(({ input, step }) => {
    step("require_run").assert({ condition: input.shouldRun });
    const gate = step("gate").if({
      condition: input.shouldRun,
      then() {
        const task = step("then_task").task({
          input: {}, exec: async () => ({ value: "then" }),
        });
        return { value: task.output.value };
      },
      else() { return { value: template`else` }; },
    });
    const final = step("final_task").task({
      input: { value: gate.output.value },
      exec: async ({ input }) => ({ final: `${input.value}-final` }),
    });
    return { final: final.output.final };
  });
}

function rootIfSequentialTaskWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-root-if-sequence",
    inputSchema: z.object({ shouldRun: z.boolean() }),
  }).build(({ input, step }) => {
    const gate = step("gate").if({
      condition: input.shouldRun,
      then() {
        const first = step("then_first").task({
          input: {}, exec: async () => ({ value: "first" }),
        });
        const second = step("then_second").task({
          input: { value: first.output.value },
          exec: async ({ input }) => ({ value: `${input.value}-second` }),
        });
        return { value: second.output.value };
      },
      else() { return { value: template`else` }; },
    });
    const final = step("final_task").task({
      input: { value: gate.output.value },
      exec: async ({ input }) => ({ final: `${input.value}-final` }),
    });
    return { final: final.output.final };
  });
}

function rootSwitchSequentialTaskWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-root-switch-sequence",
    inputSchema: z.object({ mode: z.string() }),
  }).build(({ input, step }) => {
    const route = step("route").switch({
      cases: [
        {
          when: lift(input.mode, mode => mode === "case"),
          then() {
            const first = step("case_first").task({
              input: {}, exec: async () => ({ value: "case" }),
            });
            const second = step("case_second").task({
              input: { value: first.output.value },
              exec: async ({ input }) => ({ value: `${input.value}-second` }),
            });
            return { value: second.output.value };
          },
        },
      ],
      default() { return { value: template`default` }; },
    });
    return { value: route.output.value };
  });
}

function rootParallelTaskWorkflow(options: { maxConcurrency?: number; dynamicMaxConcurrency?: boolean } = {}) {
  return defineWorkflow({
    name: "scheduler-node-executor-root-parallel",
    inputSchema: z.object({ maxConcurrency: z.number().default(options.maxConcurrency ?? 2) }),
  }).build(({ input, step }) => {
    step("race").parallel({
      ...(options.dynamicMaxConcurrency ? { maxConcurrency: input.maxConcurrency } : options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
      branches: {
        left() {
          const task = step("left_task").task({
            input: {}, exec: async () => ({ value: "left" }),
          });
          return { value: task.output.value, rootPrefix: "root" };
        },
        right() {
          const task = step("right_task").task({
            input: {}, exec: async () => ({ value: "right" }),
          });
          return { value: task.output.value };
        },
      },
    });
    return {};
  });
}

function sequentialRootParallelWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-root-sequence-parallel",
  }).build(({ step }) => {
    const prepare = step("prepare_task").task({
      input: {}, exec: async () => ({ prefix: "root" }),
    });
    const combined = step("combine").parallel({
      branches: {
        left() {
          const task = step("left_task").task({
            input: { prefix: prepare.output.prefix },
            exec: async ({ input }: { input: { prefix: string } }) => ({ value: `${input.prefix}-left` }),
          });
          return { value: task.output.value, rootPrefix: prepare.output.prefix };
        },
        right() {
          const task = step("right_task").task({
            input: { prefix: prepare.output.prefix },
            exec: async ({ input }: { input: { prefix: string } }) => ({ value: `${input.prefix}-right` }),
          });
          return { value: task.output.value, rootPrefix: prepare.output.prefix };
        },
      },
    });
    return { finalValue: combined.output.left.value, finalPrefix: combined.output.left.rootPrefix };
  });
}

function multiNodeRootParallelWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-root-parallel-multi-node",
  }).build(({ step }) => {
    step("parallel").parallel({
      branches: {
        mixed() {
          step("first_task").task({
            input: {}, exec: async () => ({ value: "first" }),
          });
          const second = step("second_task").task({
            input: {}, exec: async () => ({ value: "second" }),
          });
          return { value: second.output.value };
        },
      },
    });
    return {};
  });
}

function multiNodeRootFanoutWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-root-fanout-multi-node",
    inputSchema: z.object({ items: z.array(z.string()) }),
  }).build(({ input, step }) => {
    step("items").fanout({
      over: input.items,
      do({ item }) {
        const first = step("first_task").task({
          input: { item },
          exec: async ({ input }) => ({ value: `${input.item}-first` }),
        });
        const second = step("second_task").task({
          input: { item, first: first.output.value },
          exec: async ({ input }) => ({ item: input.item, value: input.first.replace("first", "second") }),
        });
        return { item: second.output.item, value: second.output.value };
      },
    });
    return {};
  });
}

function nestedFanoutInParallelWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-nested-fanout",
    inputSchema: z.object({ items: z.array(z.string()), parallelism: z.number() }),
  }).build(({ input, step }) => {
    const prepare = step("prepare").task({
      input: {}, exec: async () => ({ prefix: "root" }),
    });
    const combined = step("combine").parallel({
      maxConcurrency: input.parallelism,
      branches: {
        items() {
          const inner = step("inner_items").fanout({
            over: input.items,
            maxConcurrency: input.parallelism,
            do({ item, itemIndex }) {
              const task = step("inner_task").task({
                input: { prefix: prepare.output.prefix, item, itemIndex },
                exec: async ({ input }: { input: { prefix: string; item: string; itemIndex: number } }) => ({ value: `${input.prefix}-${input.item}-${input.itemIndex}` }),
              });
              return { value: task.output.value };
            },
          });
          return { values: inner.output };
        },
        sibling() {
          const task = step("sibling_task").task({
            input: { prefix: prepare.output.prefix },
            exec: async ({ input }: { input: { prefix: string } }) => ({ value: `${input.prefix}-sibling` }),
          });
          return { value: task.output.value };
        },
      },
    });
    return { values: combined.output.items.values, sibling: combined.output.sibling.value };
  });
}

function parallelSignalConcurrencyWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-signal-local-concurrency",
  }).build(({ step }) => {
    const gate = step("gate").parallel({
      maxConcurrency: 1,
      branches: {
        left() {
          const approval = step("left_signal").signal({
            outputSchema: z.object({ ok: z.boolean() }),
            prompt: "left",
          });
          return { ok: approval.output.ok };
        },
        right() {
          const approval = step("right_signal").signal({
            outputSchema: z.object({ ok: z.boolean() }),
            prompt: "right",
          });
          return { ok: approval.output.ok };
        },
      },
    });
    return { gate: gate.output };
  });
}

function rootFanoutTaskWorkflow(options: { strategy?: "all" | "quorum"; count?: number; maxConcurrency?: number; abortItem?: string; dynamicLimits?: boolean } = {}) {
  return defineWorkflow({
    name: "scheduler-node-executor-root-fanout",
    inputSchema: z.object({
      items: z.array(z.string()),
      quorum: z.number().default(options.count ?? 1),
      parallelism: z.number().default(options.maxConcurrency ?? 32),
    }),
  }).build(({ input, step }) => {
    if (options.strategy === "quorum") {
      step("items").fanout({
        over: input.items,
        strategy: "quorum",
        count: options.dynamicLimits ? input.quorum : options.count ?? 1,
        ...(options.dynamicLimits ? { maxConcurrency: input.parallelism } : options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
        do({ item, itemIndex }) {
          const task = step("item_task").task({
            input: { item, itemIndex, abortItem: options.abortItem ?? null },
            exec: async ({ input, abortSignal }) => {
              if (input.item !== input.abortItem) return { item: input.item, index: input.itemIndex };
              return await new Promise<{ item: string; index: number }>(resolve => {
                const timer = setTimeout(() => resolve({ item: "not-aborted", index: input.itemIndex }), 1_000);
                abortSignal.addEventListener("abort", () => {
                  clearTimeout(timer);
                  resolve({ item: input.item, index: input.itemIndex });
                }, { once: true });
              });
            },
          });
          return { item: task.output.item, index: task.output.index };
        },
      });
    } else {
      step("items").fanout({
        over: input.items,
        ...(options.dynamicLimits ? { maxConcurrency: input.parallelism } : options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
        do({ item, itemIndex }) {
          const task = step("item_task").task({
            input: { item, itemIndex, abortItem: options.abortItem ?? null },
            exec: async ({ input, abortSignal }) => {
              if (input.item !== input.abortItem) return { item: input.item, index: input.itemIndex };
              return await new Promise<{ item: string; index: number }>(resolve => {
                const timer = setTimeout(() => resolve({ item: "not-aborted", index: input.itemIndex }), 1_000);
                abortSignal.addEventListener("abort", () => {
                  clearTimeout(timer);
                  resolve({ item: input.item, index: input.itemIndex });
                }, { once: true });
              });
            },
          });
          return { item: task.output.item, index: task.output.index };
        },
      });
    }
    return {};
  });
}

function rootLoopTaskWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-root-loop",
  }).build(({ step }) => {
    step("retry").loop({
      state: { done: false as boolean, iter: -1 },
      do({ index }) {
        const task = step("loop_task").task({
          input: { iter: index },
          exec: async ({ input }) => ({ done: input.iter >= 1, rawIter: input.iter }),
        });
        return {
          state: { done: task.output.done, iter: task.output.rawIter },
          stop: task.output.done,
        };
      },
    });
    return {};
  });
}

function multiNodeRootLoopWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-root-loop-multi-node",
  }).build(({ step }) => {
    step("retry").loop({
      state: { done: false as boolean, value: "" },
      do({ index }) {
        const first = step("first_task").task({
          input: { iter: index },
          exec: async ({ input }) => ({ value: `first-${input.iter}` }),
        });
        const second = step("second_task").task({
          input: { iter: index, first: first.output.value },
          exec: async ({ input }) => ({ done: true, value: `${input.first}-second-${input.iter}` }),
        });
        return {
          state: { done: second.output.done, value: second.output.value },
          stop: second.output.done,
        };
      },
    });
    return {};
  });
}
