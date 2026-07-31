import { admitRunForTest } from "./support/runtime-store.js";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { defineWorkflow, z } from "@acpus/core";
import type { AgentTurnObservation, AgentTurnProgress, AgentTurnRequest, AgentTurnResult, ManagedAcpExecutor } from "@acpus/agent-executor";
import { lift, template } from "@acpus/expression";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendNode, deriveInstanceKey } from "../src/scheduler/identity.js";
import { createRuntimeNodeExecutor as createRuntimeNodeExecutorProduction, type RuntimeNodeExecutorInput } from "../src/scheduler/node-executor.js";
import { advanceFrozenRun as advanceFrozenRunProduction, type AdvanceFrozenRunInput } from "../src/scheduler/runtime-runner.js";
import { executeAgentNode as executeAgentNodeProduction } from "../src/execution/agent-node.js";
import { throwSchedulerStoreResult, type RunOwnerClaim } from "../src/scheduler/store-port.js";
import { openRuntimeStore, type RuntimeStore } from "../src/store/store.js";
import { tryCaptureRunFile } from "../src/store/run-file.js";
import { prepareSyntheticWorkflow, runtimeRow, runtimeRows, withRuntimeWorkspace } from "./support/runtime-fixtures.js";
import { throwingSchedulerStore } from "./support/scheduler-store.js";
import { loadAgentHostPolicy, type AgentHostPolicy } from "../src/configuration.js";
import type { HookContext } from "../src/hooks/context.js";
import type { HookRunner } from "../src/hooks/runner.js";
import { agentSummary, agentTiming, completedAgentTurn, taggedAgentOutput } from "./support/agent-turn.js";
import { createVersionedWakeup } from "../src/scheduler/wakeup.js";
import { rootFrameStarted } from "./support/scheduler.js";

const agentMocks = vi.hoisted(() => ({
  executeAgentTurn: vi.fn<(request: AgentTurnRequest) => Promise<AgentTurnResult>>(),
}));
declare global {
  var __acpusPromptResolutionCount: number | undefined;
  var __acpusTimeoutResolutionCount: number | undefined;
}
const initialResponseRepairMax = process.env.ACPUS_AGENT_RESPONSE_REPAIR_MAX;
const testRunClaims = new WeakMap<RuntimeStore, Map<string, RunOwnerClaim>>();
beforeEach(() => {
  restoreEnv("ACPUS_AGENT_RESPONSE_REPAIR_MAX", undefined);
  agentMocks.executeAgentTurn.mockReset();
  vi.useRealTimers();
});
afterEach(() => {
  restoreEnv("ACPUS_AGENT_RESPONSE_REPAIR_MAX", initialResponseRepairMax);
});
function advanceFrozenRun(input: AdvanceFrozenRunInput & { executeAgentTurn?: (request: AgentTurnRequest) => Promise<AgentTurnResult> }) {
  const { executeAgentTurn, managedAcpExecutor = testManagedAcpExecutor(), ...productionInput } = input;
  if (executeAgentTurn) agentMocks.executeAgentTurn.mockImplementation(executeAgentTurn);
  return advanceFrozenRunProduction({ ...productionInput, managedAcpExecutor });
}
type TestAgentExecutorOptions = Omit<Parameters<typeof executeAgentNodeProduction>[2], "hostPolicy"> & {
  hostPolicy?: AgentHostPolicy;
  executeTurn?: (request: AgentTurnRequest) => Promise<AgentTurnResult>;
};
async function executeAgentNode(node: Parameters<typeof executeAgentNodeProduction>[0], scope: Parameters<typeof executeAgentNodeProduction>[1], options: TestAgentExecutorOptions) {
  const { executeTurn, hostPolicy = loadAgentHostPolicy(process.env), managedAcpExecutor = testManagedAcpExecutor(), ...productionOptions } = options;
  if (executeTurn) agentMocks.executeAgentTurn.mockImplementation(executeTurn);
  const result = !productionOptions.store || !productionOptions.runId
    ? await executeAgentNodeProduction(node, scope, { ...productionOptions, hostPolicy, managedAcpExecutor })
    : await (() => {
        const attempt = ensureTestAttempt(
          productionOptions.store,
          productionOptions.runId,
          productionOptions.nodeKey ?? node.id,
          node.id,
          productionOptions.attemptId,
        );
        return executeAgentNodeProduction(node, scope, { ...productionOptions, ...attempt, hostPolicy, managedAcpExecutor });
      })();
  if (result.isOk()) return result.value;
  const error = result.error.type === "resolution"
    ? Object.assign(new Error(result.error.message), { resolution: result.error.error })
    : result.error.type === "cancelled"
      ? new Error(result.error.message)
      : Object.assign(new Error(`${result.error.failure.code}: ${result.error.message}`), { failure: result.error.failure });
  throw error;
}
type TestRuntimeNodeExecutorInput = Omit<RuntimeNodeExecutorInput, "agentHostPolicy"> & { agentHostPolicy?: AgentHostPolicy; executeAgentTurn?: (request: AgentTurnRequest) => Promise<AgentTurnResult> };
function createRuntimeNodeExecutor(input: TestRuntimeNodeExecutorInput) {
  const { executeAgentTurn, agentHostPolicy = loadAgentHostPolicy(process.env), managedAcpExecutor = testManagedAcpExecutor(), ...productionInput } = input;
  if (executeAgentTurn) agentMocks.executeAgentTurn.mockImplementation(executeAgentTurn);
  const executor = createRuntimeNodeExecutorProduction({ ...productionInput, agentHostPolicy, managedAcpExecutor });
  return {
    execute(context: Parameters<typeof executor.execute>[0]) {
      const attempt = ensureTestAttempt(input.store, context.runId, context.nodeKey, context.nodeId, context.attemptId);
      return executor.execute({ ...context, ...attempt });
    },
  };
}

function testManagedAcpExecutor(): ManagedAcpExecutor {
  return {
    withAttempt: async (_input, use) => use({ runTurn: request => agentMocks.executeAgentTurn(request) }),
    shutdown: async () => {},
  };
}

function ensureTestAttempt(store: RuntimeStore, runId: string, nodeKey: string, nodeId: string, requestedAttemptId?: string) {
  const scheduler = throwingSchedulerStore(store.scheduler);
  let snapshot = scheduler.loadRunSnapshot(runId);
  const existing = Object.values(snapshot.projection.attempts).find(attempt =>
    attempt.status === "started"
    && attempt.nodeKey === nodeKey
    && (requestedAttemptId === undefined || attempt.attemptId === requestedAttemptId),
  );
  if (existing) {
    return {
      attemptId: existing.attemptId,
      attemptNo: existing.attemptNo,
      ownerEpoch: existing.ownerEpoch,
    };
  }

  let claims = testRunClaims.get(store);
  if (!claims) {
    claims = new Map();
    testRunClaims.set(store, claims);
  }
  let claim = claims.get(runId);
  if (!claim) {
    claim = store.scheduler.claimRun(runId, `agent-test-${runId}`, 60_000);
    if (!claim) throw new Error(`expected test claim for run '${runId}'`);
    claims.set(runId, claim);
  }

  if (!snapshot.projection.frames.root) {
    snapshot = scheduler.appendSchedulerEvents({
      runId,
      expectedVersion: snapshot.version,
      ownerEpoch: claim.ownerEpoch,
      idempotencyKey: `agent-test:${runId}:root:${snapshot.version}`,
      events: [rootFrameStarted(runId, nodeId, nodeKey)],
    });
  }

  const instance = snapshot.projection.instances[nodeKey];
  if (!instance) {
    snapshot = scheduler.appendSchedulerEvents({
      runId,
      expectedVersion: snapshot.version,
      ownerEpoch: claim.ownerEpoch,
      idempotencyKey: `agent-test:${runId}:${nodeKey}:ready:${snapshot.version}`,
      events: [{
        type: "instance.ready",
        payload: {
          runId,
          nodeKey,
          nodeId,
          instancePath: [{ kind: "node", nodeId }],
          parentFrameKey: "root",
          readinessSequence: Object.keys(snapshot.projection.instances).length + 1,
        },
      }],
    });
  } else if (instance.status !== "ready") {
    throw new Error(`expected test instance '${nodeKey}' to be ready, received '${instance.status}'`);
  }

  const started = scheduler.startAttempt({
    runId,
    nodeKey,
    nodeId,
    ownerEpoch: claim.ownerEpoch,
    expectedVersion: snapshot.version,
    idempotencyKey: `agent-test:${runId}:${nodeKey}:start:${snapshot.version}`,
  });
  return {
    attemptId: started.attemptId,
    attemptNo: started.attemptNo,
    ownerEpoch: claim.ownerEpoch,
  };
}

describe("agent node execution", () => {
    describe("scheduler-backed progress", () => {
    it("repairs schema-backed agent output inside one scheduler-visible attempt", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-single-attempt", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, retryingAgentWorkflow());
          const store = await openRuntimeStore(workspace);
          const turns: AgentTurnRequest[] = [];
          const attempts: unknown[] = [];
          const managedAcpExecutor: ManagedAcpExecutor = {
            withAttempt: async (input, use) => {
              attempts.push(input);
              return use({ runTurn: request => agentMocks.executeAgentTurn(request) });
            },
            shutdown: async () => {},
          };
          try {
            const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
            const executor = createRuntimeNodeExecutor({
              cwd: workspace,
              ir: prepared.ir,
              scope: {},
              store,
              managedAcpExecutor,
              executeAgentTurn: async request => {
                turns.push(request);
                const turnProgress: AgentTurnProgress = {
                  responseText: `turn-${turns.length}-partial`,
                  updatedAt: "2026-07-01T00:00:00.000Z",
                  summary: agentSummary(0),
                };
                request.onObservation?.({
                  event: {
                    schemaVersion: 1,
                    sequence: 0,
                    observedAt: turnProgress.updatedAt,
                    elapsedMs: 0,
                    type: "plan",
                    value: turns.length === 1
                      ? "First-turn plan must not leak."
                      : "Second-turn plan is current.",
                  },
                  progress: turnProgress,
                });
                request.onProgress?.(turnProgress);
                return completedAgentTurn(
                  taggedAgentOutput(turns.length === 1 ? "{\"attempt\":1,\"extra\":\"drop\"}" : "{\"attempt\":\"2\",\"extra\":\"drop\"}"),
                  turns.length === 2 ? "stderr detail\n" : "",
                  turns.length === 1 ? {
                    eventCount: 5,
                    availability: { context: "available", tokenUsage: "available" },
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
                    cwd: workspace,
                    acpxRecordId: "record-1",
                  } : undefined,
                );
              },
            });

            await expect(withImmediateAgentRepairs(() => executor.execute({
              runId: run.id,
              nodeId: "review",
              nodeKey: "review.dynamic",
              attemptId: "attempt_1",
              attemptNo: 1,
              ownerEpoch: 1,
              signal: new AbortController().signal,
            }))).resolves.toEqual({
              status: "completed",
              output: { attempt: "2" },
            });
            expect(turns).toHaveLength(2);
            expect(attempts).toEqual([
              expect.objectContaining({ runId: run.id, sessionName: turns[0]!.sessionName }),
            ]);
            const terminalProgress = store.getRun(run.id)?.dynamic?.progress[0];
            expect(terminalProgress).toMatchObject({
              status: "completed",
              message: "turn 2 completed",
              tools: { turn: 2, totalToolCallCount: 0, lastCalls: [] },
              intent: {
                kind: "plan",
                value: "Second-turn plan is current.",
                updatedAt: "2026-07-01T00:00:00.000Z",
              },
            });
            expect(turns.map(turn => turn.sessionName)).toEqual([turns[0]!.sessionName, turns[0]!.sessionName]);
            expect(turns[0]).toMatchObject({ agent: { kind: "command" }, permissionMode: "approve-all" });
            expect(turns[0]!.model).toBe("profile-model");
            expect(turns[0]!.config).toEqual({ effort: "high", mode: "agent", model: "profile-model" });
            expect(turns[1]!.model).toBe("profile-model");
            expect(turns[1]!.config).toBeUndefined();
            expect(turns[1]!.prompt).toContain("# OUTPUT REPAIR");
            expect(turns[1]!.prompt).toContain("# RESULT HANDOFF [MANDATORY]");
            expect(turns[1]!.prompt).not.toContain("{\"attempt\":1,\"extra\":\"drop\"}");
            const metadataEntry = store.getRun(run.id)?.dynamic?.executionMetadata.find(entry => entry.kind === "agent_attempt");
            if (!metadataEntry?.attemptId) throw new Error("expected agent attempt metadata");
            const artifactRoot = `artifacts/review.dynamic/attempt-1/${metadataEntry.attemptId}/agent`;
            const artifactRows = runtimeRows(workspace, "SELECT id, media_type, relative_path FROM artifacts WHERE run_id = ? AND node_key = ? ORDER BY relative_path", run.id, "review.dynamic") as RuntimeArtifactRow[];
            expect(artifactRows).toEqual([
              expect.objectContaining({ media_type: "application/json", relative_path: `${artifactRoot}/turn-001.json` }),
              expect.objectContaining({ media_type: "application/json", relative_path: `${artifactRoot}/turn-002.json` }),
              expect.objectContaining({ media_type: "text/plain", relative_path: `${artifactRoot}/turn-002.stderr.log` }),
            ]);
            expect(metadataEntry).toMatchObject({ attemptId: expect.any(String), kind: "agent_attempt" });
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
                  failure: expect.objectContaining({ kind: "output_conformance" }),
                  outputProcessing: { outcome: "rejected", phase: "schema", parsing: "direct", projectionChanged: true },
                  summary: {
                    eventCount: 5,
                    availability: { context: "available", tokenUsage: "available" },
                    stopReason: "end_turn",
                    context: { used: 120, size: 240, updatedAt: "2026-07-01T00:00:00.000Z" },
                    tokenUsage: { source: "prompt_response", inputTokens: 10, outputTokens: 2, totalTokens: 12 },
                    tools: { totalToolCallCount: 1 },
                    cwd: workspace,
                    acpxRecordId: "record-1",
                  },
                }),
                expect.objectContaining({
                  turn: 2,
                  status: "completed",
                  outputProcessing: { outcome: "accepted", parsing: "direct", projectionChanged: true },
                }),
              ],
            });
            expect(JSON.stringify(metadata)).not.toContain(turns[0]!.prompt);
            expect(JSON.stringify(metadata)).not.toContain("{\"attempt\":1,\"extra\":\"drop\"}");
            expect(JSON.stringify(metadata)).not.toContain("tool-1");
            expect(JSON.stringify(metadata)).not.toContain("README.md");
            expect(JSON.stringify(metadata)).not.toContain("\"timing\"");
            expectAgentArtifactRef(metadata?.turns?.[0]?.turnArtifact, `${artifactRoot}/turn-001.json`, "application/json", artifactRows);
            expectAgentArtifactRef(metadata?.turns?.[1]?.stderrArtifact, `${artifactRoot}/turn-002.stderr.log`, "text/plain", artifactRows);
            const runDir = store.getRunDir(run.id);
            if (!runDir) throw new Error("expected run dir");
            const turnArtifact = await readJsonFile(join(runDir, artifactRoot, "turn-001.json"));
            expect(turnArtifact).toMatchObject({
              schemaVersion: 1,
              runId: run.id,
              nodeId: "review",
              nodeKey: "review.dynamic",
              attemptNo: 1,
              turn: 1,
              agentKey: "reviewer",
              sessionName: turns[0]!.sessionName,
              sessionProjectionPath: "acp/sessions/record-1.json",
              status: "completed",
              timing: agentTiming(),
              prompt: turns[0]!.prompt,
              response: taggedAgentOutput("{\"attempt\":1,\"extra\":\"drop\"}"),
              summary: {
                eventCount: 5,
                availability: { context: "available", tokenUsage: "available" },
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
                cwd: workspace,
                acpxRecordId: "record-1",
              },
            });
            expect(turnArtifact).not.toHaveProperty("summary.prompt");
            expect(turnArtifact).not.toHaveProperty("summary.response");
            expect(turnArtifact).not.toHaveProperty("summary.thinking");
            expect(turnArtifact).not.toHaveProperty("summary.rawOutput");
            await expect(readJsonFile(join(runDir, artifactRoot, "turn-002.json"))).resolves.toMatchObject({
              turn: 2,
              timing: agentTiming(),
            });
            expect(artifactRows.some(row => row.relative_path.includes("raw-parsed-output"))).toBe(false);
          } finally {
            store.close();
          }
        });
      });

    it("accepts a canonicalizable first response in one scheduler-visible turn", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-canonical-first-response", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, booleanAgentWorkflow());
          const store = await openRuntimeStore(workspace);
          const turns: AgentTurnRequest[] = [];
          try {
            const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });

            await expect(advanceFrozenRun({
              cwd: workspace,
              runId: run.id,
              ownerId: "owner-a",
              store,
              executeAgentTurn: async request => {
                turns.push(request);
                return completedAgentTurn(taggedAgentOutput('{"ok":true}"'));
              },
            })).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });

            expect(turns).toHaveLength(1);
            expect(turns[0]!.prompt).not.toContain("# OUTPUT REPAIR");
            expect(store.getRun(run.id)).toMatchObject({ status: "completed", output: {} });
            const metadata = store.getExecutionMetadata(run.id).find(entry => entry.kind === "agent_attempt")?.metadata as AgentAttemptMetadata | undefined;
            expect(metadata).toMatchObject({
              turnCount: 1,
              turns: [expect.objectContaining({
                outputProcessing: { outcome: "accepted", parsing: "repaired", projectionChanged: false },
              })],
            });
          } finally {
            store.close();
          }
        });
      });

    it("does not publish ordinary agent artifacts into a same-path replacement run directory", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-replaced-run", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, retryingAgentWorkflow());
          const node = prepared.ir.root.nodes.find(candidate => candidate.id === "review");
          if (!node || node.kind !== "agent") throw new Error("expected review agent node");
          const store = await openRuntimeStore(workspace);
          try {
            const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
            const runDir = store.getRunDir(run.id);
            if (!runDir) throw new Error("expected run directory");

            await expect(executeAgentNode(node, {}, {
              cwd: workspace,
              runId: run.id,
              nodeKey: "review",
              agents: prepared.ir.agents,
              store,
              executeTurn: async () => {
                await rename(runDir, `${runDir}.opened`);
                await mkdir(runDir);
                await writeFile(join(runDir, "sentinel.txt"), "replacement\n");
                return completedAgentTurn(taggedAgentOutput("{\"ok\":true}"));
              },
            })).rejects.toThrow();

            await expect(readdir(runDir)).resolves.toEqual(["sentinel.txt"]);
            await expect(readFile(join(runDir, "sentinel.txt"), "utf8")).resolves.toBe("replacement\n");
          } finally {
            store.close();
          }
        });
      });

    it("keeps a durably registered Agent artifact when its post-registration checkpoint fails", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-registered-checkpoint", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, retryingAgentWorkflow());
          const node = prepared.ir.root.nodes.find(candidate => candidate.id === "review");
          if (!node || node.kind !== "agent") throw new Error("expected review agent node");
          const store = await openRuntimeStore(workspace);
          const checkpointFailure = new Error("post-registration checkpoint failed");
          let failNextTokenRead = false;
          let tokenLookup: ReturnType<typeof vi.spyOn> | undefined;
          let registration: ReturnType<typeof vi.spyOn> | undefined;
          try {
            const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
            const openedRun = store.getRunDirectoryToken(run.id);
            if (!openedRun) throw new Error("expected run directory token");
            const faultedRun = new Proxy(openedRun, {
              get(target, property, receiver) {
                if (failNextTokenRead) {
                  failNextTokenRead = false;
                  throw checkpointFailure;
                }
                return Reflect.get(target, property, receiver);
              },
            });
            tokenLookup = vi.spyOn(store, "getRunDirectoryToken").mockReturnValue(faultedRun);
            const registerArtifact = store.registerArtifact.bind(store);
            registration = vi.spyOn(store, "registerArtifact").mockImplementation(input => {
              const result = registerArtifact(input);
              if (result.isOk()) failNextTokenRead = true;
              return result;
            });

            await expect(executeAgentNode(node, {}, {
              cwd: workspace,
              runId: run.id,
              nodeKey: "review",
              agents: prepared.ir.agents,
              store,
              executeTurn: async () => completedAgentTurn(taggedAgentOutput("{\"ok\":true}")),
            })).rejects.toBe(checkpointFailure);

            const artifacts = store.listArtifacts(run.id);
            expect(artifacts).toHaveLength(1);
            await expect(readFile(artifacts[0]!.path, "utf8")).resolves.toContain("\"schemaVersion\": 1");
          } finally {
            registration?.mockRestore();
            tokenLookup?.mockRestore();
            store.close();
          }
        });
      });


    it("persists agent progress while a scheduler-visible attempt is still running", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-progress", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, retryingAgentWorkflow());
          const store = await openRuntimeStore(workspace);
          try {
            const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
            const { attempt, ownerEpoch } = startReviewAttempt(store, run.id, "agent-progress");
            const executor = createRuntimeNodeExecutor({
              cwd: workspace,
              ir: prepared.ir,
              scope: {},
              store,
              executeAgentTurn: async request => {
                const reportedProgress: AgentTurnProgress = {
                  responseText: "hello from a long running agent",
                  updatedAt: "2026-07-01T00:00:00.000Z",
                  summary: agentSummary(1),
                };
                request.onProgress?.(reportedProgress);
                expect(store.getRun(run.id)?.dynamic?.progress).toEqual([
                  expect.objectContaining({
                    nodeKey: "review.dynamic",
                    attemptId: attempt.attemptId,
                    status: "running",
                    output: expect.objectContaining({ tail: "hello from a long running agent" }),
                    tools: { turn: 1, totalToolCallCount: 0, lastCalls: [] },
                  }),
                ]);
                return completedAgentTurn(taggedAgentOutput("{\"attempt\":\"1\"}"));
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

    it("writes timed out terminal agent progress", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-timeout-progress", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, timeoutAgentWorkflow());
          const store = await openRuntimeStore(workspace);
          try {
            const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
            const { attempt, ownerEpoch } = startReviewAttempt(store, run.id, "agent-timeout-progress");
            const executor = createRuntimeNodeExecutor({
              cwd: workspace,
              ir: prepared.ir,
              scope: {},
              store,
              executeAgentTurn: async () => ({
                status: "failed",
                failure: { kind: "timeout", message: "Agent turn timed out after 5ms." },
                responseText: "partial",
                stderr: "",
                summary: agentSummary(1),
                timing: agentTiming(),
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
            const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
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
                summary: agentSummary(1),
                timing: agentTiming(),
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
            const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
            const { attempt, ownerEpoch } = startReviewAttempt(store, run.id, "agent-provider-failure-progress");
            const executor = createRuntimeNodeExecutor({
              cwd: workspace,
              ir: prepared.ir,
              scope: {},
              store,
              executeAgentTurn: async () => ({
                status: "failed",
                failure: {
                  kind: "provider_exit",
                  message: "credential helper failed",
                  upstream: {
                    source: "acpx",
                    operation: "sessions.ensure",
                    exitCode: 1,
                    code: "RUNTIME",
                    origin: "cli",
                    protocol: { name: "json-rpc", code: -32603, message: "Internal error" },
                    data: { acpxCode: "RUNTIME", origin: "cli", details: "credential helper failed" },
                  },
                },
                responseText: "partial",
                stderr: "",
                summary: agentSummary(1),
                timing: agentTiming(),
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
            })).resolves.toMatchObject({
              status: "failed",
              reason: "provider_exit",
              error: {
                origin: "provider",
                code: "provider_exit",
                message: "credential helper failed",
                upstream: { source: "acpx", code: "RUNTIME", data: { details: "credential helper failed" } },
              },
            });
            expect(store.getRun(run.id)?.dynamic?.progress).toEqual([
              expect.objectContaining({
                attemptId: attempt.attemptId,
                status: "failed",
                message: "credential helper failed",
              }),
            ]);
          } finally {
            store.close();
          }
        });
      });

    it("writes failed terminal agent progress for final output framing failures", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-conformance-progress", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, booleanAgentWorkflow());
          const store = await openRuntimeStore(workspace);
          try {
            const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
            const { attempt, ownerEpoch } = startReviewAttempt(store, run.id, "agent-conformance-progress");
            const executor = createRuntimeNodeExecutor({
              cwd: workspace,
              ir: prepared.ir,
              scope: {},
              store,
              agentHostPolicy: loadAgentHostPolicy({ ACPUS_AGENT_RESPONSE_REPAIR_MAX: "0" }),
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
            })).resolves.toMatchObject({
              status: "failed",
              reason: "output_framing",
              error: { origin: "provider", code: "output_framing", message: expect.any(String) },
            });
            expect(store.getRun(run.id)?.dynamic?.progress).toEqual([
              expect.objectContaining({
                attemptId: attempt.attemptId,
                status: "failed",
                message: expect.stringContaining("<ACPUS_OUTPUT> frame"),
              }),
            ]);
          } finally {
            store.close();
          }
        });
      }, 2_000);

    it("persists a direct scalar Agent output through the scheduler root", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-scalar-output", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, scalarAgentOutputWorkflow());
          const store = await openRuntimeStore(workspace);
          try {
            const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });

            await expect(advanceFrozenRun({
              cwd: workspace,
              runId: run.id,
              ownerId: "owner-a",
              store,
              executeAgentTurn: async request => {
                expect(request.prompt).toContain("<ACPUS_OUTPUT>\nstring\n</ACPUS_OUTPUT>");
                return completedAgentTurn(`Finished.${taggedAgentOutput('"done"')}`);
              },
            })).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });

            expect(store.getRun(run.id)).toMatchObject({ status: "completed", output: "done" });
            const metadata = store.getExecutionMetadata(run.id).find(entry => entry.kind === "agent_attempt")?.metadata as AgentAttemptMetadata | undefined;
            expect(metadata?.turns).toEqual([
              expect.objectContaining({ outputProcessing: { outcome: "accepted", parsing: "direct", projectionChanged: false } }),
            ]);
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
            const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
            const executor = createRuntimeNodeExecutor({
              cwd: workspace,
              ir: prepared.ir,
              scope: {},
              store,
              executeAgentTurn: async request => {
                turns.push(request);
                return completedAgentTurn(taggedAgentOutput(JSON.stringify({
                  runId: request.env.ACPUS_RUNTIME_RUN_ID ?? null,
                  nodeId: request.env.ACPUS_RUNTIME_NODE_ID ?? null,
                  nodeKey: request.env.ACPUS_RUNTIME_NODE_KEY ?? null,
                  schedulerAttempt: request.env.ACPUS_RUNTIME_ATTEMPT ?? null,
                })));
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
                schedulerAttempt: "1",
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

    });

    describe("response conformance and host policy", () => {
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
              executeTurn: async request => completedAgentTurn(taggedAgentOutput(JSON.stringify({
                runId: request.env.ACPUS_RUNTIME_RUN_ID ?? null,
                nodeId: request.env.ACPUS_RUNTIME_NODE_ID ?? null,
                nodeKey: request.env.ACPUS_RUNTIME_NODE_KEY ?? null,
                schedulerAttempt: request.env.ACPUS_RUNTIME_ATTEMPT ?? null,
              }))),
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
            step("review").agent({ agent: agents.reviewer, prompt: "review" });
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

    it("sends only the steering tag to schema-less agents and omits initial config", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-schema-less-steer", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, defineWorkflow({
            name: "raw_steered_agent",
            agents: { reviewer: { use: "mock", config: { mode: "review" } } },
          }).build(({ agents, step }) => {
            step("review").agent({ agent: agents.reviewer, prompt: "original task" });
            return {};
          }));
          const node = prepared.ir.root.nodes.find(node => node.id === "review");
          if (!node || node.kind !== "agent") throw new Error("expected review agent node");
          const turns: AgentTurnRequest[] = [];

          await expect(executeAgentNode(node, {}, {
            cwd: workspace,
            agents: prepared.ir.agents,
            initialPrompt: { kind: "steer", instruction: "Focus on the failing assertion." },
            executeTurn: async request => {
              turns.push(request);
              return completedAgentTurn("fixed");
            },
          })).resolves.toBe("fixed");

          expect(turns).toHaveLength(1);
          expect(turns[0]!.prompt).toBe("<steering>Focus on the failing assertion.</steering>");
          expect(turns[0]!.config).toBeUndefined();
        });
      });

    it("adds the complete output contract to schema-backed steering and conforms in one turn", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-schema-steer-direct", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, retryingAgentWorkflow());
          const node = prepared.ir.root.nodes.find(node => node.id === "review");
          if (!node || node.kind !== "agent") throw new Error("expected review agent node");
          const turns: AgentTurnRequest[] = [];

          await expect(executeAgentNode(node, {}, {
            cwd: workspace,
            agents: prepared.ir.agents,
            initialPrompt: { kind: "steer", instruction: "Return the attempt as a string." },
            executeTurn: async request => {
              turns.push(request);
              return completedAgentTurn(taggedAgentOutput("{\"attempt\":\"1\"}"));
            },
          })).resolves.toEqual({ attempt: "1" });

          expect(turns).toHaveLength(1);
          expect(turns[0]!.prompt).toContain(`<steering>Return the attempt as a string.</steering>

# RESULT HANDOFF [MANDATORY]
Replace the type shape inside the tags with one matching JSON value; comments are guidance. Keep the tags verbatim, do not escape them, and end at the closing tag.
<ACPUS_OUTPUT>
{ attempt: string }
</ACPUS_OUTPUT>`);
          expect(turns[0]!.config).toBeUndefined();
        });
      });

    it("keeps steering repair free of the instruction and steer id", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-schema-steer", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, retryingAgentWorkflow());
          const store = await openRuntimeStore(workspace);
          const turns: AgentTurnRequest[] = [];
          try {
            const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
            const executor = createRuntimeNodeExecutor({
              cwd: workspace,
              ir: prepared.ir,
              scope: {},
              store,
              executeAgentTurn: async request => {
                turns.push(request);
                return completedAgentTurn(taggedAgentOutput(turns.length === 1 ? "{\"attempt\":1}" : "{\"attempt\":\"2\"}"));
              },
            });

            await expect(withImmediateAgentRepairs(() => executor.execute({
              runId: run.id,
              nodeId: "review",
              nodeKey: "review.dynamic",
              attemptId: "attempt_steered",
              attemptNo: 1,
              ownerEpoch: 1,
              steer: {
                steerId: "steer-must-remain-internal",
                instruction: "Return the attempt as a string.",
              },
              signal: new AbortController().signal,
            }))).resolves.toEqual({ status: "completed", output: { attempt: "2" } });

            expect(turns).toHaveLength(2);
            expect(turns[0]!.prompt).toMatch(/^<steering>Return the attempt as a string\.<\/steering>\n\n# RESULT HANDOFF \[MANDATORY\]/);
            expect(turns[0]!.config).toBeUndefined();
            expect(turns[1]!.prompt).toContain("# OUTPUT REPAIR");
            expect(turns[1]!.prompt).not.toContain("Return the attempt as a string.");
            expect(turns.every(turn => !turn.prompt.includes("steer-must-remain-internal"))).toBe(true);
            const turnArtifacts = store.listArtifacts(run.id)
              .filter(artifact => /turn-\d+\.json$/.test(artifact.path))
              .sort((left, right) => left.path.localeCompare(right.path));
            const recorded = await Promise.all(turnArtifacts.map(artifact => readJsonFile(artifact.path))) as Array<{ prompt: string }>;
            expect(recorded.map(artifact => artifact.prompt)).toEqual(turns.map(turn => turn.prompt));
            expect(JSON.stringify(recorded)).not.toContain("steer-must-remain-internal");
            const observationRows = runtimeRows(
              workspace,
              `SELECT turn_no, prompt_kind, state, provider_status
               FROM agent_observation_turns
               WHERE run_id = ?
               ORDER BY turn_no`,
              run.id,
            ) as Array<{
              turn_no: number;
              prompt_kind: string;
              state: string;
              provider_status: string;
            }>;
            expect(observationRows).toEqual([
              { turn_no: 1, prompt_kind: "steer", state: "settled", provider_status: "completed" },
              { turn_no: 2, prompt_kind: "repair", state: "settled", provider_status: "completed" },
            ]);
            const runDir = store.getRunDir(run.id);
            if (!runDir) throw new Error("expected run directory");
            await expect(readdir(runDir)).resolves.not.toContain("evidence");
          } finally {
            store.close();
          }
        });
      });

    it("treats a provider success returned after abort as cancellation", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-abort-wins", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, booleanAgentWorkflow());
          const node = prepared.ir.root.nodes.find(node => node.id === "review");
          if (!node || node.kind !== "agent") throw new Error("expected review agent node");
          const controller = new AbortController();
          const writeNodeProgress = vi.fn();
          agentMocks.executeAgentTurn.mockImplementation(async request => {
            controller.abort();
            request.onProgress?.({
              responseText: "late progress",
              updatedAt: "2026-07-01T00:00:00.000Z",
              summary: agentSummary(1),
            });
            return completedAgentTurn(taggedAgentOutput("{\"ok\":\"invalid\"}"));
          });

          const result = await executeAgentNodeProduction(node, {}, {
            cwd: workspace,
            runId: "run_steered",
            nodeKey: "review.dynamic",
            attemptId: "attempt_fenced",
            attemptNo: 1,
            ownerEpoch: 1,
            agents: prepared.ir.agents,
            hostPolicy: loadAgentHostPolicy(process.env),
            managedAcpExecutor: testManagedAcpExecutor(),
            progressWriter: { writeNodeProgress },
            signal: controller.signal,
            initialPrompt: { kind: "steer", instruction: "Use the smaller fix." },
          });
          expect(result.isErr() && result.error).toMatchObject({
            type: "cancelled",
            message: "Agent turn was aborted.",
          });
          expect(agentMocks.executeAgentTurn).toHaveBeenCalledOnce();
          expect(writeNodeProgress).not.toHaveBeenCalled();
        });
      });

    it("returns prompt resolution failures without rejecting the Agent boundary", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-resolution-result", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, defineWorkflow({
            name: "invalid_prompt_agent",
            agents: { reviewer: { use: "mock" } },
          }).build(({ agents, step }) => {
            step("review").agent({ agent: agents.reviewer, prompt: "review" });
            return {};
          }));
          const node = prepared.ir.root.nodes.find(node => node.id === "review");
          if (!node || node.kind !== "agent") throw new Error("expected review agent node");
          const invalid = { ...node, run: { ...node.run, prompt: { kind: "literal", value: 42 } } } as typeof node;

          const result = await executeAgentNodeProduction(invalid, {}, {
            cwd: workspace,
            agents: prepared.ir.agents,
            hostPolicy: loadAgentHostPolicy(process.env),
          });

          expect(result.isErr() && result.error).toMatchObject({
            type: "resolution",
            error: { type: "type", field: "Agent node 'review' prompt", expected: "string", actual: "number" },
          });
          expect(agentMocks.executeAgentTurn).not.toHaveBeenCalled();
        });
      });

    it("renders direct ArtifactRefs as absolute paths without rewriting nested refs", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-artifact-prompt", async workspace => {
          const worktree = join(workspace, "agent-worktree");
          await mkdir(worktree);
          const prepared = await prepareSyntheticWorkflow(workspace, defineWorkflow({
            name: "agent_artifact_prompt",
            inputSchema: z.object({ agentCwd: z.string() }),
            agents: { reviewer: { use: "mock" } },
          }).build(({ input, agents, step }) => {
            const produced = step("produce").task({
              input: null,
              exec: async ({ artifact }) => ({ patch: await artifact.write("patch.diff", "diff\n") }),
            });
            step("review").agent({
              agent: agents.reviewer,
              cwd: input.agentCwd,
              prompt: template`direct=${produced.output.patch}|uri=${produced.output.patch.uri}|nested=${produced.output}`,
            });
            return {};
          }));
          const store = await openRuntimeStore(workspace);
          try {
            const run = await admitRunForTest(store, { prepared, input: { agentCwd: worktree }, cwd: workspace });
            const runDir = store.getRunDir(run.id);
            if (!runDir) throw new Error("expected run directory");
            const artifactId = "artifact_prompt_input";
            const relativePath = join("artifacts", "produce", "attempt-1", "patch.diff");
            const artifactPath = join(runDir, relativePath);
            await mkdir(dirname(artifactPath), { recursive: true });
            await writeFile(artifactPath, "diff\n");
            const producerAttempt = ensureTestAttempt(store, run.id, "produce", "produce");
            throwSchedulerStoreResult(store.registerArtifact({
              id: artifactId,
              runId: run.id,
              nodeKey: "produce",
              attemptId: producerAttempt.attemptId,
              attempt: 1,
              ownerEpoch: producerAttempt.ownerEpoch,
              mediaType: "text/plain",
              digest: "sha256:7c4604d03f399eac32a48edbb7be1710838b70c83ad0e94b60137920945d6c40",
              size: 5,
              relativePath,
              file: tryCaptureRunFile(
                store.getRunDirectoryToken(run.id)!,
                artifactPath,
                `Artifact '${artifactId}'`,
              )._unsafeUnwrap(),
            }));
            const ref = { kind: "artifact", uri: `artifact://${run.id}/${artifactId}`, mediaType: "text/plain" } as const;
            const node = prepared.ir.root.nodes.find(item => item.id === "review");
            if (!node || node.kind !== "agent") throw new Error("expected review agent node");
            const turns: AgentTurnRequest[] = [];

            await expect(executeAgentNode(node, {
              input: { agentCwd: worktree },
              nodes: { produce: { status: "completed", output: { patch: ref } } },
            }, {
              cwd: workspace,
              runId: run.id,
              nodeKey: "review",
              attemptId: "attempt_review",
              attemptNo: 1,
              agents: prepared.ir.agents,
              store,
              executeTurn: async request => {
                turns.push(request);
                return completedAgentTurn("done");
              },
            })).resolves.toBe("done");

            expect(turns).toHaveLength(1);
            expect(turns[0]!.cwd).toBe(worktree);
            expect(turns[0]!.prompt).toBe(`direct=${artifactPath}|uri=${ref.uri}|nested=${JSON.stringify({ patch: ref })}`);
            const metadata = store.getExecutionMetadata(run.id).find(item => item.kind === "agent_attempt")?.metadata as AgentAttemptMetadata | undefined;
            expect(metadata?.turns?.[0]?.turnArtifact).toEqual({ artifactId: expect.any(String), mediaType: "application/json" });
            expect(store.listArtifacts(run.id)).toEqual(expect.arrayContaining([
              expect.objectContaining({ id: artifactId, path: artifactPath }),
            ]));
            expect(store.listArtifacts(run.id).every(item => isAbsolute(item.path) && !("relativePath" in item))).toBe(true);

            await expect(executeAgentNode(node, {
              input: { agentCwd: worktree },
              nodes: { produce: { status: "completed", output: { patch: { ...ref, uri: `artifact://run_other/${artifactId}` } } } },
            }, {
              cwd: workspace,
              runId: run.id,
              nodeKey: "review.foreign",
              attemptId: "attempt_review_foreign",
              attemptNo: 1,
              agents: prepared.ir.agents,
              store,
            })).rejects.toMatchObject({ resolution: { type: "evaluation", field: "Agent node 'review' prompt" } });
            expect(agentMocks.executeAgentTurn).toHaveBeenCalledOnce();
          } finally {
            store.close();
          }
        });
      });

    it("honors host response repair max zero for schema-backed agents", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-retry-zero", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, booleanAgentWorkflow());
          const node = prepared.ir.root.nodes.find(node => node.id === "review");
          if (!node || node.kind !== "agent") throw new Error("expected review agent node");
          const turns: AgentTurnRequest[] = [];

          await expect(withAgentResponseRepairMax("0", () => executeAgentNode(node, {}, {
            cwd: workspace,
            agents: prepared.ir.agents,
            executeTurn: async request => {
              turns.push(request);
              return completedAgentTurn("");
            },
          }))).rejects.toThrow("output_framing");
          expect(turns).toHaveLength(1);
        });
      });

    it("reads the host response repair budget once per attempt and ignores authored env overrides", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-host-repair-budget", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, hostRepairBudgetAgentWorkflow());
          const node = prepared.ir.root.nodes.find(node => node.id === "review");
          if (!node || node.kind !== "agent") throw new Error("expected review agent node");
          const store = await openRuntimeStore(workspace);
          const turns: AgentTurnRequest[] = [];
          try {
            const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
            await expect(withImmediateAgentRepairs(() => executeAgentNode(node, {}, {
              cwd: workspace,
              runId: run.id,
              nodeKey: "review.dynamic",
              attemptId: "attempt_1",
              attemptNo: 1,
              store,
              agents: prepared.ir.agents,
              hostPolicy: loadAgentHostPolicy({
                ACPUS_AGENT_RESPONSE_REPAIR_MAX: "1",
              }),
              executeTurn: async request => {
                turns.push(request);
                if (turns.length === 1) {
                  process.env.ACPUS_AGENT_RESPONSE_REPAIR_MAX = "0";
                }
                return completedAgentTurn(turns.length === 1 ? "not json" : taggedAgentOutput("{\"ok\":true}"));
              },
            }))).resolves.toEqual({ ok: true });

            expect(turns).toHaveLength(2);
            expect(turns.map(turn => turn.sessionName)).toEqual([turns[0]!.sessionName, turns[0]!.sessionName]);
            expect(turns.map(turn => turn.env.ACPUS_AGENT_RESPONSE_REPAIR_MAX)).toEqual(["0", "0"]);
            const metadata = store.getExecutionMetadata(run.id).find(entry => entry.kind === "agent_attempt")?.metadata as AgentAttemptMetadata | undefined;
            expect(metadata).toMatchObject({ responseRepairMax: 1, turnCount: 2 });
          } finally {
            store.close();
          }
        });
      });

    it("ignores an invalid host response repair value for schema-less agents", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-schema-less-repair-env", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, defineWorkflow({
            name: "schema_less_repair_env",
            agents: { reviewer: { use: "mock" } },
          }).build(({ agents, step }) => {
            step("review").agent({ agent: agents.reviewer, prompt: "review" });
            return {};
          }));
          const node = prepared.ir.root.nodes.find(node => node.id === "review");
          if (!node || node.kind !== "agent") throw new Error("expected review agent node");
          const store = await openRuntimeStore(workspace);
          try {
            const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
            await expect(withAgentResponseRepairMax("invalid", () => executeAgentNode(node, {}, {
              cwd: workspace,
              runId: run.id,
              nodeKey: "review.dynamic",
              attemptId: "attempt_1",
              attemptNo: 1,
              store,
              agents: prepared.ir.agents,
              executeTurn: async () => completedAgentTurn("plain text"),
            }))).resolves.toBe("plain text");

            const metadata = store.getExecutionMetadata(run.id).find(entry => entry.kind === "agent_attempt")?.metadata as AgentAttemptMetadata | undefined;
            expect(metadata).toMatchObject({ responseRepairMax: 0, turnCount: 1 });
          } finally {
            store.close();
          }
        });
      });

    it.each(["", " 1", "1 ", "+1", "01", "1.0", "1e1", "-1", "9007199254740992"])(
        "rejects non-canonical host response repair max %j before calling the provider",
        async value => {
          await withRuntimeWorkspace("scheduler-node-executor-agent-invalid-repair-env", async workspace => {
            const prepared = await prepareSyntheticWorkflow(workspace, booleanAgentWorkflow());
            const node = prepared.ir.root.nodes.find(node => node.id === "review");
            if (!node || node.kind !== "agent") throw new Error("expected review agent node");
            const executeTurn = vi.fn(async () => completedAgentTurn(taggedAgentOutput("{\"ok\":true}")));

            await expect(withAgentResponseRepairMax(value, () => executeAgentNode(node, {}, {
              cwd: workspace,
              agents: prepared.ir.agents,
              executeTurn,
            }))).rejects.toMatchObject({
              failure: {
                origin: "runtime",
                code: "invalid_agent_response_repair_max",
                message: expect.stringContaining("canonical non-negative decimal safe integer"),
              },
            });
            expect(executeTurn).not.toHaveBeenCalled();
          });
        },
      );

    it("persists invalid host response repair configuration as a runtime attempt failure", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-invalid-repair-metadata", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, booleanAgentWorkflow());
          const store = await openRuntimeStore(workspace);
          const executeTurn = vi.fn(async () => completedAgentTurn(taggedAgentOutput("{\"ok\":true}")));
          try {
            const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
            await expect(withAgentResponseRepairMax("01", () => advanceFrozenRun({
              cwd: workspace,
              runId: run.id,
              ownerId: "owner-a",
              store,
              executeAgentTurn: executeTurn,
            }))).resolves.toMatchObject({ status: "failed", started: 1, failed: 1 });

            expect(executeTurn).not.toHaveBeenCalled();
            expect(Object.values(throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection.attempts)[0]).toMatchObject({
              status: "failed",
              terminalReason: "invalid_agent_response_repair_max",
              error: {
                origin: "runtime",
                code: "invalid_agent_response_repair_max",
                message: expect.stringContaining("before starting the Acpus daemon"),
              },
            });
            const metadata = store.getExecutionMetadata(run.id).find(entry => entry.kind === "agent_attempt")?.metadata as AgentAttemptMetadata | undefined;
            expect(metadata).toMatchObject({ status: "failed", responseRepairMax: null, turnCount: 0, turns: [] });
          } finally {
            store.close();
          }
        });
      });

    it("does not spend response repair budget on backend failures", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-backend-no-repair", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, booleanAgentWorkflow());
          const node = prepared.ir.root.nodes.find(node => node.id === "review");
          if (!node || node.kind !== "agent") throw new Error("expected review agent node");
          const executeTurn = vi.fn(async (): Promise<AgentTurnResult> => ({
            status: "failed",
            failure: { kind: "provider_exit", message: "backend unavailable" },
            responseText: "",
            stderr: "",
            summary: agentSummary(0),
            timing: agentTiming(),
          }));

          await expect(withAgentResponseRepairMax("10", () => executeAgentNode(node, {}, {
            cwd: workspace,
            agents: prepared.ir.agents,
            executeTurn,
          }))).rejects.toMatchObject({ failure: { origin: "provider", code: "provider_exit" } });
          expect(executeTurn).toHaveBeenCalledOnce();
      });
    });

    it("persists ACP inactivity as a retryable runtime failure with evidence", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-acp-inactivity", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, booleanAgentWorkflow());
          const store = await openRuntimeStore(workspace);
          const attempts: unknown[] = [];
          const managedAcpExecutor: ManagedAcpExecutor = {
            withAttempt: async (input, use) => {
              attempts.push(input);
              return use({
                runTurn: async () => ({
                  status: "failed",
                  failure: {
                    kind: "inactivity_stale",
                    origin: "runtime",
                    retryable: true,
                    message: "ACP agent was silent for the configured inactivity limit.",
                    evidence: {
                      failAfterMs: 60_000,
                      silentForMs: 60_000,
                      silenceStartedAt: "2026-07-30T00:00:00.000Z",
                    },
                  },
                  responseText: "",
                  stderr: "",
                  summary: agentSummary(0),
                  timing: agentTiming(),
                }),
              });
            },
            shutdown: async () => {},
          };
          try {
            const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });

            await expect(advanceFrozenRun({
              cwd: workspace,
              runId: run.id,
              ownerId: "owner-a",
              store,
              agentHostPolicy: loadAgentHostPolicy({}, 60_000),
              managedAcpExecutor,
            })).resolves.toMatchObject({ status: "failed", started: 1, failed: 1 });

            expect(attempts).toEqual([expect.objectContaining({ runId: run.id, inactivityFailAfterMs: 60_000 })]);
            expect(Object.values(throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection.attempts)[0]).toMatchObject({
              status: "failed",
              terminalReason: "agent_acp_inactivity_stale",
              error: {
                origin: "runtime",
                code: "agent_acp_inactivity_stale",
                retryable: true,
                evidence: {
                  failAfterMs: 60_000,
                  silentForMs: 60_000,
                  silenceStartedAt: "2026-07-30T00:00:00.000Z",
                },
              },
            });
          } finally {
            store.close();
          }
        });
      });

    it("resolves agent timeout and prompt once per attempt and records the host repair budget", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-dynamic-config", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, dynamicAgentConfigWorkflow());
          const store = await openRuntimeStore(workspace);
          globalThis.__acpusPromptResolutionCount = 0;
          globalThis.__acpusTimeoutResolutionCount = 0;
          const now = new Date();
          try {
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(now);
            const run = await admitRunForTest(store, { prepared, input: { timeout: "5s", prompt: "dynamic review" }, cwd: workspace });
            const turns: AgentTurnRequest[] = [];
            const hookContexts: HookContext[] = [];
            const hookRunner: HookRunner = {
              trigger(_event, context) { hookContexts.push(context); },
              async drain() {},
              activeCount() { return 0; },
            };

            await expect(withAgentResponseRepairMax("0", () => advanceFrozenRun({
              cwd: workspace,
              runId: run.id,
              ownerId: "owner-a",
              store,
              hookRunner,
              executeAgentTurn: async request => {
                turns.push(request);
                return completedAgentTurn(taggedAgentOutput("{\"ok\":true}"));
              },
            }))).resolves.toMatchObject({ status: "completed", completed: 1 });

            expect(turns[0]?.prompt).toContain("dynamic review");
            expect(globalThis.__acpusPromptResolutionCount).toBe(1);
            expect(globalThis.__acpusTimeoutResolutionCount).toBe(1);
            expect(turns[0]?.timeoutMs).toBeGreaterThan(0);
            expect(turns[0]?.timeoutMs).toBeLessThanOrEqual(5_000);
            expect(runtimeRow(workspace, "SELECT deadline_at FROM node_attempts WHERE run_id = ?", run.id)).toMatchObject({
              deadline_at: new Date(now.getTime() + 5_000).toISOString(),
            });
            const metadata = store.getRun(run.id)?.dynamic?.executionMetadata.find(entry => entry.kind === "agent_attempt")?.metadata;
            expect(metadata).toMatchObject({
              responseRepairMax: 0,
              deadlineAt: new Date(now.getTime() + 5_000).toISOString(),
            });
            expect(metadata).not.toHaveProperty("renderedPrompt");
            const turnArtifact = store.listArtifacts(run.id).find(artifact => artifact.path.endsWith("/turn-001.json"));
            expect(turnArtifact).toBeDefined();
            expect(await readJsonFile(turnArtifact!.path)).toMatchObject({ prompt: turns[0]!.prompt });
            expect(hookContexts.find(context => context.event === "node.completed")?.node).toMatchObject({
              id: "review",
              agentPrompt: turns[0]!.prompt,
            });
          } finally {
            vi.useRealTimers();
            globalThis.__acpusPromptResolutionCount = undefined;
            globalThis.__acpusTimeoutResolutionCount = undefined;
            store.close();
          }
        });
      });

    it("passes a persisted agent deadline as exact remaining milliseconds", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-timeout-bridge", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, timeoutAgentWorkflow());
          const node = prepared.ir.root.nodes.find(node => node.id === "review");
          if (!node || node.kind !== "agent") throw new Error("expected review agent node");
          const turns: AgentTurnRequest[] = [];
          const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_000);

          try {
            await expect(executeAgentNode(node, {}, {
              cwd: workspace,
              agents: prepared.ir.agents,
              deadlineAt: new Date(6_000).toISOString(),
              executeTurn: async request => {
                turns.push(request);
                return completedAgentTurn(taggedAgentOutput("{\"ok\":true}"));
              },
            })).resolves.toEqual({ ok: true });

            expect(turns).toHaveLength(1);
            expect(turns[0]?.timeoutMs).toBe(5_000);
          } finally {
            dateNow.mockRestore();
          }
        });
      });

    it.each(["not-a-deadline", "+010000-01-01T00:00:00.000Z"])(
        "rejects invalid persisted agent deadline %j before executing a turn",
        async deadlineAt => {
          await withRuntimeWorkspace("scheduler-node-executor-agent-invalid-deadline", async workspace => {
            const prepared = await prepareSyntheticWorkflow(workspace, timeoutAgentWorkflow());
            const node = prepared.ir.root.nodes.find(node => node.id === "review");
            if (!node || node.kind !== "agent") throw new Error("expected review agent node");
            const executeTurn = vi.fn(async () => completedAgentTurn(taggedAgentOutput("{\"ok\":true}")));

            await expect(executeAgentNode(node, {}, {
              cwd: workspace,
              agents: prepared.ir.agents,
              deadlineAt,
              executeTurn,
            })).rejects.toThrow(`Agent node 'review' has invalid persisted deadline ${JSON.stringify(deadlineAt)}.`);

            expect(executeTurn).not.toHaveBeenCalled();
          });
        },
      );

    it("maps agent turn timeout to scheduler timed_out result", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-timeout", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, timeoutAgentWorkflow());
          const store = await openRuntimeStore(workspace);
          try {
            const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
            const executor = createRuntimeNodeExecutor({
              cwd: workspace,
              ir: prepared.ir,
              scope: {},
              store,
              executeAgentTurn: async () => ({
                status: "failed",
                failure: { kind: "timeout", message: "Agent turn timed out after 5ms." },
                responseText: "",
                stderr: "",
                summary: agentSummary(0),
                timing: agentTiming(),
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
              reason: "timeout",
              error: {
                origin: "provider",
                code: "timeout",
                message: "Agent turn timed out after 5ms.",
              },
            });
            const metadata = store.getRun(run.id)?.dynamic?.executionMetadata.find(entry => entry.kind === "agent_attempt")?.metadata as AgentAttemptMetadata | undefined;
            expect(metadata).toMatchObject({
              status: "timed_out",
              turnCount: 1,
              turns: [expect.objectContaining({ status: "failed", failure: { kind: "timeout", message: "Agent turn timed out after 5ms." } })],
            });
            const turn = store.listArtifacts(run.id).find(artifact => /turn-001\.json$/.test(artifact.path));
            expect(turn).toBeDefined();
            await expect(readJsonFile(turn!.path)).resolves.toMatchObject({
              schemaVersion: 1,
              status: "failed",
              prompt: expect.stringContaining("# RESULT HANDOFF [MANDATORY]"),
              response: "",
              summary: agentSummary(0),
              timing: agentTiming(),
              failure: { kind: "timeout", message: "Agent turn timed out after 5ms." },
            });
          } finally {
            store.close();
          }
        });
      });

    it("drops a partial response when abort wins before response repair", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-repair-delay-abort", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, retryingAgentWorkflow());
          const store = await openRuntimeStore(workspace);
          const controller = new AbortController();
          const turns: AgentTurnRequest[] = [];
          try {
            const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
            const executor = createRuntimeNodeExecutor({
              cwd: workspace,
              ir: prepared.ir,
              scope: {},
              store,
              executeAgentTurn: async request => {
                turns.push(request);
                queueMicrotask(() => controller.abort());
                return completedAgentTurn(taggedAgentOutput("{\"attempt\":1}"));
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
              message: "Agent turn was aborted.",
              turns: [expect.objectContaining({ turn: 1, status: "completed" })],
            });
            expect(store.listArtifacts(run.id).some(artifact => /turn-001\.json$/.test(artifact.path))).toBe(false);
          } finally {
            store.close();
          }
        });
      });
    });

    describe("session, retry, timeout, and cancellation", () => {
    it("cancels active agent turns on pause and removes unfenced partial artifacts", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-active-pause-artifacts", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, retryingAgentWorkflow());
          const store = await openRuntimeStore(workspace);
          const turns: AgentTurnRequest[] = [];
          const wakeup = createVersionedWakeup();
          let cooperativeAbort = false;
          try {
            const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
            const nodeKey = deriveInstanceKey(appendNode([], "review"));

            await expect(advanceFrozenRun({
              cwd: workspace,
              runId: run.id,
              ownerId: "owner-a",
              store,
              wakeup,
              executeAgentTurn: async request => {
                turns.push(request);
                request.onObservation?.(agentObservation(0, "partial response\n", "partial response\n"));
                setTimeout(() => {
                  throwingSchedulerStore(store.scheduler).pauseRun({
                    runId: run.id,
                    ownerEpoch: 1,
                    idempotencyKey: "pause-active-agent",
                  });
                  wakeup.wake();
                }, 0);
                return new Promise(resolve => {
                  request.signal?.addEventListener("abort", () => {
                    cooperativeAbort = true;
                    resolve({
                      status: "cancelled",
                      message: "paused by operator",
                      responseText: "partial response\n",
                      stderr: "partial stderr\n",
                      summary: agentSummary(1),
                      timing: agentTiming(),
                    });
                  }, { once: true });
                });
              },
            })).resolves.toMatchObject({ status: "paused", started: 1, cancelled: 1 });

            expect(cooperativeAbort).toBe(true);
            expect(turns).toHaveLength(1);
            expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection.instances[nodeKey]).toMatchObject({ status: "ready", statusReason: "paused" });

            const artifactRows = runtimeRows(workspace, "SELECT id, media_type, relative_path FROM artifacts WHERE run_id = ? AND node_key = ? ORDER BY relative_path", run.id, nodeKey) as RuntimeArtifactRow[];
            expect(artifactRows).toEqual([]);
            const runDir = store.getRunDir(run.id);
            if (!runDir) throw new Error("expected run dir");
            const files = await readdir(runDir, { recursive: true });
            expect(files.some(path => path.endsWith("/turn-001.json"))).toBe(false);
            expect(files.some(path => path.endsWith("/turn-001.stderr.log"))).toBe(false);

            const metadata = store.getRun(run.id)?.dynamic?.executionMetadata.find(entry => entry.kind === "agent_attempt")?.metadata as AgentAttemptMetadata | undefined;
            expect(metadata).toMatchObject({
              status: "cancelled",
              turnCount: 1,
              message: "paused by operator",
              turns: [expect.objectContaining({ turn: 1, status: "cancelled" })],
            });
            expect(runtimeRow(
              workspace,
              `SELECT state, fence_reason, provider_status
               FROM agent_observation_turns
               WHERE run_id = ? AND attempt_id = ? AND turn_no = 1`,
              run.id,
              Object.values(throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection.attempts)
                .find(attempt => attempt.attemptNo === 1)?.attemptId ?? "",
            )).toMatchObject({
              state: "settled",
              fence_reason: "runtime_abort",
              provider_status: "cancelled",
            });

            const claim = store.scheduler.claimRun(run.id, "resume-owner", 60_000);
            if (!claim) throw new Error("expected resume claim");
            throwingSchedulerStore(store.scheduler).resumeRun({
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
                return completedAgentTurn(taggedAgentOutput("{\"attempt\":\"2\"}"));
              },
            })).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });

            expect(turns).toHaveLength(2);
            expect(turns[1]!.sessionName).toBe(turns[0]!.sessionName);
            expect(turns[1]!.config).toBeUndefined();
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

    it("persists empty sessionKey as a constraint-tagged attempt failure", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-setup-failure-metadata", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, blankSessionAgentWorkflow());
          const store = await openRuntimeStore(workspace);
          try {
            const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
            await expect(advanceFrozenRun({
              cwd: workspace,
              runId: run.id,
              ownerId: "owner-a",
              store,
              executeAgentTurn: async () => {
                throw new Error("agent turn must not start");
              },
            })).resolves.toMatchObject({ status: "failed", started: 1, failed: 1 });

            const projection = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection;
            expect(Object.values(projection.attempts)[0]).toMatchObject({
              status: "failed",
              terminalReason: "expression_resolution_failed",
              error: {
                reason: "expression_resolution_failed",
                type: "constraint",
                field: "Agent node 'review' sessionKey",
                expected: "non-empty string",
              },
            });

            const entry = store.getRun(run.id)?.dynamic?.executionMetadata.find(entry => entry.kind === "agent_attempt");
            expect(entry?.attemptId).toBe(Object.values(projection.attempts)[0]?.attemptId);
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

    it("aggregates a recognized Agent failure with terminal metadata persistence failure", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-metadata-failure", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, blankSessionAgentWorkflow());
          const store = await openRuntimeStore(workspace);
          const metadataFailure = new Error("metadata store unavailable");
          try {
            const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
            const writeMetadata = vi.spyOn(store, "writeExecutionMetadata").mockImplementation(() => { throw metadataFailure; });
            const rejected = await advanceFrozenRun({
              cwd: workspace,
              runId: run.id,
              ownerId: "owner-a",
              store,
              executeAgentTurn: async () => { throw new Error("agent turn must not start"); },
            }).catch(error => error as unknown);

            expect(writeMetadata).toHaveBeenCalledOnce();
            expect(rejected).toBeInstanceOf(AggregateError);
            expect((rejected as AggregateError).errors[0]).toMatchObject({
              type: "resolution",
              message: "Agent node 'review' sessionKey must render to a non-empty string.",
            });
            expect((rejected as AggregateError).errors[1]).toBe(metadataFailure);
            expect(store.getExecutionMetadata(run.id)).toEqual([]);
          } finally {
            store.close();
          }
        });
      });

    it("aggregates a recognized Agent failure with terminal progress persistence failure", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-progress-failure", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, retryingAgentWorkflow());
          const node = prepared.ir.root.nodes.find(node => node.id === "review");
          if (!node || node.kind !== "agent") throw new Error("expected review agent node");
          const progressFailure = new Error("progress store unavailable");
          const writeNodeProgress = vi.fn(() => {
            throw progressFailure;
          });
          agentMocks.executeAgentTurn.mockResolvedValue({
            status: "failed",
            failure: { kind: "provider_exit", message: "provider unavailable" },
            responseText: "partial",
            stderr: "",
            summary: agentSummary(1),
            timing: agentTiming(),
          });

          let rejected: unknown;
          try {
            await executeAgentNodeProduction(node, {}, {
              cwd: workspace,
              runId: "run_1",
              nodeKey: "review.dynamic",
              attemptId: "attempt_1",
              attemptNo: 1,
              ownerEpoch: 1,
              agents: prepared.ir.agents,
              hostPolicy: loadAgentHostPolicy(process.env),
              managedAcpExecutor: testManagedAcpExecutor(),
              progressWriter: { writeNodeProgress },
            });
          } catch (error) {
            rejected = error;
          }

          expect(writeNodeProgress).toHaveBeenCalledOnce();
          expect(rejected).toBeInstanceOf(AggregateError);
          expect((rejected as AggregateError).errors[0]).toMatchObject({
            type: "failed",
            failure: { code: "provider_exit", message: "provider unavailable" },
          });
          expect((rejected as AggregateError).errors[1]).toBe(progressFailure);
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
            const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });

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
                  return completedAgentTurn(taggedAgentOutput("{\"ok\":true}"));
                },
              });
            }

            expect(turns).toHaveLength(2);
            expect(turns[1]!.sessionName).toBe(turns[0]!.sessionName);
            const secondRun = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
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
                return completedAgentTurn(taggedAgentOutput("{\"ok\":true}"));
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
              executeTurn: async () => completedAgentTurn(taggedAgentOutput("{\"runId\":null,\"nodeId\":\"inspect_agent\",\"nodeKey\":null,\"schedulerAttempt\":null}")),
            })).resolves.toMatchObject({ nodeId: "inspect_agent" });
          } finally {
            restoreEnv("ACPUS_AGENT_PROVIDER_COMMANDS", previous);
          }
        });
      });

    it("does not turn agent response repair into scheduler-visible retry", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-no-agent-scheduler-retry", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, retryingAgentWorkflow());
          const store = await openRuntimeStore(workspace);
          const turns: AgentTurnRequest[] = [];
          try {
            const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
            const nodeKey = deriveInstanceKey(appendNode([], "review"));

            await expect(withAgentResponseRepairMax(undefined, () => withImmediateAgentRepairs(() => advanceFrozenRun({
              cwd: workspace,
              runId: run.id,
              ownerId: "owner-a",
              store,
              executeAgentTurn: async request => {
                turns.push(request);
                return completedAgentTurn(taggedAgentOutput("{\"attempt\":1}"));
              },
            })))).resolves.toMatchObject({ status: "failed", started: 1, failed: 1 });

            expect(turns).toHaveLength(3);
            expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection.instances[nodeKey]).toMatchObject({ status: "failed" });
            expect(Object.values(throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).projection.attempts).filter(attempt => attempt.nodeKey === nodeKey).map(attempt => attempt.status)).toEqual(["failed"]);
            const metadata = store.getRun(run.id)?.dynamic?.executionMetadata.find(entry => entry.kind === "agent_attempt")?.metadata as AgentAttemptMetadata | undefined;
            expect(metadata).toMatchObject({
              status: "failed",
              responseRepairMax: 2,
              turnCount: 3,
              turns: [
                expect.objectContaining({ status: "completed", failure: { kind: "output_conformance", message: expect.any(String) } }),
                expect.objectContaining({ status: "completed", failure: { kind: "output_conformance", message: expect.any(String) } }),
                expect.objectContaining({ status: "completed", failure: { kind: "output_conformance", message: expect.any(String) } }),
              ],
            });
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
            const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
            const nodeKey = deriveInstanceKey(appendNode([], "review"));

            await expect(withAgentResponseRepairMax("2", () => withImmediateAgentRepairs(() => advanceFrozenRun({
              cwd: workspace,
              runId: run.id,
              ownerId: "owner-a",
              store,
              executeAgentTurn: async request => {
                turns.push(request);
                return completedAgentTurn(taggedAgentOutput("{\"ok\":\"not boolean\"}"));
              },
            })))).resolves.toMatchObject({ status: "failed", started: 1, failed: 1 });

            const claim = store.scheduler.claimRun(run.id, "retry-owner", 60_000);
            if (!claim) throw new Error("expected retry claim");
            throwingSchedulerStore(store.scheduler).retry({
              runId: run.id,
              target: nodeKey,
              ownerEpoch: claim.ownerEpoch,
              idempotencyKey: "manual-agent-retry",
            });
            store.scheduler.releaseRun(claim);

            await expect(withAgentResponseRepairMax("0", () => advanceFrozenRun({
              cwd: workspace,
              runId: run.id,
              ownerId: "owner-b",
              store,
              executeAgentTurn: async request => {
                turns.push(request);
                return completedAgentTurn(taggedAgentOutput("{\"attempt\":\"4\"}"));
              },
            }))).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });

            expect(turns).toHaveLength(4);
            expect(turns[3]!.sessionName).toBe(turns[0]!.sessionName);
            expect(turns[3]!.config).toBeUndefined();
            expect(turns[3]!.prompt).not.toBe(turns[0]!.prompt);
            expect(turns[3]!.prompt).toContain("<ACPUS_OUTPUT>");
            const metadata = store.getRun(run.id)?.dynamic?.executionMetadata.filter(entry => entry.kind === "agent_attempt").map(entry => entry.metadata) as AgentAttemptMetadata[] | undefined;
            expect(metadata).toEqual([
              expect.objectContaining({ status: "failed", sessionName: turns[0]!.sessionName, responseRepairMax: 2, turnCount: 3 }),
              expect.objectContaining({ status: "completed", sessionName: turns[0]!.sessionName, responseRepairMax: 0, turnCount: 1 }),
            ]);
            const continuation = runtimeRows(
              workspace,
              `SELECT prompt_kind, state, provider_status
               FROM agent_observation_turns
               WHERE run_id = ?
               ORDER BY attempt_no, turn_no`,
              run.id,
            ).at(-1);
            expect(continuation).toEqual({
              prompt_kind: "continuation",
              state: "settled",
              provider_status: "completed",
            });
            const runDir = store.getRunDir(run.id);
            if (!runDir) throw new Error("expected run directory");
            await expect(readdir(runDir)).resolves.not.toContain("evidence");
          } finally {
            store.close();
          }
        });
      });

    it("uses the task prompt again for run-level retry of a failed agent run", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-run-retry-task-prompt", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, booleanAgentWorkflow());
          const store = await openRuntimeStore(workspace);
          const turns: AgentTurnRequest[] = [];
          try {
            const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });

            await expect(withAgentResponseRepairMax("0", () => advanceFrozenRun({
              cwd: workspace,
              runId: run.id,
              ownerId: "owner-a",
              store,
              executeAgentTurn: async request => {
                turns.push(request);
                return completedAgentTurn(taggedAgentOutput("{\"ok\":\"not boolean\"}"));
              },
            }))).resolves.toMatchObject({ status: "failed", started: 1, failed: 1 });

            const claim = store.scheduler.claimRun(run.id, "retry-run-owner", 60_000);
            if (!claim) throw new Error("expected run retry claim");
            throwingSchedulerStore(store.scheduler).retryRun({
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
                return completedAgentTurn(taggedAgentOutput("{\"ok\":true}"));
              },
            })).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });

            expect(turns).toHaveLength(2);
            expect(turns[1]!.prompt).toBe(turns[0]!.prompt);
          } finally {
            store.close();
          }
        });
      });
    });
});

function retryingAgentWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-agent-retry",
    agents: {
      reviewer: {
        command: "custom-acp-server",
        model: "default-model",
        config: { effort: "high", mode: "agent", model: "profile-model" },
      },
    },
  }).build(({ agents, step }) => {
    step("review").agent({
      outputSchema: z.object({ attempt: z.string() }),
      agent: agents.reviewer, prompt: "review",
    });
    return {};
  });
}

function hostRepairBudgetAgentWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-agent-host-repair-budget",
    agents: {
      reviewer: { use: "codex", env: { ACPUS_AGENT_RESPONSE_REPAIR_MAX: "0" } },
    },
  }).build(({ agents, step }) => {
    step("review").agent({
      outputSchema: z.object({ ok: z.boolean() }),
      agent: agents.reviewer,
      prompt: "review",
      env: { ACPUS_AGENT_RESPONSE_REPAIR_MAX: "0" },
    });
    return {};
  });
}

function scalarAgentOutputWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-agent-scalar-output",
    agents: {
      reviewer: { use: "codex" },
    },
  }).build(({ agents, step }) => {
    const result = step("review").agent({
      outputSchema: z.string(),
      agent: agents.reviewer,
      prompt: "review",
    });
    return result.output;
  });
}

function booleanAgentWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-agent-boolean-output",
    agents: {
      reviewer: { use: "codex" },
    },
  }).build(({ agents, step }) => {
    step("review").agent({
      outputSchema: z.object({ ok: z.boolean() }),
      agent: agents.reviewer, prompt: "review",
    });
    return {};
  });
}

function dynamicAgentConfigWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-agent-dynamic-config",
    inputSchema: z.object({ timeout: z.string(), prompt: z.string() }),
    agents: {
      reviewer: { use: "codex" },
    },
  }).build(({ input, agents, step }) => {
    step("review").agent({
      outputSchema: z.object({ ok: z.boolean() }),
      timeout: lift(input.timeout, value => {
        globalThis.__acpusTimeoutResolutionCount = (globalThis.__acpusTimeoutResolutionCount ?? 0) + 1;
        return value;
      }),
      agent: agents.reviewer, prompt: lift(input.prompt, value => {
             globalThis.__acpusPromptResolutionCount = (globalThis.__acpusPromptResolutionCount ?? 0) + 1;
             return value;
           }),
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
      agent: agents.inspector, prompt: "inspect",
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
      agent: agents.reviewer, prompt: "review",
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
      agent: agents.reviewer, prompt: "review", sessionKey: "shared-session",
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
      agent: agents.reviewer, prompt: "review", sessionKey: "",
    });
    return {};
  });
}

function agentObservation(sequence: number, content: string, responseText: string): AgentTurnObservation {
  const observedAt = `2026-07-01T00:00:0${sequence}.000Z`;
  return {
    event: {
      schemaVersion: 1,
      sequence,
      observedAt,
      elapsedMs: sequence,
      type: "message",
      channel: "assistant",
      content,
    },
    progress: {
      responseText,
      summary: agentSummary(sequence + 1),
      updatedAt: observedAt,
    },
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
  responseRepairMax?: number | null;
  turnCount?: number;
  turns?: Array<Record<string, any>>;
  message?: string;
};

function expectAgentArtifactRef(ref: unknown, relativePath: string, mediaType: string, rows: RuntimeArtifactRow[]): void {
  const row = rows.find(row => row.relative_path === relativePath);
  expect(row).toBeDefined();
  expect(ref).toEqual({
    artifactId: row?.id,
    mediaType,
  });
}

async function withImmediateAgentRepairs<T>(operation: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
    void operation().then(
      value => { outcome = { ok: true, value }; },
      error => { outcome = { ok: false, error }; },
    );
    while (!outcome) {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (vi.getTimerCount() > 0) await vi.runOnlyPendingTimersAsync();
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  } finally {
    vi.useRealTimers();
  }
}

async function withAgentResponseRepairMax<T>(value: string | undefined, operation: () => Promise<T>): Promise<T> {
  const previous = process.env.ACPUS_AGENT_RESPONSE_REPAIR_MAX;
  restoreEnv("ACPUS_AGENT_RESPONSE_REPAIR_MAX", value);
  try {
    return await operation();
  } finally {
    restoreEnv("ACPUS_AGENT_RESPONSE_REPAIR_MAX", previous);
  }
}

function startReviewAttempt(store: RuntimeStore, runId: string, idempotencyPrefix: string) {
  const claim = store.scheduler.claimRun(runId, `${idempotencyPrefix}-owner`, 60_000);
  if (!claim) throw new Error("expected run claim");
  const snapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId);
  throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
    runId,
    expectedVersion: snapshot.version,
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey: `${idempotencyPrefix}:ready`,
    events: [
      rootFrameStarted(runId, "review", "review.dynamic"),
      {
        type: "instance.ready",
        payload: {
          runId,
          nodeKey: "review.dynamic",
          nodeId: "review",
          instancePath: [{ kind: "node", nodeId: "review" }],
          parentFrameKey: "root",
          readinessSequence: 1,
        },
      },
    ],
  });
  const attempt = throwingSchedulerStore(store.scheduler).startAttempt({
    runId,
    nodeKey: "review.dynamic",
    nodeId: "review",
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey: `${idempotencyPrefix}:attempt`,
  });
  return { attempt, ownerEpoch: claim.ownerEpoch };
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
