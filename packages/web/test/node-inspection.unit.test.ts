import { describe, expect, it, vi } from "vitest";
import type {
  RunInspectionAgentExecutionDocument,
  RunInspectionTargetDetailsDocument,
} from "@acpus/runtime";
import {
  projectNodeExecution,
  projectNodeInspection,
} from "../src/server/node-inspection.js";

const noTurnArtifact = async () => undefined;

describe("node inspection projection", () => {
  it("returns only the Web-owned fields after hydrating the verified prompt", async () => {
    const artifact = {
      id: "turn-1",
      runId: "run_1",
      nodeKey: "review~abc",
      attempt: 1,
      mediaType: "application/json",
      digest: "sha256:verified",
      size: 1024,
      path: "review~abc/attempt-1/agent/turn-001.json",
      createdAt: "2026-07-01T00:00:01.000Z",
    };
    const inspection = targetInspection({
      agent: {
        key: "observer",
        backend: { kind: "command" },
        availability: { context: "available", tokenUsage: "available" },
        model: "opus",
        turnCount: 2,
        lastObservedAt: "2026-07-01T00:00:04.000Z",
        context: { used: 3_000, size: 12_000 },
        tokenUsage: { inputTokens: 90, outputTokens: 10, totalTokens: 100 },
        tools: { totalCallCount: 1, recent: [{ command: "Read", status: "completed" }] },
      },
      summary: {
        runDurationMs: 4_000,
        latestAttempt: {
          attemptId: "attempt_1",
          attemptNo: 1,
          status: "started",
          startedAt: "2026-07-01T00:00:00.000Z",
          error: { private: true },
        },
        input: { kind: "runtime", value: { release: true } },
        prompt: {
          kind: "artifact",
          artifactId: artifact.id,
          path: artifact.path,
          mediaType: artifact.mediaType,
          field: "prompt",
        },
        loopProgress: {
          frameKey: "review-loop",
          index: 0,
          round: 1,
          state: { approved: false },
          stop: false,
          transition: { reason: "retry" },
          activeIterationFrameKey: "review-loop#0",
          activeChildNodeKeys: ["review~abc"],
        },
        output: { approved: false },
        failure: {
          origin: "provider",
          code: "provider_exit",
          message: "Provider rejected the request.",
          upstream: {
            source: "acpx",
            operation: "turn",
            exitCode: 7,
            code: "E_PROVIDER",
            origin: "rpc",
            protocol: { name: "json-rpc", code: -32_000, message: "Rejected." },
            data: { retryable: false },
          },
        },
        nodeStatus: "awaiting",
        signal: {
          target: "approval~exact",
          promptPreview: "Approve release?",
        },
        artifacts: [artifact],
      },
      artifacts: [artifact],
      items: [{
        key: "private:item",
        role: "static",
        path: ["review"],
        label: "review",
        kind: "agent",
        status: "running",
      }],
      frames: [{
        frameKey: "private:frame",
        nodeId: "review",
        frameKind: "node",
        status: "running",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:01.000Z",
      }],
      executionMetadata: [{
        id: 1,
        attemptId: "attempt_1",
        kind: "agent_attempt",
        metadata: { private: true },
        createdAt: "2026-07-01T00:00:01.000Z",
      }],
      progress: [{
        nodeKey: "review~abc",
        nodeId: "review",
        attemptId: "attempt_1",
        attemptNo: 1,
        kind: "agent",
        status: "running",
        message: "private",
        updatedAt: "2026-07-01T00:00:01.000Z",
      }],
      signalWaits: [{
        nodeKey: "approval~other",
        nodeId: "approval",
        status: "awaiting",
        renderedPrompt: "Wrong occurrence",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:01.000Z",
      }],
    });
    const loadPromptArtifact = vi.fn(async () => ({
      prompt: "Review the exact release.",
      response: "private",
    }));

    const result = await projectNodeInspection(inspection, loadPromptArtifact);

    expect(loadPromptArtifact).toHaveBeenCalledOnce();
    expect(loadPromptArtifact).toHaveBeenCalledWith(inspection.summary.prompt);
    expect(result).toEqual({
      nodeId: "review",
      nodeKey: "review~abc",
      cancelTarget: "review~abc",
      staticKind: "agent",
      runStartedAt: "2026-07-01T00:00:00.000Z",
      runDurationMs: 4_000,
      latestAttempt: { attemptNo: 1, status: "started" },
      agent: {
        key: "observer",
        model: "opus",
        lastObservedAt: "2026-07-01T00:00:04.000Z",
      },
      input: { kind: "runtime", value: { release: true } },
      prompt: {
        kind: "artifact",
        text: "Review the exact release.",
        artifactId: "turn-1",
        mediaType: "application/json",
      },
      loopProgress: {
        frameKey: "review-loop",
        index: 0,
        round: 1,
        state: { approved: false },
        stop: false,
        transition: { reason: "retry" },
        activeIterationFrameKey: "review-loop#0",
        activeChildNodeKeys: ["review~abc"],
      },
      output: { approved: false },
      failure: {
        origin: "provider",
        code: "provider_exit",
        message: "Provider rejected the request.",
        upstream: {
          source: "acpx",
          operation: "turn",
          exitCode: 7,
          code: "E_PROVIDER",
          origin: "rpc",
          protocol: { name: "json-rpc", code: -32_000, message: "Rejected." },
          data: { retryable: false },
        },
      },
      artifacts: [{
        id: "turn-1",
        path: "review~abc/attempt-1/agent/turn-001.json",
        size: 1024,
        mediaType: "application/json",
      }],
      awaitingSignal: {
        target: "approval~exact",
        prompt: "Approve release?",
      },
    });
  });

  it("does not invent one signal action for an aggregate target", async () => {
    const wait = (nodeKey: string): RunInspectionTargetDetailsDocument["signalWaits"][number] => ({
      nodeKey,
      nodeId: "approval",
      status: "awaiting",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:01.000Z",
    });
    const inspection = targetInspection({
      summary: { nodeStatus: "awaiting", counts: { total: 2, awaiting: 2 } },
      signalWaits: [wait("approval~0"), wait("approval~1")],
      availableControls: [],
    });
    delete inspection.summary.nodeKey;

    const result = await projectNodeInspection(inspection, noTurnArtifact);

    expect(result).toEqual({
      nodeId: "review",
      staticKind: "agent",
      runStartedAt: "2026-07-01T00:00:00.000Z",
      artifacts: [],
    });
  });

  it("omits a normalized Signal when the selected target is not awaiting", async () => {
    const result = await projectNodeInspection(targetInspection({
      summary: {
        nodeStatus: "completed",
        signal: { target: "approval~abc", promptPreview: "Already consumed" },
      },
    }), noTurnArtifact);

    expect(result).not.toHaveProperty("awaitingSignal");
  });

  it.each([
    { name: "missing", artifact: undefined },
    { name: "non-object", artifact: [] },
    { name: "non-string prompt", artifact: { prompt: 42 } },
  ])("rejects a $name registered prompt artifact", async ({ artifact }) => {
    const inspection = targetInspection({
      summary: {
        prompt: {
          kind: "artifact",
          artifactId: "turn-1",
          path: "turn-001.json",
          mediaType: "application/json",
          field: "prompt",
        },
      },
    });

    await expect(projectNodeInspection(inspection, async () => artifact)).rejects.toBeInstanceOf(Error);
  });
});

describe("node execution inspection", () => {
  it("maps only the closed Web execution fields", () => {
    const execution = {
      ...executionInspection(),
      runtimeOnly: "private",
      run: { ...executionInspection().run, runtimeOnly: "private" },
      subject: { ...executionInspection().subject, runtimeOnly: "private" },
      summary: { ...executionInspection().summary, runtimeOnly: "private" },
      contextWindow: { ...executionInspection().contextWindow, runtimeOnly: "private" },
      tokenUsage: { ...executionInspection().tokenUsage, runtimeOnly: "private" },
      output: { ...executionInspection().output, runtimeOnly: "private" },
      lastToolCalls: [{
        ...executionInspection().lastToolCalls[0]!,
        runtimeOnly: "private",
      }],
    } as unknown as RunInspectionAgentExecutionDocument;

    expect(projectNodeExecution(execution)).toEqual({
      available: true,
      lastObservedAt: "2026-07-01T00:00:02.000Z",
      summary: {
        status: "running",
        sessionName: "review-session",
        turnCount: 2,
        message: "working",
      },
      contextWindow: { used: 2_500, size: 10_000, percent: 25 },
      tokenUsage: {
        source: "usage_update",
        inputTokens: 100,
        outputTokens: 25,
        totalTokens: 125,
      },
      toolCallCount: 4,
      lastToolCalls: [{
        turn: 2,
        toolCallId: "tool_1",
        toolName: "read_file",
        status: "running",
        durationMs: 20,
        inputPreview: "README.md",
      }],
      output: { tail: "partial response", totalBytes: 16, truncated: false },
      recentToolsIncomplete: true,
    });
  });

  it.each([
    {
      reason: "not-agent" as const,
      message: "The selected scope is not an Agent node.",
    },
    {
      reason: "not-started" as const,
      message: "No agent execution metadata exists for the selected scope.",
    },
  ])("maps the $reason reason to Web-owned copy", ({ reason, message }) => {
    const result = projectNodeExecution({
      ...executionInspection(),
      available: false,
      reason,
      lastToolCalls: [],
      recentToolsIncomplete: false,
    });

    expect(result.available).toBe(false);
    expect(result.reason).toBe(message);
  });
});

function executionInspection(): RunInspectionAgentExecutionDocument {
  return {
    schemaVersion: 2,
    kind: "execution",
    run: {
      id: "run_1",
      status: "running",
      updatedAt: "2026-07-01T00:00:02.000Z",
    },
    subject: {
      targetKind: "dynamic-node",
      id: "review~abc",
      label: "review",
      kind: "agent",
      nodeId: "review",
      nodeKey: "review~abc",
      attemptId: "attempt_1",
      attemptNo: 1,
    },
    available: true,
    summary: {
      status: "running",
      sessionName: "review-session",
      turnCount: 2,
      message: "working",
    },
    lastObservedAt: "2026-07-01T00:00:02.000Z",
    contextWindow: { used: 2_500, size: 10_000, percent: 25 },
    tokenUsage: {
      source: "usage_update",
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
    },
    output: { tail: "partial response", totalBytes: 16, truncated: false },
    toolCallCount: 4,
    lastToolCalls: [{
      turn: 2,
      toolCallId: "tool_1",
      toolName: "read_file",
      status: "running",
      durationMs: 20,
      inputPreview: "README.md",
    }],
    recentToolsIncomplete: true,
  };
}

function targetInspection(overrides: Partial<Pick<
  RunInspectionTargetDetailsDocument,
  "items" | "instances" | "frames" | "attempts" | "progress" | "executionMetadata" | "signalWaits" | "artifacts" | "availableControls"
>> & {
  agent?: NonNullable<RunInspectionTargetDetailsDocument["summary"]["agent"]>;
  summary?: Partial<RunInspectionTargetDetailsDocument["summary"]>;
} = {}): RunInspectionTargetDetailsDocument {
  const artifacts = overrides.artifacts ?? [];
  return {
    schemaVersion: 2,
    kind: "details",
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
      ...overrides.summary,
      ...(overrides.agent ? { agent: overrides.agent } : {}),
      artifacts: overrides.summary?.artifacts ?? artifacts,
    },
    items: overrides.items ?? [],
    instances: overrides.instances ?? [{
      nodeKey: "review~abc",
      nodeId: "review",
      status: "running",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:02.000Z",
    }],
    frames: overrides.frames ?? [],
    attempts: overrides.attempts ?? [{
      attemptId: "attempt_1",
      nodeKey: "review~abc",
      nodeId: "review",
      attemptNo: 1,
      status: "started",
      startedAt: "2026-07-01T00:00:00.000Z",
    }],
    signalWaits: overrides.signalWaits ?? [],
    executionMetadata: overrides.executionMetadata ?? [],
    progress: overrides.progress ?? [],
    artifacts,
    availableControls: overrides.availableControls ?? [{ type: "cancel", target: "review~abc" }],
  };
}
