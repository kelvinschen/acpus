import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExprIR, StaticExprShape } from "@acpus/expression/ir";
import type { SchemaIR, WorkflowIR } from "@acpus/core/ir";
import {
  getArtifactContent as requestArtifactContent,
  getArtifactPreview as requestArtifactPreview,
  getConfig,
  getHealth,
  getNodeExecutionInspection as requestNodeExecutionInspection,
  getNodeInspection as requestNodeInspection,
  getNodeRuntimeValues as requestNodeRuntimeValues,
  getRunRuntimeSnapshot as requestRunRuntimeSnapshot,
  getRuntimeStore,
  listRuns as requestRuns,
  listWorkspaces,
  listWorkflowCatalog,
  listWorkflowFiles,
  repairRuntimeStore as requestRuntimeStoreRepair,
  submitRunCommand as requestRunCommand,
  visualizeWorkflow,
  WebApiError,
  type NodeExecutionInspection,
  type NodeInspection,
  type NodeRuntimeValues,
  type RunDetails,
  type WorkflowVisualizationResult,
} from "../src/client/api.js";
import type { WebGraph } from "../src/graph-types.js";
import { workflowIrToWebGraph } from "../src/server/graph.js";

type ReadyVisualization = Extract<WorkflowVisualizationResult, { status: "ready" }>;
const workspaceKey = "workspace one";

const listRuns = () => requestRuns(workspaceKey);
const repairRuntimeStore = () => requestRuntimeStoreRepair();
const getRunRuntimeSnapshot = (runId: string) => requestRunRuntimeSnapshot(workspaceKey, runId);
const getNodeInspection = (runId: string, target: string) => requestNodeInspection(workspaceKey, runId, target);
const getNodeRuntimeValues = (runId: string, target: string) => requestNodeRuntimeValues(workspaceKey, runId, target);
const getNodeExecutionInspection = (runId: string, target: string) => requestNodeExecutionInspection(workspaceKey, runId, target);
const getArtifactPreview = (runId: string, artifactId: string) => requestArtifactPreview(workspaceKey, runId, artifactId);
const getArtifactContent = (runId: string, artifactId: string, signal?: AbortSignal) =>
  requestArtifactContent(workspaceKey, runId, artifactId, signal);
const submitRunCommand = (runId: string, command: Parameters<typeof requestRunCommand>[2]) =>
  requestRunCommand(workspaceKey, runId, command);

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

  it("classifies unreadable JSON response bodies as network failures", async () => {
    const response = new Response("");
    vi.spyOn(response, "text").mockRejectedValue(new Error("response stream lost"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const failure = await listRuns().catch(error => error);
    expect(failure).toBeInstanceOf(WebApiError);
    expect(failure.failure).toEqual({
      type: "network-failed",
      message: "response stream lost",
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
      "/api/workspaces/workspace%20one/runs/run%201/nodes/%401a2b3c4d5e6f",
      undefined,
    );
  });

  it("uses the canonical target in node-runtime-values URLs", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      runtimeValues: nodeRuntimeValues(),
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await getNodeRuntimeValues("run 1", "@1a2b3c4d5e6f");

    expect(fetch).toHaveBeenCalledWith(
      "/api/workspaces/workspace%20one/runs/run%201/nodes/%401a2b3c4d5e6f/runtime-values",
      undefined,
    );
  });

  it("repairs the runtime store without a request body", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await repairRuntimeStore();

    expect(fetch).toHaveBeenCalledWith("/api/runtime-store", {
      method: "POST",
    });
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

  it("accepts an authored Agent slot in a static visualization", async () => {
    const result = readyVisualization();
    result.workflow.agents = {
      reviewer: { kind: "agent_slot", model: "gpt-5.6-luna" },
    };
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

  it("decodes artifact preview metadata and verifies the complete preview body", async () => {
    const bytes = new TextEncoder().encode("# Report\n");
    const fetch = vi.fn().mockResolvedValue(new Response(bytes, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "x-acpus-artifact-size": String(bytes.byteLength),
        "x-acpus-artifact-truncated": "false",
      },
    }));
    vi.stubGlobal("fetch", fetch);

    await expect(getArtifactPreview("run 1", "artifact 1")).resolves.toEqual({
      text: "# Report\n",
      mediaType: "text/markdown; charset=utf-8",
      size: bytes.byteLength,
      truncated: false,
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/workspaces/workspace%20one/runs/run%201/artifacts/artifact%201/preview",
      undefined,
    );
  });

  it("rejects artifact previews whose body and truncation metadata disagree", async () => {
    const bytes = new TextEncoder().encode("short");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytes, {
      headers: {
        "content-type": "text/plain",
        "x-acpus-artifact-size": "10",
        "x-acpus-artifact-truncated": "false",
      },
    })));

    await expect(getArtifactPreview("run_1", "artifact_1")).rejects.toMatchObject({
      failure: { type: "response-invalid-envelope", status: 200 },
    });
  });

  it("returns exact artifact content bytes and forwards cancellation", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const controller = new AbortController();
    const fetch = vi.fn().mockResolvedValue(new Response(bytes, {
      headers: {
        "content-type": "application/octet-stream",
        "x-acpus-artifact-size": String(bytes.byteLength),
        "x-acpus-artifact-name": "output%20data.bin",
      },
    }));
    vi.stubGlobal("fetch", fetch);

    const content = await getArtifactContent("run 1", "artifact 1", controller.signal);

    expect(content).toEqual({
      bytes,
      mediaType: "application/octet-stream",
      size: bytes.byteLength,
      fileName: "output data.bin",
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/workspaces/workspace%20one/runs/run%201/artifacts/artifact%201/content",
      { signal: controller.signal },
    );
  });

  it.each([
    { name: "missing size", headers: { "content-type": "text/plain", "x-acpus-artifact-name": "output.txt" } },
    { name: "non-integer size", headers: { "content-type": "text/plain", "x-acpus-artifact-size": "1.5", "x-acpus-artifact-name": "output.txt" } },
    { name: "unsafe filename", headers: { "content-type": "text/plain", "x-acpus-artifact-size": "0", "x-acpus-artifact-name": "..%2Fsecret" } },
  ])("rejects artifact content with $name metadata", async ({ headers }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array(), { headers })));

    await expect(getArtifactContent("run_1", "artifact_1")).rejects.toMatchObject({
      failure: { type: "response-invalid-envelope", status: 200 },
    });
  });

  it("rejects artifact content whose byte length differs from its declared size", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), {
      headers: {
        "content-type": "application/octet-stream",
        "x-acpus-artifact-size": "2",
        "x-acpus-artifact-name": "output.bin",
      },
    })));

    await expect(getArtifactContent("run_1", "artifact_1")).rejects.toMatchObject({
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

  it("uses the public Web API error for artifact network failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("artifact connection lost")));

    const failure = await getArtifactContent("run_1", "artifact_1").catch(error => error);
    expect(failure).toBeInstanceOf(WebApiError);
    expect(failure.failure).toEqual({
      type: "network-failed",
      message: "artifact connection lost",
    });
  });
});

function successCases() {
  const health = {
    checks: [{ area: "daemon", status: "ok" as const, message: "ready" }],
  };
  const runs = [{
    id: "run_1",
    name: "release",
    status: "running",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:01.000Z",
  }];
  const workspaces = {
    currentWorkspaceKey: "current",
    workspaces: [{
      key: "current",
      name: "workspace",
      path: "/workspace",
      runCount: 1,
      lastRunUpdatedAt: "2026-07-01T00:00:01.000Z",
    }, {
      key: "unavailable",
      name: "unavailable",
      path: "/workspace/unavailable",
    }],
  };
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
  const runtimeValues = nodeRuntimeValues();
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
    { name: "ready runtime store", call: () => getRuntimeStore(), body: { ok: true, runtimeStore: { state: "ready" } }, expected: { state: "ready" } },
    { name: "repairable runtime store", call: () => getRuntimeStore(), body: { ok: true, runtimeStore: { state: "needs-fix", message: "Runtime data needs an update." } }, expected: { state: "needs-fix", message: "Runtime data needs an update." } },
    { name: "unavailable runtime store", call: () => getRuntimeStore(), body: { ok: true, runtimeStore: { state: "unavailable", message: "Use a compatible Acpus version." } }, expected: { state: "unavailable", message: "Use a compatible Acpus version." } },
    { name: "runtime store repair acknowledgement", call: () => repairRuntimeStore(), body: { ok: true }, expected: undefined },
    { name: "workspace catalog", call: () => listWorkspaces(), body: { ok: true, catalog: workspaces }, expected: workspaces },
    { name: "run list", call: () => listRuns(), body: { ok: true, runs }, expected: runs },
    { name: "runtime snapshot", call: () => getRunRuntimeSnapshot("run_1"), body: { ok: true, ...snapshot }, expected: snapshot },
    { name: "node inspection", call: () => getNodeInspection("run_1", "review"), body: { ok: true, inspection }, expected: inspection },
    { name: "node runtime values", call: () => getNodeRuntimeValues("run_1", "review"), body: { ok: true, runtimeValues }, expected: runtimeValues },
    { name: "unavailable node runtime values", call: () => getNodeRuntimeValues("run_1", "review"), body: { ok: true, runtimeValues: { available: false, reason: "not_selected" } }, expected: { available: false, reason: "not_selected" } },
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
  const runRecord = {
    id: run.id,
    name: run.name,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
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
      name: "workspace catalog without current key",
      call: () => listWorkspaces(),
      body: { ok: true, catalog: { workspaces: [] } },
    },
    {
      name: "workspace catalog with a negative run count",
      call: () => listWorkspaces(),
      body: {
        ok: true,
        catalog: {
          currentWorkspaceKey: "current",
          workspaces: [{ key: "current", name: "workspace", path: "/workspace", runCount: -1 }],
        },
      },
    },
    {
      name: "workspace catalog with an extra workspace field",
      call: () => listWorkspaces(),
      body: {
        ok: true,
        catalog: {
          currentWorkspaceKey: "current",
          workspaces: [{ key: "current", name: "workspace", path: "/workspace", runCount: 0, private: true }],
        },
      },
    },
    {
      name: "workspace catalog with a non-string last update",
      call: () => listWorkspaces(),
      body: {
        ok: true,
        catalog: {
          currentWorkspaceKey: "current",
          workspaces: [{ key: "current", name: "workspace", path: "/workspace", runCount: 0, lastRunUpdatedAt: 42 }],
        },
      },
    },
    {
      name: "runtime store with an unknown state",
      call: () => getRuntimeStore(),
      body: { ok: true, runtimeStore: { state: "migrating" } },
    },
    {
      name: "ready runtime store with a message",
      call: () => getRuntimeStore(),
      body: { ok: true, runtimeStore: { state: "ready", message: "unexpected" } },
    },
    {
      name: "repairable runtime store without a message",
      call: () => getRuntimeStore(),
      body: { ok: true, runtimeStore: { state: "needs-fix" } },
    },
    {
      name: "runtime repair acknowledgement with an extra field",
      call: () => repairRuntimeStore(),
      body: { ok: true, result: "unexpected" },
    },
    {
      name: "run-list status leaf",
      call: () => listRuns(),
      body: { ok: true, runs: [{ ...runRecord, status: 42 }] },
    },
    {
      name: "run-list without createdAt",
      call: () => listRuns(),
      body: { ok: true, runs: [{ ...runRecord, createdAt: undefined }] },
    },
    {
      name: "run-list without updatedAt",
      call: () => listRuns(),
      body: { ok: true, runs: [{ ...runRecord, updatedAt: undefined }] },
    },
    {
      name: "run-list non-string createdAt",
      call: () => listRuns(),
      body: { ok: true, runs: [{ ...runRecord, createdAt: 42 }] },
    },
    {
      name: "run-list non-string updatedAt",
      call: () => listRuns(),
      body: { ok: true, runs: [{ ...runRecord, updatedAt: 42 }] },
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
      name: "runtime snapshot with an unbound Agent slot",
      call: () => getRunRuntimeSnapshot("run_1"),
      body: {
        ok: true,
        run,
        workflow: {
          ...workflowContext(),
          agents: { reviewer: { kind: "agent_slot" } },
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
      name: "node-runtime-values array payload",
      call: () => getNodeRuntimeValues("run_1", "review"),
      body: { ok: true, runtimeValues: { available: true, values: [] } },
    },
    {
      name: "node-runtime-values unknown unavailable reason",
      call: () => getNodeRuntimeValues("run_1", "review"),
      body: { ok: true, runtimeValues: { available: false, reason: "unknown" } },
    },
    {
      name: "node-runtime-values conflicting branches",
      call: () => getNodeRuntimeValues("run_1", "review"),
      body: { ok: true, runtimeValues: { available: false, reason: "not_started", values: {} } },
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
    {
      name: "server-config with an extra field",
      call: () => getConfig(),
      body: { ok: true, config: { cwd: "/workspace", access: "token", private: true } },
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
      name: "an extra runtime-state field",
      body: {
        ok: true,
        result: {
          ...ready,
          graph: {
            ...graph,
            runtimeStates: [{ ...graph.runtimeStates[0], private: true }],
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
      name: "node timing without a start boundary",
      inspection: {
        ...inspection,
        timing: { durationMs: 1_000 },
      },
    },
    {
      name: "a negative node duration",
      inspection: {
        ...inspection,
        timing: { ...inspection.timing, durationMs: -1 },
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
    irVersion: 8,
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
    availableControls: [{ type: "cancel", target: "review#node" }],
    staticKind: "agent",
    timing: {
      startedAt: "2026-07-27T00:00:00.000Z",
      finishedAt: "2026-07-27T00:00:01.000Z",
      durationMs: 1_000,
    },
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
        source: "acp",
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

function nodeRuntimeValues(): NodeRuntimeValues {
  return {
    available: true,
    values: {
      over: [{ id: 1 }, { id: 2 }],
      maxConcurrency: 2,
    },
  };
}

function nodeExecution(): NodeExecutionInspection {
  return {
    available: true,
    summary: {
      status: "running",
      agentSessionId: "review-session",
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
