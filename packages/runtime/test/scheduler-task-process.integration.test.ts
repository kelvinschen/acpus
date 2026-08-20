import { admitRunForTest } from "./support/runtime-store.js";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defineWorkflow, z } from "@acpus/core";
import { lift, template } from "@acpus/expression";
import type { AgentSessionSupervisor } from "@acpus/agent-executor";
import type {
  FixtureAgentTurnRequest as AgentTurnRequest,
  FixtureAgentTurnResult as AgentTurnResult,
} from "./support/agent-turn.js";
import { describe, expect, it } from "vitest";
import { tryBindArtifactRef } from "../src/artifacts/access.js";
import { appendNode, deriveInstanceKey } from "../src/scheduler/identity.js";
import { createRuntimeNodeExecutor } from "../src/scheduler/node-executor.js";
import { advanceFrozenRun } from "../src/scheduler/runtime-runner.js";
import { openRuntimeStore } from "../src/store/store.js";
import { prepareSyntheticWorkflow, runtimeDatabasePath, runtimeRunDir, runtimeRow, runtimeRows, taskArtifactWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";
import { throwingSchedulerStore } from "./support/scheduler-store.js";
import { rootFrameStarted } from "./support/scheduler.js";
import { loadAgentHostPolicy } from "../src/configuration.js";
import { observedCompletedAgentTurn, taggedAgentOutput } from "./support/agent-turn.js";
import { testAgentSessionSupervisor } from "./support/agent-session-supervisor.js";

describe.concurrent("runtime scheduler task process", () => {
  it("boots a frozen root task into durable scheduler projection and executes it", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-bootstrap", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, taskRuntimeContextWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });

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
        const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });

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
        const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
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
        const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000);
        if (!claim) throw new Error("expected run claim");
        const ready = throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "dynamic-task:ready",
          events: [
            rootFrameStarted(run.id, "context_task", "context_task.dynamic"),
            {
              type: "instance.ready",
              payload: {
                runId: run.id,
                nodeKey: "context_task.dynamic",
                nodeId: "context_task",
                instancePath: [{ kind: "node", nodeId: "context_task" }],
                parentFrameKey: "root",
                readinessSequence: 1,
              },
            },
          ],
        });
        const attempt = throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeId: "context_task",
          nodeKey: "context_task.dynamic",
          ownerEpoch: claim.ownerEpoch,
          expectedVersion: ready.version,
          idempotencyKey: "dynamic-task:start",
        });
        const executor = createRuntimeNodeExecutor({
          cwd: workspace,
          ir: prepared.ir,
          scope: {},
          store,
          agentHostPolicy: loadAgentHostPolicy(process.env),
        });

        const result = await executor.execute({
          runId: run.id,
          nodeId: "context_task",
          nodeKey: "context_task.dynamic",
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
          ownerEpoch: claim.ownerEpoch,
          signal: new AbortController().signal,
        });

        expect(result).toMatchObject({
          status: "completed",
          output: {
            artifact: { kind: "artifact" },
          },
        });
        const artifact = runtimeRow(workspace, "SELECT attempt, relative_path FROM artifacts WHERE run_id = ? AND node_key = ?", run.id, "context_task.dynamic");
        expect(artifact).toMatchObject({ attempt: 1 });
        expect(String(artifact?.relative_path)).toContain("artifacts/context_task.dynamic/attempt-1/");
        const bytes = await readFile(join(runtimeRunDir(workspace, run.id), String(artifact?.relative_path)));
        expect(bytes.toString("utf8")).toBe("dynamic artifact\n");
        const metadata = store.getRun(run.id)?.dynamic?.executionMetadata.find(entry => entry.kind === "task_attempt");
        expect(metadata).toMatchObject({
          attemptId: attempt.attemptId,
          kind: "task_attempt",
          metadata: expect.objectContaining({
            nodeId: "context_task",
            nodeKey: "context_task.dynamic",
            attemptNo: 1,
            input: null,
            cwd: workspace,
          }),
        });
      } finally {
        store.close();
      }
    });
  });

  it("activates fork-local artifact refs only when their completion is replayed", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-fork-artifact-replay", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, taskArtifactWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const source = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: source.id,
          ownerId: "source-owner",
          store,
        })).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });

        const fork = (await store.forkRun(source.id, { prepared }))._unsafeUnwrap();
        const nodeKey = deriveInstanceKey(appendNode([], "local_task"));
        const sourceArtifact = runtimeRow(workspace, "SELECT id FROM artifacts WHERE run_id = ? AND node_key = ?", source.id, nodeKey);
        expect(runtimeRow(workspace, "SELECT id FROM artifacts WHERE run_id = ? AND node_key = ?", fork.id, nodeKey)).toBeUndefined();
        expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(fork.id).projection.instances[nodeKey]).toBeUndefined();

        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: fork.id,
          ownerId: "fork-owner",
          store,
        })).resolves.toMatchObject({ status: "completed", started: 0, completed: 1 });

        const forkArtifact = runtimeRow(workspace, "SELECT id FROM artifacts WHERE run_id = ? AND node_key = ?", fork.id, nodeKey);
        expect(forkArtifact?.id).toBeDefined();
        expect(forkArtifact?.id).not.toBe(sourceArtifact?.id);
        expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(fork.id).projection.instances[nodeKey]?.output).toMatchObject({
          artifact: { kind: "artifact", uri: `artifact://${fork.id}/${String(forkArtifact?.id)}` },
        });
        const resolved = tryBindArtifactRef({
          kind: "artifact",
          uri: `artifact://${fork.id}/${String(forkArtifact?.id)}`,
        }, { runId: fork.id, store });
        expect(resolved.isOk()).toBe(true);
        if (resolved.isErr()) throw new Error(resolved.error.message);
        expect(isAbsolute(resolved.value.path)).toBe(true);
        expect(resolved.value.path).toContain(fork.id);
        await expect(readFile(resolved.value.path, "utf8")).resolves.toBe("artifact-ok\n");
      } finally {
        store.close();
      }
    });
  });

  it("plans artifact-driven session topology with the rewritten child URI", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-fork-artifact-uri", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, artifactUriSessionWorkflow());
      const store = await openRuntimeStore(workspace);
      const turns: AgentTurnRequest[] = [];
      const agentSessionSupervisor = managedAgent(async request => {
        turns.push(request);
        return observedCompletedAgentTurn(request, taggedAgentOutput("{\"ok\":true}"));
      });
      try {
        const source = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: source.id,
          ownerId: "source-owner",
          store,
          agentSessionSupervisor,
        })).resolves.toMatchObject({ status: "completed", started: 3, completed: 3 });
        const sourceArtifacts = runtimeRows(workspace, `
          SELECT artifacts.digest
          FROM artifacts
          JOIN node_instances
            ON node_instances.run_id = artifacts.run_id AND node_instances.node_key = artifacts.node_key
          WHERE artifacts.run_id = ? AND node_instances.node_id = 'write_report'
          ORDER BY artifacts.id
        `, source.id);

        const fork = (await store.forkRun(source.id))._unsafeUnwrap();
        expect(runtimeRows(workspace, `
          SELECT member_count, replayed_count
          FROM fork_replay_session_groups
          WHERE run_id = ?
        `, fork.id)).toEqual([{ member_count: 2, replayed_count: 0 }]);
        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: fork.id,
          ownerId: "fork-owner",
          store,
          agentSessionSupervisor,
        })).resolves.toMatchObject({ status: "completed", started: 0, completed: 3 });

        expect(turns).toHaveLength(2);
        expect(runtimeRows(workspace, `
          SELECT artifacts.digest
          FROM artifacts
          JOIN node_instances
            ON node_instances.run_id = artifacts.run_id AND node_instances.node_key = artifacts.node_key
          WHERE artifacts.run_id = ? AND node_instances.node_id = 'write_report'
          ORDER BY artifacts.id
        `, fork.id)).toEqual(sourceArtifacts);
        expect(Object.values(throwingSchedulerStore(store.scheduler).loadRunSnapshot(fork.id).projection.attempts)).toEqual([]);

        const guarded = (await store.forkRun(source.id, { agentOverrides: {} }))._unsafeUnwrap();
        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: guarded.id,
          ownerId: "guarded-owner-a",
          store,
          agentSessionSupervisor,
          shouldStop: () => runtimeRows(workspace, `
            SELECT replayed_count
            FROM fork_replay_session_groups
            WHERE run_id = ?
          `, guarded.id)[0]?.replayed_count === 1
            && runtimeRows(workspace, "SELECT id FROM artifacts WHERE run_id = ?", guarded.id).length === 1,
        })).resolves.toMatchObject({ status: "lease_lost", started: 0, completed: 2 });
        executeRuntimeSql(workspace, "DELETE FROM fork_replay_facts WHERE run_id = ? AND session_group_digest IS NOT NULL", guarded.id);
        executeRuntimeSql(workspace, "DELETE FROM artifacts WHERE run_id = ?", guarded.id);

        await expect(advanceFrozenRun({
          cwd: workspace,
          runId: guarded.id,
          ownerId: "guarded-owner-b",
          store,
          agentSessionSupervisor,
        })).rejects.toThrow(/attempted to execute member.*after 1 member/);
        expect(turns).toHaveLength(2);
        expect(runtimeRows(workspace, `
          SELECT member_count, replayed_count
          FROM fork_replay_session_groups
          WHERE run_id = ?
        `, guarded.id)).toEqual([{ member_count: 2, replayed_count: 1 }]);
      } finally {
        store.close();
      }
    });
  });

  it("rolls back replay when a staged child artifact fails activation verification", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-fork-artifact-activation", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, taskArtifactWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const source = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
        await advanceFrozenRun({ cwd: workspace, runId: source.id, ownerId: "source-owner", store });
        const fork = (await store.forkRun(source.id))._unsafeUnwrap();
        const fact = runtimeRow(workspace, "SELECT artifacts_json FROM fork_replay_facts WHERE run_id = ?", fork.id);
        const artifacts = JSON.parse(String(fact?.artifacts_json)) as Array<{ relativePath: string }>;
        await writeFile(join(runtimeRunDir(workspace, fork.id), artifacts[0]!.relativePath), "tampered\n");

        await expect(advanceFrozenRun({ cwd: workspace, runId: fork.id, ownerId: "fork-owner", store }))
          .rejects.toThrow("failed activation verification");

        expect(runtimeRows(workspace, "SELECT id FROM artifacts WHERE run_id = ?", fork.id)).toEqual([]);
        expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(fork.id).projection.instances)
          .toEqual({ [deriveInstanceKey(appendNode([], "local_task"))]: expect.objectContaining({ status: "ready" }) });
      } finally {
        store.close();
      }
    });
  });

  it("does not automatically retry task failures", async () => {
    await withRuntimeWorkspace("scheduler-node-executor-no-task-auto-retry", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, retryingTaskWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
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
      }
    });
  });
});

function taskRuntimeContextWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-task",
  }).build(({ step }) => {
    step("context_task").task({
      input: null,
      exec: async ({ artifact }) => ({
        artifact: await artifact.write("result.txt", "dynamic artifact\n"),
      }),
    });
    return {};
  });
}

function nonAdmissibleTaskWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-non-admissible-output",
  }).build(({ step }) => {
    step("bad_output").task({
      input: null,
      exec: async () => ({ when: new Date() }),
    } as never);
    return {};
  });
}

function artifactUriSessionWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-fork-artifact-uri",
    agents: { reviewer: { use: "codex" } },
  }).build(({ agents, meta, step }) => {
    const first = step("first_review").agent({
      outputSchema: z.object({ ok: z.boolean() }),
      agent: agents.reviewer,
      sessionKey: "artifact-session",
      prompt: "review",
    });
    const report = step("write_report").task({
      input: first.output.ok,
      exec: async ({ input, artifact }) => ({
        ok: input,
        report: await artifact.write("report.md", "report\n", { mediaType: "text/markdown" }),
      }),
    });
    step("artifact_route").if({
      condition: lift({ uri: report.output.report.uri, runId: meta.runId }, ({ uri, runId }) => uri.includes(runId)),
      then() {
        step("second_review").agent({
          outputSchema: z.object({ ok: z.boolean() }),
          agent: agents.reviewer,
          sessionKey: "artifact-session",
          prompt: template`review ${report.output.report}`,
        });
        return { used: true };
      },
      else() { return { used: false }; },
    });
    return {};
  });
}

function managedAgent(execute: (request: AgentTurnRequest) => Promise<AgentTurnResult>): AgentSessionSupervisor {
  return testAgentSessionSupervisor(execute);
}

function executeRuntimeSql(workspace: string, sql: string, ...params: string[]): void {
  const db = new DatabaseSync(runtimeDatabasePath(workspace));
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

function retryingTaskWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-retry",
  }).build(({ step }) => {
    step("retry_task").task({
      input: null,
      exec: async ({ artifact }) => {
        await artifact.write("attempt.txt", "attempt\n");
        throw new Error("task fails");
      },
    });
    return {};
  });
}
