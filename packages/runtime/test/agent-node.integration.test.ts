import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { defineWorkflow, z } from "@acpus/core";
import type { AgentTurnRequest, AgentTurnResult } from "@acpus/agent-executor";
import { lift, template } from "@acpus/expression";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendNode, deriveInstanceKey } from "../src/scheduler/identity.js";
import { createRuntimeNodeExecutor as createRuntimeNodeExecutorProduction, type RuntimeNodeExecutorInput } from "../src/scheduler/node-executor.js";
import { advanceFrozenRun as advanceFrozenRunProduction, type AdvanceFrozenRunInput } from "../src/scheduler/runtime-runner.js";
import { executeAgentNode as executeAgentNodeProduction } from "../src/execution/agent-node.js";
import { openRuntimeStore, type RuntimeStore } from "../src/store/store.js";
import { prepareSyntheticWorkflow, runtimeRow, runtimeRows, withRuntimeWorkspace } from "./support/runtime-fixtures.js";
import { throwingSchedulerStore } from "./support/scheduler-store.js";
import { loadAgentHostPolicy, type AgentHostPolicy } from "../src/configuration.js";
import type { HookContext } from "../src/hooks/context.js";
import type { HookRunner } from "../src/hooks/runner.js";
import { agentSummary, agentTiming, completedAgentTurn } from "./support/agent-turn.js";
import { listArtifacts as listRunArtifacts } from "../src/runs/use-cases.js";

const agentMocks = vi.hoisted(() => ({
  executeAgentTurn: vi.fn<(request: AgentTurnRequest) => Promise<AgentTurnResult>>(),
}));
vi.mock("@acpus/agent-executor", async importOriginal => ({
  ...await importOriginal<typeof import("@acpus/agent-executor")>(),
  executeAgentTurn: agentMocks.executeAgentTurn,
}));
declare global {
  var __acpusPromptResolutionCount: number | undefined;
  var __acpusTimeoutResolutionCount: number | undefined;
}
const initialResponseRepairMax = process.env.ACPUS_AGENT_RESPONSE_REPAIR_MAX;
beforeEach(() => {
  restoreEnv("ACPUS_AGENT_RESPONSE_REPAIR_MAX", undefined);
  agentMocks.executeAgentTurn.mockReset();
  vi.useRealTimers();
});
afterEach(() => {
  restoreEnv("ACPUS_AGENT_RESPONSE_REPAIR_MAX", initialResponseRepairMax);
});
function advanceFrozenRun(input: AdvanceFrozenRunInput & { executeAgentTurn?: (request: AgentTurnRequest) => Promise<AgentTurnResult> }) {
  const { executeAgentTurn, ...productionInput } = input;
  if (executeAgentTurn) agentMocks.executeAgentTurn.mockImplementation(executeAgentTurn);
  return advanceFrozenRunProduction(productionInput);
}
type TestAgentExecutorOptions = Omit<Parameters<typeof executeAgentNodeProduction>[2], "hostPolicy"> & {
  hostPolicy?: AgentHostPolicy;
  executeTurn?: (request: AgentTurnRequest) => Promise<AgentTurnResult>;
};
function executeAgentNode(node: Parameters<typeof executeAgentNodeProduction>[0], scope: Parameters<typeof executeAgentNodeProduction>[1], options: TestAgentExecutorOptions) {
  const { executeTurn, hostPolicy = loadAgentHostPolicy(process.env), ...productionOptions } = options;
  if (executeTurn) agentMocks.executeAgentTurn.mockImplementation(executeTurn);
  return executeAgentNodeProduction(node, scope, { ...productionOptions, hostPolicy });
}
type TestRuntimeNodeExecutorInput = Omit<RuntimeNodeExecutorInput, "agentHostPolicy"> & { agentHostPolicy?: AgentHostPolicy; executeAgentTurn?: (request: AgentTurnRequest) => Promise<AgentTurnResult> };
function createRuntimeNodeExecutor(input: TestRuntimeNodeExecutorInput) {
  const { executeAgentTurn, agentHostPolicy = loadAgentHostPolicy(process.env), ...productionInput } = input;
  if (executeAgentTurn) agentMocks.executeAgentTurn.mockImplementation(executeAgentTurn);
  return createRuntimeNodeExecutorProduction({ ...productionInput, agentHostPolicy });
}

describe("agent node execution", () => {
    describe("scheduler-backed progress", () => {
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
              executeAgentTurn: async request => {
                turns.push(request);
                return completedAgentTurn(
                  turns.length === 1 ? "{\"attempt\":1,\"extra\":\"drop\"}" : "{\"attempt\":\"2\",\"extra\":\"drop\"}",
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
            expect(turns.map(turn => turn.sessionName)).toEqual([turns[0]!.sessionName, turns[0]!.sessionName]);
            expect(turns[0]).toMatchObject({ agent: { kind: "command" }, permissionMode: "approve-all" });
            expect(turns[0]!.agentMode).toBe("agent");
            expect(turns[1]!.agentMode).toBeUndefined();
            expect(turns[1]!.prompt).toContain("Continue the previous task from where you left off.");
            expect(turns[1]!.prompt).toContain("# OUTPUT SCHEMA");
            const artifactRows = runtimeRows(workspace, "SELECT id, media_type, relative_path FROM artifacts WHERE run_id = ? AND node_key = ? ORDER BY relative_path", run.id, "review.dynamic") as RuntimeArtifactRow[];
            expect(artifactRows).toEqual([
              expect.objectContaining({ media_type: "application/json", relative_path: "artifacts/review.dynamic/attempt-1/agent/turn-001.json" }),
              expect.objectContaining({ media_type: "application/json", relative_path: "artifacts/review.dynamic/attempt-1/agent/turn-002.json" }),
              expect.objectContaining({ media_type: "text/plain", relative_path: "artifacts/review.dynamic/attempt-1/agent/turn-002.stderr.log" }),
            ]);
            expect(artifactRows.some(row => row.relative_path.endsWith(".trace.jsonl"))).toBe(false);
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
                  failure: expect.objectContaining({ kind: "output_conformance" }),
                  outputProcessing: { recovery: "direct", conformance: "rejected", projectionChanged: true },
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
                  outputProcessing: { recovery: "direct", conformance: "accepted", projectionChanged: true },
                }),
              ],
            });
            expect(JSON.stringify(metadata)).not.toContain(turns[0]!.prompt);
            expect(JSON.stringify(metadata)).not.toContain("{\"attempt\":1,\"extra\":\"drop\"}");
            expect(JSON.stringify(metadata)).not.toContain("tool-1");
            expect(JSON.stringify(metadata)).not.toContain("README.md");
            expect(JSON.stringify(metadata)).not.toContain("\"timing\"");
            expectAgentArtifactRef(metadata?.turns?.[0]?.turnArtifact, "artifacts/review.dynamic/attempt-1/agent/turn-001.json", "application/json", artifactRows);
            expectAgentArtifactRef(metadata?.turns?.[1]?.stderrArtifact, "artifacts/review.dynamic/attempt-1/agent/turn-002.stderr.log", "text/plain", artifactRows);
            const runDir = store.getRunDir(run.id);
            if (!runDir) throw new Error("expected run dir");
            const turnArtifact = await readJsonFile(join(workspace, runDir, "artifacts/review.dynamic/attempt-1/agent/turn-001.json"));
            expect(turnArtifact).toMatchObject({
              schemaVersion: 1,
              runId: run.id,
              nodeId: "review",
              nodeKey: "review.dynamic",
              attemptNo: 1,
              turn: 1,
              agentKey: "reviewer",
              sessionName: turns[0]!.sessionName,
              status: "completed",
              timing: agentTiming(),
              prompt: turns[0]!.prompt,
              response: "{\"attempt\":1,\"extra\":\"drop\"}",
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
            await expect(readJsonFile(join(workspace, runDir, "artifacts/review.dynamic/attempt-1/agent/turn-002.json"))).resolves.toMatchObject({
              turn: 2,
              timing: agentTiming(),
            });
            expect(artifactRows.some(row => row.relative_path.includes("raw-parsed-output"))).toBe(false);
          } finally {
            store.close();
          }
        });
      });

    it("writes one normalized trace artifact for every repair turn when definition trace is enabled", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-trace", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, tracedAgentWorkflow());
          const store = await openRuntimeStore(workspace);
          const turns: AgentTurnRequest[] = [];
          try {
            const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
            await expect(withImmediateAgentRepairs(() => advanceFrozenRun({
              cwd: workspace,
              runId: run.id,
              ownerId: "owner-a",
              store,
              executeAgentTurn: async request => {
                turns.push(request);
                return tracedCompletedAgentTurn(turns.length === 1 ? "not json" : "{\"ok\":true}");
              },
            }))).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });

            expect(turns).toHaveLength(2);
            expect(turns.every(turn => turn.captureTrace === true)).toBe(true);
            const traces = store.listArtifacts(run.id).filter(artifact => artifact.path.endsWith(".trace.jsonl"));
            expect(traces).toHaveLength(2);
            expect(traces.map(artifact => artifact.mediaType)).toEqual(["application/x-ndjson", "application/x-ndjson"]);
            expect(store.listArtifacts(run.id).some(artifact => artifact.path.endsWith(".raw-acp.jsonl"))).toBe(false);
            await expect(listRunArtifacts(workspace, run.id)).resolves.toEqual(store.listArtifacts(run.id));
            await expect(listRunArtifacts(workspace, "missing")).resolves.toBeUndefined();

            for (const [index, artifact] of traces.entries()) {
              const records = (await readFile(artifact.path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
              expect(records.map(record => record.sequence)).toEqual([0, 1, 2]);
              expect(records[0]).toMatchObject({
                schemaVersion: 1,
                type: "turn_start",
                runId: run.id,
                nodeId: "review",
                nodeKey: artifact.nodeKey,
                attemptNo: 1,
                turn: index + 1,
                agentKey: "reviewer",
                sessionName: turns[index]!.sessionName,
                cwd: workspace,
              });
              expect(records[1]).toMatchObject({ type: "message", channel: "assistant" });
              expect(records[2]).toMatchObject({ type: "turn_end", status: "completed" });
              expect(await readFile(artifact.path, "utf8")).not.toContain(turns[index]!.prompt);
            }

            const metadata = store.getRun(run.id)?.dynamic?.executionMetadata.find(entry => entry.kind === "agent_attempt")?.metadata as AgentAttemptMetadata | undefined;
            expect(metadata?.turns).toEqual([
              expect.objectContaining({ traceArtifact: expect.objectContaining({ mediaType: "application/x-ndjson" }) }),
              expect.objectContaining({ traceArtifact: expect.objectContaining({ mediaType: "application/x-ndjson" }) }),
            ]);
          } finally {
            store.close();
          }
        });
      });

    it("keeps a partial trace artifact when a traced provider turn fails", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-failed-trace", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, tracedAgentWorkflow());
          const store = await openRuntimeStore(workspace);
          try {
            const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
            await expect(advanceFrozenRun({
              cwd: workspace,
              runId: run.id,
              ownerId: "owner-a",
              store,
              executeAgentTurn: async () => ({
                status: "failed",
                failure: { kind: "provider_exit", message: "provider disconnected" },
                responseText: "partial",
                stderr: "",
                summary: agentSummary(1),
                timing: agentTiming(2),
                trace: agentTrace("failed", "partial", "provider disconnected"),
              }),
            })).resolves.toMatchObject({ status: "failed", started: 1, failed: 1 });

            const trace = store.listArtifacts(run.id).find(artifact => artifact.path.endsWith(".trace.jsonl"));
            expect(trace).toBeDefined();
            const records = (await readFile(trace!.path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
            expect(records.at(-1)).toMatchObject({ type: "turn_end", status: "failed", message: "provider disconnected" });
            const turn = store.listArtifacts(run.id).find(artifact => /turn-001\.json$/.test(artifact.path));
            expect(turn).toBeDefined();
            await expect(readJsonFile(turn!.path)).resolves.toMatchObject({
              schemaVersion: 1,
              status: "failed",
              prompt: expect.stringContaining("# OUTPUT SCHEMA"),
              response: "partial",
              summary: agentSummary(1),
              timing: agentTiming(2),
              failure: { kind: "provider_exit", message: "provider disconnected" },
            });
          } finally {
            store.close();
          }
        });
      });

    it("records trace write errors without changing a successful node result", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-trace-write-error", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, tracedAgentWorkflow());
          const store = await openRuntimeStore(workspace);
          const registerArtifact = store.registerArtifact.bind(store);
          const registration = vi.spyOn(store, "registerArtifact").mockImplementation(input => {
            if (input.relativePath.endsWith(".trace.jsonl")) throw new Error("trace registry unavailable");
            registerArtifact(input);
          });
          try {
            const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
            await expect(advanceFrozenRun({
              cwd: workspace,
              runId: run.id,
              ownerId: "owner-a",
              store,
              executeAgentTurn: async () => tracedCompletedAgentTurn("{\"ok\":true}"),
            })).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });

            const metadata = store.getRun(run.id)?.dynamic?.executionMetadata.find(entry => entry.kind === "agent_attempt")?.metadata as AgentAttemptMetadata | undefined;
            expect(metadata?.turns).toEqual([
              expect.objectContaining({ traceCaptureError: "trace registry unavailable" }),
            ]);
            expect(store.listArtifacts(run.id).some(artifact => artifact.path.endsWith(".trace.jsonl"))).toBe(false);
          } finally {
            registration.mockRestore();
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
                  summary: {
                    eventCount: 3,
                    availability: { context: "available", tokenUsage: "available" },
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

    it("throttles identical agent progress but flushes changed summary immediately", async () => {
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
                  summary: {
                    eventCount: 1,
                    availability: { context: "unavailable" as const, tokenUsage: "unavailable" as const },
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
                  summary: {
                    eventCount: 2,
                    availability: { context: "unavailable", tokenUsage: "unavailable" },
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
                  summary: {
                    eventCount: 1,
                    availability: { context: "unavailable", tokenUsage: "unavailable" },
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
            const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
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

    it("writes failed terminal agent progress for final output conformance failures", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-conformance-progress", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, booleanAgentWorkflow());
          const store = await openRuntimeStore(workspace);
          try {
            const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
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
              reason: "output_conformance",
              error: { origin: "provider", code: "output_conformance", message: expect.any(String) },
            });
            expect(store.getRun(run.id)?.dynamic?.progress).toEqual([
              expect.objectContaining({
                attemptId: attempt.attemptId,
                status: "failed",
                message: expect.stringContaining("could not be recovered as JSON"),
              }),
            ]);
          } finally {
            store.close();
          }
        });
      }, 2_000);

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
          const prepared = await prepareSyntheticWorkflow(workspace, booleanAgentWorkflow());
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
                  failure: { kind: "provider_exit", message: "agent crashed" },
                  responseText: "",
                  stderr: "",
                  summary: agentSummary(1),
                  timing: agentTiming(),
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
              turns: [expect.objectContaining({ status: "failed", failure: { kind: "provider_exit", message: "agent crashed" } })],
            });
            expectAgentArtifactRef(failedMetadata?.turns?.[0]?.rawAcpDebugArtifact, failedRawAcpPath, "application/x-ndjson", failedArtifactRows);
          } finally {
            restoreEnv("ACPUS_AGENT_RAW_ACP_DEBUG", previous);
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
              input: {},
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
            const run = await store.admitRun({ prepared, input: { agentCwd: worktree }, cwd: workspace });
            const runDir = store.getRunDir(run.id);
            if (!runDir) throw new Error("expected run directory");
            const artifactId = "artifact_prompt_input";
            const relativePath = join("artifacts", "produce", "attempt-1", "patch.diff");
            const artifactPath = join(workspace, runDir, relativePath);
            await mkdir(dirname(artifactPath), { recursive: true });
            await writeFile(artifactPath, "diff\n");
            store.registerArtifact({
              id: artifactId,
              runId: run.id,
              nodeKey: "produce",
              attempt: 1,
              mediaType: "text/plain",
              digest: "sha256:test",
              size: 5,
              relativePath,
            });
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

    it("repairs empty schema-backed agent responses without parsing them", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-empty-repair", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, retryingAgentWorkflow());
          const node = prepared.ir.root.nodes.find(node => node.id === "review");
          if (!node || node.kind !== "agent") throw new Error("expected review agent node");
          const turns: AgentTurnRequest[] = [];

          await expect(withImmediateAgentRepairs(() => executeAgentNode(node, {}, {
            cwd: workspace,
            agents: prepared.ir.agents,
            executeTurn: async request => {
              turns.push(request);
              return completedAgentTurn(turns.length === 1 ? "" : "{\"attempt\":\"2\"}");
            },
          }))).resolves.toEqual({ attempt: "2" });
          expect(turns).toHaveLength(2);
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
          }))).rejects.toThrow("empty_response");
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
          const previousRawDebug = process.env.ACPUS_AGENT_RAW_ACP_DEBUG;
          try {
            const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
            process.env.ACPUS_AGENT_RAW_ACP_DEBUG = "0";
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
                ACPUS_AGENT_RAW_ACP_DEBUG: "1",
              }),
              executeTurn: async request => {
                turns.push(request);
                if (turns.length === 1) {
                  process.env.ACPUS_AGENT_RESPONSE_REPAIR_MAX = "0";
                  process.env.ACPUS_AGENT_RAW_ACP_DEBUG = "0";
                }
                return completedAgentTurn(turns.length === 1 ? "not json" : "{\"ok\":true}");
              },
            }))).resolves.toEqual({ ok: true });

            expect(turns).toHaveLength(2);
            expect(turns.map(turn => turn.sessionName)).toEqual([turns[0]!.sessionName, turns[0]!.sessionName]);
            expect(turns.map(turn => turn.captureRawDebug)).toEqual([true, true]);
            expect(turns.map(turn => turn.env.ACPUS_AGENT_RESPONSE_REPAIR_MAX)).toEqual(["0", "0"]);
            expect(turns.map(turn => turn.env.ACPUS_AGENT_RAW_ACP_DEBUG)).toEqual(["0", "0"]);
            const metadata = store.getExecutionMetadata(run.id).find(entry => entry.kind === "agent_attempt")?.metadata as AgentAttemptMetadata | undefined;
            expect(metadata).toMatchObject({ responseRepairMax: 1, turnCount: 2 });
          } finally {
            restoreEnv("ACPUS_AGENT_RAW_ACP_DEBUG", previousRawDebug);
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
            const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
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
            const executeTurn = vi.fn(async () => completedAgentTurn("{\"ok\":true}"));

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
          const executeTurn = vi.fn(async () => completedAgentTurn("{\"ok\":true}"));
          try {
            const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
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
            const run = await store.admitRun({ prepared, input: { timeout: "5s", prompt: "dynamic review" }, cwd: workspace });
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
                return completedAgentTurn("{\"ok\":true}");
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
                return completedAgentTurn("{\"ok\":true}");
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
            const executeTurn = vi.fn(async () => completedAgentTurn("{\"ok\":true}"));

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

    it("records unrecoverable output metadata without creating an extra artifact", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-no-raw-parsed-output", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, booleanAgentWorkflow());
          const store = await openRuntimeStore(workspace);
          try {
            const run = await store.admitRun({ prepared, input: {}, cwd: workspace });

            await expect(withAgentResponseRepairMax("0", () => advanceFrozenRun({
              cwd: workspace,
              runId: run.id,
              ownerId: "owner-a",
              store,
              executeAgentTurn: async () => completedAgentTurn("not json"),
            }))).resolves.toMatchObject({ status: "failed", started: 1, failed: 1 });

            const nodeKey = deriveInstanceKey(appendNode([], "review"));
            const artifactRows = runtimeRows(workspace, "SELECT relative_path FROM artifacts WHERE run_id = ? AND node_key = ? ORDER BY relative_path", run.id, nodeKey) as Array<{ relative_path: string }>;
            expect(artifactRows.map(row => row.relative_path)).toEqual([
              `artifacts/${nodeKey}/attempt-1/agent/turn-001.json`,
            ]);
            const metadata = store.getRun(run.id)?.dynamic?.executionMetadata.find(entry => entry.kind === "agent_attempt")?.metadata as AgentAttemptMetadata | undefined;
            expect(metadata?.turns).toEqual([
              expect.objectContaining({ outputProcessing: { recovery: "unrecoverable", conformance: "rejected" } }),
            ]);
          } finally {
            store.close();
          }
        });
      });

    it("records empty output metadata without creating an extra artifact", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-empty-no-raw-parsed-output", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, booleanAgentWorkflow());
          const store = await openRuntimeStore(workspace);
          try {
            const run = await store.admitRun({ prepared, input: {}, cwd: workspace });

            await expect(withAgentResponseRepairMax("0", () => advanceFrozenRun({
              cwd: workspace,
              runId: run.id,
              ownerId: "owner-a",
              store,
              executeAgentTurn: async () => completedAgentTurn(""),
            }))).resolves.toMatchObject({ status: "failed", started: 1, failed: 1 });

            const nodeKey = deriveInstanceKey(appendNode([], "review"));
            const artifactRows = runtimeRows(workspace, "SELECT relative_path FROM artifacts WHERE run_id = ? AND node_key = ? ORDER BY relative_path", run.id, nodeKey) as Array<{ relative_path: string }>;
            expect(artifactRows.map(row => row.relative_path)).toEqual([
              `artifacts/${nodeKey}/attempt-1/agent/turn-001.json`,
            ]);
            const metadata = store.getRun(run.id)?.dynamic?.executionMetadata.find(entry => entry.kind === "agent_attempt")?.metadata as AgentAttemptMetadata | undefined;
            expect(metadata?.turns).toEqual([
              expect.objectContaining({ failure: { kind: "empty_response", message: expect.any(String) } }),
            ]);
            expect(metadata?.turns).toEqual([
              expect.objectContaining({ outputProcessing: { recovery: "empty", conformance: "rejected" } }),
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
              prompt: expect.stringContaining("# OUTPUT SCHEMA"),
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
              turns: [expect.objectContaining({ status: "completed", failure: { kind: "output_conformance", message: expect.any(String) } })],
            });
          } finally {
            store.close();
          }
        });
      });
    });

    describe("session, retry, timeout, and cancellation", () => {
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
                  throwingSchedulerStore(store.scheduler).pauseRun({
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
            const turnPath = `artifacts/${nodeKey}/attempt-1/agent/turn-001.json`;
            const stderrPath = `artifacts/${nodeKey}/attempt-1/agent/turn-001.stderr.log`;
            expect(artifactRows).toEqual([
              expect.objectContaining({ media_type: "application/json", relative_path: turnPath }),
              expect.objectContaining({ media_type: "text/plain", relative_path: stderrPath }),
            ]);
            const runDir = store.getRunDir(run.id);
            if (!runDir) throw new Error("expected run dir");
            await expect(readFile(join(workspace, runDir, stderrPath), "utf8")).resolves.toBe("partial stderr\n");
            await expect(readJsonFile(join(workspace, runDir, turnPath))).resolves.toMatchObject({
              status: "cancelled",
              prompt: turns[0]!.prompt,
              response: "partial response\n",
              summary: agentSummary(1),
              timing: agentTiming(),
              message: "paused by operator",
            });

            const metadata = store.getRun(run.id)?.dynamic?.executionMetadata.find(entry => entry.kind === "agent_attempt")?.metadata as AgentAttemptMetadata | undefined;
            expect(metadata).toMatchObject({
              status: "cancelled",
              turnCount: 1,
              message: "paused by operator",
              turns: [expect.objectContaining({ status: "cancelled", message: "paused by operator" })],
            });
            expectAgentArtifactRef(metadata?.turns?.[0]?.turnArtifact, turnPath, "application/json", artifactRows);
            expectAgentArtifactRef(metadata?.turns?.[0]?.stderrArtifact, stderrPath, "text/plain", artifactRows);

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

    it("persists empty sessionKey as a constraint-tagged attempt failure", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-agent-setup-failure-metadata", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, blankSessionAgentWorkflow());
          const store = await openRuntimeStore(workspace);
          try {
            const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
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

    it("does not turn agent response repair into scheduler-visible retry", async () => {
        await withRuntimeWorkspace("scheduler-node-executor-no-agent-scheduler-retry", async workspace => {
          const prepared = await prepareSyntheticWorkflow(workspace, retryingAgentWorkflow());
          const store = await openRuntimeStore(workspace);
          const turns: AgentTurnRequest[] = [];
          try {
            const run = await store.admitRun({ prepared, input: {}, cwd: workspace });
            const nodeKey = deriveInstanceKey(appendNode([], "review"));

            await expect(withAgentResponseRepairMax(undefined, () => withImmediateAgentRepairs(() => advanceFrozenRun({
              cwd: workspace,
              runId: run.id,
              ownerId: "owner-a",
              store,
              executeAgentTurn: async request => {
                turns.push(request);
                return completedAgentTurn("{\"attempt\":1}");
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
            expect(metadata?.message).toContain("does not match schema");
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

            await expect(withAgentResponseRepairMax("2", () => withImmediateAgentRepairs(() => advanceFrozenRun({
              cwd: workspace,
              runId: run.id,
              ownerId: "owner-a",
              store,
              executeAgentTurn: async request => {
                turns.push(request);
                return completedAgentTurn("{\"ok\":\"not boolean\"}");
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
                return completedAgentTurn("{\"attempt\":\"4\"}");
              },
            }))).resolves.toMatchObject({ status: "completed", started: 1, completed: 1 });

            expect(turns).toHaveLength(4);
            expect(turns[3]!.sessionName).toBe(turns[0]!.sessionName);
            expect(turns[3]!.agentMode).toBeUndefined();
            expect(turns[3]!.prompt).toBe("Continue the previous task from where you left off.");
            expect(turns[3]!.prompt).not.toContain("# OUTPUT SCHEMA");
            const metadata = store.getRun(run.id)?.dynamic?.executionMetadata.filter(entry => entry.kind === "agent_attempt").map(entry => entry.metadata) as AgentAttemptMetadata[] | undefined;
            expect(metadata).toEqual([
              expect.objectContaining({ status: "failed", sessionName: turns[0]!.sessionName, responseRepairMax: 2, turnCount: 3 }),
              expect.objectContaining({ status: "completed", sessionName: turns[0]!.sessionName, responseRepairMax: 0, turnCount: 1 }),
            ]);
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
            const run = await store.admitRun({ prepared, input: {}, cwd: workspace });

            await expect(withAgentResponseRepairMax("0", () => advanceFrozenRun({
              cwd: workspace,
              runId: run.id,
              ownerId: "owner-a",
              store,
              executeAgentTurn: async request => {
                turns.push(request);
                return completedAgentTurn("{\"ok\":\"not boolean\"}");
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
    });
});

function retryingAgentWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-agent-retry",
    agents: {
      reviewer: { command: "custom-acp-server", agentMode: "agent" },
    },
  }).build(({ agents, step }) => {
    step("review").agent({
      outputSchema: z.object({ attempt: z.string() }),
      agent: agents.reviewer, prompt: "review",
    });
    return {};
  });
}

function tracedAgentWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-agent-trace",
    agents: {
      reviewer: { use: "codex", trace: true },
    },
  }).build(({ agents, step }) => {
    step("review").agent({
      outputSchema: z.object({ ok: z.boolean() }),
      agent: agents.reviewer,
      prompt: "review",
    });
    return {};
  });
}

function tracedCompletedAgentTurn(responseText: string): AgentTurnResult {
  return {
    ...completedAgentTurn(responseText),
    timing: agentTiming(2),
    trace: agentTrace("completed", responseText),
  };
}

function agentTrace(
  status: "completed" | "failed" | "cancelled" | "timed_out",
  text: string,
  message?: string,
): NonNullable<AgentTurnResult["trace"]> {
  return {
    startedAt: "2026-07-01T00:00:00.000Z",
    elapsedMs: 2,
    events: [
      {
        schemaVersion: 1,
        sequence: 0,
        observedAt: "2026-07-01T00:00:00.001Z",
        elapsedMs: 1,
        type: "message",
        channel: "assistant",
        content: { type: "text", text },
        tag: "agent_message_chunk",
      },
      {
        schemaVersion: 1,
        sequence: 1,
        observedAt: "2026-07-01T00:00:00.002Z",
        elapsedMs: 2,
        type: "turn_end",
        status,
        ...(message ? { message } : {}),
      },
    ],
  };
}

function hostRepairBudgetAgentWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-agent-host-repair-budget",
    agents: {
      reviewer: { use: "codex", env: { ACPUS_AGENT_RESPONSE_REPAIR_MAX: "0", ACPUS_AGENT_RAW_ACP_DEBUG: "0" } },
    },
  }).build(({ agents, step }) => {
    step("review").agent({
      outputSchema: z.object({ ok: z.boolean() }),
      agent: agents.reviewer,
      prompt: "review",
      env: { ACPUS_AGENT_RESPONSE_REPAIR_MAX: "0", ACPUS_AGENT_RAW_ACP_DEBUG: "0" },
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
      agent: agents.reviewer, prompt: "review",
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
      agent: agents.reviewer, prompt: "review",
    });
    return {};
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

function nestedAgentOutputWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-agent-nested-output",
    agents: {
      reviewer: { use: "codex" },
    },
  }).build(({ agents, step }) => {
    step("review").agent({
      outputSchema: z.object({ items: z.array(z.object({ id: z.string() })) }),
      agent: agents.reviewer, prompt: "review",
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
