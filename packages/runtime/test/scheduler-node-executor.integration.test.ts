import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defineWorkflow, z } from "@acpus/core";
import type { AgentTurnRequest, AgentTurnResult } from "@acpus/agent-executor";
import { eq, template } from "@acpus/expression";
import { describe, expect, it, vi } from "vitest";
import { appendBranch, appendFanoutItem, appendLoopIteration, appendNode, deriveInstanceKey } from "../src/scheduler/identity.js";
import { createRuntimeNodeExecutor } from "../src/scheduler/node-executor.js";
import { advanceFrozenRun } from "../src/scheduler/runtime-runner.js";
import { applySchedulerControlIntent } from "../src/scheduler/control.js";
import { executeAgentNode } from "../src/execution/agent-node.js";
import { openRuntimeStore, type RuntimeStore } from "../src/store/store.js";
import { prepareSyntheticWorkflow, runtimeRow, runtimeRows, taskArtifactWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";

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

  it("fails durable task attempts before non-admissible output reaches the store", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-non-admissible-output", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, nonAdmissibleTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });

        await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store })).resolves.toMatchObject({ status: "failed", failed: 1 });

        const projection = store.scheduler.loadRunSnapshot(run.id).projection;
        const nodeKey = deriveInstanceKey(appendNode([], "bad_output"));
        expect(projection.instances[nodeKey]).toMatchObject({
          status: "failed",
          error: expect.objectContaining({ reason: expect.stringContaining("not workflow-admissible") }),
        });
        expect(projection.attempts[Object.keys(projection.attempts)[0]!]?.result).toBeUndefined();
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
        expect(store.scheduler.loadRunSnapshot(run.id).projection.instances[nodeKey]).toMatchObject({ status: "completed", output: { ok: true } });
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
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const nodeKey = deriveInstanceKey(appendNode([], "approve"));

        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: run.id,
          ownerId: "owner-a",
          store,
          now: () => new Date("2026-07-01T00:00:00.000Z"),
        })).resolves.toMatchObject({ status: "awaiting" });

        expect(store.scheduler.loadRunSnapshot(run.id).projection.signalWaits[nodeKey]).toMatchObject({
          status: "awaiting",
          deadlineAt: "2026-07-01T00:00:05.000Z",
          timeoutMessage: "Approval timed out",
        });
        expect(runtimeRow(workspace, "SELECT deadline_at, timeout_message FROM signal_waits WHERE run_id = ? AND node_key = ?", run.id, nodeKey)).toMatchObject({
          deadline_at: "2026-07-01T00:00:05.000Z",
          timeout_message: "Approval timed out",
        });
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
        store.scheduler.appendSchedulerEvents({
          runId: run.id,
          expectedVersion: store.scheduler.loadRunSnapshot(run.id).version,
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
        const afterRetryAdvance = store.scheduler.loadRunSnapshot(run.id).projection;
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
        const branchKey = deriveInstanceKey(appendBranch([], "route", "case:0"));
        const firstKey = deriveInstanceKey(appendNode(appendBranch([], "route", "case:0"), "case_first"));
        const secondKey = deriveInstanceKey(appendNode(appendBranch([], "route", "case:0"), "case_second"));

        await advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store });
        const afterFirst = store.scheduler.loadRunSnapshot(run.id).projection;
        expect(afterFirst.branchDecisions[switchKey]).toBe("case:0");
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
        expect(fanoutFrame?.result).toHaveLength(2);
        expect(fanoutFrame?.result).toEqual(expect.arrayContaining([
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

  it("executes nested fanout items with ancestor scope and local concurrency", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-nested-fanout-scope", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, nestedFanoutInParallelWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { items: ["a", "b"] }, cwd: workspace });
        const firstItemKey = deriveInstanceKey(appendNode(appendFanoutItem(appendBranch([], "combine", "items"), "inner_items", 0, 0), "inner_task"));
        const secondItemKey = deriveInstanceKey(appendNode(appendFanoutItem(appendBranch([], "combine", "items"), "inner_items", 1, 1), "inner_task"));

        await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store })).resolves.toMatchObject({ status: "idle", started: 1, completed: 1 });
        expect(store.scheduler.loadRunSnapshot(run.id).projection.instances[firstItemKey]).toMatchObject({ status: "ready" });
        expect(store.scheduler.loadRunSnapshot(run.id).projection.instances[secondItemKey]).toMatchObject({ status: "ready" });

        await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-b", store })).resolves.toMatchObject({ status: "idle", started: 1, completed: 1 });
        const afterFirstItem = store.scheduler.loadRunSnapshot(run.id).projection;
        expect(Object.values(afterFirstItem.instances).filter(instance => instance.nodeId === "inner_task" && instance.status === "completed")).toHaveLength(1);
        expect(Object.values(afterFirstItem.instances).filter(instance => instance.nodeId === "inner_task" && instance.status === "ready")).toHaveLength(1);
        expect(afterFirstItem.instances[deriveInstanceKey(appendNode(appendBranch([], "combine", "sibling"), "sibling_task"))]).toMatchObject({ status: "ready" });

        await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-c", store })).resolves.toMatchObject({ status: "idle", started: 1, completed: 1 });
        await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-d", store })).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });
        const projection = store.scheduler.loadRunSnapshot(run.id).projection;
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
        expect(details?.dynamic?.nodeInstances.find(instance => instance.nodeKey === firstItemKey)).toMatchObject({
          nodeId: "inner_task",
          instancePath: appendNode(appendFanoutItem(appendBranch([], "combine", "items"), "inner_items", 0, 0), "inner_task"),
        });
        expect(details?.dynamic?.groupMembers.find(member => member.memberKey === deriveInstanceKey(appendFanoutItem(appendBranch([], "combine", "items"), "inner_items", 0, 0)))).toMatchObject({
          childFrameKey: deriveInstanceKey(appendFanoutItem(appendBranch([], "combine", "items"), "inner_items", 0, 0)),
        });
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
        const awaiting = store.scheduler.loadRunSnapshot(run.id).projection;
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
        const rightAwaiting = store.scheduler.loadRunSnapshot(run.id).projection;
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
        expect(store.scheduler.loadRunSnapshot(run.id).projection.frames[gateKey]).toMatchObject({ status: "completed" });
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
        const bytes = await readFile(join(workspace, ".acpus", ".local", "runs", run.id, String(artifact?.relative_path)));
        expect(bytes.toString("utf8")).toBe("dynamic artifact\n");
        const metadata = store.getRun(run.id)?.dynamic?.executionMetadata.find(entry => entry.kind === "task_attempt");
        expect(metadata).toMatchObject({
          attemptId: "attempt_7",
          kind: "task_attempt",
          metadata: expect.objectContaining({
            nodeId: "context_task",
            nodeKey: "context_task.dynamic",
            attemptNo: 7,
            input: {},
            cwd: workspace,
          }),
        });
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

  it("repairs schema-backed agent output inside one scheduler-visible attempt", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-single-attempt", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, retryingAgentWorkflow());
      const store = await openRuntimeStore(workspace);
      const turns: AgentTurnRequest[] = [];
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const executor = createRuntimeNodeExecutor({
          cwd: workspace,
          ir: prepared.ir,
          scope: {},
          store,
          agentRepairDelayMs: 0,
          executeAgentTurn: async request => {
            turns.push(request);
            return completedAgentTurn(
              turns.length === 1 ? "{\"attempt\":1,\"extra\":\"drop\"}" : "{\"attempt\":\"2\",\"extra\":\"drop\"}",
              turns.length === 2 ? "stderr detail\n" : "",
              turns.length === 1 ? {
                eventCount: 5,
                stopReason: "end_turn",
                context: { used: 120, size: 240, updatedAt: "2026-07-01T00:00:00.000Z" },
                tokenUsage: { source: "prompt_response", inputTokens: 10, outputTokens: 2, totalTokens: 12 },
                tools: {
                  totalToolCallCount: 1,
                  calls: [{
                    toolCallId: "tool-1",
                    toolName: "Read",
                    status: "completed",
                    input: { preview: "{\"path\":\"README.md\"}", truncated: false, originalBytes: 20, headBytes: 20 },
                    startedAt: "2026-07-01T00:00:00.000Z",
                    updatedAt: "2026-07-01T00:00:01.000Z",
                    completedAt: "2026-07-01T00:00:01.000Z",
                  }],
                },
                input: { preview: request.prompt, truncated: false, originalBytes: Buffer.byteLength(request.prompt), headBytes: Buffer.byteLength(request.prompt) },
                output: { preview: "{\"attempt\":1,\"extra\":\"drop\"}", truncated: false, originalBytes: 28, headBytes: 28 },
                cwd: workspace,
                acpxRecordId: "record-1",
              } : undefined,
            );
          },
        });

        await expect(executor.execute({
          runId: run.id,
          nodeId: "review",
          nodeKey: "review.dynamic",
          attemptId: "attempt_1",
          attemptNo: 1,
          ownerEpoch: 1,
          signal: new AbortController().signal,
        })).resolves.toEqual({
          status: "completed",
          output: { attempt: "2" },
        });
        expect(turns).toHaveLength(2);
        expect(turns.map(turn => turn.sessionName)).toEqual([turns[0]!.sessionName, turns[0]!.sessionName]);
        expect(turns[0]).toMatchObject({ agent: { kind: "command" }, permissionMode: "approve-all" });
        expect(turns[0]!.agentMode).toBe("agent");
        expect(turns[1]!.agentMode).toBeUndefined();
        expect(turns[1]!.prompt).toContain("Continue the previous task from where you left off.");
        expect(turns[1]!.prompt).toContain("# OUTPUT SCHEMA");
        const artifactRows = runtimeRows(workspace, "SELECT id, media_type, relative_path FROM artifacts WHERE run_id = ? AND node_key = ? ORDER BY relative_path", run.id, "review.dynamic") as RuntimeArtifactRow[];
        expect(artifactRows).toEqual([
          expect.objectContaining({ media_type: "text/markdown", relative_path: "artifacts/review.dynamic/attempt-1/agent/turn-001.prompt.md" }),
          expect.objectContaining({ media_type: "application/json", relative_path: "artifacts/review.dynamic/attempt-1/agent/turn-001.raw-parsed-output.json" }),
          expect.objectContaining({ media_type: "text/markdown", relative_path: "artifacts/review.dynamic/attempt-1/agent/turn-001.response.md" }),
          expect.objectContaining({ media_type: "application/json", relative_path: "artifacts/review.dynamic/attempt-1/agent/turn-001.telemetry.json" }),
          expect.objectContaining({ media_type: "text/markdown", relative_path: "artifacts/review.dynamic/attempt-1/agent/turn-002.prompt.md" }),
          expect.objectContaining({ media_type: "application/json", relative_path: "artifacts/review.dynamic/attempt-1/agent/turn-002.raw-parsed-output.json" }),
          expect.objectContaining({ media_type: "text/markdown", relative_path: "artifacts/review.dynamic/attempt-1/agent/turn-002.response.md" }),
          expect.objectContaining({ media_type: "text/plain", relative_path: "artifacts/review.dynamic/attempt-1/agent/turn-002.stderr.log" }),
          expect.objectContaining({ media_type: "application/json", relative_path: "artifacts/review.dynamic/attempt-1/agent/turn-002.telemetry.json" }),
        ]);
        const metadataEntry = store.getRun(run.id)?.dynamic?.executionMetadata.find(entry => entry.kind === "agent_attempt");
        expect(metadataEntry).toMatchObject({ attemptId: "attempt_1", kind: "agent_attempt" });
        const metadata = metadataEntry?.metadata as AgentAttemptMetadata | undefined;
        expect(metadata).toMatchObject({
          nodeId: "review",
          nodeKey: "review.dynamic",
          attemptNo: 1,
          status: "completed",
          sessionName: turns[0]!.sessionName,
          turnCount: 2,
          turns: [
            expect.objectContaining({
              turn: 1,
              status: "completed",
              failureKind: "output_conformance",
              telemetry: {
                eventCount: 5,
                stopReason: "end_turn",
                context: { used: 120, size: 240, updatedAt: "2026-07-01T00:00:00.000Z" },
                tokenUsage: { source: "prompt_response", inputTokens: 10, outputTokens: 2, totalTokens: 12 },
                tools: { totalToolCallCount: 1 },
                cwd: workspace,
                acpxRecordId: "record-1",
              },
            }),
            expect.objectContaining({ turn: 2, status: "completed" }),
          ],
        });
        expectAgentArtifactRef(metadata?.turns?.[0]?.promptArtifact, "artifacts/review.dynamic/attempt-1/agent/turn-001.prompt.md", "text/markdown", artifactRows);
        expectAgentArtifactRef(metadata?.turns?.[0]?.rawParsedOutputArtifact, "artifacts/review.dynamic/attempt-1/agent/turn-001.raw-parsed-output.json", "application/json", artifactRows);
        expectAgentArtifactRef(metadata?.turns?.[0]?.responseArtifact, "artifacts/review.dynamic/attempt-1/agent/turn-001.response.md", "text/markdown", artifactRows);
        expectAgentArtifactRef(metadata?.turns?.[0]?.telemetryArtifact, "artifacts/review.dynamic/attempt-1/agent/turn-001.telemetry.json", "application/json", artifactRows);
        expectAgentArtifactRef(metadata?.turns?.[1]?.rawParsedOutputArtifact, "artifacts/review.dynamic/attempt-1/agent/turn-002.raw-parsed-output.json", "application/json", artifactRows);
        expectAgentArtifactRef(metadata?.turns?.[1]?.stderrArtifact, "artifacts/review.dynamic/attempt-1/agent/turn-002.stderr.log", "text/plain", artifactRows);
        const runDir = store.getRunDir(run.id);
        if (!runDir) throw new Error("expected run dir");
        await expect(readJsonFile(join(workspace, runDir, "artifacts/review.dynamic/attempt-1/agent/turn-001.raw-parsed-output.json"))).resolves.toMatchObject({
          rawParsedOutput: { attempt: 1, extra: "drop" },
        });
        await expect(readJsonFile(join(workspace, runDir, "artifacts/review.dynamic/attempt-1/agent/turn-001.telemetry.json"))).resolves.toMatchObject({
          telemetry: {
            eventCount: 5,
            context: { used: 120, size: 240 },
            tokenUsage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
            tools: {
              totalToolCallCount: 1,
              calls: [expect.objectContaining({
                toolCallId: "tool-1",
                toolName: "Read",
                status: "completed",
                input: { preview: "{\"path\":\"README.md\"}", truncated: false, originalBytes: 20, headBytes: 20 },
                startedAt: "2026-07-01T00:00:00.000Z",
                updatedAt: "2026-07-01T00:00:01.000Z",
                completedAt: "2026-07-01T00:00:01.000Z",
              })],
            },
            input: {
              preview: turns[0]!.prompt,
              artifactRef: "artifacts/review.dynamic/attempt-1/agent/turn-001.prompt.md",
            },
            output: {
              preview: "{\"attempt\":1,\"extra\":\"drop\"}",
              artifactRef: "artifacts/review.dynamic/attempt-1/agent/turn-001.response.md",
            },
            cwd: workspace,
            acpxRecordId: "record-1",
          },
        });
        await expect(readJsonFile(join(workspace, runDir, "artifacts/review.dynamic/attempt-1/agent/turn-002.raw-parsed-output.json"))).resolves.toMatchObject({
          rawParsedOutput: { attempt: "2", extra: "drop" },
        });
      } finally {
        store.close();
      }
    });
  });

  it("persists agent progress while a scheduler-visible attempt is still running", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-progress", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, retryingAgentWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const { attempt, ownerEpoch } = startReviewAttempt(store, run.id, "agent-progress");
        const executor = createRuntimeNodeExecutor({
          cwd: workspace,
          ir: prepared.ir,
          scope: {},
          store,
          executeAgentTurn: async request => {
            request.onProgress?.({
              responseText: "hello from a long running agent",
              updatedAt: "2026-07-01T00:00:00.000Z",
              telemetry: {
                eventCount: 3,
                context: { used: 90, size: 200, updatedAt: "2026-07-01T00:00:00.000Z" },
                tokenUsage: { source: "prompt_response", inputTokens: 10, outputTokens: 2, totalTokens: 12 },
                tools: {
                  totalToolCallCount: 4,
                  calls: [1, 2, 3, 4].map(index => ({
                    toolCallId: `tool-${index}`,
                    toolName: index === 4 ? "Bash" : "Read",
                    status: index === 4 ? "running" : "completed",
                    input: { preview: index === 4 ? "{\"cmd\":\"pnpm test\"}" : `file-${index}.ts`, truncated: false, originalBytes: 20, headBytes: 20 },
                    startedAt: "2026-07-01T00:00:00.000Z",
                    updatedAt: "2026-07-01T00:00:01.000Z",
                  })),
                },
              },
            });
            const progress = store.getRun(run.id)?.dynamic?.progress;
            expect(progress).toEqual([
              expect.objectContaining({
                nodeKey: "review.dynamic",
                nodeId: "review",
                attemptId: attempt.attemptId,
                attemptNo: attempt.attemptNo,
                kind: "agent",
                status: "running",
                output: {
                  tail: "hello from a long running agent",
                  totalBytes: 31,
                  truncated: false,
                },
                context: { used: 90, size: 200, updatedAt: "2026-07-01T00:00:00.000Z" },
                tokenUsage: { source: "prompt_response", inputTokens: 10, outputTokens: 2, totalTokens: 12 },
                tools: expect.objectContaining({
                  turn: 1,
                  totalToolCallCount: 4,
                  lastCalls: [
                    expect.objectContaining({ toolCallId: "tool-2" }),
                    expect.objectContaining({ toolCallId: "tool-3" }),
                    expect.objectContaining({
                      toolCallId: "tool-4",
                      toolName: "Bash",
                      status: "running",
                      inputPreview: "{\"cmd\":\"pnpm test\"}",
                    }),
                  ],
                }),
              }),
            ]);
            return completedAgentTurn("{\"attempt\":\"1\"}");
          },
        });

        await expect(executor.execute({
          runId: run.id,
          nodeId: "review",
          nodeKey: "review.dynamic",
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
          ownerEpoch,
          signal: new AbortController().signal,
        })).resolves.toEqual({
          status: "completed",
          output: { attempt: "1" },
        });
        const finalProgress = store.getRun(run.id)?.dynamic?.progress;
        expect(store.getRun(run.id)?.dynamic?.progressVersion).toBe(2);
        expect(finalProgress).toEqual([expect.objectContaining({ status: "completed", message: "turn 1 completed" })]);
      } finally {
        store.close();
      }
    });
  });

  it("throttles identical agent progress but flushes changed telemetry immediately", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-progress-throttle", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, retryingAgentWorkflow());
      const store = await openRuntimeStore(workspace);
      let now: ReturnType<typeof vi.spyOn> | undefined;
      let currentTime = 0;
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const { attempt, ownerEpoch } = startReviewAttempt(store, run.id, "agent-progress-throttle");
        now = vi.spyOn(Date, "now");
        now.mockImplementation(() => currentTime);
        const executor = createRuntimeNodeExecutor({
          cwd: workspace,
          ir: prepared.ir,
          scope: {},
          store,
          executeAgentTurn: async request => {
            const base = {
              updatedAt: "2026-07-01T00:00:00.000Z",
              telemetry: {
                eventCount: 1,
                tools: { totalToolCallCount: 0, calls: [] },
              },
            };
            request.onProgress?.({ ...base, responseText: "one" });
            const afterFirst = store.getRun(run.id)?.dynamic?.progressVersion;
            const afterFirstUpdatedAt = store.getRun(run.id)?.dynamic?.progress[0]?.updatedAt;
            expect(store.getRun(run.id)?.dynamic?.progress[0]).toMatchObject({
              output: { tail: "one", totalBytes: 3, truncated: false },
              tools: { totalToolCallCount: 0, lastCalls: [] },
              updatedAt: expect.any(String),
            });
            request.onProgress?.({ ...base, responseText: "two" });
            expect(store.getRun(run.id)?.dynamic?.progressVersion).toBe(afterFirst);
            expect(store.getRun(run.id)?.dynamic?.progress[0]).toMatchObject({
              output: { tail: "one", totalBytes: 3, truncated: false },
              updatedAt: afterFirstUpdatedAt,
            });

            request.onProgress?.({
              ...base,
              responseText: "three",
              telemetry: {
                eventCount: 2,
                tools: { totalToolCallCount: 1, calls: [{
                  toolCallId: "tool-1",
                  status: "running",
                  startedAt: "2026-07-01T00:00:00.000Z",
                  updatedAt: "2026-07-01T00:00:00.000Z",
                }] },
              },
            });
            expect(store.getRun(run.id)?.dynamic?.progressVersion).toBe((afterFirst ?? 0) + 1);
            expect(store.getRun(run.id)?.dynamic?.progress[0]).toMatchObject({
              output: { tail: "three", totalBytes: 5, truncated: false },
              tools: {
                totalToolCallCount: 1,
                lastCalls: [expect.objectContaining({ toolCallId: "tool-1", status: "running" })],
              },
            });

            currentTime = 1_001;
            request.onProgress?.({ ...base, responseText: "four" });
            expect(store.getRun(run.id)?.dynamic?.progressVersion).toBe((afterFirst ?? 0) + 2);
            expect(store.getRun(run.id)?.dynamic?.progress[0]).toMatchObject({
              output: { tail: "four", totalBytes: 4, truncated: false },
              tools: { totalToolCallCount: 0, lastCalls: [] },
              updatedAt: expect.any(String),
            });
            return completedAgentTurn("{\"attempt\":\"1\"}");
          },
        });

        await expect(executor.execute({
          runId: run.id,
          nodeId: "review",
          nodeKey: "review.dynamic",
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
          ownerEpoch,
          signal: new AbortController().signal,
        })).resolves.toMatchObject({ status: "completed" });
      } finally {
        now?.mockRestore();
        store.close();
      }
    });
  });

  it("bounds stored agent progress output tails", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-progress-tail", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, retryingAgentWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const { attempt, ownerEpoch } = startReviewAttempt(store, run.id, "agent-progress-tail");
        const longText = `${"x".repeat(17 * 1024)}终`;
        const executor = createRuntimeNodeExecutor({
          cwd: workspace,
          ir: prepared.ir,
          scope: {},
          store,
          executeAgentTurn: async request => {
            request.onProgress?.({
              responseText: longText,
              updatedAt: "2026-07-01T00:00:00.000Z",
              telemetry: {
                eventCount: 1,
                tools: { totalToolCallCount: 0, calls: [] },
              },
            });
            const progressOutput = store.getRun(run.id)?.dynamic?.progress[0]?.output;
            expect(progressOutput).toMatchObject({
              totalBytes: Buffer.byteLength(longText, "utf8"),
              truncated: true,
            });
            expect(Buffer.byteLength(progressOutput?.tail ?? "", "utf8")).toBeLessThanOrEqual(16 * 1024);
            expect(progressOutput?.tail.endsWith("终")).toBe(true);
            return completedAgentTurn("{\"attempt\":\"1\"}");
          },
        });

        await expect(executor.execute({
          runId: run.id,
          nodeId: "review",
          nodeKey: "review.dynamic",
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
          ownerEpoch,
          signal: new AbortController().signal,
        })).resolves.toEqual({
          status: "completed",
          output: { attempt: "1" },
        });
      } finally {
        store.close();
      }
    });
  });

  it("bounds stored terminal agent progress output tails", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-terminal-progress-tail", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, largeAgentOutputWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const { attempt, ownerEpoch } = startReviewAttempt(store, run.id, "agent-terminal-progress-tail");
        const longText = `${"x".repeat(17 * 1024)}终`;
        const responseText = JSON.stringify({ text: longText });
        const executor = createRuntimeNodeExecutor({
          cwd: workspace,
          ir: prepared.ir,
          scope: {},
          store,
          executeAgentTurn: async () => completedAgentTurn(responseText),
        });

        await expect(executor.execute({
          runId: run.id,
          nodeId: "review",
          nodeKey: "review.dynamic",
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
          ownerEpoch,
          signal: new AbortController().signal,
        })).resolves.toEqual({
          status: "completed",
          output: { text: longText },
        });

        const output = store.getRun(run.id)?.dynamic?.progress[0]?.output;
        expect(output).toMatchObject({
          totalBytes: Buffer.byteLength(responseText, "utf8"),
          truncated: true,
        });
        expect(Buffer.byteLength(output?.tail ?? "", "utf8")).toBeLessThanOrEqual(16 * 1024);
        expect(output?.tail.endsWith("\"}")).toBe(true);
      } finally {
        store.close();
      }
    });
  });

  it("writes timed out terminal agent progress", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-timeout-progress", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, timeoutAgentWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const { attempt, ownerEpoch } = startReviewAttempt(store, run.id, "agent-timeout-progress");
        const executor = createRuntimeNodeExecutor({
          cwd: workspace,
          ir: prepared.ir,
          scope: {},
          store,
          executeAgentTurn: async () => ({
            status: "failed",
            failureKind: "timeout",
            message: "Agent turn timed out after 5ms.",
            responseText: "partial",
            stderr: "",
            telemetry: agentTelemetry(1),
          }),
        });

        await expect(executor.execute({
          runId: run.id,
          nodeId: "review",
          nodeKey: "review.dynamic",
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
          ownerEpoch,
          signal: new AbortController().signal,
        })).resolves.toMatchObject({ status: "timed_out" });
        expect(store.getRun(run.id)?.dynamic?.progress).toEqual([
          expect.objectContaining({
            attemptId: attempt.attemptId,
            status: "timed_out",
            message: "Agent turn timed out after 5ms.",
            output: { tail: "partial", totalBytes: 7, truncated: false },
          }),
        ]);
      } finally {
        store.close();
      }
    });
  });

  it("writes cancelled terminal agent progress", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-cancelled-progress", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, retryingAgentWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const { attempt, ownerEpoch } = startReviewAttempt(store, run.id, "agent-cancelled-progress");
        const executor = createRuntimeNodeExecutor({
          cwd: workspace,
          ir: prepared.ir,
          scope: {},
          store,
          executeAgentTurn: async () => ({
            status: "cancelled",
            message: "paused by operator",
            responseText: "partial",
            stderr: "",
            telemetry: agentTelemetry(1),
          }),
        });

        await expect(executor.execute({
          runId: run.id,
          nodeId: "review",
          nodeKey: "review.dynamic",
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
          ownerEpoch,
          signal: new AbortController().signal,
        })).resolves.toMatchObject({ status: "cancelled" });
        expect(store.getRun(run.id)?.dynamic?.progress).toEqual([
          expect.objectContaining({
            attemptId: attempt.attemptId,
            status: "cancelled",
            message: "paused by operator",
            output: { tail: "partial", totalBytes: 7, truncated: false },
          }),
        ]);
      } finally {
        store.close();
      }
    });
  });

  it("writes failed terminal agent progress for backend failures", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-provider-failure-progress", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, retryingAgentWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const { attempt, ownerEpoch } = startReviewAttempt(store, run.id, "agent-provider-failure-progress");
        const executor = createRuntimeNodeExecutor({
          cwd: workspace,
          ir: prepared.ir,
          scope: {},
          store,
          executeAgentTurn: async () => ({
            status: "failed",
            failureKind: "provider_exit",
            message: "agent failed",
            responseText: "partial",
            stderr: "",
            telemetry: agentTelemetry(1),
          }),
        });

        await expect(executor.execute({
          runId: run.id,
          nodeId: "review",
          nodeKey: "review.dynamic",
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
          ownerEpoch,
          signal: new AbortController().signal,
        })).rejects.toThrow("provider_exit: agent failed");
        expect(store.getRun(run.id)?.dynamic?.progress).toEqual([
          expect.objectContaining({
            attemptId: attempt.attemptId,
            status: "failed",
            message: "provider_exit: agent failed",
          }),
        ]);
      } finally {
        store.close();
      }
    });
  });

  it("writes failed terminal agent progress for final output conformance failures", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-conformance-progress", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, retryZeroAgentWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const { attempt, ownerEpoch } = startReviewAttempt(store, run.id, "agent-conformance-progress");
        const executor = createRuntimeNodeExecutor({
          cwd: workspace,
          ir: prepared.ir,
          scope: {},
          store,
          agentRepairDelayMs: 0,
          executeAgentTurn: async () => completedAgentTurn("not json"),
        });

        await expect(executor.execute({
          runId: run.id,
          nodeId: "review",
          nodeKey: "review.dynamic",
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
          ownerEpoch,
          signal: new AbortController().signal,
        })).rejects.toThrow("output_conformance");
        expect(store.getRun(run.id)?.dynamic?.progress).toEqual([
          expect.objectContaining({
            attemptId: attempt.attemptId,
            status: "failed",
            message: expect.stringContaining("output_conformance"),
          }),
        ]);
      } finally {
        store.close();
      }
    });
  });

  it("repairs array schema agent output before classifying conformance", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-array-repair", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, arrayAgentOutputWorkflow());
      const store = await openRuntimeStore(workspace);
      const turns: AgentTurnRequest[] = [];
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const executor = createRuntimeNodeExecutor({
          cwd: workspace,
          ir: prepared.ir,
          scope: {},
          store,
          executeAgentTurn: async request => {
            turns.push(request);
            return completedAgentTurn("Here is the result:\n```json\n[\"alpha\",]\n```");
          },
        });

        await expect(executor.execute({
          runId: run.id,
          nodeId: "review",
          nodeKey: "review.dynamic",
          attemptId: "attempt_1",
          attemptNo: 1,
          ownerEpoch: 1,
          signal: new AbortController().signal,
        })).resolves.toEqual({
          status: "completed",
          output: ["alpha"],
        });
        expect(turns).toHaveLength(1);
        expect(turns[0]!.prompt).toContain("exactly one JSON value");
        expect(turns[0]!.prompt).not.toContain("exactly one JSON object");
      } finally {
        store.close();
      }
    });
  });

  it("passes scheduler runtime identity into acpx-backed agent turn environment", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-runtime-context", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, agentRuntimeContextWorkflow());
      const store = await openRuntimeStore(workspace);
      const turns: AgentTurnRequest[] = [];
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const executor = createRuntimeNodeExecutor({
          cwd: workspace,
          ir: prepared.ir,
          scope: {},
          store,
          executeAgentTurn: async request => {
            turns.push(request);
            return completedAgentTurn(JSON.stringify({
              runId: request.env.ACPUS_RUNTIME_RUN_ID ?? null,
              nodeId: request.env.ACPUS_RUNTIME_NODE_ID ?? null,
              nodeKey: request.env.ACPUS_RUNTIME_NODE_KEY ?? null,
              schedulerAttempt: request.env.ACPUS_RUNTIME_ATTEMPT ?? null,
            }));
          },
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
          },
        });
        expect(turns[0]).toMatchObject({
          agent: { kind: "named", name: "codex" },
          cwd: workspace,
          permissionMode: "approve-all",
        });
      } finally {
        store.close();
      }
    });
  });

  it("writes raw ACP debug artifacts only when the host debug switch is enabled", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-raw-acp-debug", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, retryZeroAgentWorkflow());
      const store = await openRuntimeStore(workspace);
      const previous = process.env.ACPUS_AGENT_RAW_ACP_DEBUG;
      const rawStdout = "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\"}\n";
      try {
        delete process.env.ACPUS_AGENT_RAW_ACP_DEBUG;
        const disabled = await store.admitRun({ prepared, input: {}, cwd: workspace });
        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: disabled.id,
          ownerId: "owner-disabled",
          store,
          executeAgentTurn: async request => {
            expect(request.captureRawDebug).toBeUndefined();
            return completedAgentTurn("{\"ok\":true}");
          },
        })).resolves.toMatchObject({ status: "completed" });
        expect(runtimeRows(workspace, "SELECT relative_path FROM artifacts WHERE run_id = ? AND relative_path LIKE '%raw-acp%'", disabled.id)).toEqual([]);

        process.env.ACPUS_AGENT_RAW_ACP_DEBUG = "true";
        const nonOne = await store.admitRun({ prepared, input: {}, cwd: workspace });
        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: nonOne.id,
          ownerId: "owner-non-one",
          store,
          executeAgentTurn: async request => {
            expect(request.captureRawDebug).toBeUndefined();
            return { ...completedAgentTurn("{\"ok\":true}"), rawDebug: { stdout: rawStdout } };
          },
        })).resolves.toMatchObject({ status: "completed" });
        expect(runtimeRows(workspace, "SELECT relative_path FROM artifacts WHERE run_id = ? AND relative_path LIKE '%raw-acp%'", nonOne.id)).toEqual([]);

        process.env.ACPUS_AGENT_RAW_ACP_DEBUG = "1";
        const enabled = await store.admitRun({ prepared, input: {}, cwd: workspace });
        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: enabled.id,
          ownerId: "owner-enabled",
          store,
          executeAgentTurn: async request => {
            expect(request.captureRawDebug).toBe(true);
            return { ...completedAgentTurn("{\"ok\":true}"), rawDebug: { stdout: rawStdout } };
          },
        })).resolves.toMatchObject({ status: "completed" });

        const nodeKey = deriveInstanceKey(appendNode([], "review"));
        const rawAcpPath = `artifacts/${nodeKey}/attempt-1/agent/turn-001.raw-acp.jsonl`;
        const artifactRows = runtimeRows(workspace, "SELECT id, media_type, relative_path FROM artifacts WHERE run_id = ? AND node_key = ? ORDER BY relative_path", enabled.id, nodeKey) as RuntimeArtifactRow[];
        expect(artifactRows).toContainEqual(expect.objectContaining({
          media_type: "application/x-ndjson",
          relative_path: rawAcpPath,
        }));
        const metadata = store.getRun(enabled.id)?.dynamic?.executionMetadata.find(entry => entry.kind === "agent_attempt")?.metadata as AgentAttemptMetadata | undefined;
        expectAgentArtifactRef(metadata?.turns?.[0]?.rawAcpDebugArtifact, rawAcpPath, "application/x-ndjson", artifactRows);
        const runDir = store.getRunDir(enabled.id);
        if (!runDir) throw new Error("expected run dir");
        await expect(readFile(join(workspace, runDir, rawAcpPath), "utf8")).resolves.toBe(rawStdout);

        const failed = await store.admitRun({ prepared, input: {}, cwd: workspace });
        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: failed.id,
          ownerId: "owner-failed",
          store,
          executeAgentTurn: async request => {
            expect(request.captureRawDebug).toBe(true);
            return {
              status: "failed",
              failureKind: "provider_exit",
              message: "agent crashed",
              responseText: "",
              stderr: "",
              telemetry: agentTelemetry(1),
              rawDebug: { stdout: rawStdout },
            };
          },
        })).resolves.toMatchObject({ status: "failed", started: 1, failed: 1 });
        const failedRawAcpPath = `artifacts/${nodeKey}/attempt-1/agent/turn-001.raw-acp.jsonl`;
        const failedArtifactRows = runtimeRows(workspace, "SELECT id, media_type, relative_path FROM artifacts WHERE run_id = ? AND node_key = ? ORDER BY relative_path", failed.id, nodeKey) as RuntimeArtifactRow[];
        expect(failedArtifactRows).toContainEqual(expect.objectContaining({
          media_type: "application/x-ndjson",
          relative_path: failedRawAcpPath,
        }));
        const failedMetadata = store.getRun(failed.id)?.dynamic?.executionMetadata.find(entry => entry.kind === "agent_attempt")?.metadata as AgentAttemptMetadata | undefined;
        expect(failedMetadata).toMatchObject({
          status: "failed",
          turns: [expect.objectContaining({ status: "failed", failureKind: "provider_exit" })],
        });
        expectAgentArtifactRef(failedMetadata?.turns?.[0]?.rawAcpDebugArtifact, failedRawAcpPath, "application/x-ndjson", failedArtifactRows);
      } finally {
        restoreEnv("ACPUS_AGENT_RAW_ACP_DEBUG", previous);
        store.close();
      }
    });
  });

  it("executes scheduler-backed agent nodes with submit-time agent overrides", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-submit-override", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, overrideAgentWorkflow());
      const store = await openRuntimeStore(workspace);
      const turns: AgentTurnRequest[] = [];
      try {
        const run = await store.admitRun({
          prepared,
          input: {},
          cwd: workspace,
          agentOverrides: {
            reviewer: { command: "custom-acp-server", permissionMode: "deny-all" },
          },
        });

        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: run.id,
          ownerId: "owner-a",
          store,
          executeAgentTurn: async request => {
            turns.push(request);
            return completedAgentTurn("{\"ok\":true}");
          },
        })).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });

        expect(store.getRun(run.id)?.agentOverrides).toEqual({
          reviewer: { command: "custom-acp-server", permissionMode: "deny-all" },
        });
        expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({
          agent: { kind: "command", command: "custom-acp-server" },
          permissionMode: "deny-all",
        });
        expect(turns[0]!.model).toBeUndefined();
        expect(turns[0]!.agentMode).toBeUndefined();
      } finally {
        store.close();
      }
    });
  });

  it("inherits fork agent overrides and clears identity-tied fields on replacement", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-fork-override", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, overrideAgentWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const source = await store.admitRun({
          prepared,
          input: {},
          cwd: workspace,
          agentOverrides: {
            reviewer: {
              use: "claude",
              model: "sonnet",
              agentMode: "plan",
              permissionMode: "deny-all",
            },
            auditor: { use: "codex", model: "audit-model" },
          },
        });

        const inherited = await store.forkRun(source.id);
        expect(store.getRun(inherited.id)?.agentOverrides).toEqual({
          reviewer: {
            use: "claude",
            model: "sonnet",
            agentMode: "plan",
            permissionMode: "deny-all",
          },
          auditor: { use: "codex", model: "audit-model" },
        });
        expect(store.getFrozenRun(inherited.id)?.ir.agents.reviewer).toMatchObject({
          kind: "agent_definition",
          use: "claude",
          model: "sonnet",
          agentMode: "plan",
          permissionMode: "deny-all",
        });

        const replaced = await store.forkRun(source.id, {
          agentOverrides: { reviewer: { command: "custom-acp-server" } },
        });
        const effective = store.getFrozenRun(replaced.id)?.ir.agents.reviewer;
        expect(store.getRun(replaced.id)?.agentOverrides).toEqual({
          reviewer: { command: "custom-acp-server", permissionMode: "deny-all" },
          auditor: { use: "codex", model: "audit-model" },
        });
        expect(effective).toMatchObject({
          kind: "agent_command",
          command: "custom-acp-server",
          permissionMode: "deny-all",
        });
        expect(effective && "model" in effective ? effective.model : undefined).toBeUndefined();
        expect(effective && "agentMode" in effective ? effective.agentMode : undefined).toBeUndefined();
        expect(store.getFrozenRun(replaced.id)?.ir.agents.auditor).toMatchObject({
          kind: "agent_definition",
          use: "codex",
          model: "audit-model",
        });
      } finally {
        store.close();
      }
    });
  });

  it("seeds compatible completed prerequisites from a failed source fork", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-targeted-fork-seed", async workspace => {
      const sourcePrepared = await prepareSyntheticWorkflow(workspace, targetedForkFailedSourceWorkflow());
      const replacementPrepared = await prepareSyntheticWorkflow(workspace, targetedForkReplacementWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const source = await store.admitRun({ prepared: sourcePrepared, input: {}, cwd: workspace });
        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: source.id,
          ownerId: "source-owner",
          store,
        })).resolves.toMatchObject({ status: "idle", started: 1, completed: 1 });
        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: source.id,
          ownerId: "source-owner",
          store,
        })).resolves.toMatchObject({ status: "failed", started: 1, failed: 1 });

        const firstKey = deriveInstanceKey(appendNode([], "first"));
        expect(store.scheduler.loadRunSnapshot(source.id).projection.instances[firstKey]).toMatchObject({
          status: "completed",
          output: { ok: true },
        });

        const fork = await store.forkRun(source.id, { prepared: replacementPrepared });
        const seeded = store.scheduler.loadRunSnapshot(fork.id).projection;
        expect(seeded.instances[firstKey]).toMatchObject({
          status: "completed",
          output: { ok: true },
        });
        expect(Object.values(seeded.attempts).filter(attempt => attempt.nodeKey === firstKey)).toHaveLength(0);

        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: fork.id,
          ownerId: "fork-owner",
          store,
        })).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });

        const completed = store.scheduler.loadRunSnapshot(fork.id).projection;
        const fixedKey = deriveInstanceKey(appendNode([], "fixed"));
        expect(Object.values(completed.attempts).filter(attempt => attempt.nodeKey === firstKey)).toHaveLength(0);
        expect(Object.values(completed.attempts).filter(attempt => attempt.nodeKey === fixedKey)).toHaveLength(1);
        expect(store.getRun(fork.id)).toMatchObject({ status: "completed", output: { ok: true } });
      } finally {
        store.close();
      }
    });
  });

  it("unsafe targeted fork reuses loop history across a changed failed task definition", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-unsafe-loop-fork", async workspace => {
      const sourcePrepared = await prepareSyntheticWorkflow(workspace, unsafeLoopForkWorkflow(false));
      const replacementPrepared = await prepareSyntheticWorkflow(workspace, unsafeLoopForkWorkflow(true));
      const store = await openRuntimeStore(workspace);
      try {
        const source = await store.admitRun({ prepared: sourcePrepared, input: {}, cwd: workspace });
        await expect(driveFrozenRunToTerminal(workspace, store, source.id, "unsafe-loop-source")).resolves.toMatchObject({ status: "failed" });

        const iter0Prepare = deriveInstanceKey(appendNode(appendLoopIteration([], "retry", 0), "prepare"));
        const iter0Maybe = deriveInstanceKey(appendNode(appendLoopIteration([], "retry", 0), "maybe_fail"));
        const iter1Prepare = deriveInstanceKey(appendNode(appendLoopIteration([], "retry", 1), "prepare"));
        const iter1Maybe = deriveInstanceKey(appendNode(appendLoopIteration([], "retry", 1), "maybe_fail"));
        const iter2Prepare = deriveInstanceKey(appendNode(appendLoopIteration([], "retry", 2), "prepare"));
        const failedTarget = deriveInstanceKey(appendNode(appendLoopIteration([], "retry", 2), "maybe_fail"));
        const inherited = [iter0Prepare, iter0Maybe, iter1Prepare, iter1Maybe, iter2Prepare];
        const sourceProjection = store.scheduler.loadRunSnapshot(source.id).projection;
        for (const nodeKey of inherited) expect(sourceProjection.instances[nodeKey]).toMatchObject({ status: "completed" });
        expect(sourceProjection.instances[failedTarget]).toMatchObject({ status: "failed" });

        const implicit = await store.forkRun(source.id, { prepared: replacementPrepared, unsafeReuse: true });
        assertUnsafeLoopForkSeed(store, implicit.id, inherited, failedTarget);
        await expect(driveFrozenRunToTerminal(workspace, store, implicit.id, "unsafe-loop-implicit")).resolves.toMatchObject({ status: "completed" });
        assertUnsafeLoopForkCompleted(store, implicit.id, inherited, failedTarget);

        const explicit = await store.forkRun(source.id, { prepared: replacementPrepared, target: failedTarget, unsafeReuse: true });
        assertUnsafeLoopForkSeed(store, explicit.id, inherited, failedTarget);
        await expect(driveFrozenRunToTerminal(workspace, store, explicit.id, "unsafe-loop-explicit")).resolves.toMatchObject({ status: "completed" });
        assertUnsafeLoopForkCompleted(store, explicit.id, inherited, failedTarget);
      } finally {
        store.close();
      }
    });
  });

  it("does not seed an explicit fork target even when the source completed it", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-targeted-fork-explicit-target", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, targetedForkCompletedSourceWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const source = await store.admitRun({ prepared, input: {}, cwd: workspace });
        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: source.id,
          ownerId: "source-owner",
          store,
        })).resolves.toMatchObject({ status: "idle", started: 1, completed: 1 });
        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: source.id,
          ownerId: "source-owner",
          store,
        })).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });

        const fork = await store.forkRun(source.id, { target: "second" });
        const firstKey = deriveInstanceKey(appendNode([], "first"));
        const secondKey = deriveInstanceKey(appendNode([], "second"));
        const seeded = store.scheduler.loadRunSnapshot(fork.id).projection;
        expect(seeded.instances[firstKey]).toMatchObject({ status: "completed" });
        expect(seeded.instances[secondKey]).toMatchObject({ status: "ready" });

        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: fork.id,
          ownerId: "fork-owner",
          store,
        })).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });

        const completed = store.scheduler.loadRunSnapshot(fork.id).projection;
        expect(Object.values(completed.attempts).filter(attempt => attempt.nodeKey === firstKey)).toHaveLength(0);
        expect(Object.values(completed.attempts).filter(attempt => attempt.nodeKey === secondKey)).toHaveLength(1);
      } finally {
        store.close();
      }
    });
  });

  it("uses targeted fork mode when agent overrides are supplied even if unchanged", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-targeted-fork-empty-agent-overrides", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, targetedForkCompletedSourceWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const source = await store.admitRun({ prepared, input: {}, cwd: workspace });
        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: source.id,
          ownerId: "source-owner",
          store,
        })).resolves.toMatchObject({ status: "idle", started: 1, completed: 1 });
        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: source.id,
          ownerId: "source-owner",
          store,
        })).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });

        const fork = await store.forkRun(source.id, { agentOverrides: {} });

        expect(runtimeRow(workspace, "SELECT COUNT(*) AS count FROM scheduler_commits WHERE run_id = ? AND idempotency_key = ?", fork.id, `fork-seed:${fork.id}`)).toMatchObject({ count: 1 });
        expect(store.scheduler.loadRunSnapshot(fork.id).projection.instances[deriveInstanceKey(appendNode([], "first"))]).toMatchObject({ status: "completed" });
      } finally {
        store.close();
      }
    });
  });

  it("rewrites seeded artifact refs into fork-local scheduler payloads", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-targeted-fork-artifact-seed", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, taskArtifactWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const source = await store.admitRun({ prepared, input: {}, cwd: workspace });
        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: source.id,
          ownerId: "source-owner",
          store,
        })).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });

        const fork = await store.forkRun(source.id, { prepared });
        const nodeKey = deriveInstanceKey(appendNode([], "local_task"));
        const sourceArtifact = runtimeRow(workspace, "SELECT id FROM artifacts WHERE run_id = ? AND node_key = ?", source.id, nodeKey);
        const forkArtifact = runtimeRow(workspace, "SELECT id FROM artifacts WHERE run_id = ? AND node_key = ?", fork.id, nodeKey);
        expect(forkArtifact?.id).toBeDefined();
        expect(forkArtifact?.id).not.toBe(sourceArtifact?.id);
        expect(store.scheduler.loadRunSnapshot(fork.id).projection.instances[nodeKey]?.output).toMatchObject({
          artifact: { kind: "artifact", uri: `artifact://${fork.id}/${String(forkArtifact?.id)}` },
        });
      } finally {
        store.close();
      }
    });
  });

  it("rolls back targeted fork admission when seed artifact rewriting fails", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-targeted-fork-rollback", async workspace => {
      const sourcePrepared = await prepareSyntheticWorkflow(workspace, targetedForkFailedSourceWorkflow());
      const replacementPrepared = await prepareSyntheticWorkflow(workspace, targetedForkReplacementWorkflow());
      const firstKey = deriveInstanceKey(appendNode([], "first"));
      let sourceId = "";
      const sourceStore = await openRuntimeStore(workspace);
      try {
        const source = await sourceStore.admitRun({ prepared: sourcePrepared, input: {}, cwd: workspace });
        sourceId = source.id;
        await advanceFrozenRun({ cwd: workspace, runId: source.id, ownerId: "source-owner", store: sourceStore });
        await advanceFrozenRun({ cwd: workspace, runId: source.id, ownerId: "source-owner", store: sourceStore });
      } finally {
        sourceStore.close();
      }

      replaceCompletedInstanceEventOutput(workspace, sourceId, firstKey, {
        ok: true,
        artifact: { kind: "artifact", uri: `artifact://${sourceId}/missing_artifact` },
      });

      const runIdsBefore = new Set(runtimeRows(workspace, "SELECT id FROM runs").map(row => String(row.id)));
      const runDirsBefore = (await readdir(join(workspace, ".acpus", ".local", "runs"))).sort();

      const forkStore = await openRuntimeStore(workspace);
      try {
        await expect(forkStore.forkRun(sourceId, { prepared: replacementPrepared })).rejects.toMatchObject({
          failure: {
            type: "artifact-rewrite-failure",
            artifactId: "missing_artifact",
          },
        });
      } finally {
        forkStore.close();
      }

      expect(new Set(runtimeRows(workspace, "SELECT id FROM runs").map(row => String(row.id)))).toEqual(runIdsBefore);
      expect(forkAdmissionLeaks(workspace, runIdsBefore)).toEqual({
        runInputs: [],
        runEvents: [],
        schedulerCommits: [],
        schedulerFrames: [],
        nodeInstances: [],
        nodeStates: [],
        artifacts: [],
      });
      await expect(readdir(join(workspace, ".acpus", ".local", "runs")).then(entries => entries.sort())).resolves.toEqual(runDirsBefore);
    });
  });

  it("re-executes completed fork runs when fork-time agent overrides change", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-fork-override-reexecutes", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, overrideAgentWorkflow());
      const store = await openRuntimeStore(workspace);
      const sourceTurns: AgentTurnRequest[] = [];
      const forkTurns: AgentTurnRequest[] = [];
      try {
        const source = await store.admitRun({ prepared, input: {}, cwd: workspace });
        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: source.id,
          ownerId: "source-owner",
          store,
          executeAgentTurn: async request => {
            sourceTurns.push(request);
            return completedAgentTurn("{\"ok\":true}");
          },
        })).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });
        expect(store.getRun(source.id)).toMatchObject({ status: "completed", output: {} });

        const fork = await store.forkRun(source.id, {
          agentOverrides: { reviewer: { command: "custom-acp-server" } },
        });
        const forkRun = store.getRun(fork.id);
        expect(forkRun).toMatchObject({ status: "running" });
        expect(forkRun).not.toHaveProperty("output");

        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: fork.id,
          ownerId: "fork-owner",
          store,
          executeAgentTurn: async request => {
            forkTurns.push(request);
            return completedAgentTurn("{\"ok\":true}");
          },
        })).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });

        expect(sourceTurns).toHaveLength(1);
        expect(forkTurns).toHaveLength(1);
        expect(forkTurns[0]!.agent).toEqual({ kind: "command", command: "custom-acp-server" });
      } finally {
        store.close();
      }
    });
  });

  it("rejects invalid agent overrides at admission", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-override-invalid", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, overrideAgentWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        await expect(store.admitRun({
          prepared,
          input: {},
          cwd: workspace,
          agentOverrides: { reviewer: { options: {} } } as any,
        })).rejects.toThrow("$.reviewer Unrecognized key");
        await expect(store.admitRun({
          prepared,
          input: {},
          cwd: workspace,
          agentOverrides: { missing: { use: "codex" } },
        })).rejects.toThrow("does not reference a declared agent");
        for (const [agentOverrides, message] of [
          [{ reviewer: { policy: "full" } }, "$.reviewer Unrecognized key"],
          [{ reviewer: { kind: "agent_definition" } }, "$.reviewer Unrecognized key"],
          [{ reviewer: { timeout: "1s" } }, "$.reviewer Unrecognized key"],
          [{ reviewer: { use: "codex", command: "custom-acp-server" } }, "must not specify both use and command"],
          [{ reviewer: { cwd: 123 } }, "$.reviewer.cwd"],
          [{ reviewer: { env: { FLAG: true } } }, "$.reviewer.env.FLAG"],
        ] as Array<[any, string]>) {
          await expect(store.admitRun({
            prepared,
            input: {},
            cwd: workspace,
            agentOverrides,
          })).rejects.toThrow(message);
        }
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
          executeTurn: async request => completedAgentTurn(JSON.stringify({
            runId: request.env.ACPUS_RUNTIME_RUN_ID ?? null,
            nodeId: request.env.ACPUS_RUNTIME_NODE_ID ?? null,
            nodeKey: request.env.ACPUS_RUNTIME_NODE_KEY ?? null,
            schedulerAttempt: request.env.ACPUS_RUNTIME_ATTEMPT ?? null,
          })),
        })).resolves.toEqual({
          runId: null,
          nodeId: "inspect_agent",
          nodeKey: null,
          schedulerAttempt: null,
        });
      } finally {
        restoreEnv("ACPUS_RUNTIME_RUN_ID", previous.runId);
        restoreEnv("ACPUS_RUNTIME_NODE_KEY", previous.nodeKey);
        restoreEnv("ACPUS_RUNTIME_ATTEMPT", previous.attempt);
      }
    });
  });

  it("returns raw response text for schema-less agent nodes", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-raw-string", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, defineWorkflow({
        name: "raw_agent",
        agents: { reviewer: { use: "mock" } },
      }).build(({ agents, step }) => {
        step("review").agent({ run: { agent: agents.reviewer, prompt: "review" } });
        return {};
      }));
      const node = prepared.ir.root.nodes.find(node => node.id === "review");
      if (!node || node.kind !== "agent") throw new Error("expected review agent node");

      await expect(executeAgentNode(node, {}, {
        cwd: workspace,
        agents: prepared.ir.agents,
        executeTurn: async () => completedAgentTurn("plain text"),
      })).resolves.toBe("plain text");
    });
  });

  it("repairs empty schema-backed agent responses without parsing them", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-empty-repair", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, retryingAgentWorkflow());
      const node = prepared.ir.root.nodes.find(node => node.id === "review");
      if (!node || node.kind !== "agent") throw new Error("expected review agent node");
      const turns: AgentTurnRequest[] = [];

      await expect(executeAgentNode(node, {}, {
        cwd: workspace,
        agents: prepared.ir.agents,
        repairDelayMs: 0,
        executeTurn: async request => {
          turns.push(request);
          return completedAgentTurn(turns.length === 1 ? "" : "{\"attempt\":\"2\"}");
        },
      })).resolves.toEqual({ attempt: "2" });
      expect(turns).toHaveLength(2);
    });
  });

  it("honors retry max zero for schema-backed agent response repair", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-retry-zero", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, retryZeroAgentWorkflow());
      const node = prepared.ir.root.nodes.find(node => node.id === "review");
      if (!node || node.kind !== "agent") throw new Error("expected review agent node");
      const turns: AgentTurnRequest[] = [];

      await expect(executeAgentNode(node, {}, {
        cwd: workspace,
        agents: prepared.ir.agents,
        repairDelayMs: 0,
        executeTurn: async request => {
          turns.push(request);
          return completedAgentTurn("");
        },
      })).rejects.toThrow("empty_response");
      expect(turns).toHaveLength(1);
    });
  });

  it("does not write raw parsed output artifacts when agent JSON recovery fails", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-no-raw-parsed-output", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, retryZeroAgentWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });

        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: run.id,
          ownerId: "owner-a",
          store,
          executeAgentTurn: async () => completedAgentTurn("not json"),
        })).resolves.toMatchObject({ status: "failed", started: 1, failed: 1 });

        const nodeKey = deriveInstanceKey(appendNode([], "review"));
        const artifactRows = runtimeRows(workspace, "SELECT relative_path FROM artifacts WHERE run_id = ? AND node_key = ? ORDER BY relative_path", run.id, nodeKey) as Array<{ relative_path: string }>;
        expect(artifactRows.map(row => row.relative_path)).toEqual([
          `artifacts/${nodeKey}/attempt-1/agent/turn-001.prompt.md`,
          `artifacts/${nodeKey}/attempt-1/agent/turn-001.response.md`,
          `artifacts/${nodeKey}/attempt-1/agent/turn-001.telemetry.json`,
        ]);
        const metadata = store.getRun(run.id)?.dynamic?.executionMetadata.find(entry => entry.kind === "agent_attempt")?.metadata as AgentAttemptMetadata | undefined;
        expect(metadata?.turns).toEqual([
          expect.not.objectContaining({ rawParsedOutputArtifact: expect.anything() }),
        ]);
      } finally {
        store.close();
      }
    });
  });

  it("does not write raw parsed output artifacts for empty agent responses", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-empty-no-raw-parsed-output", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, retryZeroAgentWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });

        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: run.id,
          ownerId: "owner-a",
          store,
          executeAgentTurn: async () => completedAgentTurn(""),
        })).resolves.toMatchObject({ status: "failed", started: 1, failed: 1 });

        const nodeKey = deriveInstanceKey(appendNode([], "review"));
        const artifactRows = runtimeRows(workspace, "SELECT relative_path FROM artifacts WHERE run_id = ? AND node_key = ? ORDER BY relative_path", run.id, nodeKey) as Array<{ relative_path: string }>;
        expect(artifactRows.map(row => row.relative_path)).toEqual([
          `artifacts/${nodeKey}/attempt-1/agent/turn-001.prompt.md`,
          `artifacts/${nodeKey}/attempt-1/agent/turn-001.response.md`,
          `artifacts/${nodeKey}/attempt-1/agent/turn-001.telemetry.json`,
        ]);
        const metadata = store.getRun(run.id)?.dynamic?.executionMetadata.find(entry => entry.kind === "agent_attempt")?.metadata as AgentAttemptMetadata | undefined;
        expect(metadata?.turns).toEqual([
          expect.objectContaining({ failureKind: "empty_response" }),
        ]);
        expect(metadata?.turns).toEqual([
          expect.not.objectContaining({ rawParsedOutputArtifact: expect.anything() }),
        ]);
      } finally {
        store.close();
      }
    });
  });

  it("projects nested extra keys from schema-backed agent output", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-nested-projection", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, nestedAgentOutputWorkflow());
      const node = prepared.ir.root.nodes.find(node => node.id === "review");
      if (!node || node.kind !== "agent") throw new Error("expected review agent node");

      await expect(executeAgentNode(node, {}, {
        cwd: workspace,
        agents: prepared.ir.agents,
        executeTurn: async () => completedAgentTurn("{\"items\":[{\"id\":\"a\",\"extra\":\"drop\"}],\"extra\":\"drop\"}"),
      })).resolves.toEqual({ items: [{ id: "a" }] });
    });
  });

  it("maps agent turn timeout to scheduler timed_out result", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-timeout", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, timeoutAgentWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const executor = createRuntimeNodeExecutor({
          cwd: workspace,
          ir: prepared.ir,
          scope: {},
          store,
          executeAgentTurn: async () => ({
            status: "failed",
            failureKind: "timeout",
            message: "Agent turn timed out after 5ms.",
            responseText: "",
            stderr: "",
            telemetry: agentTelemetry(0),
          }),
        });

        await expect(executor.execute({
          runId: run.id,
          nodeId: "review",
          nodeKey: "review.dynamic",
          attemptId: "attempt_timeout",
          attemptNo: 1,
          ownerEpoch: 1,
          signal: new AbortController().signal,
        })).resolves.toEqual({
          status: "timed_out",
          reason: "Agent turn timed out after 5ms.",
        });
        const metadata = store.getRun(run.id)?.dynamic?.executionMetadata.find(entry => entry.kind === "agent_attempt")?.metadata as AgentAttemptMetadata | undefined;
        expect(metadata).toMatchObject({
          status: "timed_out",
          turnCount: 1,
          turns: [expect.objectContaining({ status: "failed", failureKind: "timeout" })],
        });
      } finally {
        store.close();
      }
    });
  });

  it("records partial agent metadata when response repair delay is aborted", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-repair-delay-abort", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, retryingAgentWorkflow());
      const store = await openRuntimeStore(workspace);
      const controller = new AbortController();
      const turns: AgentTurnRequest[] = [];
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const executor = createRuntimeNodeExecutor({
          cwd: workspace,
          ir: prepared.ir,
          scope: {},
          store,
          agentRepairDelayMs: 100,
          executeAgentTurn: async request => {
            turns.push(request);
            queueMicrotask(() => controller.abort());
            return completedAgentTurn("{\"attempt\":1}");
          },
        });

        await expect(executor.execute({
          runId: run.id,
          nodeId: "review",
          nodeKey: "review.dynamic",
          attemptId: "attempt_abort",
          attemptNo: 1,
          ownerEpoch: 1,
          signal: controller.signal,
        })).resolves.toEqual({
          status: "cancelled",
          reason: "paused",
        });
        expect(turns).toHaveLength(1);
        const metadata = store.getRun(run.id)?.dynamic?.executionMetadata.find(entry => entry.kind === "agent_attempt")?.metadata as AgentAttemptMetadata | undefined;
        expect(metadata).toMatchObject({
          status: "cancelled",
          turnCount: 1,
          message: "Agent response repair was aborted.",
          turns: [expect.objectContaining({ status: "completed", failureKind: "output_conformance" })],
        });
      } finally {
        store.close();
      }
    });
  });

  it("cancels active agent turns on pause and keeps partial turn artifacts", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-active-pause-artifacts", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, retryingAgentWorkflow());
      const store = await openRuntimeStore(workspace);
      const turns: AgentTurnRequest[] = [];
      let cooperativeAbort = false;
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const nodeKey = deriveInstanceKey(appendNode([], "review"));

        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: run.id,
          ownerId: "owner-a",
          store,
          executeAgentTurn: async request => {
            turns.push(request);
            setTimeout(() => {
              store.scheduler.pauseRun({
                runId: run.id,
                ownerEpoch: 1,
                idempotencyKey: "pause-active-agent",
              });
            }, 0);
            return new Promise(resolve => {
              request.signal?.addEventListener("abort", () => {
                cooperativeAbort = true;
                resolve({
                  status: "cancelled",
                  message: "paused by operator",
                  responseText: "partial response\n",
                  stderr: "partial stderr\n",
                  telemetry: agentTelemetry(1),
                });
              }, { once: true });
            });
          },
        })).resolves.toMatchObject({ status: "paused", started: 1, cancelled: 1 });

        expect(cooperativeAbort).toBe(true);
        expect(turns).toHaveLength(1);
        expect(store.scheduler.loadRunSnapshot(run.id).projection.instances[nodeKey]).toMatchObject({ status: "ready", statusReason: "paused" });

        const artifactRows = runtimeRows(workspace, "SELECT id, media_type, relative_path FROM artifacts WHERE run_id = ? AND node_key = ? ORDER BY relative_path", run.id, nodeKey) as RuntimeArtifactRow[];
        const promptPath = `artifacts/${nodeKey}/attempt-1/agent/turn-001.prompt.md`;
        const responsePath = `artifacts/${nodeKey}/attempt-1/agent/turn-001.response.md`;
        const stderrPath = `artifacts/${nodeKey}/attempt-1/agent/turn-001.stderr.log`;
        const telemetryPath = `artifacts/${nodeKey}/attempt-1/agent/turn-001.telemetry.json`;
        expect(artifactRows).toEqual([
          expect.objectContaining({ media_type: "text/markdown", relative_path: promptPath }),
          expect.objectContaining({ media_type: "text/markdown", relative_path: responsePath }),
          expect.objectContaining({ media_type: "text/plain", relative_path: stderrPath }),
          expect.objectContaining({ media_type: "application/json", relative_path: telemetryPath }),
        ]);
        const runDir = store.getRunDir(run.id);
        if (!runDir) throw new Error("expected run dir");
        await expect(readFile(join(workspace, runDir, responsePath), "utf8")).resolves.toBe("partial response\n");
        await expect(readFile(join(workspace, runDir, stderrPath), "utf8")).resolves.toBe("partial stderr\n");
        await expect(readJsonFile(join(workspace, runDir, telemetryPath))).resolves.toMatchObject({
          status: "cancelled",
          telemetry: agentTelemetry(1),
          message: "paused by operator",
        });

        const metadata = store.getRun(run.id)?.dynamic?.executionMetadata.find(entry => entry.kind === "agent_attempt")?.metadata as AgentAttemptMetadata | undefined;
        expect(metadata).toMatchObject({
          status: "cancelled",
          turnCount: 1,
          message: "paused by operator",
          turns: [expect.objectContaining({ status: "cancelled", message: "paused by operator" })],
        });
        expectAgentArtifactRef(metadata?.turns?.[0]?.promptArtifact, promptPath, "text/markdown", artifactRows);
        expectAgentArtifactRef(metadata?.turns?.[0]?.responseArtifact, responsePath, "text/markdown", artifactRows);
        expectAgentArtifactRef(metadata?.turns?.[0]?.stderrArtifact, stderrPath, "text/plain", artifactRows);
        expectAgentArtifactRef(metadata?.turns?.[0]?.telemetryArtifact, telemetryPath, "application/json", artifactRows);

        const claim = store.scheduler.claimRun(run.id, "resume-owner", 60_000);
        if (!claim) throw new Error("expected resume claim");
        store.scheduler.resumeRun({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "resume-active-agent",
        });
        store.scheduler.releaseRun(claim);

        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: run.id,
          ownerId: "owner-b",
          store,
          executeAgentTurn: async request => {
            turns.push(request);
            return completedAgentTurn("{\"attempt\":\"2\"}");
          },
        })).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });

        expect(turns).toHaveLength(2);
        expect(turns[1]!.sessionName).toBe(turns[0]!.sessionName);
        expect(turns[1]!.agentMode).toBeUndefined();
        expect(turns[1]!.prompt).toBe("Continue the previous task from where you left off.");
        expect(turns[1]!.prompt).not.toContain("# OUTPUT SCHEMA");
        const metadataEntries = store.getRun(run.id)?.dynamic?.executionMetadata.filter(entry => entry.kind === "agent_attempt").map(entry => entry.metadata) as AgentAttemptMetadata[] | undefined;
        expect(metadataEntries).toEqual([
          expect.objectContaining({ status: "cancelled", sessionName: turns[0]!.sessionName, turnCount: 1 }),
          expect.objectContaining({ status: "completed", sessionName: turns[0]!.sessionName, turnCount: 1 }),
        ]);
      } finally {
        store.close();
      }
    });
  });

  it("records zero-turn agent metadata for pre-turn setup failures", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-setup-failure-metadata", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, blankSessionAgentWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const node = prepared.ir.root.nodes.find(node => node.id === "review");
        if (!node || node.kind !== "agent") throw new Error("expected review agent node");

        await expect(executeAgentNode(node, {}, {
          cwd: workspace,
          runId: run.id,
          nodeKey: "review.dynamic",
          attemptId: "attempt_setup",
          attemptNo: 1,
          store,
          agents: prepared.ir.agents,
          executeTurn: async () => completedAgentTurn("{\"ok\":true}"),
        })).rejects.toThrow("sessionKey must render to a non-empty string");

        const entry = store.getRun(run.id)?.dynamic?.executionMetadata.find(entry => entry.kind === "agent_attempt");
        expect(entry).toMatchObject({ attemptId: "attempt_setup" });
        expect(entry?.metadata).toMatchObject({
          status: "failed",
          turnCount: 0,
          message: "Agent node 'review' sessionKey must render to a non-empty string.",
          turns: [],
        });
      } finally {
        store.close();
      }
    });
  });

  it("uses rendered explicit agent sessionKeys instead of dynamic node keys", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-explicit-session", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, explicitSessionAgentWorkflow());
      const node = prepared.ir.root.nodes.find(node => node.id === "review");
      if (!node || node.kind !== "agent") throw new Error("expected review agent node");
      const store = await openRuntimeStore(workspace);
      const turns: AgentTurnRequest[] = [];
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });

        for (const [index, nodeKey] of ["review.dynamic_a", "review.dynamic_b"].entries()) {
          await executeAgentNode(node, {}, {
            cwd: workspace,
            runId: run.id,
            nodeKey,
            attemptId: `attempt_${index + 1}`,
            attemptNo: index + 1,
            store,
            agents: prepared.ir.agents,
            executeTurn: async request => {
              turns.push(request);
              return completedAgentTurn("{\"ok\":true}");
            },
          });
        }

        expect(turns).toHaveLength(2);
        expect(turns[1]!.sessionName).toBe(turns[0]!.sessionName);
        const secondRun = await store.admitRun({ prepared, input: {}, cwd: workspace });
        await executeAgentNode(node, {}, {
          cwd: workspace,
          runId: secondRun.id,
          nodeKey: "review.dynamic_a",
          attemptId: "attempt_second_run",
          attemptNo: 1,
          store,
          agents: prepared.ir.agents,
          executeTurn: async request => {
            turns.push(request);
            return completedAgentTurn("{\"ok\":true}");
          },
        });
        expect(turns[2]!.sessionName).not.toBe(turns[0]!.sessionName);
        const agentMetadata = store.getRun(run.id)?.dynamic?.executionMetadata.filter(entry => entry.kind === "agent_attempt").map(entry => entry.metadata) as Array<{ sessionKey?: string; sessionName?: string }> | undefined;
        expect(agentMetadata).toEqual([
          expect.objectContaining({ sessionKey: "shared-session", sessionName: turns[0]!.sessionName }),
          expect.objectContaining({ sessionKey: "shared-session", sessionName: turns[0]!.sessionName }),
        ]);
      } finally {
        store.close();
      }
    });
  });

  it("does not parse provider-command env mappings before dispatching agent turns", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-no-provider-env", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, agentRuntimeContextWorkflow());
      const node = prepared.ir.root.nodes.find(node => node.id === "inspect_agent");
      if (!node || node.kind !== "agent") throw new Error("expected inspect_agent agent node");
      const previous = process.env.ACPUS_AGENT_PROVIDER_COMMANDS;
      process.env.ACPUS_AGENT_PROVIDER_COMMANDS = "not json";
      try {
        await expect(executeAgentNode(node, {}, {
          cwd: workspace,
          agents: prepared.ir.agents,
          executeTurn: async () => completedAgentTurn("{\"runId\":null,\"nodeId\":\"inspect_agent\",\"nodeKey\":null,\"schedulerAttempt\":null}"),
        })).resolves.toMatchObject({ nodeId: "inspect_agent" });
      } finally {
        restoreEnv("ACPUS_AGENT_PROVIDER_COMMANDS", previous);
      }
    });
  });

  it("does not apply workflow-level automatic retry to task failures", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-no-task-auto-retry", async workspace => {
      (globalThis as Record<string, unknown>).__acpus_scheduler_node_executor_retry_count = 0;
      const prepared = await prepareSyntheticWorkflow(workspace, retryingTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const nodeKey = deriveInstanceKey(appendNode([], "retry_task"));

        await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store }))
          .resolves.toMatchObject({ status: "failed", started: 1, failed: 1 });
        const projection = store.scheduler.loadRunSnapshot(run.id).projection;
        expect(projection.instances[nodeKey]).toMatchObject({ status: "failed" });
        expect(Object.values(projection.attempts).filter(attempt => attempt.nodeKey === nodeKey).map(attempt => attempt.status)).toEqual(["failed"]);
        expect(runtimeRows(workspace, "SELECT attempt, relative_path FROM artifacts WHERE run_id = ? AND node_key = ? ORDER BY attempt", run.id, nodeKey)).toEqual([
          expect.objectContaining({ attempt: 1, relative_path: expect.stringContaining(`${nodeKey}/attempt-1/`) }),
        ]);
      } finally {
        store.close();
        delete (globalThis as Record<string, unknown>).__acpus_scheduler_node_executor_retry_count;
      }
    });
  });

  it("does not turn agent response repair into scheduler-visible retry", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-no-agent-scheduler-retry", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, retryingAgentWorkflow());
      const store = await openRuntimeStore(workspace);
      const turns: AgentTurnRequest[] = [];
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const nodeKey = deriveInstanceKey(appendNode([], "review"));

        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: run.id,
          ownerId: "owner-a",
          store,
          agentRepairDelayMs: 0,
          executeAgentTurn: async request => {
            turns.push(request);
            return completedAgentTurn("{\"attempt\":1}");
          },
        })).resolves.toMatchObject({ status: "failed", started: 1, failed: 1 });

        expect(turns).toHaveLength(3);
        expect(store.scheduler.loadRunSnapshot(run.id).projection.instances[nodeKey]).toMatchObject({ status: "failed" });
        expect(Object.values(store.scheduler.loadRunSnapshot(run.id).projection.attempts).filter(attempt => attempt.nodeKey === nodeKey).map(attempt => attempt.status)).toEqual(["failed"]);
        const metadata = store.getRun(run.id)?.dynamic?.executionMetadata.find(entry => entry.kind === "agent_attempt")?.metadata as AgentAttemptMetadata | undefined;
        expect(metadata).toMatchObject({
          status: "failed",
          turnCount: 3,
          turns: [
            expect.objectContaining({ status: "completed", failureKind: "output_conformance" }),
            expect.objectContaining({ status: "completed", failureKind: "output_conformance" }),
            expect.objectContaining({ status: "completed", failureKind: "output_conformance" }),
          ],
        });
        expect(metadata?.message).toContain("output_conformance");
      } finally {
        store.close();
      }
    });
  });

  it("uses plain continuation prompt and same session for manual agent node retry", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-manual-retry-continuation", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, retryingAgentWorkflow());
      const store = await openRuntimeStore(workspace);
      const turns: AgentTurnRequest[] = [];
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const nodeKey = deriveInstanceKey(appendNode([], "review"));

        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: run.id,
          ownerId: "owner-a",
          store,
          agentRepairDelayMs: 0,
          executeAgentTurn: async request => {
            turns.push(request);
            return completedAgentTurn("{\"ok\":\"not boolean\"}");
          },
        })).resolves.toMatchObject({ status: "failed", started: 1, failed: 1 });

        const claim = store.scheduler.claimRun(run.id, "retry-owner", 60_000);
        if (!claim) throw new Error("expected retry claim");
        store.scheduler.retry({
          runId: run.id,
          targetKey: nodeKey,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "manual-agent-retry",
        });
        store.scheduler.releaseRun(claim);

        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: run.id,
          ownerId: "owner-b",
          store,
          agentRepairDelayMs: 0,
          executeAgentTurn: async request => {
            turns.push(request);
            return completedAgentTurn("{\"attempt\":\"4\"}");
          },
        })).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });

        expect(turns).toHaveLength(4);
        expect(turns[3]!.sessionName).toBe(turns[0]!.sessionName);
        expect(turns[3]!.agentMode).toBeUndefined();
        expect(turns[3]!.prompt).toBe("Continue the previous task from where you left off.");
        expect(turns[3]!.prompt).not.toContain("# OUTPUT SCHEMA");
        const metadata = store.getRun(run.id)?.dynamic?.executionMetadata.filter(entry => entry.kind === "agent_attempt").map(entry => entry.metadata) as AgentAttemptMetadata[] | undefined;
        expect(metadata).toEqual([
          expect.objectContaining({ status: "failed", sessionName: turns[0]!.sessionName, turnCount: 3 }),
          expect.objectContaining({ status: "completed", sessionName: turns[0]!.sessionName, turnCount: 1 }),
        ]);
      } finally {
        store.close();
      }
    });
  });

  it("uses the task prompt again for run-level retry of a failed agent run", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-agent-run-retry-task-prompt", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, retryZeroAgentWorkflow());
      const store = await openRuntimeStore(workspace);
      const turns: AgentTurnRequest[] = [];
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });

        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: run.id,
          ownerId: "owner-a",
          store,
          executeAgentTurn: async request => {
            turns.push(request);
            return completedAgentTurn("{\"ok\":\"not boolean\"}");
          },
        })).resolves.toMatchObject({ status: "failed", started: 1, failed: 1 });

        const claim = store.scheduler.claimRun(run.id, "retry-run-owner", 60_000);
        if (!claim) throw new Error("expected run retry claim");
        store.scheduler.retryRun({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "manual-run-retry",
        });
        store.scheduler.releaseRun(claim);

        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: run.id,
          ownerId: "owner-b",
          store,
          executeAgentTurn: async request => {
            turns.push(request);
            return completedAgentTurn("{\"ok\":true}");
          },
        })).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });

        expect(turns).toHaveLength(2);
        expect(turns[1]!.prompt).toContain("review");
        expect(turns[1]!.prompt).toContain("# OUTPUT SCHEMA");
        expect(turns[1]!.prompt).not.toBe("Continue the previous task from where you left off.");
      } finally {
        store.close();
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

function rootTimedSignalWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-signal-timeout",
  }).build(({ step }) => {
    const approval = step("approve").signal({
      outputSchema: z.object({ ok: z.boolean() }),
      timeout: "5s",
      onTimeout: { action: "fail", message: "Approval timed out" },
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
      run: { input: {}, exec: async () => ({ value: "first" }) },
    });
    const second = step("second_task").task({
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
      then: ({ step }) => {
        const task = step("then_task").task({
          run: { input: {}, exec: async () => ({ value: "then" }) },
        });
        return { value: task.output.value };
      },
      else: () => ({ value: template`else` }),
    });
    const final = step("final_task").task({
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
      then: ({ step }) => {
        const first = step("then_first").task({
          run: { input: {}, exec: async () => ({ value: "first" }) },
        });
        const second = step("then_second").task({
          run: {
            input: { value: first.output.value },
            exec: async ({ input }) => ({ value: `${input.value}-second` }),
          },
        });
        return { value: second.output.value };
      },
      else: () => ({ value: template`else` }),
    });
    const final = step("final_task").task({
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
      cases: [
        {
          when: eq(input.mode, "case"),
          then: ({ step }) => {
            const first = step("case_first").task({
              run: { input: {}, exec: async () => ({ value: "case" }) },
            });
            const second = step("case_second").task({
              run: {
                input: { value: first.output.value },
                exec: async ({ input }) => ({ value: `${input.value}-second` }),
              },
            });
            return { value: second.output.value };
          },
        },
      ],
      default: () => ({ value: template`default` }),
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
          do: ({ step }) => {
            const task = step("left_task").task({
              run: { input: {}, exec: async () => ({ value: "left" }) },
            });
            return { value: task.output.value, rootPrefix: "root" };
          },
        },
        right: {
          do: ({ step }) => {
            const task = step("right_task").task({
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
      run: { input: {}, exec: async () => ({ prefix: "root" }) },
    });
    const combined = step("combine").parallel({
      branches: {
        left: {
          do: ({ step }) => {
            const task = step("left_task").task({
              run: {
                input: { prefix: prepare.output.prefix },
                exec: async ({ input }: { input: { prefix: string } }) => ({ value: `${input.prefix}-left` }),
              },
            });
            return { value: task.output.value, rootPrefix: prepare.output.prefix };
          },
        },
        right: {
          do: ({ step }) => {
            const task = step("right_task").task({
              run: {
                input: { prefix: prepare.output.prefix },
                exec: async ({ input }: { input: { prefix: string } }) => ({ value: `${input.prefix}-right` }),
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
          do: ({ step }) => {
            step("first_task").task({
              run: { input: {}, exec: async () => ({ value: "first" }) },
            });
            const second = step("second_task").task({
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
      do: ({ item, step }) => {
        const first = step("first_task").task({
          run: {
            input: { item },
            exec: async ({ input }) => ({ value: `${input.item}-first` }),
          },
        });
        const second = step("second_task").task({
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

function nestedFanoutInParallelWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-nested-fanout",
    inputSchema: z.object({ items: z.array(z.string()) }),
  }).build(({ input, step }) => {
    const prepare = step("prepare").task({
      run: { input: {}, exec: async () => ({ prefix: "root" }) },
    });
    const combined = step("combine").parallel({
      maxConcurrency: 1,
      branches: {
        items: {
          do: ({ step }) => {
            const inner = step("inner_items").fanout({
              over: input.items,
              maxConcurrency: 1,
              do: ({ item, itemIndex, step }) => {
                const task = step("inner_task").task({
                  run: {
                    input: { prefix: prepare.output.prefix, item, itemIndex },
                    exec: async ({ input }: { input: { prefix: string; item: string; itemIndex: number } }) => ({ value: `${input.prefix}-${input.item}-${input.itemIndex}` }),
                  },
                });
                return { value: task.output.value };
              },
            });
            return { values: inner.output };
          },
        },
        sibling: {
          do: ({ step }) => {
            const task = step("sibling_task").task({
              run: {
                input: { prefix: prepare.output.prefix },
                exec: async ({ input }: { input: { prefix: string } }) => ({ value: `${input.prefix}-sibling` }),
              },
            });
            return { value: task.output.value };
          },
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
        left: {
          do: ({ step }) => {
            const approval = step("left_signal").signal({
              outputSchema: z.object({ ok: z.boolean() }),
              run: { prompt: "left" },
            });
            return { ok: approval.output.ok };
          },
        },
        right: {
          do: ({ step }) => {
            const approval = step("right_signal").signal({
              outputSchema: z.object({ ok: z.boolean() }),
              run: { prompt: "right" },
            });
            return { ok: approval.output.ok };
          },
        },
      },
    });
    return { gate: gate.output };
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
        strategy: "quorum",
        count: options.count ?? 1,
        ...(options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
        do: ({ item, itemIndex, step }) => {
          const task = step("item_task").task({
            run: {
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
            },
          });
          return { item: task.output.item, index: task.output.index };
        },
      });
    } else {
      step("items").fanout({
        over: input.items,
        ...(options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
        do: ({ item, itemIndex, step }) => {
          const task = step("item_task").task({
            run: {
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
      initial: { done: false as boolean, iter: -1 },
      maxIterations: 3,
      do: ({ iter, step }) => {
        const task = step("loop_task").task({
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
      initial: { done: false as boolean, value: "" },
      maxIterations: 3,
      do: ({ iter, step }) => {
        const first = step("first_task").task({
          run: {
            input: { iter },
            exec: async ({ input }) => ({ value: `first-${input.iter}` }),
          },
        });
        const second = step("second_task").task({
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
      reviewer: { command: "custom-acp-server", agentMode: "agent" },
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

function largeAgentOutputWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-agent-large-output",
    agents: {
      reviewer: { use: "codex" },
    },
  }).build(({ agents, step }) => {
    step("review").agent({
      outputSchema: z.object({ text: z.string() }),
      run: { agent: agents.reviewer, prompt: "review" },
    });
    return {};
  });
}

function arrayAgentOutputWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-agent-array-output",
    agents: {
      reviewer: { use: "codex" },
    },
  }).build(({ agents, step }) => {
    step("review").agent({
      outputSchema: z.array(z.string()),
      run: { agent: agents.reviewer, prompt: "review" },
    });
    return {};
  });
}

function retryZeroAgentWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-agent-retry-zero",
    agents: {
      reviewer: { use: "codex" },
    },
  }).build(({ agents, step }) => {
    step("review").agent({
      outputSchema: z.object({ ok: z.boolean() }),
      retry: { max: 0 },
      run: { agent: agents.reviewer, prompt: "review" },
    });
    return {};
  });
}

function overrideAgentWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-agent-override",
    agents: {
      reviewer: {
        use: "codex",
        model: "old-model",
        permissionMode: "approve-reads",
        agentMode: "agent",
      },
      auditor: { use: "claude" },
    },
  }).build(({ agents, step }) => {
    step("review").agent({
      outputSchema: z.object({ ok: z.boolean() }),
      run: { agent: agents.reviewer, prompt: "review" },
    });
    return {};
  });
}

function agentRuntimeContextWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-agent-runtime-context",
    agents: {
      inspector: { use: "codex" },
    },
  }).build(({ agents, step }) => {
    step("inspect_agent").agent({
      outputSchema: z.object({
        runId: z.string().nullable(),
        nodeId: z.string().nullable(),
        nodeKey: z.string().nullable(),
        schedulerAttempt: z.string().nullable(),
      }),
      run: { agent: agents.inspector, prompt: "inspect" },
    });
    return {};
  });
}

function nestedAgentOutputWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-agent-nested-output",
    agents: {
      reviewer: { use: "codex" },
    },
  }).build(({ agents, step }) => {
    step("review").agent({
      outputSchema: z.object({ items: z.array(z.object({ id: z.string() })) }),
      run: { agent: agents.reviewer, prompt: "review" },
    });
    return {};
  });
}

function timeoutAgentWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-agent-timeout",
    agents: {
      reviewer: { use: "codex" },
    },
  }).build(({ agents, step }) => {
    step("review").agent({
      outputSchema: z.object({ ok: z.boolean() }),
      timeout: "5ms",
      run: { agent: agents.reviewer, prompt: "review" },
    });
    return {};
  });
}

function explicitSessionAgentWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-agent-explicit-session",
    agents: {
      reviewer: { use: "codex" },
    },
  }).build(({ agents, step }) => {
    step("review").agent({
      outputSchema: z.object({ ok: z.boolean() }),
      run: { agent: agents.reviewer, prompt: "review", sessionKey: "shared-session" },
    });
    return {};
  });
}

function blankSessionAgentWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-agent-blank-session",
    agents: {
      reviewer: { use: "codex" },
    },
  }).build(({ agents, step }) => {
    step("review").agent({
      outputSchema: z.object({ ok: z.boolean() }),
      run: { agent: agents.reviewer, prompt: "review", sessionKey: "" },
    });
    return {};
  });
}

async function driveFrozenRunToTerminal(
  workspace: string,
  store: Awaited<ReturnType<typeof openRuntimeStore>>,
  runId: string,
  ownerPrefix: string,
): Promise<Awaited<ReturnType<typeof advanceFrozenRun>>> {
  for (let index = 0; index < 30; index += 1) {
    const summary = await advanceFrozenRun({ cwd: workspace, runId, ownerId: `${ownerPrefix}-${index}`, store });
    if (summary.status === "completed" || summary.status === "failed" || summary.status === "canceled") return summary;
  }
  throw new Error(`Run '${runId}' did not reach a terminal state.`);
}

function assertUnsafeLoopForkSeed(
  store: Awaited<ReturnType<typeof openRuntimeStore>>,
  runId: string,
  inherited: string[],
  target: string,
): void {
  const projection = store.scheduler.loadRunSnapshot(runId).projection;
  for (const nodeKey of inherited) {
    expect(projection.instances[nodeKey]).toMatchObject({ status: "completed" });
    expect(Object.values(projection.attempts).filter(attempt => attempt.nodeKey === nodeKey)).toHaveLength(0);
  }
  expect(projection.instances[target]).toMatchObject({ status: "ready" });
  expect(Object.values(projection.attempts).filter(attempt => attempt.nodeKey === target)).toHaveLength(0);
}

function assertUnsafeLoopForkCompleted(
  store: Awaited<ReturnType<typeof openRuntimeStore>>,
  runId: string,
  inherited: string[],
  target: string,
): void {
  const projection = store.scheduler.loadRunSnapshot(runId).projection;
  for (const nodeKey of inherited) {
    expect(Object.values(projection.attempts).filter(attempt => attempt.nodeKey === nodeKey)).toHaveLength(0);
  }
  expect(Object.values(projection.attempts).filter(attempt => attempt.nodeKey === target)).toHaveLength(1);
  expect(store.getRun(runId)).toMatchObject({ status: "completed", output: { done: true, last: "fixed-2" } });
}

function unsafeLoopForkWorkflow(fixed: boolean) {
  return defineWorkflow({
    name: fixed ? "scheduler-node-executor-unsafe-loop-replacement" : "scheduler-node-executor-unsafe-loop-source",
  }).build(({ step }) => {
    const retry = step("retry").loop({
      initial: { done: false as boolean, last: "initial" },
      maxIterations: 4,
      do: ({ iter, step }) => {
        const prepare = step("prepare").task({
          run: {
            input: { iter },
            exec: async ({ input }) => ({ marker: `prepare-${input.iter}` }),
          },
        });
        const maybe = step("maybe_fail").task({
          run: {
            input: { iter, marker: prepare.output.marker },
            exec: fixed
              ? async ({ input }) => ({ done: input.iter >= 2, last: input.iter >= 2 ? "fixed-2" : `source-${input.iter}`, marker: input.marker })
              : async ({ input }) => {
                  if (input.iter === 2) throw new Error("source failure at iter 2");
                  return { done: false, last: `source-${input.iter}`, marker: input.marker };
                },
          },
        });
        return { done: maybe.output.done, last: maybe.output.last };
      },
      stopWhen: ({ result }) => result.done,
    });
    return { done: retry.output.done, last: retry.output.last };
  });
}

function targetedForkFailedSourceWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-targeted-fork-source",
  }).build(({ step }) => {
    const first = step("first").task({
      run: {
        input: {},
        exec: async () => ({ ok: true }),
      },
    });
    step("boom").task({
      run: {
        input: { ok: first.output.ok },
        exec: async () => {
          throw new Error("boom");
        },
      },
    });
    return {};
  });
}

function targetedForkReplacementWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-targeted-fork-replacement",
  }).build(({ step }) => {
    const first = step("first").task({
      run: {
        input: {},
        exec: async () => ({ ok: true }),
      },
    });
    const fixed = step("fixed").task({
      run: {
        input: { ok: first.output.ok },
        exec: async ({ input }) => ({ ok: input.ok }),
      },
    });
    return { ok: fixed.output.ok };
  });
}

function targetedForkCompletedSourceWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-targeted-fork-completed",
  }).build(({ step }) => {
    const first = step("first").task({
      run: {
        input: {},
        exec: async () => ({ ok: true }),
      },
    });
    const second = step("second").task({
      run: {
        input: { ok: first.output.ok },
        exec: async ({ input }) => ({ ok: input.ok }),
      },
    });
    return { ok: second.output.ok };
  });
}

function replaceCompletedInstanceEventOutput(workspace: string, runId: string, nodeKey: string, output: unknown): void {
  const db = new DatabaseSync(join(workspace, ".acpus", ".local", "state", "runtime.db"));
  try {
    db.prepare("UPDATE run_events SET payload_json = ? WHERE run_id = ? AND type = 'instance.completed' AND node_key = ?").run(
      JSON.stringify({ schedulerEventVersion: 1, payload: { nodeKey, output } }),
      runId,
      nodeKey,
    );
  } finally {
    db.close();
  }
}

function forkAdmissionLeaks(workspace: string, knownRunIds: Set<string>) {
  const unknown = (rows: Array<Record<string, unknown>>) => rows.filter(row => !knownRunIds.has(String(row.run_id)));
  return {
    runInputs: unknown(runtimeRows(workspace, "SELECT run_id FROM run_inputs ORDER BY run_id")),
    runEvents: unknown(runtimeRows(workspace, "SELECT run_id, sequence, type FROM run_events ORDER BY run_id, sequence, type")),
    schedulerCommits: unknown(runtimeRows(workspace, "SELECT run_id, idempotency_key FROM scheduler_commits ORDER BY run_id, idempotency_key")),
    schedulerFrames: unknown(runtimeRows(workspace, "SELECT run_id, frame_key, status FROM scheduler_frames ORDER BY run_id, frame_key")),
    nodeInstances: unknown(runtimeRows(workspace, "SELECT run_id, node_key, status FROM node_instances ORDER BY run_id, node_key")),
    nodeStates: unknown(runtimeRows(workspace, "SELECT run_id, node_key, status FROM node_states ORDER BY run_id, node_key")),
    artifacts: unknown(runtimeRows(workspace, "SELECT run_id, id FROM artifacts ORDER BY run_id, id")),
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

type RuntimeArtifactRow = {
  id: string;
  media_type: string;
  relative_path: string;
};

type AgentAttemptMetadata = {
  nodeId?: string;
  nodeKey?: string;
  attemptNo?: number;
  status?: string;
  sessionName?: string;
  sessionKey?: string;
  turnCount?: number;
  turns?: Array<Record<string, any>>;
  message?: string;
};

function expectAgentArtifactRef(ref: unknown, relativePath: string, mediaType: string, rows: RuntimeArtifactRow[]): void {
  const row = rows.find(row => row.relative_path === relativePath);
  expect(row).toBeDefined();
  expect(ref).toEqual({
    artifactId: row?.id,
    relativePath,
    mediaType,
  });
}

function completedAgentTurn(responseText: string, stderr = "", telemetry = agentTelemetry(1)): AgentTurnResult {
  return { status: "completed", responseText, stderr, telemetry };
}

function startReviewAttempt(store: RuntimeStore, runId: string, idempotencyPrefix: string) {
  const claim = store.scheduler.claimRun(runId, `${idempotencyPrefix}-owner`, 60_000);
  if (!claim) throw new Error("expected run claim");
  const snapshot = store.scheduler.loadRunSnapshot(runId);
  store.scheduler.appendSchedulerEvents({
    runId,
    expectedVersion: snapshot.version,
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey: `${idempotencyPrefix}:ready`,
    events: [{
      type: "instance.ready",
      payload: {
        runId,
        nodeKey: "review.dynamic",
        nodeId: "review",
        instancePath: [{ kind: "node", nodeId: "review" }],
        readinessSequence: 1,
      },
    }],
  });
  const attempt = store.scheduler.startAttempt({
    runId,
    nodeKey: "review.dynamic",
    nodeId: "review",
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey: `${idempotencyPrefix}:attempt`,
  });
  return { attempt, ownerEpoch: claim.ownerEpoch };
}

function agentTelemetry(eventCount: number): AgentTurnResult["telemetry"] {
  return { eventCount, tools: { totalToolCallCount: 0, calls: [] } };
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function timeoutTaskWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-timeout-deadline",
  }).build(({ step }) => {
    const task = step("timeout_task").task({
      timeout: "5s",
      run: {
        input: {},
        exec: async () => ({ ok: true }),
      },
    });
    return { ok: task.output.ok };
  });
}

function nonAdmissibleTaskWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-non-admissible-output",
  }).build(({ step }) => {
    step("bad_output").task({
      run: {
        input: {},
        exec: async () => ({ when: new Date() }),
      },
    });
    return {};
  });
}
