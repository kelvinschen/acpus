import {
  advanceFrozenRun,
  forkAgentWorkflow,
  forkRuntimeRun,
  injectedAgentWorkflow,
  targetedForkCompletedSourceWorkflow,
  targetedForkFailedSourceWorkflow,
  targetedForkReplacementWorkflow,
} from "./support/scheduler-agent-fork.js";
import { admitRunForTest } from "./support/runtime-store.js";
import { readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { defineWorkflow, z } from "@acpus/core";
import { lift, template } from "@acpus/expression";
import type { FixtureAgentTurnRequest as AgentTurnRequest } from "./support/agent-turn.js";
import { describe, expect, it } from "vitest";
import { appendLoopIteration, appendNode, deriveInstanceKey } from "../src/scheduler/identity.js";
import { openRuntimeStore } from "../src/store/store.js";
import {
  prepareSyntheticWorkflow,
  runtimeDatabasePath,
  runtimeRows,
  runtimeRunsRoot,
  withRuntimeWorkspace,
} from "./support/runtime-fixtures.js";
import { throwingSchedulerStore } from "./support/scheduler-store.js";
import { agentSummary, agentTiming, observedCompletedAgentTurn, taggedAgentOutput } from "./support/agent-turn.js";

describe.concurrent("scheduler Agent fork session replay", () => {
  it("replays unchanged loop work and reruns changed operations by round", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-loop-fork", async workspace => {
        const sourcePrepared = await prepareSyntheticWorkflow(workspace, loopForkWorkflow(false));
        const replacementPrepared = await prepareSyntheticWorkflow(workspace, loopForkWorkflow(true));
        const store = await openRuntimeStore(workspace);
        try {
          const source = await admitRunForTest(store, { prepared: sourcePrepared, input: {}, cwd: workspace });
          await expect(driveFrozenRunToTerminal(workspace, store, source.id, "loop-source")).resolves.toMatchObject({ status: "failed" });

          const iter0Prepare = deriveInstanceKey(appendNode(appendLoopIteration([], "retry", 0), "prepare"));
          const iter0Maybe = deriveInstanceKey(appendNode(appendLoopIteration([], "retry", 0), "maybe_fail"));
          const iter1Prepare = deriveInstanceKey(appendNode(appendLoopIteration([], "retry", 1), "prepare"));
          const iter1Maybe = deriveInstanceKey(appendNode(appendLoopIteration([], "retry", 1), "maybe_fail"));
          const iter2Prepare = deriveInstanceKey(appendNode(appendLoopIteration([], "retry", 2), "prepare"));
          const failedTarget = deriveInstanceKey(appendNode(appendLoopIteration([], "retry", 2), "maybe_fail"));
          const inherited = [iter0Prepare, iter1Prepare, iter2Prepare];
          const changed = [iter0Maybe, iter1Maybe];
          const sourceProjection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(source.id).projection;
          for (const nodeKey of inherited) expect(sourceProjection.instances[nodeKey]).toMatchObject({ status: "completed" });
          expect(sourceProjection.instances[failedTarget]).toMatchObject({ status: "failed" });

          const implicit = await forkRuntimeRun(store, source.id, { prepared: replacementPrepared });
          expect(store.getRun(implicit.id)?.fork).toEqual({ sourceRunId: source.id });
          await expect(driveFrozenRunToTerminal(workspace, store, implicit.id, "loop-fork")).resolves.toMatchObject({ status: "completed" });
          assertLoopForkCompleted(store, implicit.id, inherited, [...changed, failedTarget]);
        } finally {
          store.close();
        }
      });
    });

  it("uses target ready time as an exclusive replay checkpoint", async () => {
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
          expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(fork.id).projection.instances).toEqual({});

          await expect(advanceFrozenRun({
            cwd: workspace,
            runId: fork.id,
            ownerId: "fork-owner",
            store,
          })).resolves.toMatchObject({ status: "completed", started: 1, completed: 2 });

          const completed = throwingSchedulerStore(store.scheduler).loadRunSnapshot(fork.id).projection;
          expect(Object.values(completed.attempts).filter(attempt => attempt.nodeKey === firstKey)).toHaveLength(0);
          expect(Object.values(completed.attempts).filter(attempt => attempt.nodeKey === secondKey)).toHaveLength(1);
        } finally {
          store.close();
        }
      });
    });

  it("applies session-group atomicity to targets inside and after the group", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-agent-fork-session-targets", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, forkAgentCheckpointWorkflow(false));
        const store = await openRuntimeStore(workspace);
        const turns: AgentTurnRequest[] = [];
        const executeAgentTurn = async (request: AgentTurnRequest) => {
          turns.push(request);
          return observedCompletedAgentTurn(request, taggedAgentOutput("{\"ok\":true}"));
        };
        try {
          const source = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
          await advanceFrozenRun({ cwd: workspace, runId: source.id, ownerId: "source-owner", store, executeAgentTurn });

          const intersecting = await forkRuntimeRun(store, source.id, { target: "second_review" });
          expect(runtimeRows(workspace, "SELECT * FROM fork_replay_session_groups WHERE run_id = ?", intersecting.id)).toEqual([]);
          await expect(advanceFrozenRun({ cwd: workspace, runId: intersecting.id, ownerId: "inside-owner", store, executeAgentTurn }))
            .resolves.toMatchObject({ status: "completed", started: 3, completed: 3 });

          expect(turns).toHaveLength(4);
          expect(turns[0]!.agentSessionId).toBe(turns[1]!.agentSessionId);
          expect(turns[2]!.agentSessionId).toBe(turns[3]!.agentSessionId);
          expect(turns[2]!.agentSessionId).not.toBe(turns[0]!.agentSessionId);

          const after = await forkRuntimeRun(store, source.id, { target: "after_group" });
          await expect(advanceFrozenRun({ cwd: workspace, runId: after.id, ownerId: "after-owner", store, executeAgentTurn }))
            .resolves.toMatchObject({ status: "completed", started: 1, completed: 3 });

          expect(turns).toHaveLength(4);
          const attempts = Object.values(throwingSchedulerStore(store.scheduler).loadRunSnapshot(after.id).projection.attempts);
          expect(attempts.map(attempt => attempt.nodeId)).toEqual(["after_group"]);
        } finally {
          store.close();
        }
      });
    });

  it("reruns earlier members when a later same-session member is after the target", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-agent-fork-session-open-after-target", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, forkAgentCheckpointWorkflow(true));
        const store = await openRuntimeStore(workspace);
        const turns: AgentTurnRequest[] = [];
        const executeAgentTurn = async (request: AgentTurnRequest) => {
          turns.push(request);
          return observedCompletedAgentTurn(request, taggedAgentOutput("{\"ok\":true}"));
        };
        try {
          const source = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
          await advanceFrozenRun({ cwd: workspace, runId: source.id, ownerId: "source-owner", store, executeAgentTurn });

          const fork = await forkRuntimeRun(store, source.id, { target: "after_group" });
          expect(runtimeRows(workspace, "SELECT * FROM fork_replay_session_groups WHERE run_id = ?", fork.id)).toEqual([]);
          await expect(advanceFrozenRun({ cwd: workspace, runId: fork.id, ownerId: "fork-owner", store, executeAgentTurn }))
            .resolves.toMatchObject({ status: "completed", started: 4, completed: 4 });

          expect(turns).toHaveLength(6);
          expect(new Set(turns.slice(0, 3).map(turn => turn.agentSessionId)).size).toBe(1);
          expect(new Set(turns.slice(3).map(turn => turn.agentSessionId)).size).toBe(1);
          expect(turns[3]!.agentSessionId).not.toBe(turns[0]!.agentSessionId);
        } finally {
          store.close();
        }
      });
    });

  it("replays every occurrence in a completed loop session group", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-agent-fork-session-loop-complete", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, forkAgentLoopWorkflow());
        const store = await openRuntimeStore(workspace);
        const turns: AgentTurnRequest[] = [];
        try {
          const source = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
          await expect(advanceFrozenRun({
            cwd: workspace,
            runId: source.id,
            ownerId: "source-owner",
            store,
            executeAgentTurn: async request => {
              turns.push(request);
              const output = turns.length === 2
                ? "{\"approved\":false,\"feedback\":\"revise\"}"
                : turns.length === 4
                  ? "{\"approved\":true,\"feedback\":\"done\"}"
                  : "{\"ok\":true}";
              return observedCompletedAgentTurn(request, taggedAgentOutput(output));
            },
          })).resolves.toMatchObject({ status: "completed", started: 4, completed: 4 });

          const fork = await forkRuntimeRun(store, source.id);
          expect(runtimeRows(workspace, `
            SELECT member_count, replayed_count
            FROM fork_replay_session_groups
            WHERE run_id = ?
          `, fork.id)).toEqual([{ member_count: 2, replayed_count: 0 }]);
          await expect(advanceFrozenRun({ cwd: workspace, runId: fork.id, ownerId: "fork-owner", store }))
            .resolves.toMatchObject({ status: "completed", started: 0, completed: 4 });

          expect(turns).toHaveLength(4);
          expect(Object.values(throwingSchedulerStore(store.scheduler).loadRunSnapshot(fork.id).projection.attempts)).toEqual([]);
        } finally {
          store.close();
        }
      });
    });

  it("reruns every implementer occurrence after a later same-session occurrence fails", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-agent-fork-session-loop-failure", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, forkAgentLoopWorkflow());
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
              if (sourceTurns.length === 1) return observedCompletedAgentTurn(request, taggedAgentOutput("{\"ok\":true}"));
              if (sourceTurns.length === 2) return observedCompletedAgentTurn(request, taggedAgentOutput("{\"approved\":false,\"feedback\":\"revise\"}"));
              return {
                status: "failed",
                failure: { kind: "provider_exit", message: "implementer crashed" },
                responses: [],
                stderr: "",
                summary: agentSummary(0),
                timing: agentTiming(),
              };
            },
          })).resolves.toMatchObject({ status: "failed", started: 3, completed: 2, failed: 1 });

          const fork = await forkRuntimeRun(store, source.id);
          expect(runtimeRows(workspace, "SELECT * FROM fork_replay_session_groups WHERE run_id = ?", fork.id)).toEqual([]);
          await expect(advanceFrozenRun({
            cwd: workspace,
            runId: fork.id,
            ownerId: "fork-owner",
            store,
            executeAgentTurn: async request => {
              forkTurns.push(request);
              const output = forkTurns.length < 3 ? "{\"ok\":true}" : "{\"approved\":true,\"feedback\":\"done\"}";
              return observedCompletedAgentTurn(request, taggedAgentOutput(output));
            },
          })).resolves.toMatchObject({ status: "completed", started: 3, completed: 4 });

          const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(fork.id).projection;
          const implement0 = deriveInstanceKey(appendNode(appendLoopIteration([], "review_cycle", 0), "implement"));
          const review0 = deriveInstanceKey(appendNode(appendLoopIteration([], "review_cycle", 0), "review"));
          const implement1 = deriveInstanceKey(appendNode(appendLoopIteration([], "review_cycle", 1), "implement"));
          expect(Object.values(projection.attempts).filter(attempt => attempt.nodeKey === implement0)).toHaveLength(1);
          expect(Object.values(projection.attempts).filter(attempt => attempt.nodeKey === implement1)).toHaveLength(1);
          expect(Object.values(projection.attempts).filter(attempt => attempt.nodeKey === review0)).toHaveLength(0);
          expect(forkTurns[0]!.agentSessionId).toBe(forkTurns[1]!.agentSessionId);
          expect(forkTurns[0]!.agentSessionId).not.toBe(sourceTurns[0]!.agentSessionId);
        } finally {
          store.close();
        }
      });
    });

  it("fails visibly when optimistic topology diverges after partial group replay", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-agent-fork-session-divergence", async workspace => {
        const globalKey = "__acpus_fork_session_topology_evaluations";
        delete (globalThis as Record<string, unknown>)[globalKey];
        const prepared = await prepareSyntheticWorkflow(workspace, divergentSessionTopologyWorkflow());
        const store = await openRuntimeStore(workspace);
        const turns: AgentTurnRequest[] = [];
        const executeAgentTurn = async (request: AgentTurnRequest) => {
          turns.push(request);
          return observedCompletedAgentTurn(request, taggedAgentOutput("{\"ok\":true}"));
        };
        try {
          const source = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
          await expect(advanceFrozenRun({ cwd: workspace, runId: source.id, ownerId: "source-owner", store, executeAgentTurn }))
            .resolves.toMatchObject({ status: "completed", started: 2, completed: 2 });

          const fork = await forkRuntimeRun(store, source.id);
          expect(runtimeRows(workspace, `
            SELECT member_count, replayed_count
            FROM fork_replay_session_groups
            WHERE run_id = ?
          `, fork.id)).toEqual([{ member_count: 2, replayed_count: 0 }]);

          await expect(advanceFrozenRun({ cwd: workspace, runId: fork.id, ownerId: "fork-owner", store }))
            .rejects.toThrow(/cannot complete after reusing 1 of 2 members/);
          expect(turns).toHaveLength(2);
          expect(runtimeRows(workspace, `
            SELECT member_count, replayed_count
            FROM fork_replay_session_groups
            WHERE run_id = ?
          `, fork.id)).toEqual([{ member_count: 2, replayed_count: 1 }]);
          expect(store.getRun(fork.id)?.status).not.toBe("completed");
        } finally {
          store.close();
          delete (globalThis as Record<string, unknown>)[globalKey];
        }
      });
    });

  it("invalidates before replay and refuses a missing fact after replay starts", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-agent-fork-session-store-invariants", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, forkAgentWorkflow("shared-session"));
        const store = await openRuntimeStore(workspace);
        const turns: AgentTurnRequest[] = [];
        const executeAgentTurn = async (request: AgentTurnRequest) => {
          turns.push(request);
          return observedCompletedAgentTurn(request, taggedAgentOutput("{\"ok\":true}"));
        };
        try {
          const source = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
          await advanceFrozenRun({ cwd: workspace, runId: source.id, ownerId: "source-owner", store, executeAgentTurn });
          const firstMismatch = await forkRuntimeRun(store, source.id);
          executeRuntimeSql(workspace, `
            UPDATE fork_replay_facts
            SET operation_digest = 'sha256:mismatch'
            WHERE run_id = ? AND source_sequence = (
              SELECT MIN(source_sequence) FROM fork_replay_facts WHERE run_id = ?
            )
          `, firstMismatch.id, firstMismatch.id);

          await expect(advanceFrozenRun({ cwd: workspace, runId: firstMismatch.id, ownerId: "mismatch-owner", store, executeAgentTurn }))
            .resolves.toMatchObject({ status: "completed", started: 2, completed: 2 });
          expect(turns).toHaveLength(4);
          expect(turns[2]!.agentSessionId).toBe(turns[3]!.agentSessionId);
          expect(turns[2]!.agentSessionId).not.toBe(turns[0]!.agentSessionId);

          executeRuntimeSql(workspace, `
            UPDATE run_events
            SET payload_json = json_set(payload_json, '$.semanticFingerprint', 'test-consumed-before-missing')
            WHERE run_id = ? AND type = 'run.forked'
          `, firstMismatch.id);
          const missingBeforeReplay = await forkRuntimeRun(store, source.id, { input: {} });
          executeRuntimeSql(workspace, `
            DELETE FROM fork_replay_facts
            WHERE run_id = ? AND source_sequence = (
              SELECT MIN(source_sequence) FROM fork_replay_facts WHERE run_id = ?
            )
          `, missingBeforeReplay.id, missingBeforeReplay.id);

          await expect(advanceFrozenRun({ cwd: workspace, runId: missingBeforeReplay.id, ownerId: "missing-owner", store, executeAgentTurn }))
            .resolves.toMatchObject({ status: "completed", started: 2, completed: 2 });
          expect(turns).toHaveLength(6);
          expect(turns[4]!.agentSessionId).toBe(turns[5]!.agentSessionId);
          expect(turns[4]!.agentSessionId).not.toBe(turns[0]!.agentSessionId);

          executeRuntimeSql(workspace, `
            UPDATE run_events
            SET payload_json = json_set(payload_json, '$.semanticFingerprint', 'test-consumed')
            WHERE run_id = ? AND type = 'run.forked'
          `, missingBeforeReplay.id);
          const partial = await forkRuntimeRun(store, source.id, { agentInjections: {} });
          executeRuntimeSql(workspace, `
            DELETE FROM fork_replay_facts
            WHERE run_id = ? AND source_sequence = (
              SELECT MAX(source_sequence) FROM fork_replay_facts WHERE run_id = ?
            )
          `, partial.id, partial.id);

          await expect(advanceFrozenRun({ cwd: workspace, runId: partial.id, ownerId: "partial-owner", store, executeAgentTurn }))
            .rejects.toThrow(/attempted to execute member.*after 1 member/);
          expect(turns).toHaveLength(6);
          expect(runtimeRows(workspace, `
            SELECT member_count, replayed_count
            FROM fork_replay_session_groups
            WHERE run_id = ?
          `, partial.id)).toEqual([{ member_count: 2, replayed_count: 1 }]);
        } finally {
          store.close();
        }
      });
    });

  it("rolls back fork admission when a replay output references an unknown artifact", async () => {
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
          replayGroups: [],
          replayFacts: [],
        });
        await expect(readdir(runtimeRunsRoot(workspace)).then(entries => entries.sort())).resolves.toEqual(runDirsBefore);
      });
    });

  it("ignores unknown artifacts referenced only by a rejected session group", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-fork-rejected-artifact", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, forkAgentWorkflow("shared-session"));
        const firstKey = deriveInstanceKey(appendNode([], "first_review"));
        let sourceId = "";
        const sourceStore = await openRuntimeStore(workspace);
        try {
          const source = await admitRunForTest(sourceStore, { prepared, input: {}, cwd: workspace });
          sourceId = source.id;
          await advanceFrozenRun({
            cwd: workspace,
            runId: source.id,
            ownerId: "source-owner",
            store: sourceStore,
            executeAgentTurn: async request => observedCompletedAgentTurn(request, taggedAgentOutput("{\"ok\":true}")),
          });
        } finally {
          sourceStore.close();
        }

        replaceCompletedInstanceEventOutput(workspace, sourceId, firstKey, {
          ok: true,
          artifact: { kind: "artifact", uri: `artifact://${sourceId}/missing_artifact` },
        });

        const forkStore = await openRuntimeStore(workspace);
        try {
          const fork = await forkRuntimeRun(forkStore, sourceId, {
            agentInjections: { reviewer: { command: "custom-acp-server" } },
          });
          expect(runtimeRows(workspace, "SELECT * FROM fork_replay_session_groups WHERE run_id = ?", fork.id)).toEqual([]);
          expect(runtimeRows(workspace, "SELECT * FROM fork_replay_facts WHERE run_id = ?", fork.id)).toEqual([]);
          expect(runtimeRows(workspace, "SELECT * FROM artifacts WHERE run_id = ?", fork.id)).toEqual([]);
        } finally {
          forkStore.close();
        }
      });
    });

  it("re-executes the whole session group when fork-time Agent injections change", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-agent-fork-injection-reexecutes", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, forkAgentWorkflow("shared-session"));
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
              return observedCompletedAgentTurn(request, taggedAgentOutput("{\"ok\":true}"));
            },
          })).resolves.toMatchObject({ status: "completed", started: 2, completed: 2 });
          expect(store.getRun(source.id)).toMatchObject({ status: "completed", output: {} });

          const fork = await forkRuntimeRun(store, source.id, {
            agentInjections: { reviewer: { command: "custom-acp-server" } },
          });
          const forkRun = store.getRun(fork.id);
          expect(forkRun).toMatchObject({ status: "pending" });
          expect(forkRun).not.toHaveProperty("output");
          expect(runtimeRows(workspace, "SELECT * FROM fork_replay_session_groups WHERE run_id = ?", fork.id)).toEqual([]);

          await expect(advanceFrozenRun({
            cwd: workspace,
            runId: fork.id,
            ownerId: "fork-owner",
            store,
            executeAgentTurn: async request => {
              forkTurns.push(request);
              return observedCompletedAgentTurn(request, taggedAgentOutput("{\"ok\":true}"));
            },
          })).resolves.toMatchObject({ status: "completed", started: 2, completed: 2 });

          expect(sourceTurns).toHaveLength(2);
          expect(forkTurns).toHaveLength(2);
          expect(forkTurns.map(turn => turn.agent)).toEqual([
            { kind: "command", command: "custom-acp-server" },
            { kind: "command", command: "custom-acp-server" },
          ]);
        } finally {
          store.close();
        }
      });
    });

  it("rejects invalid Agent injections at admission", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-agent-injection-invalid", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, injectedAgentWorkflow());
        const store = await openRuntimeStore(workspace);
        try {
          expect((await store.admitRun({
            prepared,
            input: {},
            cwd: workspace,
            agentInjections: { reviewer: { options: {} } } as any,
          }))._unsafeUnwrapErr()).toMatchObject({
            type: "agent-injections-invalid",
            message: expect.stringContaining("$.reviewer Unrecognized key"),
          });
          expect((await store.admitRun({
            prepared,
            input: {},
            cwd: workspace,
            agentInjections: { missing: { use: "codex" } },
          }))._unsafeUnwrapErr()).toMatchObject({
            type: "agent-injections-invalid",
            message: expect.stringContaining("does not reference a declared agent"),
          });
          for (const [agentInjections, message] of [
            [{ reviewer: { policy: "full" } }, "$.reviewer Unrecognized key"],
            [{ reviewer: { kind: "agent_definition" } }, "$.reviewer Unrecognized key"],
            [{ reviewer: { timeout: "1s" } }, "$.reviewer Unrecognized key"],
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
              agentInjections,
            }))._unsafeUnwrapErr()).toMatchObject({
              type: "agent-injections-invalid",
              message: expect.stringContaining(message),
            });
          }
        } finally {
          store.close();
        }
      });
    });
});

function forkAgentCheckpointWorkflow(withLaterSessionMember: boolean) {
  return defineWorkflow({
    name: withLaterSessionMember
      ? "scheduler-node-executor-fork-agent-open-session"
      : "scheduler-node-executor-fork-agent-closed-session",
    agents: { reviewer: { use: "codex" } },
  }).build(({ agents, step }) => {
    const first = step("first_review").agent({
      outputSchema: z.object({ ok: z.boolean() }),
      agent: agents.reviewer,
      sessionKey: "shared-session",
      prompt: "review",
    });
    const second = step("second_review").agent({
      outputSchema: z.object({ ok: z.boolean() }),
      agent: agents.reviewer,
      sessionKey: "shared-session",
      prompt: template`review again: ${first.output.ok}`,
    });
    const after = step("after_group").task({
      input: second.output.ok,
      exec: async ({ input }) => ({ ok: input }),
    });
    if (withLaterSessionMember) {
      step("later_review").agent({
        outputSchema: z.object({ ok: z.boolean() }),
        agent: agents.reviewer,
        sessionKey: "shared-session",
        prompt: template`review after task: ${after.output.ok}`,
      });
    }
    return {};
  });
}

function forkAgentLoopWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-fork-agent-session-loop",
    agents: {
      implementer: { use: "codex" },
      reviewer: { use: "codex" },
    },
  }).build(({ agents, step }) => {
    const cycle = step("review_cycle").loop({
      state: { approved: false, feedback: "initial" },
      do({ index, state }) {
        const implement = step("implement").agent({
          outputSchema: z.object({ ok: z.boolean() }),
          agent: agents.implementer,
          sessionKey: "loop-implementer",
          prompt: template`implement round ${index}: ${state.feedback}`,
        });
        const review = step("review").agent({
          outputSchema: z.object({ approved: z.boolean(), feedback: z.string() }),
          agent: agents.reviewer,
          prompt: template`review round ${index}: ${implement.output.ok}`,
        });
        return { state: review.output, stop: review.output.approved };
      },
    });
    return { approved: cycle.output.approved };
  });
}

function divergentSessionTopologyWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-fork-agent-session-divergence",
    agents: { reviewer: { use: "codex" } },
  }).build(({ agents, meta, step }) => {
    const first = step("first_review").agent({
      outputSchema: z.object({ ok: z.boolean() }),
      agent: agents.reviewer,
      sessionKey: "shared-session",
      prompt: "review",
    });
    step("unstable_route").if({
      condition: lift({ ok: first.output.ok, runId: meta.runId }, ({ ok, runId }) => {
        const key = "__acpus_fork_session_topology_evaluations";
        const counts = (Reflect.get(globalThis, key) as Record<string, number> | undefined) ?? {};
        const count = (counts[runId] ?? 0) + 1;
        counts[runId] = count;
        Reflect.set(globalThis, key, counts);
        return ok && count === 1;
      }),
      then() {
        step("second_review").agent({
          outputSchema: z.object({ ok: z.boolean() }),
          agent: agents.reviewer,
          sessionKey: "shared-session",
          prompt: "review again",
        });
        return { continued: true };
      },
      else() { return { continued: false }; },
    });
    return {};
  });
}

function replaceCompletedInstanceEventOutput(workspace: string, runId: string, nodeKey: string, output: unknown): void {
  const db = new DatabaseSync(runtimeDatabasePath(workspace));
  try {
    const row = db.prepare("SELECT payload_json FROM run_events WHERE run_id = ? AND type = 'instance.completed' AND node_key = ?")
      .get(runId, nodeKey) as { payload_json: string } | undefined;
    if (!row) throw new Error(`Expected completed event for '${nodeKey}'.`);
    const envelope = JSON.parse(row.payload_json) as { schedulerEventVersion: number; payload: Record<string, unknown> };
    envelope.payload.output = output;
    db.prepare("UPDATE run_events SET payload_json = ? WHERE run_id = ? AND type = 'instance.completed' AND node_key = ?").run(
      JSON.stringify(envelope),
      runId,
      nodeKey,
    );
    db.prepare("UPDATE node_instances SET output_json = ? WHERE run_id = ? AND node_key = ?").run(
      JSON.stringify(output),
      runId,
      nodeKey,
    );
    db.prepare("DELETE FROM scheduler_projection_checkpoints WHERE run_id = ?").run(runId);
  } finally {
    db.close();
  }
}

function executeRuntimeSql(workspace: string, sql: string, ...params: string[]): void {
  const db = new DatabaseSync(runtimeDatabasePath(workspace));
  try {
    db.prepare(sql).run(...params);
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
    replayGroups: unknown(runtimeRows(workspace, "SELECT run_id, session_group_digest FROM fork_replay_session_groups ORDER BY run_id, session_group_digest")),
    replayFacts: unknown(runtimeRows(workspace, "SELECT run_id, node_key FROM fork_replay_facts ORDER BY run_id, node_key")),
  };
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

function assertLoopForkCompleted(
  store: Awaited<ReturnType<typeof openRuntimeStore>>,
  runId: string,
  inherited: string[],
  executed: string[],
): void {
  const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId).projection;
  for (const nodeKey of inherited) {
    expect(Object.values(projection.attempts).filter(attempt => attempt.nodeKey === nodeKey)).toHaveLength(0);
  }
  for (const nodeKey of executed) {
    expect(Object.values(projection.attempts).filter(attempt => attempt.nodeKey === nodeKey)).toHaveLength(1);
  }
  expect(store.getRun(runId)).toMatchObject({ status: "completed", output: { done: true, last: "fixed-2" } });
}

function loopForkWorkflow(fixed: boolean) {
  return defineWorkflow({
    name: fixed ? "scheduler-node-executor-loop-replacement" : "scheduler-node-executor-loop-source",
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
