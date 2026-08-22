import * as Result from "effect/Result";
import {
  advanceFrozenRun,
  holdFirstTaskAttempt,
  multiNodeRootFanoutWorkflow,
  multiNodeRootLoopWorkflow,
  multiNodeRootParallelWorkflow,
  nestedFanoutInParallelWorkflow,
  parallelSignalConcurrencyWorkflow,
  rootFanoutTaskWorkflow,
  rootLoopTaskWorkflow,
  taskMocks,
} from "./support/scheduler-runtime-runner.js";
import { admitRunForTest } from "./support/runtime-store.js";
import { describe, expect, it, vi } from "vitest";
import {
  appendBranch,
  appendFanoutItem,
  appendNode,
  deriveInstanceKey,
} from "../src/scheduler/identity.js";
import { openRuntimeStoreAdapter } from "../src/store/store.js";
import { tryNormalizeWorkflowInput } from "../src/admission/input.js";
import { prepareSyntheticWorkflow, runtimeRow, withRuntimeWorkspace } from "./support/runtime-harness.js";
import { throwingSchedulerStore } from "./support/scheduler-store.js";
import { applySchedulerControlIntent } from "./support/scheduler.js";

describe("runtime scheduler runner", () => {
  it("bootstraps root fanout items with durable item scope for task inputs", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-fanout", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, rootFanoutTaskWorkflow());
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: { items: ["a", "b"] }, cwd: workspace });
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
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const input = Result.getOrThrow(tryNormalizeWorkflowInput(prepared.ir, { items: ["a", "b"] }));
          const run = await admitRunForTest(store, { prepared, input, cwd: workspace });
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
        const firstStore = await openRuntimeStoreAdapter(workspace);
        let runId = "";
        try {
          const run = await admitRunForTest(firstStore, { prepared, input: { items: ["a", "b", "c"], quorum: 2, parallelism: 1 }, cwd: workspace });
          runId = run.id;
          const first = await advanceFrozenRun({ cwd: workspace, runId, ownerId: "owner-a", store: firstStore, maxLeafConcurrency: 0 });
          expect(first).toMatchObject({ status: "idle", started: 0, completed: 0 });
          expect(Object.values(throwingSchedulerStore(firstStore.scheduler).loadRunSnapshot(runId).projection.groups)[0]).toMatchObject({ quorumCount: 2, maxConcurrency: 1 });
        } finally {
          firstStore.close();
        }

        const resumedStore = await openRuntimeStoreAdapter(workspace);
        try {
          const second = await advanceFrozenRun({ cwd: workspace, runId, ownerId: "owner-b", store: resumedStore });
          const projection = throwingSchedulerStore(resumedStore.scheduler).loadRunSnapshot(runId).projection;
          expect(second).toMatchObject({ status: "completed", started: 2, completed: 2 });
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

  it("honors root fanout quorum and cancels surplus work admitted before quorum settlement", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-fanout-quorum", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, rootFanoutTaskWorkflow({ strategy: "quorum", dynamicLimits: true }));
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: { items: ["a", "b", "c"], quorum: 2, parallelism: 2 }, cwd: workspace });
          const summary = await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store });
          const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;

          expect(summary).toMatchObject({ status: "completed", started: 3, completed: 2, cancelled: 1 });
          const fanoutFrame = projection.frames[deriveInstanceKey(appendNode([], "items"))];
          expect(fanoutFrame).toMatchObject({ status: "completed" });
          expect(fanoutFrame?.result).toHaveLength(2);
          expect(fanoutFrame?.result).toEqual(expect.arrayContaining([
            { item: "a", index: 0 },
            { item: "b", index: 1 },
          ]));
          expect(Object.values(projection.groupMembers).filter(member => member.status === "completed")).toHaveLength(2);
          expect(Object.values(projection.groupMembers).filter(member => member.status === "cancelled")).toHaveLength(1);
          expect(Object.values(projection.attempts).filter(attempt => attempt.status === "cancelled")).toHaveLength(1);
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
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: { items: ["slow", "fast"] }, cwd: workspace });
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

  it("advances a multi-node root parallel branch to completion", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-parallel-multi-node", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, multiNodeRootParallelWorkflow());
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
          const parallelKey = deriveInstanceKey(appendNode([], "parallel"));
          const branchKey = deriveInstanceKey(appendBranch([], "parallel", "mixed"));

          await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store })).resolves.toMatchObject({ status: "completed", started: 2, completed: 2 });
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

  it("advances multi-node root fanout item bodies to completion", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-fanout-multi-node", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, multiNodeRootFanoutWorkflow());
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: { items: ["a", "b"] }, cwd: workspace });
          const fanoutKey = deriveInstanceKey(appendNode([], "items"));

          await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store })).resolves.toMatchObject({ status: "completed", started: 4, completed: 4 });
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

  it("keeps physical execution within the configured per-run leaf ceiling", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-run-leaf-ceiling", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, multiNodeRootFanoutWorkflow());
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: { items: ["a", "b"] }, cwd: workspace });
          const controlled = holdFirstTaskAttempt();

          const advancing = advanceFrozenRun({
            cwd: workspace,
            runId: run.id,
            ownerId: "owner-a",
            store,
            maxLeafConcurrency: 1,
          });
          await vi.waitFor(() => expect(taskMocks.runTaskAttempt).toHaveBeenCalledTimes(1));
          controlled.releaseFirst();
          await expect(advancing).resolves.toMatchObject({ status: "completed", started: 4, completed: 4 });

          const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(controlled.peak()).toBe(1);
          expect(taskMocks.runTaskAttempt).toHaveBeenCalledTimes(4);
          expect(Object.values(projection.instances).filter(instance => instance.status === "completed")).toHaveLength(4);
        } finally {
          store.close();
        }
      });
    });

  it("executes nested fanout items with ancestor scope and local concurrency", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-nested-fanout-scope", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, nestedFanoutInParallelWorkflow());
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: { items: ["a", "b"], parallelism: 1 }, cwd: workspace });
          const firstItemNodeKey = deriveInstanceKey(appendNode(appendFanoutItem(appendBranch([], "combine", "items"), "inner_items", 0), "inner_task"));
          const secondItemNodeKey = deriveInstanceKey(appendNode(appendFanoutItem(appendBranch([], "combine", "items"), "inner_items", 1), "inner_task"));

          await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store })).resolves.toMatchObject({ status: "completed", started: 4, completed: 4 });
          const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
          expect(projection.instances[firstItemNodeKey]).toMatchObject({ status: "completed", output: { value: "root-a-0" } });
          expect(projection.instances[secondItemNodeKey]).toMatchObject({ status: "completed", output: { value: "root-b-1" } });
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
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
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

  it("resumes a root loop single-leaf task from a durable ready checkpoint", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-loop", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, rootLoopTaskWorkflow());
        const store = await openRuntimeStoreAdapter(workspace);
        let runId = "";
        try {
          const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
          runId = run.id;
          const first = await advanceFrozenRun({ cwd: workspace, runId, ownerId: "owner-a", store, maxLeafConcurrency: 0 });
          expect(first).toMatchObject({ status: "idle", started: 0, completed: 0 });
          expect(Object.values(throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId).projection.instances).filter(instance => instance.status === "ready")).toHaveLength(1);
        } finally {
          store.close();
        }

        const resumed = await openRuntimeStoreAdapter(workspace);
        try {
          const second = await advanceFrozenRun({ cwd: workspace, runId, ownerId: "owner-b", store: resumed });
          const projection = throwingSchedulerStore(resumed.scheduler).loadRunSnapshot(runId).projection;
          const loopFrame = Object.values(projection.frames).find(frame => frame.frameKind === "loop");
          expect(second).toMatchObject({ status: "completed", started: 2, completed: 2 });
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

  it("advances a root loop multi-node body to completion", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-root-loop-multi-node", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, multiNodeRootLoopWorkflow());
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
          const loopKey = deriveInstanceKey(appendNode([], "retry"));

          await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store })).resolves.toMatchObject({ status: "completed", started: 2, completed: 2 });

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
