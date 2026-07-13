import { describe, expect, it, vi } from "vitest";
import type { RunInspectionTargetDocument } from "@acpus/runtime";
import { inspectNodeExecution } from "../src/server/node-inspection.js";

const noTurnArtifact = async () => undefined;

describe("node execution inspection", () => {
  it("derives live execution summary from target-scoped progress", async () => {
    const inspection = targetInspection({
      progress: [{
        nodeKey: "review~abc",
        nodeId: "review",
        attemptId: "attempt_1",
        attemptNo: 1,
        kind: "agent",
        status: "running",
        message: "working",
        context: { used: 2_500, size: 10_000, updatedAt: "2026-07-01T00:00:02.000Z" },
        tokenUsage: { source: "provider", inputTokens: 100, outputTokens: 25, totalTokens: 125 },
        tools: {
          turn: 2,
          totalToolCallCount: 4,
          lastCalls: [{ toolCallId: "tool_1", toolName: "read_file", status: "running", inputPreview: "README.md" }],
        },
        output: { tail: "partial response", totalBytes: 16, truncated: false },
        updatedAt: "2026-07-01T00:00:02.000Z",
      }],
    });

    const result = await inspectNodeExecution(inspection, noTurnArtifact);

    expect(result).toMatchObject({
      available: true,
      lastActiveAt: "2026-07-01T00:00:02.000Z",
      summary: { status: "running", message: "working" },
      contextWindow: { used: 2_500, size: 10_000, percent: 25 },
      tokenUsage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
      toolCallCount: 4,
      lastToolCalls: [{ turn: 2, toolName: "read_file", inputPreview: "README.md" }],
      output: { tail: "partial response", totalBytes: 16, truncated: false },
    });
  });

  it("loads full tool summary through the artifact loader", async () => {
    const inspection = targetInspection({
      executionMetadata: [{
        id: 1,
        attemptId: "attempt_1",
        kind: "agent_attempt",
        createdAt: "2026-07-01T00:00:03.000Z",
        metadata: {
          status: "completed",
          sessionName: "session-1",
          turnCount: 1,
          turns: [{
            turn: 1,
            turnArtifact: { artifactId: "turn-1" },
            summary: {
              context: { used: 4_000, size: 8_000 },
              tokenUsage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
              tools: { totalToolCallCount: 1 },
            },
          }],
        },
      }],
    });
    const loadTurnArtifact = vi.fn(async () => ({
      summary: {
        tools: {
          calls: [{
            toolCallId: "tool_1",
            toolName: "shell",
            status: "completed",
            startedAt: "2026-07-01T00:00:00.000Z",
            completedAt: "2026-07-01T00:00:01.000Z",
            input: { preview: "pnpm test" },
          }],
        },
      },
    }));

    const withoutArtifact = await inspectNodeExecution(inspection, noTurnArtifact);
    const withArtifact = await inspectNodeExecution(inspection, loadTurnArtifact);

    expect(loadTurnArtifact).toHaveBeenCalledOnce();
    expect(loadTurnArtifact).toHaveBeenCalledWith({ artifactId: "turn-1" });
    expect(withoutArtifact.lastToolCalls).toEqual([]);
    expect(withArtifact).toMatchObject({
      available: true,
      summary: { status: "completed", sessionName: "session-1", turnCount: 1 },
      contextWindow: { used: 4_000, size: 8_000, percent: 50 },
      tokenUsage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
      toolCallCount: 1,
      lastToolCalls: [{
        turn: 1,
        toolName: "shell",
        durationMs: 1_000,
        inputPreview: "pnpm test",
      }],
    });
  });

  it("reports unavailable when the target projection has no agent execution data", async () => {
    const result = await inspectNodeExecution(targetInspection(), noTurnArtifact);

    expect(result).toMatchObject({
      available: false,
      reason: "No agent execution metadata exists for the selected scope.",
      summary: {},
      lastToolCalls: [],
    });
  });

  it("uses normalized compact Agent state without loading full turn data", async () => {
    const loadTurnArtifact = vi.fn();
    const result = await inspectNodeExecution(targetInspection({
      agent: {
        key: "observer",
        backend: { kind: "command" },
        turnCount: 2,
        lastActivityAt: "2026-07-01T00:00:04.000Z",
        context: { used: 3_000, size: 12_000 },
        tokenUsage: { inputTokens: 90, outputTokens: 10, cachedReadTokens: 20, totalTokens: 120 },
        tools: {
          totalCallCount: 5,
          recent: [
            { command: "Read", status: "completed" },
            { command: "Bash: rg", status: "running" },
          ],
        },
      },
    }), loadTurnArtifact);

    expect(loadTurnArtifact).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      available: true,
      summary: { status: "running", turnCount: 2 },
      lastActiveAt: "2026-07-01T00:00:04.000Z",
      contextWindow: { used: 3_000, size: 12_000, percent: 25 },
      tokenUsage: { inputTokens: 90, outputTokens: 10, totalTokens: 120 },
      toolCallCount: 5,
      lastToolCalls: [
        { turn: 2, toolName: "Read", status: "completed" },
        { turn: 2, toolName: "Bash: rg", status: "running" },
      ],
    });
  });
});

function targetInspection(overrides: Partial<Pick<
  RunInspectionTargetDocument,
  "progress" | "executionMetadata"
>> & { agent?: NonNullable<RunInspectionTargetDocument["summary"]["agent"]> } = {}): RunInspectionTargetDocument {
  return {
    schemaVersion: 1,
    kind: "target",
    cursor: { eventSequence: 3, progressVersion: 1 },
    run: {
      id: "run_1",
      name: "review-workflow",
      status: "running",
      workflowEntry: "review.workflow.ts",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:02.000Z",
      execution: { state: "active", lastStatus: "running" },
    },
    target: { kind: "dynamic-node", id: "review~abc" },
    staticNode: { nodeId: "review", kind: "agent", order: 0, path: ["review"], agent: "reviewer" },
    summary: {
      targetKind: "dynamic-node",
      targetId: "review~abc",
      runStatus: "running",
      runStartedAt: "2026-07-01T00:00:00.000Z",
      nodeId: "review",
      nodeKey: "review~abc",
      nodeStatus: "running",
      staticKind: "agent",
      staticOrder: 0,
      ...(overrides.agent ? { agent: overrides.agent } : {}),
      artifacts: [],
    },
    items: [],
    instances: [{
      nodeKey: "review~abc",
      nodeId: "review",
      status: "running",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:02.000Z",
    }],
    frames: [],
    attempts: [{
      attemptId: "attempt_1",
      nodeKey: "review~abc",
      nodeId: "review",
      attemptNo: 1,
      status: "started",
      startedAt: "2026-07-01T00:00:00.000Z",
    }],
    signalWaits: [],
    executionMetadata: overrides.executionMetadata ?? [],
    progress: overrides.progress ?? [],
    artifacts: [],
  };
}
