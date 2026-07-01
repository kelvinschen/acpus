import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineWorkflow, z } from "@acpus/core";
import { eq } from "@acpus/expression";
import { describe, expect, it } from "vitest";
import { appendBranch, appendNode, deriveInstanceKey } from "../src/scheduler/identity.js";
import { createRuntimeNodeExecutor } from "../src/scheduler/node-executor.js";
import { advanceFrozenRun } from "../src/scheduler/runtime-runner.js";
import { applySchedulerControlCommand } from "../src/scheduler/control.js";
import { executeAgentNode } from "../src/execution/agent-node.js";
import { openRuntimeStore } from "../src/store/store.js";
import { prepareSyntheticWorkflow, runtimeRow, runtimeRows, withRuntimeWorkspace } from "./support/runtime-fixtures.js";

describe("runtime scheduler node executor", () => {
  it("boots a frozen root task into durable scheduler projection and executes it", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-bootstrap", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, taskRuntimeContextWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });

        const nodeKey = deriveInstanceKey(appendNode([], "context_task"));
        await advanceFrozenRun({
          cwd: workspace,
          runId: run.id,
          ownerId: "owner-a",
          store,
        });

        const projection = store.scheduler.loadRunSnapshot(run.id).projection;
        expect(projection.frames.root).toMatchObject({ status: "completed", result: {} });
        expect(projection.run).toMatchObject({ status: "completed" });
        expect(store.getRun(run.id)).toMatchObject({ status: "completed", output: {} });
        expect(projection.instances[nodeKey]).toMatchObject({
          status: "completed",
          nodeId: "context_task",
          output: {
            artifact: { kind: "artifact" },
          },
        });
        expect(runtimeRow(workspace, "SELECT attempt, relative_path FROM artifacts WHERE run_id = ? AND node_key = ?", run.id, nodeKey)).toMatchObject({ attempt: 1 });
        expect(runtimeRow(workspace, "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type = 'run.completed'", run.id)).toMatchObject({ count: 1 });
      } finally {
        store.close();
      }
    });
  });

  it("bridges scheduler root failure to the public run projection", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-public-failed", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, failingRootAssertWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });

        await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store })).resolves.toMatchObject({ status: "failed" });

        expect(store.scheduler.loadRunSnapshot(run.id).projection.frames.root).toMatchObject({ status: "failed" });
        expect(store.getRun(run.id)).toMatchObject({ status: "failed" });
        expect(store.getRun(run.id)?.output).toBeUndefined();
        expect(runtimeRow(workspace, "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type = 'run.failed'", run.id)).toMatchObject({ count: 1 });
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

        const command = store.submitCommand({ runId: run.id, type: "signal", payload: { node: "approve", payload: { ok: true } }, idempotencyKey: `signal:${run.id}:approve` });
        const applied = await applySchedulerControlCommand(workspace, store, command, { ownerId: "owner-b" });

        expect(applied.advanced).toMatchObject({ status: "completed" });
        expect(store.scheduler.loadRunSnapshot(run.id).projection.instances[nodeKey]).toMatchObject({ status: "completed", output: { ok: true } });
        expect(store.getRun(run.id)).toMatchObject({ status: "completed", output: { ok: true } });
        expect(runtimeRow(workspace, "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type = 'run.completed'", run.id)).toMatchObject({ count: 1 });
      } finally {
        store.close();
      }
    });
  });

  it("does not duplicate root bootstrap, attempts, or artifacts on repeated frozen-run advance", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-bootstrap-repeat", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, taskRuntimeContextWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const nodeKey = deriveInstanceKey(appendNode([], "context_task"));

        await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store })).resolves.toMatchObject({ status: "completed", started: 1 });
        await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-b", store })).resolves.toMatchObject({ status: "completed", started: 0, ownerEpoch: 2 });

        expect(runtimeRow(workspace, "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type = 'frame.started'", run.id)).toMatchObject({ count: 1 });
        expect(runtimeRow(workspace, "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type = 'instance.ready' AND node_key = ?", run.id, nodeKey)).toMatchObject({ count: 1 });
        expect(runtimeRow(workspace, "SELECT COUNT(*) AS count FROM node_attempts WHERE run_id = ? AND node_key = ?", run.id, nodeKey)).toMatchObject({ count: 1 });
        expect(runtimeRow(workspace, "SELECT COUNT(*) AS count FROM artifacts WHERE run_id = ? AND node_key = ?", run.id, nodeKey)).toMatchObject({ count: 1 });
        expect(store.scheduler.loadRunSnapshot(run.id).projection.instances[nodeKey]).toMatchObject({ status: "completed" });
      } finally {
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
        const afterFirst = store.scheduler.loadRunSnapshot(run.id).projection;
        expect(first).toMatchObject({ status: "idle", started: 1, completed: 1 });
        expect(afterFirst.instances[firstKey]).toMatchObject({ status: "completed", output: { value: "first" } });
        expect(afterFirst.instances[secondKey]).toMatchObject({ status: "ready", readinessSequence: 2 });
        expect(afterFirst.frames.root).toMatchObject({ status: "running" });

        const second = await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-b", store });
        const afterSecond = store.scheduler.loadRunSnapshot(run.id).projection;
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
        const afterFirst = store.scheduler.loadRunSnapshot(run.id).projection;
        expect(first).toMatchObject({ status: "idle", started: 1, completed: 1 });
        expect(afterFirst.frames[assertKey]).toMatchObject({ status: "completed", result: {} });
        expect(afterFirst.branchDecisions[ifKey]).toBe("then");
        expect(afterFirst.instances[branchTaskKey]).toMatchObject({ status: "completed", output: { value: "then" } });
        expect(afterFirst.frames[branchKey]).toMatchObject({ status: "completed", result: { value: "then" } });
        expect(afterFirst.frames[ifKey]).toMatchObject({ status: "completed", result: { value: "then" } });
        expect(afterFirst.instances[finalKey]).toMatchObject({ status: "ready" });

        const second = await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-b", store });
        const afterSecond = store.scheduler.loadRunSnapshot(run.id).projection;
        expect(second).toMatchObject({ status: "completed", started: 1, completed: 1 });
        expect(afterSecond.instances[finalKey]).toMatchObject({ status: "completed", output: { final: "then-final" } });
        expect(afterSecond.frames.root).toMatchObject({ status: "completed", result: { final: "then-final" } });
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
        const afterFirst = store.scheduler.loadRunSnapshot(run.id).projection;
        expect(first).toMatchObject({ status: "idle", started: 1, completed: 1 });
        expect(afterFirst.instances[firstKey]).toMatchObject({ status: "completed", output: { value: "first" } });
        expect(afterFirst.instances[secondKey]).toMatchObject({ status: "ready" });
        expect(afterFirst.frames[branchKey]).toMatchObject({ status: "running" });
        expect(afterFirst.frames[ifKey]).toMatchObject({ status: "running" });

        const second = await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-b", store });
        const afterSecond = store.scheduler.loadRunSnapshot(run.id).projection;
        expect(second).toMatchObject({ status: "idle", started: 1, completed: 1 });
        expect(afterSecond.instances[secondKey]).toMatchObject({ status: "completed", output: { value: "first-second" } });
        expect(afterSecond.frames[branchKey]).toMatchObject({ status: "completed", result: { value: "first-second" } });
        expect(afterSecond.frames[ifKey]).toMatchObject({ status: "completed", result: { value: "first-second" } });
        expect(afterSecond.instances[finalKey]).toMatchObject({ status: "ready" });

        const final = await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-c", store });
        const afterFinal = store.scheduler.loadRunSnapshot(run.id).projection;
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
        const branchKey = deriveInstanceKey(appendBranch([], "route", "case_0"));
        const firstKey = deriveInstanceKey(appendNode(appendBranch([], "route", "case_0"), "case_first"));
        const secondKey = deriveInstanceKey(appendNode(appendBranch([], "route", "case_0"), "case_second"));

        await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store });
        const afterFirst = store.scheduler.loadRunSnapshot(run.id).projection;
        expect(afterFirst.branchDecisions[switchKey]).toBe("case_0");
        expect(afterFirst.instances[firstKey]).toMatchObject({ status: "completed", output: { value: "case" } });
        expect(afterFirst.instances[secondKey]).toMatchObject({ status: "ready" });
        expect(afterFirst.frames[branchKey]).toMatchObject({ status: "running" });

        await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-b", store });
        const afterSecond = store.scheduler.loadRunSnapshot(run.id).projection;
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

        await expect(advanceFrozenRun({
          cwd: workspace,
          runId,
          ownerId: "owner-a",
          store: firstStore,
          maxLeafConcurrency: 0,
        })).resolves.toMatchObject({ status: "idle", started: 0, completed: 0 });

        const projection = firstStore.scheduler.loadRunSnapshot(runId).projection;
        expect(projection.branchDecisions[ifKey]).toBe("then");
        expect(projection.frames[branchKey]).toMatchObject({ status: "running" });
        expect(projection.instances[branchTaskKey]).toMatchObject({ status: "ready" });
        expect(JSON.parse(String(runtimeRow(workspace, "SELECT instance_path_json FROM scheduler_frames WHERE run_id = ? AND frame_key = ?", runId, ifKey)?.instance_path_json))).toEqual([{ kind: "node", nodeId: "gate" }]);
        expect(JSON.parse(String(runtimeRow(workspace, "SELECT instance_path_json FROM scheduler_frames WHERE run_id = ? AND frame_key = ?", runId, branchKey)?.instance_path_json))).toEqual([{ kind: "branch", nodeId: "gate", branchId: "then" }]);
      } finally {
        firstStore.close();
      }

      const resumedStore = await openRuntimeStore(workspace);
      try {
        await expect(advanceFrozenRun({ cwd: workspace, runId, ownerId: "owner-b", store: resumedStore })).resolves.toMatchObject({ status: "idle", started: 1, completed: 1 });
        const afterBranch = resumedStore.scheduler.loadRunSnapshot(runId).projection;
        expect(afterBranch.branchDecisions[ifKey]).toBe("then");
        expect(afterBranch.instances[branchTaskKey]).toMatchObject({ status: "completed", output: { value: "then" } });
        expect(afterBranch.frames[branchKey]).toMatchObject({ status: "completed", result: { value: "then" } });
        expect(afterBranch.frames[ifKey]).toMatchObject({ status: "completed", result: { value: "then" } });
        expect(afterBranch.instances[finalKey]).toMatchObject({ status: "ready" });

        await expect(advanceFrozenRun({ cwd: workspace, runId, ownerId: "owner-c", store: resumedStore })).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });
        expect(resumedStore.scheduler.loadRunSnapshot(runId).projection.frames.root).toMatchObject({ status: "completed", result: { final: "then-final" } });
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
        const projection = store.scheduler.loadRunSnapshot(run.id).projection;
        expect(summary).toMatchObject({ status: "completed", started: 2, completed: 2 });
        expect(projection.run).toMatchObject({ status: "completed" });
        expect(projection.frames[groupKey]).toMatchObject({ status: "completed", result: { left: { value: "left" }, right: { value: "right" } } });
        expect(projection.groups[groupKey]).toMatchObject({ status: "completed", strategy: "all" });
        expect(Object.values(projection.groupMembers).map(member => member.branchId).sort()).toEqual(["left", "right"]);
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
        expect(store.scheduler.loadRunSnapshot(run.id).projection.instances[prepareKey]).toMatchObject({ status: "completed", output: { prefix: "root" } });

        await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-b", store })).resolves.toMatchObject({ status: "completed", started: 2, completed: 2 });
        const projection = store.scheduler.loadRunSnapshot(run.id).projection;
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
      const prepared = await prepareSyntheticWorkflow(workspace, rootParallelTaskWorkflow({ maxConcurrency: 1 }));
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const first = await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store });
        const afterFirst = store.scheduler.loadRunSnapshot(run.id).projection;
        expect(first).toMatchObject({ status: "idle", started: 1, completed: 1 });
        expect(Object.values(afterFirst.instances).filter(instance => instance.status === "completed")).toHaveLength(1);

        const second = await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-b", store });
        const afterSecond = store.scheduler.loadRunSnapshot(run.id).projection;
        expect(second).toMatchObject({ status: "completed", started: 1, completed: 1 });
        expect(Object.values(afterSecond.instances).filter(instance => instance.status === "completed")).toHaveLength(2);
        expect(Object.values(afterSecond.groups)[0]).toMatchObject({ status: "completed" });
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
        const projection = store.scheduler.loadRunSnapshot(run.id).projection;

        expect(summary).toMatchObject({ status: "completed", started: 2, completed: 2 });
        expect(projection.frames[deriveInstanceKey(appendNode([], "items"))]).toMatchObject({
          status: "completed",
          result: [{ item: "a", index: 0 }, { item: "b", index: 1 }],
        });
        expect(Object.values(projection.groupMembers).map(member => ({ item: member.item, itemIndex: member.itemIndex, status: member.status }))).toEqual([
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

  it("rebuilds fanout item scope from durable events after reopening the store", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-root-fanout-resume", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, rootFanoutTaskWorkflow({ maxConcurrency: 1 }));
      const firstStore = await openRuntimeStore(workspace);
      let runId = "";
      try {
        const run = await firstStore.admitRun({ prepared, input: { items: ["a", "b"] }, cwd: workspace });
        runId = run.id;
        const first = await advanceFrozenRun({ cwd: workspace, runId, ownerId: "owner-a", store: firstStore });
        expect(first).toMatchObject({ status: "idle", started: 1, completed: 1 });
      } finally {
        firstStore.close();
      }

      const resumedStore = await openRuntimeStore(workspace);
      try {
        const second = await advanceFrozenRun({ cwd: workspace, runId, ownerId: "owner-b", store: resumedStore });
        const projection = resumedStore.scheduler.loadRunSnapshot(runId).projection;
        expect(second).toMatchObject({ status: "completed", started: 1, completed: 1 });
        expect(projection.run).toMatchObject({ status: "completed" });
        expect(Object.values(projection.instances).map(instance => instance.output).sort((a, b) => Number((a as { index: number }).index) - Number((b as { index: number }).index))).toEqual([
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
      const prepared = await prepareSyntheticWorkflow(workspace, rootFanoutTaskWorkflow({ strategy: "quorum", count: 2, maxConcurrency: 2 }));
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { items: ["a", "b", "c"] }, cwd: workspace });
        const summary = await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store });
        const projection = store.scheduler.loadRunSnapshot(run.id).projection;

        expect(summary).toMatchObject({ status: "completed", started: 2, completed: 2 });
        const fanoutFrame = projection.frames[deriveInstanceKey(appendNode([], "items"))];
        expect(fanoutFrame).toMatchObject({ status: "completed" });
        expect((fanoutFrame?.result as { accepted: unknown[] }).accepted).toHaveLength(2);
        expect((fanoutFrame?.result as { completed: unknown[] }).completed).toHaveLength(2);
        expect((fanoutFrame?.result as { accepted: unknown[] }).accepted).toEqual(expect.arrayContaining([
          { item: "a", index: 0 },
          { item: "b", index: 1 },
        ]));
        expect(Object.values(projection.groupMembers).filter(member => member.status === "completed")).toHaveLength(2);
        expect(Object.values(projection.groupMembers).filter(member => member.status === "cancelled")).toHaveLength(1);
        expect(Object.values(projection.instances).filter(instance => instance.status === "completed")).toHaveLength(2);
        expect(Object.values(projection.instances).filter(instance => instance.status === "cancelled")).toHaveLength(1);
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
        const projection = store.scheduler.loadRunSnapshot(run.id).projection;

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
        expect(store.scheduler.loadRunSnapshot(run.id).projection.groupMembers[branchKey]).toMatchObject({ status: "running" });

        await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-b", store })).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });
        const projection = store.scheduler.loadRunSnapshot(run.id).projection;
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
        expect(Object.values(store.scheduler.loadRunSnapshot(run.id).projection.groupMembers).every(member => member.status === "running")).toBe(true);

        await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-b", store })).resolves.toMatchObject({ status: "completed", started: 2, completed: 2 });
        const projection = store.scheduler.loadRunSnapshot(run.id).projection;
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
        expect(Object.values(store.scheduler.loadRunSnapshot(runId).projection.instances).filter(instance => instance.status === "ready")).toHaveLength(1);
      } finally {
        store.close();
      }

      const resumed = await openRuntimeStore(workspace);
      try {
        const second = await advanceFrozenRun({ cwd: workspace, runId, ownerId: "owner-b", store: resumed });
        const projection = resumed.scheduler.loadRunSnapshot(runId).projection;
        const loopFrame = Object.values(projection.frames).find(frame => frame.frameKind === "loop");
        expect(second).toMatchObject({ status: "completed", started: 1, completed: 1 });
        expect(projection.frames.root).toMatchObject({ status: "completed" });
        expect(loopFrame).toMatchObject({ status: "completed", result: { done: true, iter: 1 }, terminalReason: "stopped" });
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

        const projection = store.scheduler.loadRunSnapshot(run.id).projection;
        expect(projection.frames[loopKey]).toMatchObject({
          status: "completed",
          result: { done: true, value: "first-0-second-0" },
        });
        expect(Object.values(projection.frames).find(frame => frame.frameKind === "loop_iteration")).toMatchObject({
          status: "completed",
          result: { done: true, value: "first-0-second-0" },
        });
      } finally {
        store.close();
      }
    });
  });

  it("uses dynamic node key and scheduler attempt for task artifacts", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-task", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, taskRuntimeContextWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const executor = createRuntimeNodeExecutor({
          cwd: workspace,
          ir: prepared.ir,
          scope: {},
          store,
        });

        const result = await executor.execute({
          runId: run.id,
          nodeId: "context_task",
          nodeKey: "context_task.dynamic",
          attemptId: "attempt_7",
          attemptNo: 7,
          ownerEpoch: 1,
          signal: new AbortController().signal,
        });

        expect(result).toMatchObject({
          status: "completed",
          output: {
            artifact: { kind: "artifact" },
          },
        });
        const artifact = runtimeRow(workspace, "SELECT attempt, relative_path FROM artifacts WHERE run_id = ? AND node_key = ?", run.id, "context_task.dynamic");
        expect(artifact).toMatchObject({ attempt: 7 });
        expect(String(artifact?.relative_path)).toContain("artifacts/context_task.dynamic/attempt-7/");
        const bytes = await readFile(join(workspace, ".acpus", "runs", run.id, String(artifact?.relative_path)));
        expect(bytes.toString("utf8")).toBe("dynamic artifact\n");
      } finally {
        store.close();
      }
    });
  });

  it("runs one task invocation per scheduler-visible attempt", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-single-attempt", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, retryingTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const executor = createRuntimeNodeExecutor({
          cwd: workspace,
          ir: prepared.ir,
          scope: {},
          store,
        });

        await expect(executor.execute({
          runId: run.id,
          nodeId: "retry_task",
          nodeKey: "retry_task.dynamic",
          attemptId: "attempt_1",
          attemptNo: 1,
          ownerEpoch: 1,
          signal: new AbortController().signal,
        })).rejects.toThrow("first invocation fails");
      } finally {
        store.close();
      }
    });
  });

  it("does not spend node retry inside one scheduler-visible agent attempt", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-single-attempt", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, retryingAgentWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const executor = createRuntimeNodeExecutor({
          cwd: workspace,
          ir: prepared.ir,
          scope: {},
          store,
        });

        await expect(executor.execute({
          runId: run.id,
          nodeId: "review",
          nodeKey: "review.dynamic",
          attemptId: "attempt_1",
          attemptNo: 1,
          ownerEpoch: 1,
          signal: new AbortController().signal,
        })).rejects.toThrow("Node 'review' output");
      } finally {
        store.close();
      }
    });
  });

  it("passes scheduler runtime identity into command-backed agent environment", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-runtime-context", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, agentRuntimeContextWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const executor = createRuntimeNodeExecutor({
          cwd: workspace,
          ir: prepared.ir,
          scope: {},
          store,
        });

        await expect(executor.execute({
          runId: run.id,
          nodeId: "inspect_agent",
          nodeKey: "inspect_agent.dynamic",
          attemptId: "attempt_7",
          attemptNo: 7,
          ownerEpoch: 1,
          signal: new AbortController().signal,
        })).resolves.toEqual({
          status: "completed",
          output: {
            runId: run.id,
            nodeId: "inspect_agent",
            nodeKey: "inspect_agent.dynamic",
            schedulerAttempt: "7",
            providerAttempt: "1",
          },
        });
      } finally {
        store.close();
      }
    });
  });

  it("does not leak stale scheduler runtime identity into non-scheduler agent execution", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-runtime-env-scrub", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, agentRuntimeContextWorkflow());
      const node = prepared.ir.root.nodes.find(node => node.id === "inspect_agent");
      if (!node || node.kind !== "agent") throw new Error("expected inspect_agent agent node");
      const previous = {
        runId: process.env.ACPUS_RUNTIME_RUN_ID,
        nodeKey: process.env.ACPUS_RUNTIME_NODE_KEY,
        attempt: process.env.ACPUS_RUNTIME_ATTEMPT,
      };
      process.env.ACPUS_RUNTIME_RUN_ID = "stale-run";
      process.env.ACPUS_RUNTIME_NODE_KEY = "stale-key";
      process.env.ACPUS_RUNTIME_ATTEMPT = "99";
      try {
        await expect(executeAgentNode(node, {}, {
          cwd: workspace,
          agents: prepared.ir.agents,
          getProviderCommand: () => undefined,
          maxAttempts: 1,
        })).resolves.toEqual({
          runId: null,
          nodeId: "inspect_agent",
          nodeKey: null,
          schedulerAttempt: null,
          providerAttempt: "1",
        });
      } finally {
        restoreEnv("ACPUS_RUNTIME_RUN_ID", previous.runId);
        restoreEnv("ACPUS_RUNTIME_NODE_KEY", previous.nodeKey);
        restoreEnv("ACPUS_RUNTIME_ATTEMPT", previous.attempt);
      }
    });
  });

  it("applies task retry policy through scheduler-visible attempts", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-scheduler-retry", async workspace => {
      (globalThis as Record<string, unknown>).__acpus_scheduler_node_executor_retry_count = 0;
      const prepared = await prepareSyntheticWorkflow(workspace, retryingTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const nodeKey = deriveInstanceKey(appendNode([], "retry_task"));

        await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store }))
          .resolves.toMatchObject({ status: "idle", started: 1, failed: 1 });
        expect(store.scheduler.loadRunSnapshot(run.id).projection.instances[nodeKey]).toMatchObject({ status: "ready", statusReason: "retry" });

        await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-b", store }))
          .resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });
        const projection = store.scheduler.loadRunSnapshot(run.id).projection;
        expect(projection.instances[nodeKey]).toMatchObject({ status: "completed", output: { ok: true } });
        expect(Object.values(projection.attempts).filter(attempt => attempt.nodeKey === nodeKey).map(attempt => attempt.status).sort()).toEqual(["completed", "failed"]);
        expect(runtimeRows(workspace, "SELECT attempt, relative_path FROM artifacts WHERE run_id = ? AND node_key = ? ORDER BY attempt", run.id, nodeKey)).toEqual([
          expect.objectContaining({ attempt: 1, relative_path: expect.stringContaining(`${nodeKey}/attempt-1/`) }),
          expect.objectContaining({ attempt: 2, relative_path: expect.stringContaining(`${nodeKey}/attempt-2/`) }),
        ]);
      } finally {
        store.close();
        delete (globalThis as Record<string, unknown>).__acpus_scheduler_node_executor_retry_count;
      }
    });
  });

  it("persists task timeout as a scheduler attempt deadline", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-attempt-deadline", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, timeoutTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: run.id,
          ownerId: "owner-a",
          store,
          now: () => new Date("2026-07-01T00:00:00.000Z"),
        })).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });

        expect(runtimeRow(workspace, "SELECT deadline_at FROM node_attempts WHERE run_id = ?", run.id)).toMatchObject({
          deadline_at: "2026-07-01T00:00:05.000Z",
        });
      } finally {
        store.close();
      }
    });
  });

  it("propagates a pre-aborted scheduler signal into task execution", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-pre-aborted", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, abortStatusTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const executor = createRuntimeNodeExecutor({ cwd: workspace, ir: prepared.ir, scope: {}, store });
        const controller = new AbortController();
        controller.abort();

        await expect(executor.execute({
          runId: run.id,
          nodeId: "abort_task",
          nodeKey: "abort_task.dynamic",
          attemptId: "attempt_abort",
          attemptNo: 3,
          ownerEpoch: 1,
          signal: controller.signal,
        })).resolves.toEqual({
          status: "completed",
          output: { aborted: true },
        });
      } finally {
        store.close();
      }
    });
  });
});

function taskRuntimeContextWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-task",
  }).build(({ step }) => {
    step("context_task").task({
      outputSchema: z.object({
        artifact: z.artifact("text/plain"),
      }),
      run: {
        input: {},
        exec: async ({ artifact }) => ({
          artifact: await artifact.writeText("result.txt", "dynamic artifact\n"),
        }),
      },
    });
    return {};
  });
}

function failingRootAssertWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-failing-assert",
  }).build(({ step }) => {
    step("fail").assert({ condition: false });
    return {};
  });
}

function rootSignalWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-signal",
  }).build(({ step }) => {
    const approval = step("approve").signal({
      outputSchema: z.object({ ok: z.boolean() }),
      run: { prompt: "approve" },
    });
    return { ok: approval.output.ok };
  });
}

function sequentialRootTaskWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-root-sequence",
  }).build(({ step }) => {
    const first = step("first_task").task({
      outputSchema: z.object({ value: z.string() }),
      run: { input: {}, exec: async () => ({ value: "first" }) },
    });
    const second = step("second_task").task({
      outputSchema: z.object({ value: z.string() }),
      run: {
        input: { value: first.output.value },
        exec: async ({ input }) => ({ value: `${input.value}-second` }),
      },
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
      outputSchema: z.object({ value: z.string() }),
      then: ({ step }) => {
        const task = step("then_task").task({
          outputSchema: z.object({ value: z.string() }),
          run: { input: {}, exec: async () => ({ value: "then" }) },
        });
        return { value: task.output.value };
      },
      else: () => ({ value: "else" }),
    });
    const final = step("final_task").task({
      outputSchema: z.object({ final: z.string() }),
      run: {
        input: { value: gate.output.value },
        exec: async ({ input }) => ({ final: `${input.value}-final` }),
      },
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
      outputSchema: z.object({ value: z.string() }),
      then: ({ step }) => {
        const first = step("then_first").task({
          outputSchema: z.object({ value: z.string() }),
          run: { input: {}, exec: async () => ({ value: "first" }) },
        });
        const second = step("then_second").task({
          outputSchema: z.object({ value: z.string() }),
          run: {
            input: { value: first.output.value },
            exec: async ({ input }) => ({ value: `${input.value}-second` }),
          },
        });
        return { value: second.output.value };
      },
      else: () => ({ value: "else" }),
    });
    const final = step("final_task").task({
      outputSchema: z.object({ final: z.string() }),
      run: {
        input: { value: gate.output.value },
        exec: async ({ input }) => ({ final: `${input.value}-final` }),
      },
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
      outputSchema: z.object({ value: z.string() }),
      cases: [
        {
          when: eq(input.mode, "case"),
          then: ({ step }) => {
            const first = step("case_first").task({
              outputSchema: z.object({ value: z.string() }),
              run: { input: {}, exec: async () => ({ value: "case" }) },
            });
            const second = step("case_second").task({
              outputSchema: z.object({ value: z.string() }),
              run: {
                input: { value: first.output.value },
                exec: async ({ input }) => ({ value: `${input.value}-second` }),
              },
            });
            return { value: second.output.value };
          },
        },
      ],
      default: () => ({ value: "default" }),
    });
    return { value: route.output.value };
  });
}

function rootParallelTaskWorkflow(options: { maxConcurrency?: number } = {}) {
  return defineWorkflow({
    name: "scheduler-node-executor-root-parallel",
  }).build(({ step }) => {
    step("race").parallel({
      ...(options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
      branches: {
        left: {
          outputSchema: z.object({ value: z.string(), rootPrefix: z.string() }),
          do: ({ step }) => {
            const task = step("left_task").task({
              outputSchema: z.object({ value: z.string() }),
              run: { input: {}, exec: async () => ({ value: "left" }) },
            });
            return { value: task.output.value, rootPrefix: "root" };
          },
        },
        right: {
          outputSchema: z.object({ value: z.string() }),
          do: ({ step }) => {
            const task = step("right_task").task({
              outputSchema: z.object({ value: z.string() }),
              run: { input: {}, exec: async () => ({ value: "right" }) },
            });
            return { value: task.output.value };
          },
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
      outputSchema: z.object({ prefix: z.string() }),
      run: { input: {}, exec: async () => ({ prefix: "root" }) },
    });
    const combined = step("combine").parallel({
      branches: {
        left: {
          outputSchema: z.object({ value: z.string(), rootPrefix: z.string() }),
          do: ({ step }) => {
            const task = step("left_task").task({
              outputSchema: z.object({ value: z.string() }),
              run: {
                input: { prefix: prepare.output.prefix },
                exec: async ({ input }) => ({ value: `${input.prefix}-left` }),
              },
            });
            return { value: task.output.value, rootPrefix: prepare.output.prefix };
          },
        },
        right: {
          outputSchema: z.object({ value: z.string(), rootPrefix: z.string() }),
          do: ({ step }) => {
            const task = step("right_task").task({
              outputSchema: z.object({ value: z.string() }),
              run: {
                input: { prefix: prepare.output.prefix },
                exec: async ({ input }) => ({ value: `${input.prefix}-right` }),
              },
            });
            return { value: task.output.value, rootPrefix: prepare.output.prefix };
          },
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
        mixed: {
          outputSchema: z.object({ value: z.string() }),
          do: ({ step }) => {
            step("first_task").task({
              outputSchema: z.object({ value: z.string() }),
              run: { input: {}, exec: async () => ({ value: "first" }) },
            });
            const second = step("second_task").task({
              outputSchema: z.object({ value: z.string() }),
              run: { input: {}, exec: async () => ({ value: "second" }) },
            });
            return { value: second.output.value };
          },
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
      itemOutputSchema: z.object({ item: z.string(), value: z.string() }),
      do: ({ item, step }) => {
        const first = step("first_task").task({
          outputSchema: z.object({ value: z.string() }),
          run: {
            input: { item },
            exec: async ({ input }) => ({ value: `${input.item}-first` }),
          },
        });
        const second = step("second_task").task({
          outputSchema: z.object({ item: z.string(), value: z.string() }),
          run: {
            input: { item, first: first.output.value },
            exec: async ({ input }) => ({ item: input.item, value: input.first.replace("first", "second") }),
          },
        });
        return { item: second.output.item, value: second.output.value };
      },
    });
    return {};
  });
}

function rootFanoutTaskWorkflow(options: { strategy?: "all" | "quorum"; count?: number; maxConcurrency?: number; abortItem?: string } = {}) {
  return defineWorkflow({
    name: "scheduler-node-executor-root-fanout",
    inputSchema: z.object({ items: z.array(z.string()) }),
  }).build(({ input, step }) => {
    if (options.strategy === "quorum") {
      step("items").fanout({
        over: input.items,
        itemOutputSchema: z.object({ item: z.string(), index: z.number() }),
        strategy: "quorum",
        count: options.count ?? 1,
        ...(options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
        do: ({ item, itemIndex, step }) => {
          const task = step("item_task").task({
            outputSchema: z.object({ item: z.string(), index: z.number() }),
            run: {
              input: { item, itemIndex, abortItem: options.abortItem ?? null },
              exec: async ({ input, abortSignal }) => {
                if (input.item !== input.abortItem) return { item: input.item, index: input.itemIndex };
                return await new Promise(resolve => {
                  const timer = setTimeout(() => resolve({ item: "not-aborted", index: input.itemIndex }), 1_000);
                  abortSignal.addEventListener("abort", () => {
                    clearTimeout(timer);
                    resolve({ item: input.item, index: input.itemIndex });
                  }, { once: true });
                });
              },
            },
          });
          return { item: task.output.item, index: task.output.index };
        },
      });
    } else {
      step("items").fanout({
        over: input.items,
        itemOutputSchema: z.object({ item: z.string(), index: z.number() }),
        ...(options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
        do: ({ item, itemIndex, step }) => {
          const task = step("item_task").task({
            outputSchema: z.object({ item: z.string(), index: z.number() }),
            run: {
              input: { item, itemIndex, abortItem: options.abortItem ?? null },
              exec: async ({ input, abortSignal }) => {
                if (input.item !== input.abortItem) return { item: input.item, index: input.itemIndex };
                return await new Promise(resolve => {
                  const timer = setTimeout(() => resolve({ item: "not-aborted", index: input.itemIndex }), 1_000);
                  abortSignal.addEventListener("abort", () => {
                    clearTimeout(timer);
                    resolve({ item: input.item, index: input.itemIndex });
                  }, { once: true });
                });
              },
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
      maxIterations: 3,
      outputSchema: z.object({ done: z.boolean(), iter: z.number() }),
      do: ({ iter, step }) => {
        const task = step("loop_task").task({
          outputSchema: z.object({ done: z.boolean(), rawIter: z.number() }),
          run: {
            input: { iter },
            exec: async ({ input }) => ({ done: input.iter >= 1, rawIter: input.iter }),
          },
        });
        return { done: task.output.done, iter: task.output.rawIter };
      },
      stopWhen: ({ result }) => result.done,
    });
    return {};
  });
}

function multiNodeRootLoopWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-root-loop-multi-node",
  }).build(({ step }) => {
    step("retry").loop({
      maxIterations: 3,
      outputSchema: z.object({ done: z.boolean(), value: z.string() }),
      do: ({ iter, step }) => {
        const first = step("first_task").task({
          outputSchema: z.object({ value: z.string() }),
          run: {
            input: { iter },
            exec: async ({ input }) => ({ value: `first-${input.iter}` }),
          },
        });
        const second = step("second_task").task({
          outputSchema: z.object({ done: z.boolean(), value: z.string() }),
          run: {
            input: { iter, first: first.output.value },
            exec: async ({ input }) => ({ done: true, value: `${input.first}-second-${input.iter}` }),
          },
        });
        return { done: second.output.done, value: second.output.value };
      },
      stopWhen: ({ result }) => result.done,
    });
    return {};
  });
}

function abortStatusTaskWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-abort",
  }).build(({ step }) => {
    step("abort_task").task({
      outputSchema: z.object({ aborted: z.boolean() }),
      run: {
        input: {},
        exec: async ({ abortSignal }) => ({ aborted: abortSignal.aborted }),
      },
    });
    return {};
  });
}

function retryingTaskWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-retry",
  }).build(({ step }) => {
    step("retry_task").task({
      outputSchema: z.object({ ok: z.boolean() }),
      retry: { max: 2 },
      run: {
        input: {},
        exec: async ({ artifact }) => {
          const globalKey = "__acpus_scheduler_node_executor_retry_count";
          const current = Number((globalThis as Record<string, unknown>)[globalKey] ?? 0) + 1;
          (globalThis as Record<string, unknown>)[globalKey] = current;
          await artifact.writeText(`attempt-${current}.txt`, `attempt ${current}\n`);
          if (current === 1) throw new Error("first invocation fails");
          return { ok: true };
        },
      },
    });
    return {};
  });
}

function retryingAgentWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-agent-retry",
    agents: {
      reviewer: {
        command: "node -e 'if (process.env.ACPUS_AGENT_ATTEMPT === \"1\") process.stdout.write(JSON.stringify({ attempt: 1 })); else process.stdout.write(JSON.stringify({ attempt: process.env.ACPUS_AGENT_ATTEMPT }))'",
      },
    },
  }).build(({ agents, step }) => {
    step("review").agent({
      outputSchema: z.object({ attempt: z.string() }),
      retry: { max: 2 },
      run: { agent: agents.reviewer, prompt: "review" },
    });
    return {};
  });
}

function agentRuntimeContextWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-agent-runtime-context",
    agents: {
      inspector: {
        command: "node -e 'process.stdout.write(JSON.stringify({ runId: process.env.ACPUS_RUNTIME_RUN_ID ?? null, nodeId: process.env.ACPUS_RUNTIME_NODE_ID ?? null, nodeKey: process.env.ACPUS_RUNTIME_NODE_KEY ?? null, schedulerAttempt: process.env.ACPUS_RUNTIME_ATTEMPT ?? null, providerAttempt: process.env.ACPUS_AGENT_ATTEMPT ?? null }))'",
      },
    },
  }).build(({ agents, step }) => {
    step("inspect_agent").agent({
      outputSchema: z.object({
        runId: z.string().nullable(),
        nodeId: z.string().nullable(),
        nodeKey: z.string().nullable(),
        schedulerAttempt: z.string().nullable(),
        providerAttempt: z.string().nullable(),
      }),
      run: { agent: agents.inspector, prompt: "inspect" },
    });
    return {};
  });
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function timeoutTaskWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-timeout-deadline",
  }).build(({ step }) => {
    const task = step("timeout_task").task({
      outputSchema: z.object({ ok: z.boolean() }),
      timeout: "5s",
      run: {
        input: {},
        exec: async () => ({ ok: true }),
      },
    });
    return { ok: task.output.ok };
  });
}
