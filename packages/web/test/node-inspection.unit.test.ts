import { describe, expect, it } from "vitest";
import type { RunInspection } from "@acpus/runtime";
import { inspectNode, inspectNodeExecution } from "../src/server/node-inspection.js";

const baseRun: RunInspection["run"] = {
  id: "run_1",
  name: "test",
  status: "running",
  workflowEntry: "/tmp/workflow.ts",
  sourceGraphDigest: "sha256:def",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:01.000Z",
  progressVersion: 0,
  input: {},
  eventCount: 5,
  nodeCount: 3,
  hooks: [],
  execution: { state: "active", lastStatus: "running" },
  dynamic: {
    version: 3,
    progressVersion: 0,
    progress: [],
    frames: [],
    nodeInstances: [],
    attempts: [],
    groupMembers: [],
    signalWaits: [],
    executionMetadata: [],
  },
};

const baseStaticNodes: RunInspection["staticNodes"] = [
  { nodeId: "prepare", kind: "task", order: 0 },
  { nodeId: "review", kind: "agent", order: 1 },
  { nodeId: "deploy", kind: "task", order: 2 },
];

describe("inspectNode", () => {
  it("classifies a static node target", () => {
    const inspection: RunInspection = { run: baseRun, staticNodes: baseStaticNodes };
    const result = inspectNode(inspection, "prepare", []);

    expect(result.target).toEqual({ kind: "static-node", id: "prepare" });
    expect(result.staticNode).toEqual({ nodeId: "prepare", kind: "task", order: 0 });
    expect(result.summary).toMatchObject({
      targetKind: "static-node",
      targetId: "prepare",
      runStatus: "running",
      nodeId: "prepare",
      staticKind: "task",
      staticOrder: 0,
    });
    expect(result.instances).toHaveLength(0);
    expect(result.attempts).toHaveLength(0);
  });

  it("classifies a dynamic node instance target", () => {
    const inspection: RunInspection = {
      run: {
        ...baseRun,
        dynamic: {
          version: 3,
          progressVersion: 0,
          progress: [],
          frames: [],
          nodeInstances: [
            { nodeKey: "review:1", nodeId: "review", status: "running", createdAt: "t", updatedAt: "t" },
          ],
          attempts: [],
          groupMembers: [],
          signalWaits: [],
          executionMetadata: [],
        },
      },
      staticNodes: baseStaticNodes,
    };

    const result = inspectNode(inspection, "review:1", []);
    expect(result.target).toEqual({ kind: "dynamic-node", id: "review:1" });
    expect(result.instances).toHaveLength(1);
    expect(result.instances[0]!.nodeKey).toBe("review:1");
    expect(result.summary).toMatchObject({
      targetKind: "dynamic-node",
      nodeId: "review",
      nodeKey: "review:1",
      nodeStatus: "running",
    });
  });

  it("classifies a frame target", () => {
    const inspection: RunInspection = {
      run: {
        ...baseRun,
        dynamic: {
          version: 3,
          progressVersion: 0,
          progress: [],
          frames: [
            { frameKey: "review-frame", nodeId: "review", nodeKey: "review:1", frameKind: "node", status: "running", createdAt: "t", updatedAt: "t" },
          ],
          nodeInstances: [],
          attempts: [],
          groupMembers: [],
          signalWaits: [],
          executionMetadata: [],
        },
      },
      staticNodes: baseStaticNodes,
    };

    const result = inspectNode(inspection, "review-frame", []);
    expect(result.target).toEqual({ kind: "frame", id: "review-frame" });
    expect(result.frames).toHaveLength(1);
  });

  it("summarizes persisted loop progress from loop frames", () => {
    const inspection: RunInspection = {
      run: {
        ...baseRun,
        dynamic: {
          version: 3,
          progressVersion: 0,
          progress: [],
          frames: [
            {
              frameKey: "retry",
              nodeId: "retry",
              frameKind: "loop",
              status: "completed",
              loop: {
                iter: 1,
                index: 1,
                round: 2,
                state: { ready: true, draft: "final" },
                transition: { state: { ready: true, draft: "final" }, stop: true },
              },
              createdAt: "2026-07-01T00:00:00.000Z",
              updatedAt: "2026-07-01T00:00:02.000Z",
            },
            {
              frameKey: "retry#1",
              nodeId: "retry",
              frameKind: "loop_iteration",
              status: "completed",
              instancePath: [{ kind: "loop", nodeId: "retry", iter: 1 }],
              scope: { refine_round: "retry#1/refine_round" },
              createdAt: "2026-07-01T00:00:01.000Z",
              updatedAt: "2026-07-01T00:00:02.000Z",
            },
          ],
          nodeInstances: [],
          attempts: [],
          groupMembers: [],
          signalWaits: [],
          executionMetadata: [],
        },
      },
      staticNodes: [{ nodeId: "retry", kind: "loop", order: 0 }],
    };

    const result = inspectNode(inspection, "retry", []);
    expect(result.summary.loopProgress).toEqual({
      frameKey: "retry",
      index: 1,
      round: 2,
      state: { ready: true, draft: "final" },
      stop: true,
      transition: { state: { ready: true, draft: "final" }, stop: true },
      activeIterationFrameKey: "retry#1",
      activeChildNodeKeys: ["retry#1/refine_round"],
    });
  });

  it("classifies an attempt target", () => {
    const inspection: RunInspection = {
      run: {
        ...baseRun,
        dynamic: {
          version: 3,
          progressVersion: 0,
          progress: [],
          frames: [],
          nodeInstances: [],
          attempts: [
            { attemptId: "a1", nodeKey: "prepare", nodeId: "prepare", attemptNo: 1, status: "completed", startedAt: "t", finishedAt: "t" },
          ],
          groupMembers: [],
          signalWaits: [],
          executionMetadata: [],
        },
      },
      staticNodes: baseStaticNodes,
    };

    const result = inspectNode(inspection, "a1", []);
    expect(result.target).toEqual({ kind: "attempt", id: "a1" });
    expect(result.attempts).toHaveLength(1);
  });

  it("returns unknown target for unmatched id", () => {
    const inspection: RunInspection = { run: baseRun, staticNodes: baseStaticNodes };
    const result = inspectNode(inspection, "nonexistent", []);

    expect(result.target).toEqual({ kind: "unknown", id: "nonexistent" });
    expect(result.staticNode).toBeUndefined();
    expect(result.instances).toHaveLength(0);
  });

  it("filters execution metadata by attempt id", () => {
    const inspection: RunInspection = {
      run: {
        ...baseRun,
        dynamic: {
          version: 3,
          progressVersion: 0,
          progress: [],
          frames: [],
          nodeInstances: [],
          attempts: [
            { attemptId: "a1", nodeKey: "prepare", nodeId: "prepare", attemptNo: 1, status: "completed", startedAt: "t", finishedAt: "t" },
          ],
          groupMembers: [],
          signalWaits: [],
          executionMetadata: [
            { id: 0, attemptId: "a1", kind: "token", metadata: {}, createdAt: "t" },
            { id: 1, attemptId: "a2", kind: "timing", metadata: {}, createdAt: "t" },
          ],
        },
      },
      staticNodes: baseStaticNodes,
    };

    const result = inspectNode(inspection, "a1", []);
    expect(result.executionMetadata).toHaveLength(1);
    expect(result.executionMetadata[0]!.kind).toBe("token");
  });

  it("finds signal waits for a node", () => {
    const inspection: RunInspection = {
      run: {
        ...baseRun,
        dynamic: {
          version: 3,
          progressVersion: 0,
          progress: [],
          frames: [],
          nodeInstances: [],
          attempts: [],
          groupMembers: [],
          signalWaits: [
            { nodeKey: "review:1", nodeId: "review", status: "awaiting", createdAt: "t", updatedAt: "t" },
          ],
          executionMetadata: [],
        },
      },
      staticNodes: baseStaticNodes,
    };

    const result = inspectNode(inspection, "review", []);
    expect(result.signalWaits).toHaveLength(1);
    expect(result.signalWaits[0]!.status).toBe("awaiting");
  });

  it("summarizes output, latest attempt, signal prompt, and leaf artifacts", () => {
    const inspection: RunInspection = {
      run: {
        ...baseRun,
        dynamic: {
          version: 3,
          progressVersion: 0,
          progress: [],
          frames: [],
          nodeInstances: [
            { nodeKey: "review:1", nodeId: "review", status: "completed", output: { ok: true }, createdAt: "2026-07-01T00:00:01.000Z", updatedAt: "2026-07-01T00:00:04.000Z" },
          ],
          attempts: [
            { attemptId: "a1", nodeKey: "review:1", nodeId: "review", attemptNo: 1, status: "completed", result: { ok: true }, startedAt: "2026-07-01T00:00:02.000Z", finishedAt: "2026-07-01T00:00:03.000Z" },
          ],
          groupMembers: [],
          signalWaits: [
            { nodeKey: "review:1", nodeId: "review", status: "awaiting", renderedPrompt: "Approve?", createdAt: "2026-07-01T00:00:02.000Z", updatedAt: "2026-07-01T00:00:03.000Z" },
          ],
          executionMetadata: [],
        },
      },
      staticNodes: baseStaticNodes,
    };

    const result = inspectNode(inspection, "review", [
      { id: "artifact_prompt", runId: "run_1", nodeKey: "review:1", attempt: 1, mediaType: "text/markdown", digest: "sha256:a", size: 12, relativePath: "agents/review/prompt.md" },
    ]);

    expect(result.summary).toMatchObject({
      nodeId: "review",
      nodeKey: "review:1",
      nodeStatus: "completed",
      output: { ok: true },
      prompt: { kind: "signal", text: "Approve?" },
      latestAttempt: { attemptId: "a1", attemptNo: 1, status: "completed", result: { ok: true } },
    });
    expect(result.summary.artifacts).toHaveLength(1);
  });

  it("falls back to authored agent prompt when no runtime prompt artifact exists", () => {
    const inspection: RunInspection = {
      run: baseRun,
      staticNodes: [
        {
          nodeId: "review",
          kind: "agent",
          order: 0,
          prompt: { kind: "template", parts: [{ kind: "text", value: "Review release" }] },
        },
      ],
    };

    const result = inspectNode(inspection, "review", []);

    expect(result.summary.prompt).toEqual({
      kind: "authored",
      text: "Review release",
    });
  });

  it("omits artifacts for composite static nodes", () => {
    const inspection: RunInspection = {
      run: baseRun,
      staticNodes: [{ nodeId: "gate", kind: "if", order: 0 }],
    };
    const result = inspectNode(inspection, "gate", [
      { id: "artifact_1", runId: "run_1", nodeKey: "gate", attempt: 1, mediaType: "application/json", digest: "sha256:a", size: 10, relativePath: "gate/result.json" },
    ]);

    expect(result.summary.artifacts).toEqual([]);
  });

  it("scopes static node inspection to the selected fanout item", () => {
    const inspection: RunInspection = {
      run: {
        ...baseRun,
        status: "completed",
        dynamic: {
          version: 3,
          progressVersion: 0,
          progress: [],
          frames: [],
          nodeInstances: [
            {
              nodeKey: "opaque-auto",
              nodeId: "auto_route",
              status: "completed",
              output: { route: "auto-fast" },
              instancePath: [{ kind: "fanout", nodeId: "lanes", itemIndex: 0 }, { kind: "node", nodeId: "auto_route" }],
              createdAt: "2026-07-01T00:00:01.000Z",
              updatedAt: "2026-07-01T00:00:04.000Z",
            },
            {
              nodeKey: "opaque-manual",
              nodeId: "manual_route",
              status: "completed",
              output: { route: "manual" },
              instancePath: [{ kind: "fanout", nodeId: "lanes", itemIndex: 1 }, { kind: "node", nodeId: "manual_route" }],
              createdAt: "2026-07-01T00:00:01.000Z",
              updatedAt: "2026-07-01T00:00:04.000Z",
            },
          ],
          attempts: [
            { attemptId: "attempt_auto", nodeKey: "opaque-auto", nodeId: "auto_route", attemptNo: 1, status: "completed", result: { route: "auto-fast" }, startedAt: "2026-07-01T00:00:02.000Z", finishedAt: "2026-07-01T00:00:03.000Z" },
            { attemptId: "attempt_manual", nodeKey: "opaque-manual", nodeId: "manual_route", attemptNo: 1, status: "completed", result: { route: "manual" }, startedAt: "2026-07-01T00:00:02.000Z", finishedAt: "2026-07-01T00:00:03.000Z" },
          ],
          groupMembers: [],
          signalWaits: [],
          executionMetadata: [
            { id: 1, attemptId: "attempt_manual", kind: "task_attempt", metadata: { input: { lane: "beta" } }, createdAt: "2026-07-01T00:00:02.000Z" },
          ],
        },
      },
      staticNodes: [
        { nodeId: "auto_route", kind: "task", order: 0 },
        { nodeId: "manual_route", kind: "task", order: 1 },
      ],
    };

    const betaContext = [{ nodeId: "lanes", kind: "fanout" as const, itemIndex: 1 }];
    const autoInBeta = inspectNode(inspection, "auto_route", [], betaContext);
    expect(autoInBeta.summary).toMatchObject({
      nodeId: "auto_route",
      nodeStatus: "not_started",
    });
    expect(autoInBeta.summary.output).toBeUndefined();
    expect(autoInBeta.attempts).toEqual([]);

    const manualInBeta = inspectNode(inspection, "manual_route", [
      { id: "manual_artifact", runId: "run_1", nodeKey: "opaque-manual", attempt: 1, mediaType: "application/json", digest: "sha256:a", size: 10, relativePath: "manual/result.json" },
    ], betaContext);
    expect(manualInBeta.summary).toMatchObject({
      nodeKey: "opaque-manual",
      output: { route: "manual" },
      input: { kind: "runtime", value: { lane: "beta" } },
    });
    expect(manualInBeta.summary.artifacts.map(artifact => artifact.id)).toEqual(["manual_artifact"]);
  });

  it("returns selected-scope agent execution summary", async () => {
    const inspection: RunInspection = {
      run: {
        ...baseRun,
        dynamic: {
          version: 3,
          progressVersion: 0,
          progress: [],
          frames: [],
          nodeInstances: [
            {
              nodeKey: "agent-alpha",
              nodeId: "reviewer_agent",
              status: "completed",
              instancePath: [{ kind: "fanout", nodeId: "lanes", itemIndex: 0 }, { kind: "node", nodeId: "reviewer_agent" }],
              createdAt: "t",
              updatedAt: "t",
            },
            {
              nodeKey: "agent-beta",
              nodeId: "reviewer_agent",
              status: "completed",
              instancePath: [{ kind: "fanout", nodeId: "lanes", itemIndex: 1 }, { kind: "node", nodeId: "reviewer_agent" }],
              createdAt: "t",
              updatedAt: "t",
            },
          ],
          attempts: [
            { attemptId: "attempt_alpha", nodeKey: "agent-alpha", nodeId: "reviewer_agent", attemptNo: 1, status: "completed", startedAt: "t" },
            { attemptId: "attempt_beta", nodeKey: "agent-beta", nodeId: "reviewer_agent", attemptNo: 1, status: "completed", startedAt: "t" },
          ],
          groupMembers: [],
          signalWaits: [],
          executionMetadata: [
            { id: 1, attemptId: "attempt_alpha", kind: "agent_attempt", metadata: { status: "completed", turns: [{ turn: 1, telemetry: { tokenUsage: { totalTokens: 1 } } }] }, createdAt: "t1" },
            { id: 2, attemptId: "attempt_beta", kind: "agent_attempt", metadata: { status: "completed", turns: [{ turn: 1, telemetry: { tokenUsage: { totalTokens: 2 } } }] }, createdAt: "t2" },
          ],
        },
      },
      staticNodes: [{ nodeId: "reviewer_agent", kind: "agent", order: 0 }],
    };

    const betaExecution = await inspectNodeExecution(inspection, "reviewer_agent", [
      { nodeId: "lanes", kind: "fanout", itemIndex: 1 },
    ]);

    expect(betaExecution).toMatchObject({
      nodeKey: "agent-beta",
      attemptId: "attempt_beta",
      available: true,
      summary: { status: "completed" },
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 2 },
      lastToolCalls: [],
    });
    expect(betaExecution).not.toHaveProperty("turns");
    expect(betaExecution).not.toHaveProperty("metadata");
  });

  it("returns selected-scope agent progress", async () => {
    const inspection: RunInspection = {
      run: {
        ...baseRun,
        dynamic: {
          version: 3,
          progressVersion: 2,
          progress: [
            { nodeKey: "agent-alpha", nodeId: "reviewer_agent", attemptId: "attempt_alpha", attemptNo: 1, kind: "agent", status: "running", output: { tail: "alpha", totalBytes: 5, truncated: false }, updatedAt: "t3" },
            { nodeKey: "agent-beta", nodeId: "reviewer_agent", attemptId: "attempt_beta", attemptNo: 1, kind: "agent", status: "running", output: { tail: "beta", totalBytes: 4, truncated: false }, tokenUsage: { totalTokens: 2 }, updatedAt: "t2" },
          ],
          frames: [],
          nodeInstances: [
            {
              nodeKey: "agent-alpha",
              nodeId: "reviewer_agent",
              status: "running",
              instancePath: [{ kind: "fanout", nodeId: "lanes", itemIndex: 0 }, { kind: "node", nodeId: "reviewer_agent" }],
              createdAt: "t",
              updatedAt: "t",
            },
            {
              nodeKey: "agent-beta",
              nodeId: "reviewer_agent",
              status: "running",
              instancePath: [{ kind: "fanout", nodeId: "lanes", itemIndex: 1 }, { kind: "node", nodeId: "reviewer_agent" }],
              createdAt: "t",
              updatedAt: "t",
            },
          ],
          attempts: [
            { attemptId: "attempt_alpha", nodeKey: "agent-alpha", nodeId: "reviewer_agent", attemptNo: 1, status: "started", startedAt: "t" },
            { attemptId: "attempt_beta", nodeKey: "agent-beta", nodeId: "reviewer_agent", attemptNo: 1, status: "started", startedAt: "t" },
          ],
          groupMembers: [],
          signalWaits: [],
          executionMetadata: [],
        },
      },
      staticNodes: [{ nodeId: "reviewer_agent", kind: "agent", order: 0 }],
    };

    const betaExecution = await inspectNodeExecution(inspection, "reviewer_agent", [
      { nodeId: "lanes", kind: "fanout", itemIndex: 1 },
    ]);

    expect(betaExecution).toMatchObject({
      nodeKey: "agent-beta",
      attemptId: "attempt_beta",
      available: true,
      summary: { status: "running" },
      output: { tail: "beta" },
      tokenUsage: { totalTokens: 2 },
    });
  });

  it("does not use newer retry progress when inspecting an older agent attempt", async () => {
    const inspection: RunInspection = {
      run: {
        ...baseRun,
        dynamic: {
          version: 3,
          progressVersion: 2,
          progress: [{
            nodeKey: "agent-key",
            nodeId: "reviewer_agent",
            attemptId: "attempt_2",
            attemptNo: 2,
            kind: "agent",
            status: "running",
            output: { tail: "new attempt", totalBytes: 11, truncated: false },
            updatedAt: "t2",
          }],
          frames: [],
          nodeInstances: [
            { nodeKey: "agent-key", nodeId: "reviewer_agent", status: "running", createdAt: "t", updatedAt: "t" },
          ],
          attempts: [
            { attemptId: "attempt_1", nodeKey: "agent-key", nodeId: "reviewer_agent", attemptNo: 1, status: "failed", startedAt: "t1", finishedAt: "t1" },
            { attemptId: "attempt_2", nodeKey: "agent-key", nodeId: "reviewer_agent", attemptNo: 2, status: "started", startedAt: "t2" },
          ],
          groupMembers: [],
          signalWaits: [],
          executionMetadata: [
            { id: 1, attemptId: "attempt_1", kind: "agent_attempt", metadata: { status: "failed", message: "first failed" }, createdAt: "t1" },
          ],
        },
      },
      staticNodes: [{ nodeId: "reviewer_agent", kind: "agent", order: 0 }],
    };

    const execution = await inspectNodeExecution(inspection, "attempt_1");

    expect(execution).toMatchObject({
      target: { kind: "attempt", id: "attempt_1" },
      attemptId: "attempt_1",
      available: true,
      summary: { status: "failed", message: "first failed" },
    });
    expect(execution).not.toHaveProperty("output");
  });

  it("summarizes progress-derived agent telemetry", async () => {
    const inspection: RunInspection = {
      run: {
        ...baseRun,
        dynamic: {
          version: 3,
          progressVersion: 1,
          progress: [{
            nodeKey: "agent-key",
            nodeId: "reviewer_agent",
            attemptId: "attempt_agent",
            attemptNo: 1,
            kind: "agent",
            status: "running",
            message: "reviewing",
            context: { used: 50, size: 200, updatedAt: "2026-07-01T00:00:02.000Z" },
            tokenUsage: { source: "prompt_response", inputTokens: 10, outputTokens: 3, totalTokens: 13 },
            tools: {
              turn: 2,
              totalToolCallCount: 4,
              lastCalls: [
                { toolCallId: "b", toolName: "Read", status: "completed", inputPreview: "README.md" },
                { toolCallId: "c", toolName: "Bash", status: "running", inputPreview: "pnpm test" },
              ],
            },
            updatedAt: "2026-07-01T00:00:02.000Z",
          }],
          frames: [],
          nodeInstances: [
            { nodeKey: "agent-key", nodeId: "reviewer_agent", status: "running", createdAt: "t", updatedAt: "t" },
          ],
          attempts: [
            { attemptId: "attempt_agent", nodeKey: "agent-key", nodeId: "reviewer_agent", attemptNo: 1, status: "started", startedAt: "t" },
          ],
          groupMembers: [],
          signalWaits: [],
          executionMetadata: [],
        },
      },
      staticNodes: [{ nodeId: "reviewer_agent", kind: "agent", order: 0 }],
    };

    const execution = await inspectNodeExecution(inspection, "reviewer_agent");

    expect(execution).toMatchObject({
      available: true,
      summary: { status: "running", message: "reviewing" },
      lastActiveAt: "2026-07-01T00:00:02.000Z",
      contextWindow: { used: 50, size: 200, percent: 25, updatedAt: "2026-07-01T00:00:02.000Z" },
      tokenUsage: { source: "prompt_response", inputTokens: 10, outputTokens: 3, totalTokens: 13 },
      toolCallCount: 4,
      lastToolCalls: [
        { turn: 2, toolCallId: "b", toolName: "Read", inputPreview: "README.md" },
        { turn: 2, toolCallId: "c", toolName: "Bash", status: "running", inputPreview: "pnpm test" },
      ],
    });
  });

  it("keeps multi-turn metadata aggregates when terminal progress contains only the final turn", async () => {
    const inspection: RunInspection = {
      run: {
        ...baseRun,
        dynamic: {
          version: 3,
          progressVersion: 1,
          progress: [{
            nodeKey: "agent-key",
            nodeId: "reviewer_agent",
            attemptId: "attempt_agent",
            attemptNo: 1,
            kind: "agent",
            status: "completed",
            tokenUsage: { source: "prompt_response", inputTokens: 20, outputTokens: 3, totalTokens: 23 },
            tools: {
              turn: 2,
              totalToolCallCount: 1,
              lastCalls: [{ toolCallId: "c", toolName: "Bash", status: "completed", inputPreview: "pnpm test" }],
            },
            updatedAt: "2026-07-01T00:00:03.000Z",
          }],
          frames: [],
          nodeInstances: [
            { nodeKey: "agent-key", nodeId: "reviewer_agent", status: "completed", createdAt: "t", updatedAt: "t" },
          ],
          attempts: [
            { attemptId: "attempt_agent", nodeKey: "agent-key", nodeId: "reviewer_agent", attemptNo: 1, status: "completed", startedAt: "t" },
          ],
          groupMembers: [],
          signalWaits: [],
          executionMetadata: [
            {
              id: 1,
              attemptId: "attempt_agent",
              kind: "agent_attempt",
              metadata: {
                status: "completed",
                turnCount: 2,
                turns: [
                  { turn: 1, telemetry: { tokenUsage: { source: "prompt_response", inputTokens: 10, outputTokens: 2, totalTokens: 12 }, tools: { totalToolCallCount: 2 } }, telemetryArtifact: { relativePath: "turn-001.telemetry.json" } },
                  { turn: 2, telemetry: { tokenUsage: { source: "prompt_response", inputTokens: 20, outputTokens: 3, totalTokens: 23 }, tools: { totalToolCallCount: 1 } }, telemetryArtifact: { relativePath: "turn-002.telemetry.json" } },
                ],
              },
              createdAt: "t2",
            },
          ],
        },
      },
      staticNodes: [{ nodeId: "reviewer_agent", kind: "agent", order: 0 }],
    };

    const execution = await inspectNodeExecution(inspection, "reviewer_agent", [], async artifact => {
      const path = (artifact as { relativePath?: string } | undefined)?.relativePath;
      return {
        telemetry: {
          tools: {
            calls: path?.includes("001")
              ? [
                { toolCallId: "a", toolName: "Read", status: "completed", input: { preview: "README.md" } },
                { toolCallId: "b", toolName: "Write", status: "completed", input: { preview: "notes.md" } },
              ]
              : [{ toolCallId: "c", toolName: "Bash", status: "completed", input: { preview: "pnpm test" } }],
          },
        },
      };
    });

    expect(execution).toMatchObject({
      summary: { status: "completed", turnCount: 2 },
      tokenUsage: { source: "prompt_response", inputTokens: 30, outputTokens: 5, totalTokens: 35 },
      toolCallCount: 3,
      lastToolCalls: [
        { turn: 1, toolCallId: "a", toolName: "Read" },
        { turn: 1, toolCallId: "b", toolName: "Write" },
        { turn: 2, toolCallId: "c", toolName: "Bash" },
      ],
    });
  });

  it("does not mix stale attempt metadata with newer progress", async () => {
    const inspection: RunInspection = {
      run: {
        ...baseRun,
        dynamic: {
          version: 3,
          progressVersion: 2,
          progress: [{
            nodeKey: "agent-key",
            nodeId: "reviewer_agent",
            attemptId: "attempt_2",
            attemptNo: 2,
            kind: "agent",
            status: "running",
            output: { tail: "running", totalBytes: 7, truncated: false },
            tokenUsage: { totalTokens: 2 },
            tools: {
              turn: 1,
              totalToolCallCount: 1,
              lastCalls: [{ toolCallId: "new", toolName: "Bash", status: "running" }],
            },
            updatedAt: "t2",
          }],
          frames: [],
          nodeInstances: [
            { nodeKey: "agent-key", nodeId: "reviewer_agent", status: "running", createdAt: "t2", updatedAt: "t2" },
          ],
          attempts: [
            { attemptId: "attempt_1", nodeKey: "agent-key", nodeId: "reviewer_agent", attemptNo: 1, status: "failed", startedAt: "t1", finishedAt: "t1" },
            { attemptId: "attempt_2", nodeKey: "agent-key", nodeId: "reviewer_agent", attemptNo: 2, status: "started", startedAt: "t2" },
          ],
          groupMembers: [],
          signalWaits: [],
          executionMetadata: [
            {
              id: 1,
              attemptId: "attempt_1",
              kind: "agent_attempt",
              metadata: {
                status: "failed",
                turns: [
                  { turn: 1, telemetry: { tokenUsage: { totalTokens: 99 }, tools: { totalToolCallCount: 9 } } },
                ],
              },
              createdAt: "t1",
            },
          ],
        },
      },
      staticNodes: [{ nodeId: "reviewer_agent", kind: "agent", order: 0 }],
    };

    const execution = await inspectNodeExecution(inspection, "reviewer_agent");

    expect(execution).toMatchObject({
      attemptId: "attempt_2",
      summary: { status: "running" },
      lastActiveAt: "t2",
      output: { tail: "running" },
      tokenUsage: { totalTokens: 2 },
      toolCallCount: 1,
      lastToolCalls: [{ turn: 1, toolCallId: "new", toolName: "Bash", status: "running" }],
    });
  });

  it("summarizes latest agent context, token usage, and last three tool calls", async () => {
    const inspection: RunInspection = {
      run: {
        ...baseRun,
        dynamic: {
          version: 3,
          progressVersion: 0,
          progress: [],
          frames: [],
          nodeInstances: [
            { nodeKey: "agent-key", nodeId: "reviewer_agent", status: "completed", createdAt: "t", updatedAt: "t" },
          ],
          attempts: [
            { attemptId: "attempt_agent", nodeKey: "agent-key", nodeId: "reviewer_agent", attemptNo: 1, status: "completed", startedAt: "t" },
          ],
          groupMembers: [],
          signalWaits: [],
          executionMetadata: [
            {
              id: 1,
              attemptId: "attempt_agent",
              kind: "agent_attempt",
              metadata: {
                status: "completed",
                sessionName: "session-1",
                turnCount: 2,
                turns: [
                  {
                    turn: 1,
                    telemetry: {
                      context: { used: 80, size: 200, updatedAt: "2026-07-01T00:00:01.000Z" },
                      tokenUsage: { source: "prompt_response", inputTokens: 10, outputTokens: 2, totalTokens: 12 },
                      tools: { totalToolCallCount: 2 },
                    },
                    telemetryArtifact: { relativePath: "turn-001.telemetry.json" },
                  },
                  {
                    turn: 2,
                    telemetry: {
                      context: { used: 120, size: 240, updatedAt: "2026-07-01T00:00:02.000Z" },
                      tokenUsage: { source: "prompt_response", inputTokens: 20, outputTokens: 3, totalTokens: 23 },
                      tools: { totalToolCallCount: 2 },
                    },
                    telemetryArtifact: { relativePath: "turn-002.telemetry.json" },
                  },
                ],
              },
              createdAt: "t2",
            },
          ],
        },
      },
      staticNodes: [{ nodeId: "reviewer_agent", kind: "agent", order: 0 }],
    };

    const execution = await inspectNodeExecution(inspection, "reviewer_agent", [], async artifact => {
      const path = (artifact as { relativePath?: string } | undefined)?.relativePath;
      return {
        telemetry: {
          tools: {
            calls: path?.includes("001")
              ? [
                { toolCallId: "a", toolName: "Read", status: "completed", input: { preview: "README.md" }, startedAt: "2026-07-01T00:00:00.000Z", completedAt: "2026-07-01T00:00:01.000Z" },
                { toolCallId: "b", toolName: "Write", status: "completed", input: { preview: "notes.md" } },
              ]
              : [
                { toolCallId: "c", toolName: "Bash", status: "failed", input: { preview: "pnpm test" } },
                { toolCallId: "d", toolName: "Read", status: "completed", input: { preview: "package.json" } },
              ],
          },
        },
      };
    });

    expect(execution).toMatchObject({
      summary: { status: "completed", sessionName: "session-1", turnCount: 2 },
      available: true,
      contextWindow: { used: 120, size: 240, percent: 50, updatedAt: "2026-07-01T00:00:02.000Z" },
      tokenUsage: { source: "prompt_response", inputTokens: 30, outputTokens: 5, totalTokens: 35 },
      toolCallCount: 4,
      lastToolCalls: [
        { turn: 1, toolCallId: "b", toolName: "Write" },
        { turn: 2, toolCallId: "c", toolName: "Bash", status: "failed" },
        { turn: 2, toolCallId: "d", toolName: "Read", inputPreview: "package.json" },
      ],
    });
  });

  it("returns one unavailable state when selected agent has no attempt metadata", async () => {
    const inspection: RunInspection = {
      run: baseRun,
      staticNodes: [{ nodeId: "reviewer_agent", kind: "agent", order: 0 }],
    };

    const execution = await inspectNodeExecution(inspection, "reviewer_agent");

    expect(execution).toMatchObject({
      nodeId: "reviewer_agent",
      available: false,
      reason: "No agent execution metadata exists for the selected scope.",
      summary: {},
      lastToolCalls: [],
    });
  });
});
