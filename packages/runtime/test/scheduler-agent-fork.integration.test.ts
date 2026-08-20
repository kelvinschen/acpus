import { admitRunForTest } from "./support/runtime-store.js";
import { defineWorkflow, z } from "@acpus/core";
import { template } from "@acpus/expression";
import type { FixtureAgentTurnRequest as AgentTurnRequest } from "./support/agent-turn.js";
import { describe, expect, it } from "vitest";
import { appendNode, deriveInstanceKey } from "../src/scheduler/identity.js";
import { openRuntimeStore } from "../src/store/store.js";
import { prepareSyntheticWorkflow, runtimeRows, withRuntimeWorkspace } from "./support/runtime-fixtures.js";
import { throwingSchedulerStore } from "./support/scheduler-store.js";
import { observedCompletedAgentTurn, taggedAgentOutput } from "./support/agent-turn.js";
import { getRunVisualizationSnapshot } from "../src/runs/use-cases.js";
import {
  advanceFrozenRun,
  forkAgentWorkflow,
  forkRuntimeRun,
  injectedAgentWorkflow,
  targetedForkCompletedSourceWorkflow,
  targetedForkFailedSourceWorkflow,
  targetedForkReplacementWorkflow,
} from "./support/scheduler-agent-fork.js";

describe.concurrent("scheduler Agent injections and forks", () => {
  it("executes scheduler-backed Agent nodes with submit-time injections", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-agent-submit-injection", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, injectedAgentWorkflow());
        const store = await openRuntimeStore(workspace);
        const turns: AgentTurnRequest[] = [];
        try {
          const run = await admitRunForTest(store, {
            prepared,
            input: {},
            cwd: workspace,
            agentInjections: {
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
              return observedCompletedAgentTurn(request, taggedAgentOutput("{\"ok\":true}"));
            },
          })).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });

          expect(store.getFrozenRun(run.id)?.agentBindings.reviewer).toMatchObject({
            source: { kind: "direct" },
            injection: { command: "custom-acp-server", permissionMode: "deny-all" },
          });
          expect((await getRunVisualizationSnapshot(workspace, run.id))._unsafeUnwrap()).toMatchObject({
            workflow: {
              name: "scheduler-node-executor-agent-injection",
              description: "Review a change with configured agents.",
              agents: {
                reviewer: {
                  kind: "agent_command",
                  command: "custom-acp-server",
                  permissionMode: "deny-all",
                },
                auditor: { kind: "agent_definition", use: "claude" },
              },
            },
          });
          expect(turns).toHaveLength(1);
          expect(turns[0]).toMatchObject({
            agent: { kind: "command", command: "custom-acp-server" },
            permissionMode: "deny-all",
          });
          expect(turns[0]!.model).toBeUndefined();
          expect(turns[0]!.config).toBeUndefined();
        } finally {
          store.close();
        }
      });
    });

  it("inherits fork Agent injections and clears identity-tied fields on replacement", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-agent-fork-injection", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, injectedAgentWorkflow());
        const store = await openRuntimeStore(workspace);
        try {
          const source = await admitRunForTest(store, {
            prepared,
            input: {},
            cwd: workspace,
            agentInjections: {
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
          expect(store.getFrozenRun(inherited.id)?.agentBindings).toMatchObject({
            reviewer: { injection: {
              use: "claude",
              model: "sonnet",
              config: { mode: "plan", effort: "high" },
              permissionMode: "deny-all",
            } },
            auditor: { injection: { use: "codex", model: "audit-model" } },
          });
          expect(store.getFrozenRun(inherited.id)?.ir.agents.reviewer).toMatchObject({
            kind: "agent_definition",
            use: "claude",
            model: "sonnet",
            config: { mode: "plan", effort: "high" },
            permissionMode: "deny-all",
          });

          const reconfigured = await forkRuntimeRun(store, source.id, {
            agentInjections: { reviewer: { config: { mode: "agent" } } },
          });
          expect(store.getFrozenRun(reconfigured.id)?.agentBindings.reviewer?.injection).toMatchObject({
            use: "claude",
            model: "sonnet",
            config: { mode: "agent" },
            permissionMode: "deny-all",
          });
          expect(store.getFrozenRun(reconfigured.id)?.ir.agents.reviewer).toMatchObject({
            config: { mode: "agent" },
          });

          const cleared = await forkRuntimeRun(store, source.id, {
            agentInjections: { reviewer: { config: {} } },
          });
          expect(store.getFrozenRun(cleared.id)?.agentBindings.reviewer?.injection).toMatchObject({ config: {} });
          expect(store.getFrozenRun(cleared.id)?.ir.agents.reviewer).toMatchObject({ config: {} });

          const replaced = await forkRuntimeRun(store, source.id, {
            agentInjections: { reviewer: { command: "custom-acp-server" } },
          });
          const effective = store.getFrozenRun(replaced.id)?.ir.agents.reviewer;
          expect(store.getFrozenRun(replaced.id)?.agentBindings).toMatchObject({
            reviewer: { injection: { command: "custom-acp-server", permissionMode: "deny-all" } },
            auditor: { injection: { use: "codex", model: "audit-model" } },
          });
          expect(effective).toMatchObject({
            kind: "agent_command",
            command: "custom-acp-server",
            permissionMode: "deny-all",
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

  it("replays compatible completions while recovering a failed source without a target", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-fork-recovery", async workspace => {
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
          expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(fork.id).projection.instances).toEqual({});

          await expect(advanceFrozenRun({
            cwd: workspace,
            runId: fork.id,
            ownerId: "fork-owner",
            store,
          })).resolves.toMatchObject({ status: "completed", started: 1, completed: 2 });

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

  it("reruns only leaves whose declared workflow input changed", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-fork-field-input", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, fieldInputForkWorkflow());
        const store = await openRuntimeStore(workspace);
        try {
          const source = await admitRunForTest(store, {
            prepared,
            input: { a: "old", b: "same" },
            cwd: workspace,
          });
          await expect(advanceFrozenRun({ cwd: workspace, runId: source.id, ownerId: "source-owner", store }))
            .resolves.toMatchObject({ status: "completed", started: 2, completed: 2 });

          const fork = await forkRuntimeRun(store, source.id, { input: { a: "new", b: "same" } });
          await expect(advanceFrozenRun({ cwd: workspace, runId: fork.id, ownerId: "fork-owner", store }))
            .resolves.toMatchObject({ status: "completed", started: 1, completed: 2 });

          const attempts = Object.values(throwingSchedulerStore(store.scheduler).loadRunSnapshot(fork.id).projection.attempts);
          expect(attempts.map(attempt => attempt.nodeId)).toEqual(["from_a"]);
          expect(store.getRun(fork.id)).toMatchObject({ output: { a: "new", b: "same" } });
        } finally {
          store.close();
        }
      });
    });

  it("semantically reuses omitted and explicitly equivalent normalized fork input", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-fork-semantic-input", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, semanticForkInputWorkflow());
        const store = await openRuntimeStore(workspace);
        try {
          const source = await admitRunForTest(store, {
            prepared,
            input: { value: "same" },
            cwd: workspace,
          });

          const inherited = await forkRuntimeRun(store, source.id);
          const explicitEquivalent = await forkRuntimeRun(store, source.id, { input: { value: "same" } });
          const changed = await forkRuntimeRun(store, source.id, { input: { value: "different" } });

          expect(explicitEquivalent).toMatchObject({ id: inherited.id, forkCreated: false });
          expect(changed).toMatchObject({ forkCreated: true });
          expect(changed.id).not.toBe(inherited.id);
          expect(store.getFrozenRun(inherited.id)?.input).toEqual({ value: "same", mode: "standard" });
        } finally {
          store.close();
        }
      });
    });

  it("replays a downstream leaf when a changed predecessor reproduces the same output", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-fork-stable-output", async workspace => {
        const sourcePrepared = await prepareSyntheticWorkflow(workspace, stableOutputForkWorkflow(false));
        const replacementPrepared = await prepareSyntheticWorkflow(workspace, stableOutputForkWorkflow(true));
        const store = await openRuntimeStore(workspace);
        try {
          const source = await admitRunForTest(store, { prepared: sourcePrepared, input: {}, cwd: workspace });
          await expect(advanceFrozenRun({ cwd: workspace, runId: source.id, ownerId: "source-owner", store }))
            .resolves.toMatchObject({ status: "completed", started: 2, completed: 2 });

          const fork = await forkRuntimeRun(store, source.id, { prepared: replacementPrepared });
          await expect(advanceFrozenRun({ cwd: workspace, runId: fork.id, ownerId: "fork-owner", store }))
            .resolves.toMatchObject({ status: "completed", started: 1, completed: 2 });

          const attempts = Object.values(throwingSchedulerStore(store.scheduler).loadRunSnapshot(fork.id).projection.attempts);
          expect(attempts.map(attempt => attempt.nodeId)).toEqual(["produce"]);
          expect(store.getRun(fork.id)).toMatchObject({ output: { value: 1 } });
        } finally {
          store.close();
        }
      });
    });

  it("drives completed children through the same replay path", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-targeted-fork-empty-agent-injections", async workspace => {
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

          const fork = await forkRuntimeRun(store, source.id, { agentInjections: {} });
          expect(store.getRun(fork.id)).toMatchObject({ status: "pending" });
          await expect(advanceFrozenRun({ cwd: workspace, runId: fork.id, ownerId: "fork-owner", store }))
            .resolves.toMatchObject({ status: "completed", started: 0, completed: 2 });
          expect(Object.values(throwingSchedulerStore(store.scheduler).loadRunSnapshot(fork.id).projection.attempts)).toHaveLength(0);
        } finally {
          store.close();
        }
      });
    });

  it("replays compatible agents without creating a child attempt or session", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-agent-fork-replay", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, injectedAgentWorkflow());
        const store = await openRuntimeStore(workspace);
        const turns: AgentTurnRequest[] = [];
        try {
          const source = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
          await advanceFrozenRun({
            cwd: workspace,
            runId: source.id,
            ownerId: "source-owner",
            store,
            executeAgentTurn: async request => {
              turns.push(request);
              return observedCompletedAgentTurn(request, taggedAgentOutput("{\"ok\":true}"));
            },
          });

          const fork = await forkRuntimeRun(store, source.id);
          await expect(advanceFrozenRun({ cwd: workspace, runId: fork.id, ownerId: "fork-owner", store }))
            .resolves.toMatchObject({ status: "completed", started: 0, completed: 1 });

          expect(turns).toHaveLength(1);
          expect(Object.values(throwingSchedulerStore(store.scheduler).loadRunSnapshot(fork.id).projection.attempts)).toEqual([]);
          expect(runtimeRows(workspace, "SELECT * FROM fork_replay_session_groups WHERE run_id = ?", fork.id)).toEqual([]);
          expect(store.getRun(fork.id)?.dynamic?.nodeInstances).toEqual([
            expect.objectContaining({ reusedFromRunId: source.id, reusedFromNodeKey: expect.any(String) }),
          ]);
        } finally {
          store.close();
        }
      });
    });

  it("replays an unchanged explicit session group without creating a child session", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-agent-fork-explicit-session", async workspace => {
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

          const fork = await forkRuntimeRun(store, source.id);
          expect(runtimeRows(workspace, `
            SELECT member_count, replayed_count
            FROM fork_replay_session_groups
            WHERE run_id = ?
          `, fork.id)).toEqual([{ member_count: 2, replayed_count: 0 }]);
          await expect(advanceFrozenRun({ cwd: workspace, runId: fork.id, ownerId: "fork-owner", store, executeAgentTurn }))
            .resolves.toMatchObject({ status: "completed", started: 0, completed: 2 });

          expect(turns).toHaveLength(2);
          expect(turns[1]!.agentSessionId).toBe(turns[0]!.agentSessionId);
          expect(Object.values(throwingSchedulerStore(store.scheduler).loadRunSnapshot(fork.id).projection.attempts)).toEqual([]);
          expect(store.getRun(fork.id)?.dynamic?.nodeInstances).toEqual([
            expect.objectContaining({ nodeId: "first_review", reusedFromRunId: source.id }),
            expect.objectContaining({ nodeId: "second_review", reusedFromRunId: source.id }),
          ]);
        } finally {
          store.close();
        }
      });
    });

  it("continues an atomic session-group replay after the runtime store reopens", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-agent-fork-session-reopen", async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, forkAgentWorkflow("shared-session"));
        let store = await openRuntimeStore(workspace);
        const turns: AgentTurnRequest[] = [];
        const executeAgentTurn = async (request: AgentTurnRequest) => {
          turns.push(request);
          return observedCompletedAgentTurn(request, taggedAgentOutput("{\"ok\":true}"));
        };
        try {
          const source = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
          await advanceFrozenRun({ cwd: workspace, runId: source.id, ownerId: "source-owner", store, executeAgentTurn });
          const fork = await forkRuntimeRun(store, source.id);

          await expect(advanceFrozenRun({
            cwd: workspace,
            runId: fork.id,
            ownerId: "fork-owner-a",
            store,
            shouldStop: () => runtimeRows(workspace, `
              SELECT replayed_count
              FROM fork_replay_session_groups
              WHERE run_id = ?
            `, fork.id)[0]?.replayed_count === 1,
          })).resolves.toMatchObject({ status: "lease_lost", started: 0, completed: 1 });
          store.close();
          store = await openRuntimeStore(workspace);

          await expect(advanceFrozenRun({ cwd: workspace, runId: fork.id, ownerId: "fork-owner-b", store }))
            .resolves.toMatchObject({ status: "completed", started: 0, completed: 1 });
          expect(turns).toHaveLength(2);
          expect(Object.values(throwingSchedulerStore(store.scheduler).loadRunSnapshot(fork.id).projection.attempts)).toEqual([]);
        } finally {
          store.close();
        }
      });
    });

  it("replays and enforces the source conversation order independently of child admission", async () => {
      await withRuntimeWorkspace("scheduler-node-executor-agent-fork-session-source-order", async workspace => {
        const sourcePrepared = await prepareSyntheticWorkflow(workspace, parallelSessionOrderWorkflow(1));
        const childPrepared = await prepareSyntheticWorkflow(workspace, parallelSessionOrderWorkflow(3));
        const store = await openRuntimeStore(workspace);
        const turns: AgentTurnRequest[] = [];
        const executeAgentTurn = async (request: AgentTurnRequest) => {
          turns.push(request);
          return observedCompletedAgentTurn(request, taggedAgentOutput("{\"ok\":true}"));
        };
        try {
          const source = await admitRunForTest(store, { prepared: sourcePrepared, input: { variant: 0 }, cwd: workspace });
          await expect(advanceFrozenRun({ cwd: workspace, runId: source.id, ownerId: "source-owner", store, executeAgentTurn }))
            .resolves.toMatchObject({ status: "completed", started: 4, completed: 4 });
          expect(runtimeRows(workspace, `
            SELECT node_instances.node_id
            FROM run_events
            JOIN node_instances
              ON node_instances.run_id = run_events.run_id AND node_instances.node_key = run_events.node_key
            WHERE run_events.run_id = ?
              AND run_events.type = 'instance.completed'
              AND node_instances.node_id LIKE 'agent_%'
            ORDER BY run_events.sequence
          `, source.id).map(row => row.node_id)).toEqual(["agent_a", "agent_b", "agent_c"]);

          const replayed = await forkRuntimeRun(store, source.id, { prepared: childPrepared, input: { variant: 1 } });
          expect(runtimeRows(workspace, `
            SELECT member_count, replayed_count
            FROM fork_replay_session_groups
            WHERE run_id = ?
          `, replayed.id)).toEqual([{ member_count: 3, replayed_count: 0 }]);
          await expect(advanceFrozenRun({ cwd: workspace, runId: replayed.id, ownerId: "replay-owner", store, executeAgentTurn }))
            .resolves.toMatchObject({ status: "completed", started: 0, completed: 4 });
          expect(turns).toHaveLength(3);
          expect(runtimeRows(workspace, `
            SELECT node_instances.node_id
            FROM run_events
            JOIN node_instances
              ON node_instances.run_id = run_events.run_id AND node_instances.node_key = run_events.node_key
            WHERE run_events.run_id = ?
              AND run_events.type = 'instance.completed'
              AND node_instances.node_id LIKE 'agent_%'
            ORDER BY run_events.sequence
          `, replayed.id).map(row => row.node_id)).toEqual(["agent_a", "agent_b", "agent_c"]);

          const outOfOrder = await forkRuntimeRun(store, source.id, { prepared: childPrepared, input: { variant: 2 } });
          await expect(advanceFrozenRun({
            cwd: workspace,
            runId: outOfOrder.id,
            ownerId: "bootstrap-order-owner",
            store,
            shouldStop: () => true,
          })).resolves.toMatchObject({ status: "lease_lost", started: 0, completed: 0 });
          const orderedCandidates = store.scheduler.listReplayCandidates(outOfOrder.id)
            .filter(candidate => candidate.sessionGroupDigest !== undefined);
          expect(orderedCandidates).toHaveLength(3);
          const bootstrapProjection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(outOfOrder.id).projection;
          expect(Object.values(bootstrapProjection.instances)
            .filter(instance => instance.status === "ready")
            .map(instance => instance.nodeId)).toEqual(expect.arrayContaining(["agent_b", "agent_c"]));
          expect(Object.values(bootstrapProjection.instances)
            .find(instance => instance.nodeId === "agent_a")?.status).not.toBe("ready");
          const lateCandidate = orderedCandidates[2]!;
          const lateFact = runtimeRows(workspace, `
            SELECT operation_digest, input_digest, session_group_digest
            FROM fork_replay_facts
            WHERE run_id = ? AND node_key = ?
          `, outOfOrder.id, lateCandidate.nodeKey)[0]!;
          const orderClaim = store.scheduler.claimRun(outOfOrder.id, "direct-order-owner", 60_000);
          if (!orderClaim) throw new Error("expected out-of-order run claim");
          try {
            const snapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(outOfOrder.id);
            const committed = store.scheduler.tryCommitReplay({
              runId: outOfOrder.id,
              nodeKey: lateCandidate.nodeKey,
              ownerEpoch: orderClaim.ownerEpoch,
              expectedVersion: snapshot.version,
              expectedSessionGroupDigest: String(lateFact.session_group_digest),
              replayIdentity: {
                operationDigest: String(lateFact.operation_digest),
                inputDigest: String(lateFact.input_digest),
                sessionGroupDigest: String(lateFact.session_group_digest),
              },
            });
            if (committed.isErr()) throw new Error(committed.error.message);
            expect(committed.value).toMatchObject({
              disposition: "mismatch",
              invalidatedNodeKeys: orderedCandidates.map(candidate => candidate.nodeKey),
            });
          } finally {
            store.scheduler.releaseRun(orderClaim);
          }
          expect(runtimeRows(workspace, "SELECT * FROM fork_replay_session_groups WHERE run_id = ?", outOfOrder.id)).toEqual([]);
          expect(runtimeRows(workspace, `
            SELECT * FROM fork_replay_facts
            WHERE run_id = ? AND session_group_digest IS NOT NULL
          `, outOfOrder.id)).toEqual([]);

          const partial = await forkRuntimeRun(store, source.id, { prepared: childPrepared, input: { variant: 3 } });
          await expect(advanceFrozenRun({
            cwd: workspace,
            runId: partial.id,
            ownerId: "partial-order-owner",
            store,
            shouldStop: () => runtimeRows(workspace, `
              SELECT replayed_count
              FROM fork_replay_session_groups
              WHERE run_id = ?
            `, partial.id)[0]?.replayed_count === 1,
          })).resolves.toMatchObject({ status: "lease_lost", started: 0, completed: 2 });
          const remaining = store.scheduler.listReplayCandidates(partial.id)
            .filter(candidate => candidate.sessionGroupDigest !== undefined);
          expect(remaining).toHaveLength(2);
          const skippedCandidate = remaining[1]!;
          const skippedFact = runtimeRows(workspace, `
            SELECT operation_digest, input_digest, session_group_digest
            FROM fork_replay_facts
            WHERE run_id = ? AND node_key = ?
          `, partial.id, skippedCandidate.nodeKey)[0]!;
          const partialClaim = store.scheduler.claimRun(partial.id, "direct-partial-order-owner", 60_000);
          if (!partialClaim) throw new Error("expected partial-order run claim");
          try {
            const snapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(partial.id);
            expect(() => store.scheduler.tryCommitReplay({
              runId: partial.id,
              nodeKey: skippedCandidate.nodeKey,
              ownerEpoch: partialClaim.ownerEpoch,
              expectedVersion: snapshot.version,
              expectedSessionGroupDigest: String(skippedFact.session_group_digest),
              replayIdentity: {
                operationDigest: String(skippedFact.operation_digest),
                inputDigest: String(skippedFact.input_digest),
                sessionGroupDigest: String(skippedFact.session_group_digest),
              },
            })).toThrow(/out of source order.*after 1 member/);
          } finally {
            store.scheduler.releaseRun(partialClaim);
          }
          expect(runtimeRows(workspace, `
            SELECT member_count, replayed_count
            FROM fork_replay_session_groups
            WHERE run_id = ?
          `, partial.id)).toEqual([{ member_count: 3, replayed_count: 1 }]);
        } finally {
          store.close();
        }
      });
    });

});

function parallelSessionOrderWorkflow(maxConcurrency: number) {
  return defineWorkflow({
    name: "scheduler-node-executor-fork-agent-session-source-order",
    inputSchema: z.object({ variant: z.number() }),
    agents: { reviewer: { use: "codex" } },
  }).build(({ agents, step }) => {
    step("conversation").parallel({
      maxConcurrency,
      branches: {
        a() {
          const gate = step("gate").task({
            input: null,
            exec: async () => {
              await new Promise(resolve => setTimeout(resolve, 20));
              return { ok: true };
            },
          });
          step("agent_a").agent({
            outputSchema: z.object({ ok: z.boolean() }),
            agent: agents.reviewer,
            sessionKey: "ordered-session",
            prompt: template`A ${gate.output.ok}`,
          });
          return {};
        },
        b() {
          step("agent_b").agent({
            outputSchema: z.object({ ok: z.boolean() }),
            agent: agents.reviewer,
            sessionKey: "ordered-session",
            prompt: "B",
          });
          return {};
        },
        c() {
          step("agent_c").agent({
            outputSchema: z.object({ ok: z.boolean() }),
            agent: agents.reviewer,
            sessionKey: "ordered-session",
            prompt: "C",
          });
          return {};
        },
      },
    });
    return {};
  });
}

function fieldInputForkWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-fork-field-input",
    inputSchema: z.object({ a: z.string(), b: z.string() }),
  }).build(({ input, step }) => {
    const fromA = step("from_a").task({ input: input.a, exec: async ({ input }) => input });
    const fromB = step("from_b").task({ input: input.b, exec: async ({ input }) => input });
    return { a: fromA.output, b: fromB.output };
  });
}

function semanticForkInputWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-fork-semantic-input",
    inputSchema: z.object({ value: z.string(), mode: z.string().default("standard") }),
  }).build(({ input }) => ({ value: input.value, mode: input.mode }));
}

function stableOutputForkWorkflow(changed: boolean) {
  return defineWorkflow({ name: "scheduler-node-executor-fork-stable-output" }).build(({ step }) => {
    const produced = step("produce").task({
      input: null,
      exec: changed ? async () => ({ value: 1, implementation: "new" }) : async () => ({ value: 1 }),
    });
    const consumed = step("consume").task({
      input: produced.output.value,
      exec: async ({ input }) => ({ value: input }),
    });
    return { value: consumed.output.value };
  });
}
