import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineWorkflow } from "@acpus/core";
import { describe, expect, it } from "vitest";
import { appendNode, deriveInstanceKey } from "../src/scheduler/identity.js";
import { createRuntimeNodeExecutor } from "../src/scheduler/node-executor.js";
import { advanceFrozenRun } from "../src/scheduler/runtime-runner.js";
import { openRuntimeStore } from "../src/store/store.js";
import { prepareSyntheticWorkflow, runtimeRow, runtimeRows, taskArtifactWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";
import { throwingSchedulerStore } from "./support/scheduler-store.js";

describe("runtime scheduler task process", () => {
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

        const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
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

  it("fails durable task attempts before non-admissible output reaches the store", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-non-admissible-output", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, nonAdmissibleTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });

        await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store })).resolves.toMatchObject({ status: "failed", failed: 1 });

        const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
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
        expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection.instances[nodeKey]).toMatchObject({ status: "completed" });
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
        expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(fork.id).projection.instances[nodeKey]?.output).toMatchObject({
          artifact: { kind: "artifact", uri: `artifact://${fork.id}/${String(forkArtifact?.id)}` },
        });
      } finally {
        store.close();
      }
    });
  });

  it("does not automatically retry task failures", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-no-task-auto-retry", async workspace => {
      (globalThis as Record<string, unknown>).__acpus_scheduler_node_executor_retry_count = 0;
      const prepared = await prepareSyntheticWorkflow(workspace, retryingTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
        const nodeKey = deriveInstanceKey(appendNode([], "retry_task"));

        await expect(advanceFrozenRun({ cwd: workspace, runId: run.id, ownerId: "owner-a", store }))
          .resolves.toMatchObject({ status: "failed", started: 1, failed: 1 });
        const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
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

function nonAdmissibleTaskWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-non-admissible-output",
  }).build(({ step }) => {
    step("bad_output").task({
      run: {
        input: {},
        exec: (async () => ({ when: new Date() })) as any,
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
