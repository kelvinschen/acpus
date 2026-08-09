import { describe, expect, it, vi } from "vitest";
import type {
  ForensicsDefinition,
  ForensicsInvocation,
  InspectionForensicsView,
  RunInspectionAgentExecutionDocument,
  RunInspectionNodeDocument,
} from "@acpus/runtime";
import {
  projectNodeExecution,
  projectNodeInspection,
  projectNodeRuntimeValues,
} from "../src/server/node-inspection.js";

const noTurnArtifact = async () => undefined;

describe("node inspection projection", () => {
  it.each(["pending", "starting", "ready", "running", "awaiting"] as const)(
    "keeps Agent observation for a live %s target",
    async status => {
      const result = await projectNodeInspection(nodeInspection({
        state: { status },
        summary: {
          agent: {
            key: "observer",
            availability: { context: "available", tokenUsage: "available" },
            lastObservedAt: "2026-07-01T00:00:04.000Z",
          },
        },
      }), noTurnArtifact);

      expect(result.agent).toEqual({
        key: "observer",
        lastObservedAt: "2026-07-01T00:00:04.000Z",
      });
    },
  );

  it.each(["not_started", "not_selected", "completed", "failed", "timed_out", "cancelled", "mixed"] as const)(
    "omits Agent observation for a non-live %s target",
    async status => {
      const result = await projectNodeInspection(nodeInspection({
        state: { status },
        summary: {
          agent: {
            key: "observer",
            availability: { context: "available", tokenUsage: "available" },
            lastObservedAt: "2026-07-01T00:00:04.000Z",
          },
        },
      }), noTurnArtifact);

      expect(result.agent).toEqual({ key: "observer" });
    },
  );

  it("projects selected-target timing instead of run timing", async () => {
    const inspection = nodeInspection({
      summary: { runDurationMs: 60_000 },
      state: {
        status: "completed",
        startedAt: "2026-07-01T00:00:01.000Z",
        finishedAt: "2026-07-01T00:00:03.000Z",
        durationMs: 2_000,
      },
    });

    const result = await projectNodeInspection(inspection, noTurnArtifact);

    expect(result).toMatchObject({
      timing: {
        startedAt: "2026-07-01T00:00:01.000Z",
        finishedAt: "2026-07-01T00:00:03.000Z",
        durationMs: 2_000,
      },
    });
    expect(result).not.toHaveProperty("runStartedAt");
    expect(result).not.toHaveProperty("runDurationMs");
  });

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
    const inspection = nodeInspection({
      artifacts: [artifact],
      state: {
        status: "awaiting",
        startedAt: "2026-07-01T00:00:01.000Z",
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
        agent: {
          key: "observer",
          backend: { kind: "command" },
          availability: { context: "available", tokenUsage: "available" },
          model: "opus",
          turnCount: 2,
          lastObservedAt: "2026-07-01T00:00:04.000Z",
          context: { used: 3_000, size: 12_000 },
          tokenUsage: { inputTokens: 90, outputTokens: 10, totalTokens: 100 },
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
      },
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
      timing: { startedAt: "2026-07-01T00:00:01.000Z" },
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

  it("does not expose absent optional fields", async () => {
    const result = await projectNodeInspection(nodeInspection({
      summary: { nodeStatus: "completed" },
      availableControls: [],
    }), noTurnArtifact);

    expect(result).toEqual({
      nodeId: "review",
      nodeKey: "review~abc",
      staticKind: "agent",
      artifacts: [],
    });
  });

  it("omits a normalized Signal when the selected target is not awaiting", async () => {
    const result = await projectNodeInspection(nodeInspection({
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
    const inspection = nodeInspection({
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

describe("node runtime values projection", () => {
  it("projects the durable Assert outcome", () => {
    expect(projectNodeRuntimeValues(forensicsView(
      { kind: "assert", condition: "input.ok" },
      { status: "resolved", kind: "assert", condition: true },
    ))).toEqual({ available: true, values: { condition: true } });
  });

  it("projects the If condition from its durable selected branch", () => {
    expect(projectNodeRuntimeValues(forensicsView(
      { kind: "if", condition: "input.ok", branches: { then: emptyScope, else: emptyScope } },
      { status: "resolved", kind: "if", selectedBranch: "else" },
    ))).toEqual({ available: true, values: { condition: false, selectedBranch: "else" } });
  });

  it("projects evaluated and short-circuited Switch cases", () => {
    expect(projectNodeRuntimeValues(forensicsView(
      {
        kind: "switch",
        cases: [
          { id: "case:0", when: "input.mode === 'a'", then: emptyScope },
          { id: "case:1", when: "input.mode === 'b'", then: emptyScope },
          { id: "case:2", when: "input.mode === 'c'", then: emptyScope },
        ],
        default: emptyScope,
      },
      { status: "resolved", kind: "switch", selectedBranch: "case:1" },
    ))).toEqual({
      available: true,
      values: {
        cases: [
          { id: "case:0", state: "resolved", value: false },
          { id: "case:1", state: "resolved", value: true },
          { id: "case:2", state: "not_evaluated" },
        ],
        selectedBranch: "case:1",
      },
    });
  });

  it("projects effective Parallel concurrency", () => {
    expect(projectNodeRuntimeValues(forensicsView(
      { kind: "parallel", strategy: "all", maxConcurrency: "input.limit", branches: { work: emptyScope } },
      { status: "resolved", kind: "parallel", maxConcurrency: 3 },
    ))).toEqual({ available: true, values: { maxConcurrency: 3 } });
  });

  it("projects the complete materialized Fanout input", () => {
    expect(projectNodeRuntimeValues(forensicsView(
      { kind: "fanout", over: "input.items", strategy: "quorum", count: "2", maxConcurrency: "3", do: emptyScope },
      {
        status: "resolved",
        kind: "fanout",
        items: [{ id: 1 }, { id: 2 }],
        quorumCount: 2,
        maxConcurrency: 3,
      },
    ))).toEqual({
      available: true,
      values: { over: [{ id: 1 }, { id: 2 }], count: 2, maxConcurrency: 3 },
    });
  });

  it("projects durable Loop progress values", () => {
    expect(projectNodeRuntimeValues(forensicsView(
      { kind: "loop", state: "input.state", do: { nodes: [], transition: { state: "do.state", stop: "do.stop" } } },
      { status: "resolved", kind: "loop", index: 2, round: 3, state: { count: 3 }, transition: { stop: true } },
    ))).toEqual({
      available: true,
      values: { index: 2, round: 3, state: { count: 3 }, transition: { stop: true } },
    });
  });

  it("preserves a composite invocation's unavailable reason", () => {
    expect(projectNodeRuntimeValues(forensicsView(
      { kind: "fanout", over: "input.items", strategy: "all", do: emptyScope },
      { status: "unavailable", reason: "not_yet_resolved" },
    ))).toEqual({ available: false, reason: "not_yet_resolved" });
  });

  it("does not expose leaf invocation fields", () => {
    const projected = projectNodeRuntimeValues(forensicsView(
      {
        kind: "agent",
        agent: "worker",
        profile: { kind: "agent_definition", use: "codex" },
        prompt: "private authored prompt",
      },
      {
        status: "resolved",
        kind: "agent",
        attempt: 1,
        promptOrigin: "authored",
        prompt: "private runtime prompt",
        cwd: "/private/workspace",
        env: { TOKEN: "private" },
        permissionMode: "deny-all",
      },
    ));

    expect(projected).toEqual({ available: false, reason: "not-composite" });
    expect(JSON.stringify(projected)).not.toContain("private");
  });
});

describe("node execution inspection", () => {
  it.each(["pending", "starting", "ready", "running", "awaiting"] as const)(
    "keeps Agent execution observation for a live %s target",
    status => {
      const result = projectNodeExecution({
        ...executionInspection(),
        summary: { status },
      });

      expect(result).toHaveProperty("lastObservedAt", "2026-07-01T00:00:02.000Z");
    },
  );

  it.each(["not_started", "not_selected", "completed", "failed", "timed_out", "cancelled", "mixed"] as const)(
    "omits Agent execution observation for a non-live %s target",
    status => {
      const result = projectNodeExecution({
        ...executionInspection(),
        summary: { status },
      });

      expect(result).not.toHaveProperty("lastObservedAt");
    },
  );

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
      recentTools: [{
        ...executionInspection().recentTools[0]!,
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
      recentTools: [{
        turn: 2,
        toolCallId: "tool_1",
        toolName: "read_file",
        status: "running",
        durationMs: 20,
        inputPreview: "README.md",
      }],
      output: { tail: "partial response", totalBytes: 16, truncated: false },
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
      recentTools: [],
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
      id: "@1a2b3c4d5e6f#1",
      ref: "@1a2b3c4d5e6f#1",
      label: "review",
      kind: "agent",
      nodeId: "review",
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
    recentTools: [{
      turn: 2,
      toolCallId: "tool_1",
      toolName: "read_file",
      status: "running",
      durationMs: 20,
      inputPreview: "README.md",
    }],
  };
}

function nodeInspection(overrides: {
  state?: RunInspectionNodeDocument["state"];
  summary?: Partial<RunInspectionNodeDocument["summary"]>;
  artifacts?: RunInspectionNodeDocument["artifacts"];
  availableControls?: RunInspectionNodeDocument["availableControls"];
} = {}): RunInspectionNodeDocument {
  const artifacts = overrides.artifacts ?? [];
  return {
    schemaVersion: 2,
    kind: "node",
    run: {
      id: "run_1",
      name: "review-workflow",
      status: "running",
      workflowEntry: "review.workflow.ts",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:02.000Z",
      execution: { state: "active", lastStatus: "running" },
    },
    subject: {
      targetKind: "dynamic-node",
      id: "review~abc",
      ref: "@1a2b3c4d5e6f",
      label: "review",
      kind: "agent",
      nodeId: "review",
    },
    state: overrides.state ?? { status: "running" },
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
      artifacts: overrides.summary?.artifacts ?? artifacts,
    },
    artifacts,
    availableControls: overrides.availableControls ?? [{ type: "cancel", target: "review~abc" }],
  };
}

const emptyScope = { nodes: [], output: "null" };

function forensicsView(
  definition: ForensicsDefinition,
  invocation: ForensicsInvocation,
): InspectionForensicsView {
  return {
    kind: "target",
    detail: "forensics",
    run: { id: "run_1", status: "running" },
    subject: { label: "target", kind: definition.kind, selector: "@1a2b3c4d5e6f" },
    state: { status: "running" },
    definition,
    invocation,
    result: { status: "pending" },
  };
}
