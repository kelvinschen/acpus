import { admitRunForTest } from "./support/runtime-store.js";
import { readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { defineWorkflow, z } from "@acpus/core";
import type { AgentTurnRequest, AgentTurnResult } from "@acpus/agent-executor";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendLoopIteration, appendNode, deriveInstanceKey } from "../src/scheduler/identity.js";
import { advanceFrozenRun as advanceFrozenRunProduction, type AdvanceFrozenRunInput } from "../src/scheduler/runtime-runner.js";
import { openRuntimeStore } from "../src/store/store.js";
import { createInlineTaskAttemptHarness, type TaskAttemptRunner } from "./support/task-attempt-harness.js";
import { prepareSyntheticWorkflow, runtimeDatabasePath, runtimeRows, runtimeRunsRoot, runtimeRow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";
import { throwingSchedulerStore } from "./support/scheduler-store.js";
import { taggedAgentOutput, tracedCompletedAgentTurn } from "./support/agent-turn.js";

const executorMocks = vi.hoisted(() => ({
  executeAgentTurn: vi.fn<(request: AgentTurnRequest) => Promise<AgentTurnResult>>(),
  runTaskAttempt: vi.fn<TaskAttemptRunner>(),
}));
vi.mock("@acpus/agent-executor", async importOriginal => ({
  ...await importOriginal<typeof import("@acpus/agent-executor")>(),
  executeAgentTurn: executorMocks.executeAgentTurn,
}));
vi.mock("../src/execution/task-process.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/execution/task-process.js")>(),
  runTaskAttempt: executorMocks.runTaskAttempt,
}));
let taskAttemptHarness = createInlineTaskAttemptHarness();
beforeEach(() => {
  taskAttemptHarness = createInlineTaskAttemptHarness();
  executorMocks.runTaskAttempt.mockReset().mockImplementation(input => taskAttemptHarness.runAttempt(input));
  executorMocks.executeAgentTurn.mockReset();
});
function advanceFrozenRun(input: AdvanceFrozenRunInput & { executeAgentTurn?: (request: AgentTurnRequest) => Promise<AgentTurnResult> }) {
  const { executeAgentTurn, ...productionInput } = input;
  if (executeAgentTurn) executorMocks.executeAgentTurn.mockImplementation(executeAgentTurn);
  return advanceFrozenRunProduction(productionInput);
}

async function forkRuntimeRun(
  store: Awaited<ReturnType<typeof openRuntimeStore>>,
  runId: string,
  options?: Parameters<Awaited<ReturnType<typeof openRuntimeStore>>["forkRun"]>[1],
) {
  const result = await store.forkRun(runId, options);
  if (result.isErr()) throw Object.assign(new Error(result.error.message), { failure: result.error });
  return result.value;
}

describe("scheduler agent overrides and forks", () => {
  it("executes scheduler-backed agent nodes with submit-time agent overrides", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-agent-submit-override", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, overrideAgentWorkflow());
        const store = await openRuntimeStore(workspace);
        const turns: AgentTurnRequest[] = [];
        try {
          const run = await admitRunForTest(store, {
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
              return tracedCompletedAgentTurn(taggedAgentOutput("{\"ok\":true}"));
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
          expect(turns[0]!.config).toBeUndefined();
          expect(turns[0]!.captureTrace).toBe(true);
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
          const source = await admitRunForTest(store, {
            prepared,
            input: {},
            cwd: workspace,
            agentOverrides: {
              reviewer: {
                use: "claude",
                model: "sonnet",
                config: { mode: "plan", effort: "high" },
                permissionMode: "deny-all",
              },
              auditor: { use: "codex", model: "audit-model" },
            },
          });

          const inherited = await forkRuntimeRun(store, source.id);
          expect(store.getRun(inherited.id)?.agentOverrides).toEqual({
            reviewer: {
              use: "claude",
              model: "sonnet",
              config: { mode: "plan", effort: "high" },
              permissionMode: "deny-all",
            },
            auditor: { use: "codex", model: "audit-model" },
          });
          expect(store.getFrozenRun(inherited.id)?.ir.agents.reviewer).toMatchObject({
            kind: "agent_definition",
            use: "claude",
            model: "sonnet",
            config: { mode: "plan", effort: "high" },
            permissionMode: "deny-all",
            trace: true,
          });

          const reconfigured = await forkRuntimeRun(store, source.id, {
            agentOverrides: { reviewer: { config: { mode: "agent" } } },
          });
          expect(store.getRun(reconfigured.id)?.agentOverrides?.reviewer).toMatchObject({
            use: "claude",
            model: "sonnet",
            config: { mode: "agent" },
            permissionMode: "deny-all",
          });
          expect(store.getFrozenRun(reconfigured.id)?.ir.agents.reviewer).toMatchObject({
            config: { mode: "agent" },
          });

          const cleared = await forkRuntimeRun(store, source.id, {
            agentOverrides: { reviewer: { config: {} } },
          });
          expect(store.getRun(cleared.id)?.agentOverrides?.reviewer).toMatchObject({ config: {} });
          expect(store.getFrozenRun(cleared.id)?.ir.agents.reviewer).toMatchObject({ config: {} });

          const replaced = await forkRuntimeRun(store, source.id, {
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
            trace: true,
          });
          expect(effective && "model" in effective ? effective.model : undefined).toBeUndefined();
          expect(effective && "config" in effective ? effective.config : undefined).toBeUndefined();
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
          const source = await admitRunForTest(store, { prepared: sourcePrepared, input: {}, cwd: workspace });
          await expect(advanceFrozenRun({
            cwd: workspace,
            runId: source.id,
            ownerId: "source-owner",
            store,
          })).resolves.toMatchObject({ status: "failed", started: 2, completed: 1, failed: 1 });

          const firstKey = deriveInstanceKey(appendNode([], "first"));
          expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(source.id).projection.instances[firstKey]).toMatchObject({
            status: "completed",
            output: { ok: true },
          });

          const fork = await forkRuntimeRun(store, source.id, { prepared: replacementPrepared });
          const seeded = throwingSchedulerStore(store.scheduler).loadRunSnapshot(fork.id).projection;
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

          const completed = throwingSchedulerStore(store.scheduler).loadRunSnapshot(fork.id).projection;
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
          const source = await admitRunForTest(store, { prepared: sourcePrepared, input: {}, cwd: workspace });
          await expect(driveFrozenRunToTerminal(workspace, store, source.id, "unsafe-loop-source")).resolves.toMatchObject({ status: "failed" });

          const iter0Prepare = deriveInstanceKey(appendNode(appendLoopIteration([], "retry", 0), "prepare"));
          const iter0Maybe = deriveInstanceKey(appendNode(appendLoopIteration([], "retry", 0), "maybe_fail"));
          const iter1Prepare = deriveInstanceKey(appendNode(appendLoopIteration([], "retry", 1), "prepare"));
          const iter1Maybe = deriveInstanceKey(appendNode(appendLoopIteration([], "retry", 1), "maybe_fail"));
          const iter2Prepare = deriveInstanceKey(appendNode(appendLoopIteration([], "retry", 2), "prepare"));
          const failedTarget = deriveInstanceKey(appendNode(appendLoopIteration([], "retry", 2), "maybe_fail"));
          const inherited = [iter0Prepare, iter0Maybe, iter1Prepare, iter1Maybe, iter2Prepare];
          const sourceProjection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(source.id).projection;
          for (const nodeKey of inherited) expect(sourceProjection.instances[nodeKey]).toMatchObject({ status: "completed" });
          expect(sourceProjection.instances[failedTarget]).toMatchObject({ status: "failed" });

          const implicit = await forkRuntimeRun(store, source.id, { prepared: replacementPrepared, unsafeReuse: true });
          expect(store.getRun(implicit.id)?.fork).toEqual({ sourceRunId: source.id, unsafeReuse: true });
          assertUnsafeLoopForkSeed(store, implicit.id, inherited, failedTarget);
          await expect(driveFrozenRunToTerminal(workspace, store, implicit.id, "unsafe-loop-implicit")).resolves.toMatchObject({ status: "completed" });
          assertUnsafeLoopForkCompleted(store, implicit.id, inherited, failedTarget);

          const explicit = await forkRuntimeRun(store, source.id, { prepared: replacementPrepared, target: failedTarget, unsafeReuse: true });
          expect(store.getRun(explicit.id)?.fork).toEqual({ sourceRunId: source.id, target: failedTarget, unsafeReuse: true });
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
          const source = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
          await expect(advanceFrozenRun({
            cwd: workspace,
            runId: source.id,
            ownerId: "source-owner",
            store,
          })).resolves.toMatchObject({ status: "completed", started: 2, completed: 2 });

          const fork = await forkRuntimeRun(store, source.id, { target: "second" });
          const firstKey = deriveInstanceKey(appendNode([], "first"));
          const secondKey = deriveInstanceKey(appendNode([], "second"));
          const seeded = throwingSchedulerStore(store.scheduler).loadRunSnapshot(fork.id).projection;
          expect(seeded.instances[firstKey]).toMatchObject({ status: "completed" });
          expect(seeded.instances[secondKey]).toMatchObject({ status: "ready" });

          await expect(advanceFrozenRun({
            cwd: workspace,
            runId: fork.id,
            ownerId: "fork-owner",
            store,
          })).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });

          const completed = throwingSchedulerStore(store.scheduler).loadRunSnapshot(fork.id).projection;
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
          const source = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
          await expect(advanceFrozenRun({
            cwd: workspace,
            runId: source.id,
            ownerId: "source-owner",
            store,
          })).resolves.toMatchObject({ status: "completed", started: 2, completed: 2 });

          const fork = await forkRuntimeRun(store, source.id, { agentOverrides: {} });

          expect(runtimeRow(workspace, "SELECT COUNT(*) AS count FROM scheduler_commits WHERE run_id = ? AND idempotency_key = ?", fork.id, `fork-seed:${fork.id}`)).toMatchObject({ count: 1 });
          expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(fork.id).projection.instances[deriveInstanceKey(appendNode([], "first"))]).toMatchObject({ status: "completed" });
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
          const source = await admitRunForTest(sourceStore, { prepared: sourcePrepared, input: {}, cwd: workspace });
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
        const runDirsBefore = (await readdir(runtimeRunsRoot(workspace))).sort();

        const forkStore = await openRuntimeStore(workspace);
        try {
          await expect(forkRuntimeRun(forkStore, sourceId, { prepared: replacementPrepared })).rejects.toMatchObject({
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
        await expect(readdir(runtimeRunsRoot(workspace)).then(entries => entries.sort())).resolves.toEqual(runDirsBefore);
      });
    });

  it("re-executes completed fork runs when fork-time agent overrides change", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-agent-fork-override-reexecutes", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, overrideAgentWorkflow());
        const store = await openRuntimeStore(workspace);
        const sourceTurns: AgentTurnRequest[] = [];
        const forkTurns: AgentTurnRequest[] = [];
        try {
          const source = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
          await expect(advanceFrozenRun({
            cwd: workspace,
            runId: source.id,
            ownerId: "source-owner",
            store,
            executeAgentTurn: async request => {
              sourceTurns.push(request);
              return tracedCompletedAgentTurn(taggedAgentOutput("{\"ok\":true}"));
            },
          })).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });
          expect(store.getRun(source.id)).toMatchObject({ status: "completed", output: {} });

          const fork = await forkRuntimeRun(store, source.id, {
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
              return tracedCompletedAgentTurn(taggedAgentOutput("{\"ok\":true}"));
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
          expect((await store.admitRun({
            prepared,
            input: {},
            cwd: workspace,
            agentOverrides: { reviewer: { options: {} } } as any,
          }))._unsafeUnwrapErr()).toMatchObject({
            type: "agent-overrides-invalid",
            message: expect.stringContaining("$.reviewer Unrecognized key"),
          });
          expect((await store.admitRun({
            prepared,
            input: {},
            cwd: workspace,
            agentOverrides: { missing: { use: "codex" } },
          }))._unsafeUnwrapErr()).toMatchObject({
            type: "agent-overrides-invalid",
            message: expect.stringContaining("does not reference a declared agent"),
          });
          for (const [agentOverrides, message] of [
            [{ reviewer: { policy: "full" } }, "$.reviewer Unrecognized key"],
            [{ reviewer: { kind: "agent_definition" } }, "$.reviewer Unrecognized key"],
            [{ reviewer: { timeout: "1s" } }, "$.reviewer Unrecognized key"],
            [{ reviewer: { trace: true } }, "$.reviewer Unrecognized key"],
            [{ reviewer: { agentMode: "plan" } }, "$.reviewer Unrecognized key"],
            [{ reviewer: { use: "codex", command: "custom-acp-server" } }, "must not specify both use and command"],
            [{ reviewer: { cwd: 123 } }, "$.reviewer.cwd"],
            [{ reviewer: { env: { FLAG: true } } }, "$.reviewer.env.FLAG"],
            [{ reviewer: { config: { mode: true } } }, "$.reviewer.config.mode"],
          ] as Array<[any, string]>) {
            expect((await store.admitRun({
              prepared,
              input: {},
              cwd: workspace,
              agentOverrides,
            }))._unsafeUnwrapErr()).toMatchObject({
              type: "agent-overrides-invalid",
              message: expect.stringContaining(message),
            });
          }
        } finally {
          store.close();
        }
      });
    });
});

function overrideAgentWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-agent-override",
    agents: {
      reviewer: {
        use: "codex",
        model: "old-model",
        permissionMode: "approve-reads",
        config: { mode: "agent" },
        trace: true,
      },
      auditor: { use: "claude" },
    },
  }).build(({ agents, step }) => {
    step("review").agent({
      outputSchema: z.object({ ok: z.boolean() }),
      agent: agents.reviewer, prompt: "review",
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
  const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId).projection;
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
  const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId).projection;
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
      state: { done: false as boolean, last: "initial" },
      do({ index }) {
        const prepare = step("prepare").task({
          input: { iter: index },
          exec: async ({ input }) => ({ marker: `prepare-${input.iter}` }),
        });
        const maybe = step("maybe_fail").task({
          input: { iter: index, marker: prepare.output.marker },
          exec: fixed
            ? async ({ input }) => ({ done: input.iter >= 2, last: input.iter >= 2 ? "fixed-2" : `source-${input.iter}`, marker: input.marker })
            : async ({ input }) => {
                if (input.iter === 2) throw new Error("source failure at iter 2");
                return { done: false, last: `source-${input.iter}`, marker: input.marker };
              },
        });
        return {
          state: { done: maybe.output.done, last: maybe.output.last },
          stop: maybe.output.done,
        };
      },
    });
    return { done: retry.output.done, last: retry.output.last };
  });
}

function targetedForkFailedSourceWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-targeted-fork-source",
  }).build(({ step }) => {
    const first = step("first").task({
      input: {},
      exec: async () => ({ ok: true }),
    });
    step("boom").task({
      input: { ok: first.output.ok },
      exec: async () => {
        throw new Error("boom");
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
      input: {},
      exec: async () => ({ ok: true }),
    });
    const fixed = step("fixed").task({
      input: { ok: first.output.ok },
      exec: async ({ input }) => ({ ok: input.ok }),
    });
    return { ok: fixed.output.ok };
  });
}

function targetedForkCompletedSourceWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-targeted-fork-completed",
  }).build(({ step }) => {
    const first = step("first").task({
      input: {},
      exec: async () => ({ ok: true }),
    });
    const second = step("second").task({
      input: { ok: first.output.ok },
      exec: async ({ input }) => ({ ok: input.ok }),
    });
    return { ok: second.output.ok };
  });
}

function replaceCompletedInstanceEventOutput(workspace: string, runId: string, nodeKey: string, output: unknown): void {
  const db = new DatabaseSync(runtimeDatabasePath(workspace));
  try {
    db.prepare("UPDATE run_events SET payload_json = ? WHERE run_id = ? AND type = 'instance.completed' AND node_key = ?").run(
      JSON.stringify({ schedulerEventVersion: 1, payload: { nodeKey, output } }),
      runId,
      nodeKey,
    );
    db.prepare("DELETE FROM scheduler_projection_checkpoints WHERE run_id = ?").run(runId);
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
