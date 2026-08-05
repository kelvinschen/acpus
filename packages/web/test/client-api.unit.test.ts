import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExprIR, StaticExprShape } from "@acpus/expression/ir";
import type { SchemaIR, WorkflowIR } from "@acpus/core/ir";
import {
  getArtifactPreview,
  getConfig,
  getHealth,
  getNodeExecutionInspection,
  getNodeInspection,
  getRunRuntimeSnapshot,
  listRuns,
  listWorkflowCatalog,
  listWorkflowFiles,
  submitRunCommand,
  visualizeWorkflow,
  WebApiError,
  type NodeExecutionInspection,
  type NodeInspection,
  type RunDetails,
  type WorkflowVisualizationResult,
} from "../src/client/api.js";
import type { WebGraph } from "../src/graph-types.js";
import { workflowIrToWebGraph } from "../src/server/graph.js";

type ReadyVisualization = Extract<WorkflowVisualizationResult, { status: "ready" }>;

describe("Web API transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps network failures distinct from server responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection lost")));

    await expect(listRuns()).rejects.toMatchObject({
      failure: { type: "network-failed", message: "connection lost" },
    });
  });

  it("preserves a valid server error envelope", async () => {
    respondJson({
      ok: false,
      error: { code: "store_busy", message: "Try again." },
    }, 503);

    await expect(listRuns()).rejects.toMatchObject({
      failure: { type: "request-failed", status: 503, code: "store_busy", message: "Try again." },
    });
  });

  it("rejects an HTML error body as invalid JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>failed</html>", { status: 500 })));

    await expect(listRuns()).rejects.toMatchObject({
      failure: { type: "response-invalid-json", status: 500 },
    });
  });

  it("rejects a non-object success envelope", async () => {
    respondJson([]);

    const failure = await listRuns().catch(error => error);
    expect(failure).toBeInstanceOf(WebApiError);
    expect(failure.failure).toMatchObject({ type: "response-invalid-envelope", status: 200 });
  });

  it("uses the canonical target in node-inspection URLs without a context query", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      inspection: nodeInspection(),
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await getNodeInspection("run 1", "@1a2b3c4d5e6f");

    expect(fetch).toHaveBeenCalledWith(
      "/api/runs/run%201/nodes/%401a2b3c4d5e6f",
      undefined,
    );
  });

  it.each(successCases())("decodes the canonical $name result", async ({ call, body, expected }) => {
    respondJson(body);

    await expect(call()).resolves.toEqual(expected);
  });

  it.each(malformedEndpointCases())("rejects a malformed nested $name result", async ({ call, body }) => {
    respondJson(body);

    await expect(call()).rejects.toMatchObject({
      failure: { type: "response-invalid-envelope", status: 200 },
    });
  });

  it("accepts a canonical visualization failure branch", async () => {
    const result = {
      status: "failed",
      phase: "source",
      message: "Workflow must be inside its source root.",
    } as const;
    respondJson({ ok: true, result });

    await expect(visualizeWorkflow({ kind: "file", path: "workflow.ts" })).resolves.toEqual(result);
  });

  it.each([
    ["unknown discriminant", { status: "unknown", message: "ignored" }],
    ["invalid failure phase", { status: "failed", phase: "bundle", message: "failed" }],
    ["invalid failure message", { status: "failed", phase: "source", message: 42 }],
  ])("rejects a visualization %s", async (_name, result) => {
    respondJson({ ok: true, result });

    await expect(visualizeWorkflow({ kind: "file", path: "workflow.ts" })).rejects.toMatchObject({
      failure: { type: "response-invalid-envelope", status: 200 },
    });
  });

  it.each(malformedVisualizationCases())("rejects a ready visualization with $name", async ({ body }) => {
    respondJson(body);

    await expect(visualizeWorkflow({ kind: "file", path: "workflow.ts" })).rejects.toMatchObject({
      failure: { type: "response-invalid-envelope", status: 200 },
    });
  });

  it("rejects a non-finite SchemaIR default produced by JSON parsing", async () => {
    const result = readyVisualization();
    result.contract.inputSchema = {
      kind: "number",
      default: "__overflow_number__",
    };
    const body = JSON.stringify({ ok: true, result })
      .replace('"__overflow_number__"', "1e400");
    respondText(body);

    await expect(visualizeWorkflow({ kind: "file", path: "workflow.ts" })).rejects.toMatchObject({
      failure: { type: "response-invalid-envelope", status: 200 },
    });
  });

  it("rejects non-finite structured failure data produced by JSON parsing", async () => {
    const inspection = nodeInspection();
    inspection.failure!.upstream!.data = "__overflow_number__";
    const body = JSON.stringify({ ok: true, inspection })
      .replace('"__overflow_number__"', "1e400");
    respondText(body);

    await expect(getNodeInspection("run_1", "review")).rejects.toMatchObject({
      failure: { type: "response-invalid-envelope", status: 200 },
    });
  });

  it("classifies an excessively deep result shape as an invalid envelope", async () => {
    const result = readyVisualization();
    result.contract.output = { kind: "literal", value: "__deep_expression__" };
    const marker = JSON.stringify(result.contract.output);
    const depth = 20_000;
    const nestedExpression = '{"kind":"array","items":['.repeat(depth)
      + '{"kind":"literal","value":true}'
      + "]}".repeat(depth);
    const body = JSON.stringify({ ok: true, result }).replace(marker, nestedExpression);
    respondText(body);

    await expect(visualizeWorkflow({ kind: "file", path: "workflow.ts" })).rejects.toMatchObject({
      failure: { type: "response-invalid-envelope", status: 200 },
    });
  });

  it.each(validExpressions())("accepts the $name output-expression branch", async ({ output }) => {
    const result = readyVisualization();
    result.contract.output = output;
    respondJson({ ok: true, result });

    await expect(visualizeWorkflow({ kind: "file", path: "workflow.ts" })).resolves.toEqual(result);
  });

  it.each(validSchemas())("accepts the $name input-schema branch", async ({ schema }) => {
    const result = readyVisualization();
    result.contract.inputSchema = schema;
    respondJson({ ok: true, result });

    await expect(visualizeWorkflow({ kind: "file", path: "workflow.ts" })).resolves.toEqual(result);
  });

  it.each(validStaticShapes())("accepts the $name static-expression shape", async ({ shape }) => {
    const result = readyVisualization();
    result.contract.outputShape = shape;
    respondJson({ ok: true, result });

    await expect(visualizeWorkflow({ kind: "file", path: "workflow.ts" })).resolves.toEqual(result);
  });

  it.each(malformedInspectionCases())("rejects node inspection with $name", async ({ inspection }) => {
    respondJson({ ok: true, inspection });

    await expect(getNodeInspection("run_1", "review")).rejects.toMatchObject({
      failure: { type: "response-invalid-envelope", status: 200 },
    });
  });

  it.each(malformedExecutionCases())("rejects node execution with $name", async ({ execution }) => {
    respondJson({ ok: true, execution });

    await expect(getNodeExecutionInspection("run_1", "review")).rejects.toMatchObject({
      failure: { type: "response-invalid-envelope", status: 200 },
    });
  });

  it("rejects extra top-level node-inspection fields", async () => {
    const inspection = {
      ...nodeInspection(),
      implementationState: { private: true },
    };
    respondJson({ ok: true, inspection });

    await expect(getNodeInspection("run_1", "review")).rejects.toMatchObject({
      failure: { type: "response-invalid-envelope", status: 200 },
    });
  });

  it("preserves the server error envelope for artifact previews", async () => {
    respondJson({
      ok: false,
      error: { code: "artifact_corrupt", message: "Artifact is corrupt." },
    }, 500);

    await expect(getArtifactPreview("run_1", "artifact_1")).rejects.toMatchObject({
      failure: { type: "request-failed", status: 500, code: "artifact_corrupt", message: "Artifact is corrupt." },
    });
  });
});

function successCases() {
  const health = {
    checks: [{ area: "daemon", status: "ok" as const, message: "ready" }],
  };
  const runs = [{ id: "run_1", name: "release", status: "running" }];
  const snapshot = {
    run: runDetails(),
    workflow: workflowContext(),
    graph: runtimeGraph(),
    controls: {
      canCancelRun: false,
      retryTargets: [{ target: "ship#node", kind: "node" as const, nodeId: "ship" }],
    },
  };
  const inspection = nodeInspection();
  const execution = nodeExecution();
  const catalog = [{ name: "release", entryPath: "/workspace/release/workflow.ts" }];
  const files = {
    dir: "nested",
    entries: [
      { name: "more", path: "nested/more", kind: "directory" as const },
      { name: "release.workflow.ts", path: "nested/release.workflow.ts", kind: "workflow" as const },
    ],
  };
  const result = readyVisualization();
  const config = { cwd: "/workspace", access: "token" as const };

  return [
    { name: "health", call: () => getHealth(), body: { ok: true, health }, expected: health },
    { name: "run list", call: () => listRuns(), body: { ok: true, runs }, expected: runs },
    { name: "runtime snapshot", call: () => getRunRuntimeSnapshot("run_1"), body: { ok: true, ...snapshot }, expected: snapshot },
    { name: "node inspection", call: () => getNodeInspection("run_1", "review"), body: { ok: true, inspection }, expected: inspection },
    { name: "node execution", call: () => getNodeExecutionInspection("run_1", "review"), body: { ok: true, execution }, expected: execution },
    { name: "control acknowledgement", call: () => submitRunCommand("run_1", { type: "pause" }), body: { ok: true }, expected: undefined },
    { name: "workflow catalog", call: () => listWorkflowCatalog(), body: { ok: true, catalog }, expected: catalog },
    { name: "workflow files", call: () => listWorkflowFiles("nested"), body: { ok: true, files }, expected: files },
    { name: "workflow visualization from the canonical graph producer", call: () => visualizeWorkflow({ kind: "catalog", name: "release" }), body: { ok: true, result }, expected: result },
    { name: "server config", call: () => getConfig(), body: { ok: true, config }, expected: config },
  ];
}

function malformedEndpointCases() {
  const run = runDetails();
  const graph = runtimeGraph();
  const inspection = nodeInspection();
  const execution = nodeExecution();
  return [
    {
      name: "health check status",
      call: () => getHealth(),
      body: { ok: true, health: { checks: [{ area: "daemon", status: "unknown", message: "?" }] } },
    },
    {
      name: "run-list status leaf",
      call: () => listRuns(),
      body: { ok: true, runs: [{ id: "run_1", name: "release", status: 42 }] },
    },
    {
      name: "runtime snapshot without required run input",
      call: () => getRunRuntimeSnapshot("run_1"),
      body: {
        ok: true,
        run: {
          id: run.id,
          name: run.name,
          status: run.status,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
          ...(run.runtimeVersion === undefined ? {} : { runtimeVersion: run.runtimeVersion }),
        },
        graph,
        controls: { canCancelRun: false, retryTargets: [] },
      },
    },
    {
      name: "runtime snapshot without workflow context",
      call: () => getRunRuntimeSnapshot("run_1"),
      body: {
        ok: true,
        run,
        graph,
        controls: { canCancelRun: false, retryTargets: [] },
      },
    },
    {
      name: "runtime snapshot with a malformed effective agent definition",
      call: () => getRunRuntimeSnapshot("run_1"),
      body: {
        ok: true,
        run,
        workflow: {
          ...workflowContext(),
          agents: { reviewer: { kind: "agent_definition", use: 42 } },
        },
        graph,
        controls: { canCancelRun: false, retryTargets: [] },
      },
    },
    {
      name: "runtime snapshot with a non-public retry target kind",
      call: () => getRunRuntimeSnapshot("run_1"),
      body: {
        ok: true,
        run,
        graph,
        controls: {
          canCancelRun: false,
          retryTargets: [{ target: "member_1", kind: "member" }],
        },
      },
    },
    {
      name: "runtime snapshot with a blank retry target",
      call: () => getRunRuntimeSnapshot("run_1"),
      body: {
        ok: true,
        run,
        graph,
        controls: {
          canCancelRun: false,
          retryTargets: [{ target: "  ", kind: "node" }],
        },
      },
    },
    {
      name: "node-inspection artifact path",
      call: () => getNodeInspection("run_1", "review"),
      body: {
        ok: true,
        inspection: {
          ...inspection,
          artifacts: [{ ...inspection.artifacts[0], path: 42 }],
        },
      },
    },
    {
      name: "node-execution tool-call turn",
      call: () => getNodeExecutionInspection("run_1", "review"),
      body: {
        ok: true,
        execution: {
          ...execution,
          recentTools: [{ ...execution.recentTools[0], turn: "one" }],
        },
      },
    },
    {
      name: "closed node-execution envelope",
      call: () => getNodeExecutionInspection("run_1", "review"),
      body: { ok: true, execution, private: true },
    },
    {
      name: "closed control acknowledgement",
      call: () => submitRunCommand("run_1", { type: "pause" }),
      body: { ok: true, result: "unexpected" },
    },
    {
      name: "workflow-catalog entry path",
      call: () => listWorkflowCatalog(),
      body: { ok: true, catalog: [{ name: "release", entryPath: 42 }] },
    },
    {
      name: "workflow-file entry kind",
      call: () => listWorkflowFiles(),
      body: { ok: true, files: { dir: "", entries: [{ name: "x", path: "x", kind: "file" }] } },
    },
    {
      name: "server-config access mode",
      call: () => getConfig(),
      body: { ok: true, config: { cwd: "/workspace", access: "admin" } },
    },
  ];
}

function malformedVisualizationCases() {
  const graph = runtimeGraph();
  const ready = readyVisualization();
  return [
    {
      name: "a malformed authored agent definition",
      body: {
        ok: true,
        result: {
          ...ready,
          workflow: {
            ...ready.workflow,
            agents: { reviewer: { kind: "agent_command", command: 42 } },
          },
        },
      },
    },
    {
      name: "a graph node without an inspection target",
      body: {
        ok: true,
        result: {
          ...ready,
          graph: {
            ...graph,
            nodes: [{ ...graph.nodes[0], target: undefined }, ...graph.nodes.slice(1)],
          },
        },
      },
    },
    {
      name: "an invalid graph detail discriminant",
      body: {
        ok: true,
        result: {
          ...ready,
          graph: {
            ...graph,
            nodes: [{
              ...graph.nodes[0],
              detail: { kind: "parallel", branches: [], strategy: "first" },
            }, ...graph.nodes.slice(1)],
          },
        },
      },
    },
    {
      name: "a legacy task inputs detail",
      body: {
        ok: true,
        result: {
          ...ready,
          graph: {
            ...graph,
            nodes: [{
              ...graph.nodes[0],
              detail: { kind: "task", inputs: ["release"], target: "inline" },
            }, ...graph.nodes.slice(1)],
          },
        },
      },
    },
    {
      name: "an invalid nested graph selection",
      body: {
        ok: true,
        result: {
          ...ready,
          graph: {
            ...graph,
            fanoutOccurrences: [{
              ...graph.fanoutOccurrences[0],
              context: [{ nodeId: "fanout", kind: "fanout", itemIndex: -1 }],
            }],
          },
        },
      },
    },
    {
      name: "an invalid output expression",
      body: {
        ok: true,
        result: {
          ...ready,
          contract: { ...ready.contract, output: { kind: "mystery" } },
        },
      },
    },
    {
      name: "an invalid input schema",
      body: {
        ok: true,
        result: {
          ...ready,
          contract: {
            ...ready.contract,
            inputSchema: { kind: "array", item: { kind: "mystery" } },
          },
        },
      },
    },
    {
      name: "an invalid output shape",
      body: {
        ok: true,
        result: {
          ...ready,
          contract: {
            ...ready.contract,
            outputShape: { kind: "object", possibleKeys: [42] },
          },
        },
      },
    },
  ];
}

function malformedInspectionCases() {
  const inspection = nodeInspection();
  return [
    {
      name: "an invalid awaiting signal",
      inspection: {
        ...inspection,
        awaitingSignal: { ...inspection.awaitingSignal, prompt: 42 },
      },
    },
    {
      name: "a blank awaiting signal target",
      inspection: {
        ...inspection,
        awaitingSignal: { target: "   " },
      },
    },
    {
      name: "an invalid present Agent projection",
      inspection: {
        ...inspection,
        agent: { key: "reviewer", model: 42 },
      },
    },
    {
      name: "an invalid loop child collection",
      inspection: {
        ...inspection,
        loopProgress: {
          ...inspection.loopProgress,
          activeChildNodeKeys: [42],
        },
      },
    },
    {
      name: "an incomplete structured failure",
      inspection: {
        ...inspection,
        failure: { message: "not approved" },
      },
    },
    {
      name: "a Runtime-only nested Agent field",
      inspection: {
        ...inspection,
        agent: { ...inspection.agent, backend: { kind: "command" } },
      },
    },
    {
      name: "an invalid cancel target",
      inspection: {
        ...inspection,
        cancelTarget: 42,
      },
    },
    {
      name: "a blank cancel target",
      inspection: {
        ...inspection,
        cancelTarget: "",
      },
    },
  ];
}

function malformedExecutionCases() {
  const execution = nodeExecution();
  return [
    {
      name: "an invalid streamed-output tail",
      execution: { ...execution, output: { ...execution.output, tail: 42 } },
    },
    {
      name: "an unknown root field",
      execution: { ...execution, runtimeOnly: true },
    },
    {
      name: "an unknown summary field",
      execution: { ...execution, summary: { ...execution.summary, runtimeOnly: true } },
    },
    {
      name: "a missing scheduler status",
      execution: { ...execution, summary: {} },
    },
    {
      name: "an unknown scheduler status",
      execution: { ...execution, summary: { ...execution.summary, status: "unknown" } },
    },
    {
      name: "an unknown context-window field",
      execution: { ...execution, contextWindow: { ...execution.contextWindow, runtimeOnly: true } },
    },
    {
      name: "an unknown token-usage field",
      execution: { ...execution, tokenUsage: { ...execution.tokenUsage, runtimeOnly: true } },
    },
    {
      name: "an unknown token-usage source",
      execution: { ...execution, tokenUsage: { ...execution.tokenUsage, source: "provider" } },
    },
    {
      name: "an unknown output field",
      execution: { ...execution, output: { ...execution.output, runtimeOnly: true } },
    },
    {
      name: "an unknown tool-call field",
      execution: {
        ...execution,
        recentTools: [{ ...execution.recentTools[0], runtimeOnly: true }],
      },
    },
    {
      name: "a reason for available execution",
      execution: { ...execution, reason: "active" },
    },
    {
      name: "no reason for unavailable execution",
      execution: { ...execution, available: false },
    },
    {
      name: "more than three recent tool calls",
      execution: {
        ...execution,
        recentTools: Array.from({ length: 4 }, (_, index) => ({
          turn: index,
          toolName: "Read",
        })),
      },
    },
    {
      name: "a negative context-window value",
      execution: { ...execution, contextWindow: { ...execution.contextWindow, used: -1 } },
    },
    {
      name: "a negative summary turn count",
      execution: { ...execution, summary: { ...execution.summary, turnCount: -1 } },
    },
    {
      name: "a fractional token count",
      execution: { ...execution, tokenUsage: { ...execution.tokenUsage, totalTokens: 1.5 } },
    },
    {
      name: "a negative streamed-output byte count",
      execution: { ...execution, output: { ...execution.output, totalBytes: -1 } },
    },
    {
      name: "a fractional tool-call turn",
      execution: {
        ...execution,
        recentTools: [{ ...execution.recentTools[0], turn: 1.5 }],
      },
    },
    {
      name: "a negative tool-call duration",
      execution: {
        ...execution,
        recentTools: [{ ...execution.recentTools[0], durationMs: -1 }],
      },
    },
  ];
}

function readyVisualization(): ReadyVisualization {
  const ir = producerWorkflow();
  const graph = workflowIrToWebGraph(ir);
  return {
    status: "ready",
    graph,
    workflow: {
      name: ir.name,
      ...(ir.description === undefined ? {} : { description: ir.description }),
      agents: ir.agents,
      irVersion: ir.irVersion,
      nodeCount: graph.nodes.length,
    },
    contract: {
      inputSchema: ir.inputSchema,
      output: ir.root.output,
      outputShape: { kind: "object", possibleKeys: ["approved"] },
    },
    sourceGraphDigest: "sha256:source",
  };
}

function producerWorkflow(): WorkflowIR {
  return {
    irVersion: 7,
    name: "release",
    description: "Release workflow",
    inputSchema: {
      kind: "object",
      fields: { release: { kind: "boolean" } },
      required: ["release"],
      additionalProperties: false,
    },
    agents: {
      reviewer: {
        kind: "agent_definition",
        use: "codex",
        model: "gpt-5",
        permissionMode: "approve-reads",
        config: { effort: "high" },
      },
    },
    root: {
      output: {
        kind: "object",
        fields: { approved: { kind: "literal", value: true } },
      },
      nodes: [{
        id: "gate",
        kind: "if",
        condition: { kind: "ref", path: ["input", "release"] },
        then: {
          output: { kind: "object", fields: {} },
          nodes: [{
            id: "ship",
            kind: "task",
            run: {
              input: { kind: "ref", path: ["input", "release"] },
              target: { kind: "inline", source: "async function ship() {}" },
            },
          }],
        },
        else: {
          output: { kind: "object", fields: {} },
          nodes: [],
        },
      }],
    },
    diagnostics: [],
  };
}

function runDetails(): RunDetails {
  return {
    id: "run_1",
    name: "release",
    status: "failed",
    input: { release: true },
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:01.000Z",
    runtimeVersion: 3,
  };
}

function workflowContext() {
  return {
    name: "release",
    description: "Release workflow",
    agents: producerWorkflow().agents,
  };
}

function nodeInspection(): NodeInspection {
  return {
    nodeId: "review",
    nodeKey: "review#node",
    frameKey: "review#frame",
    cancelTarget: "review#node",
    staticKind: "agent",
    runStartedAt: "2026-07-27T00:00:00.000Z",
    runDurationMs: 1_000,
    latestAttempt: { attemptNo: 1, status: "running" },
    agent: {
      key: "reviewer",
      model: "review-model",
      lastObservedAt: "2026-07-27T00:00:00.500Z",
    },
    input: { kind: "runtime", value: { release: true } },
    prompt: { kind: "authored", text: "Review the release.", mediaType: "text/markdown" },
    loopProgress: {
      frameKey: "loop#frame",
      index: 0,
      round: 1,
      state: { approved: false },
      stop: false,
      activeIterationFrameKey: "loop#iteration-0",
      activeChildNodeKeys: ["review#node"],
    },
    output: { approved: false },
    failure: {
      origin: "provider",
      code: "not_approved",
      message: "not approved",
      upstream: {
        source: "acpx",
        operation: "turn",
        protocol: { name: "json-rpc", code: -32_000, message: "Rejected." },
        data: { retryable: false },
      },
    },
    artifacts: [{
      id: "artifact_1",
      path: "review.md",
      size: 42,
      mediaType: "text/markdown",
    }],
    awaitingSignal: {
      target: "approval#node",
      prompt: "Approve?",
    },
  };
}

function nodeExecution(): NodeExecutionInspection {
  return {
    available: true,
    summary: {
      status: "running",
      sessionName: "review-session",
      turnCount: 2,
      message: "working",
    },
    lastObservedAt: "2026-07-27T00:00:00.500Z",
    contextWindow: { used: 10, size: 100, percent: 10, updatedAt: "2026-07-27T00:00:00.500Z" },
    tokenUsage: { source: "usage_update", inputTokens: 8, outputTokens: 2, totalTokens: 10 },
    output: { tail: "working", totalBytes: 7, truncated: false },
    recentTools: [{
      turn: 2,
      toolCallId: "tool_1",
      toolName: "Read",
      status: "completed",
      durationMs: 5,
      inputPreview: "README.md",
    }],
  };
}

function runtimeGraph(): WebGraph {
  const details: NonNullable<WebGraph["nodes"][number]["detail"]>[] = [
    { kind: "task", input: "input.release", target: "inline" },
    { kind: "agent", agent: "reviewer", use: "claude", model: "review-model", outputSchema: "{approved:boolean}" },
    { kind: "signal", outputSchema: "{approved:boolean}" },
    { kind: "assert", condition: "input.release", message: "release required" },
    { kind: "if", condition: "input.release" },
    { kind: "switch", cases: ["input.channel"], hasDefault: true },
    { kind: "parallel", branches: ["build", "test"], strategy: "all", maxConcurrency: "2" },
    { kind: "fanout", over: "input.targets", strategy: "quorum", count: "2", maxConcurrency: "3" },
    { kind: "loop", state: "input.state" },
  ];
  return {
    workflow: { name: "release", runId: "run_1", status: "running" },
    mode: "runtime",
    nodes: details.map((detail, index) => ({
      id: `node_${index}`,
      nodeId: `node_${index}`,
      target: `node_${index}`,
      kind: detail.kind,
      label: `Node ${index}`,
      path: ["root", `node_${index}`],
      ...(index === 0 ? {} : { parentId: "scope_1" }),
      detail,
      status: "running",
    })),
    containers: [
      {
        id: "branch_1",
        nodeId: "node_4",
        kind: "branch",
        label: "then",
        path: ["root", "node_4", "then"],
        parentId: "node_4",
        status: "running",
      },
      {
        id: "scope_1",
        nodeId: "node_7",
        kind: "scope",
        label: "do",
        path: ["root", "node_7", "do"],
        parentId: "node_7",
        status: "running",
      },
    ],
    edges: [
      { id: "sequence", source: "node_0", target: "node_1", kind: "sequence" },
      { id: "branch", source: "node_4", target: "branch_1", kind: "branch" },
      { id: "loop", source: "node_8", target: "scope_1", kind: "loop" },
    ],
    fanoutOccurrences: [{
      id: "fanout_occurrence",
      nodeId: "node_7",
      targetId: "scope_1",
      context: [{ nodeId: "node_8", kind: "loop", iteration: 0 }],
      status: "running",
      items: [{
        id: "fanout_item_0",
        itemIndex: 0,
        label: "item[0]",
        status: "running",
        context: [
          { nodeId: "node_8", kind: "loop", iteration: 0 },
          { nodeId: "node_7", kind: "fanout", itemIndex: 0 },
        ],
      }],
    }],
    selectors: [{
      id: "loop_selector",
      nodeId: "node_8",
      kind: "loop",
      targetId: "scope_1",
      context: [{ nodeId: "node_7", kind: "fanout", itemIndex: 0 }],
      defaultOptionId: "loop_0",
      options: [{
        id: "loop_0",
        iteration: 0,
        context: [
          { nodeId: "node_7", kind: "fanout", itemIndex: 0 },
          { nodeId: "node_8", kind: "loop", iteration: 0 },
        ],
      }],
    }],
    runtimeStates: [{
      targetId: "node_1",
      target: "@1a2b3c4d5e6f",
      status: "running",
      context: [{ nodeId: "node_7", kind: "fanout", itemIndex: 0 }],
    }],
  };
}

function validExpressions(): Array<{ name: string; output: ExprIR }> {
  return [
    { name: "literal", output: { kind: "literal", value: true } },
    { name: "reference", output: { kind: "ref", path: ["input", "release"] } },
    { name: "call", output: { kind: "call", fn: "eq", args: [{ kind: "literal", value: true }] } },
    { name: "array", output: { kind: "array", items: [{ kind: "literal", value: true }] } },
    { name: "object", output: { kind: "object", fields: { approved: { kind: "literal", value: true } } } },
    {
      name: "template",
      output: {
        kind: "template",
        parts: [
          { kind: "text", value: "approved=" },
          { kind: "expr", expr: { kind: "ref", path: ["input", "release"] } },
        ],
      },
    },
  ];
}

function validSchemas(): Array<{ name: string; schema: SchemaIR }> {
  return [
    {
      name: "primitive with metadata",
      schema: {
        kind: "string",
        description: "Release channel",
        default: { channel: ["stable", 1, true, null] },
        optional: true,
        nullable: false,
      },
    },
    { name: "array", schema: { kind: "array", item: { kind: "string" } } },
    {
      name: "object",
      schema: {
        kind: "object",
        fields: { release: { kind: "boolean" } },
        required: ["release"],
        additionalProperties: false,
      },
    },
    { name: "record", schema: { kind: "record", value: { kind: "number" } } },
    { name: "union", schema: { kind: "union", variants: [{ kind: "string" }, { kind: "null" }] } },
    { name: "literal", schema: { kind: "literal", value: "release" } },
    { name: "enum", schema: { kind: "enum", values: ["canary", "stable"] } },
  ];
}

function validStaticShapes(): Array<{ name: string; shape: StaticExprShape }> {
  return [
    { name: "object", shape: { kind: "object", possibleKeys: ["approved"] } },
    { name: "array", shape: { kind: "array" } },
    { name: "scalar", shape: { kind: "scalar" } },
    { name: "dynamic", shape: { kind: "dynamic" } },
  ];
}

function respondJson(body: unknown, status = 200): void {
  respondText(JSON.stringify(body), status);
}

function respondText(body: string, status = 200): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  })));
}
