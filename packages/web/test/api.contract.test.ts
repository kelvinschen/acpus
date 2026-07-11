import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockGetRuntimeHealth = vi.fn();
const mockListRuns = vi.fn();
const mockGetRun = vi.fn();
const mockGetRunVisualizationSnapshot = vi.fn();
const mockGetRunInspection = vi.fn();
const mockApplyRunControl = vi.fn();
const mockApplySignalRunControl = vi.fn();

vi.mock("@acpus/runtime", () => ({
  getRuntimeHealth: (...args: unknown[]) => mockGetRuntimeHealth(...args),
  listRuns: (...args: unknown[]) => mockListRuns(...args),
  getRun: (...args: unknown[]) => mockGetRun(...args),
  createWorkflowVisualizationOverlay: (ir: any) => ({ workflow: { name: ir.name }, nodes: [], groups: [] }),
  getRunVisualizationSnapshot: (...args: unknown[]) => mockGetRunVisualizationSnapshot(...args),
  getRunInspection: (...args: unknown[]) => mockGetRunInspection(...args),
  applyRunControl: (...args: unknown[]) => mockApplyRunControl(...args),
  applySignalRunControl: (...args: unknown[]) => mockApplySignalRunControl(...args),
  RuntimeUseCaseException: class extends Error {
    constructor(readonly failure: { type: string; message: string; [key: string]: unknown }) {
      super(failure.message);
    }
  },
}));

import { createWebApp } from "../src/server/app.js";
import { createAccessPolicy } from "../src/server/security.js";

type JsonBody = Record<string, any>;

describe("web API contract", () => {
  const app = createWebApp({ cwd: "/tmp/acpus-web-test" });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/health", () => {
    it("returns ok: true with health shape", async () => {
      mockGetRuntimeHealth.mockResolvedValue({ ok: true, phase: "doctor", checks: [] });
      const res = await app.request("/api/health");
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body.ok).toBe(true);
      expect(body.health.ok).toBe(true);
      expect(body.health.phase).toBe("doctor");
      expect(Array.isArray(body.health.checks)).toBe(true);
      expect(mockGetRuntimeHealth).toHaveBeenCalledWith("/tmp/acpus-web-test");
    });
  });

  describe("GET /api/config", () => {
    it("reports open access by default", async () => {
      const res = await app.request("/api/config");
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body.config.access).toBe("open");
    });

    it("reports token access when token policy is enabled", async () => {
      const protectedApp = createWebApp({
        cwd: "/tmp/acpus-web-test",
        access: createAccessPolicy({ enabled: true, token: "test-token" }),
      });
      const res = await protectedApp.request("/api/config", {
        headers: { authorization: "Bearer test-token" },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body.config.access).toBe("token");
    });
  });

  describe("GET /api/runs", () => {
    it("returns runs array with order", async () => {
      mockListRuns.mockResolvedValue([{ id: "run_1", updatedAt: "t" }]);
      const res = await app.request("/api/runs");
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body.ok).toBe(true);
      expect(body.runs).toEqual([{ id: "run_1", updatedAt: "t" }]);
      expect(body.order).toBe("updatedAt DESC");
      expect(mockListRuns).toHaveBeenCalledWith("/tmp/acpus-web-test");
    });
  });

  describe("GET /api/runs/:id", () => {
    it("returns run for valid id", async () => {
      mockGetRun.mockResolvedValue({ id: "run_1", status: "running" });
      const res = await app.request("/api/runs/run_1");
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body.ok).toBe(true);
      expect(body.run).toEqual({ id: "run_1", status: "running" });
    });

    it("returns 404 for unknown run", async () => {
      mockGetRun.mockResolvedValue(undefined);
      const res = await app.request("/api/runs/nonexistent");
      expect(res.status).toBe(404);
      const body = await res.json() as JsonBody;
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("run_not_found");
    });
  });

  describe("GET /api/runs/:id/runtime-snapshot", () => {
    it("returns run and graph from the same runtime snapshot", async () => {
      mockGetRunVisualizationSnapshot.mockResolvedValue({
        run: { id: "run_1", name: "test", status: "running", dynamic: { version: 7 } },
        overlay: {
          workflow: { name: "test", runId: "run_1", status: "running", dynamicVersion: 7 },
          nodes: [{ nodeId: "step_1", kind: "task", path: ["step_1"], instances: [], frames: [], attempts: [], signalWaits: [], status: "completed" }],
          groups: [],
        },
      });
      const res = await app.request("/api/runs/run_1/runtime-snapshot");
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body.ok).toBe(true);
      expect(body.run).toMatchObject({ id: "run_1", status: "running" });
      expect(body.graph).toBeDefined();
      expect(body.graph.version).toBe(7);
      expect(mockGetRunVisualizationSnapshot).toHaveBeenCalledWith("/tmp/acpus-web-test", "run_1");
    });

    it("returns 404 for unknown run", async () => {
      mockGetRunVisualizationSnapshot.mockResolvedValue(undefined);
      const res = await app.request("/api/runs/run_1/runtime-snapshot");
      expect(res.status).toBe(404);
      const body = await res.json() as JsonBody;
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("run_not_found");
    });

  });

  describe("GET /api/runs/:id/nodes/:target", () => {
    it("returns agent execution last active from progress", async () => {
      mockGetRunInspection.mockResolvedValue(inspectionOk(targetInspection({
        progress: [{
          nodeKey: "review~abc",
          nodeId: "review",
          attemptId: "attempt_1",
          attemptNo: 1,
          kind: "agent",
          status: "running",
          updatedAt: "2026-07-01T00:00:02.000Z",
        }],
      })));

      const res = await app.request("/api/runs/run_1/nodes/review~abc/execution");

      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body.ok).toBe(true);
      expect(body.execution).toMatchObject({
        available: true,
        lastActiveAt: "2026-07-01T00:00:02.000Z",
        summary: { status: "running" },
      });
    });

    it("delegates target and selector context to runtime inspection", async () => {
      mockGetRunInspection.mockResolvedValue(inspectionOk(targetInspection()));
      const selectorContext = [{ nodeId: "items", kind: "fanout", itemIndex: 1 }];
      const context = Buffer.from(JSON.stringify(selectorContext)).toString("base64url");
      const res = await app.request(`/api/runs/run_1/nodes/review~abc?context=${context}`);

      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body.ok).toBe(true);
      expect(body.inspection.target).toEqual({ kind: "dynamic-node", id: "review~abc" });
      expect(body.inspection.summary.agent).toEqual({
        key: "reviewer",
        backend: { kind: "use", name: "claude" },
        turnCount: 1,
        tools: { totalCallCount: 1, recent: [{ command: "Read", status: "completed" }] },
      });
      expect(mockGetRunInspection).toHaveBeenCalledWith("/tmp/acpus-web-test", {
        runId: "run_1",
        mode: "target",
        target: "review~abc",
        context: selectorContext,
      });
    });

    it("rejects fanout inspection context without an item index", async () => {
      const context = Buffer.from(JSON.stringify([{ nodeId: "items", kind: "fanout" }])).toString("base64url");
      const res = await app.request(`/api/runs/run_1/nodes/step_1?context=${context}`);

      expect(res.status).toBe(400);
      const body = await res.json() as JsonBody;
      expect(body.error.code).toBe("invalid_context");
    });

    it("returns 404 for unknown run", async () => {
      mockGetRunInspection.mockResolvedValue(inspectionErr({
        type: "run-not-found",
        runId: "nonexistent",
        message: "Run 'nonexistent' was not found.",
      }));
      const res = await app.request("/api/runs/nonexistent/nodes/step_1");
      expect(res.status).toBe(404);
      const body = await res.json() as JsonBody;
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("run_not_found");
    });

    it("returns 404 for an unknown inspection target", async () => {
      mockGetRunInspection.mockResolvedValue(inspectionErr({
        type: "target-not-found",
        runId: "run_1",
        target: "missing",
        message: "Target 'missing' was not found.",
      }));

      const res = await app.request("/api/runs/run_1/nodes/missing");

      expect(res.status).toBe(404);
      expect((await res.json() as JsonBody).error.code).toBe("target_not_found");
    });
  });

  describe("POST /api/runs/:id/controls", () => {
    it("returns 400 when body is not JSON", async () => {
      const res = await app.request("/api/runs/run_1/controls", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "not json",
      });
      expect(res.status).toBe(400);
      const body = await res.json() as JsonBody;
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("invalid_json");
    });

    it("returns 400 for invalid command type", async () => {
      const res = await app.request("/api/runs/run_1/controls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "invalid" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as JsonBody;
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("invalid_command");
    });

    it("returns 400 for signal without target", async () => {
      const res = await app.request("/api/runs/run_1/controls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "signal", payload: {} }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as JsonBody;
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("invalid_command");
    });

    it("returns 400 for signal without payload", async () => {
      const res = await app.request("/api/runs/run_1/controls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "signal", target: "step_1" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as JsonBody;
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("invalid_command");
    });

    it("accepts pause control and returns result", async () => {
      mockApplyRunControl.mockResolvedValue({ run: { id: "run_1", status: "paused" } });
      const res = await app.request("/api/runs/run_1/controls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "pause" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body.ok).toBe(true);
      expect(body.result.run.status).toBe("paused");
      expect(mockApplyRunControl).toHaveBeenCalledWith("/tmp/acpus-web-test", "run_1", "pause", {});
    });

    it("accepts pause with target", async () => {
      mockApplyRunControl.mockResolvedValue({ run: { id: "run_1", status: "paused" } });
      const res = await app.request("/api/runs/run_1/controls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "pause", target: "step_1" }),
      });
      expect(res.status).toBe(200);
      expect(mockApplyRunControl).toHaveBeenCalledWith("/tmp/acpus-web-test", "run_1", "pause", { target: "step_1" });
    });

    it("accepts signal control", async () => {
      mockApplySignalRunControl.mockResolvedValue({ run: { id: "run_1", status: "running" } });
      const res = await app.request("/api/runs/run_1/controls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "signal", target: "step_1", payload: { value: 42 } }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body.ok).toBe(true);
      expect(mockApplySignalRunControl).toHaveBeenCalledWith("/tmp/acpus-web-test", "run_1", "step_1", { value: 42 });
    });

    it("returns 400 on RuntimeUseCaseException", async () => {
      const RuntimeUseCaseException = (await import("@acpus/runtime")).RuntimeUseCaseException;
      mockApplyRunControl.mockRejectedValue(
        new RuntimeUseCaseException({ type: "run-not-found", message: "Run not found.", runId: "x" }),
      );
      const res = await app.request("/api/runs/run_1/controls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "pause" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as JsonBody;
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("run-not-found");
    });

    it("returns 404 for unknown run", async () => {
      mockApplyRunControl.mockResolvedValue(undefined);
      const res = await app.request("/api/runs/nonexistent/controls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "pause" }),
      });
      expect(res.status).toBe(404);
      const body = await res.json() as JsonBody;
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("run_not_found");
    });
  });

  describe("workflow visualization APIs", () => {
    it("lists project catalog entries without importing workflows", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "acpus-web-catalog-"));
      await mkdir(join(cwd, ".acpus", "workflows", "release"), { recursive: true });
      await writeFile(join(cwd, ".acpus", "workflows", "release", "workflow.ts"), "throw new Error('must not import');\n");
      const catalogApp = createWebApp({ cwd });
      const res = await catalogApp.request("/api/workflows/catalog");
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body.ok).toBe(true);
      expect(body.catalog).toMatchObject([{ scope: "project", name: "release", status: "available" }]);
    });

    it("lists only safe workflow files under the workspace", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "acpus-web-files-"));
      await writeFile(join(cwd, "workflow.ts"), "export default {};\n");
      await writeFile(join(cwd, "README.md"), "ignore\n");
      await mkdir(join(cwd, "nested"), { recursive: true });
      const filesApp = createWebApp({ cwd });
      const res = await filesApp.request("/api/workflows/files");
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body.files.entries).toEqual(expect.arrayContaining([
        { name: "nested", path: "nested", kind: "directory" },
        { name: "workflow.ts", path: "workflow.ts", kind: "workflow" },
      ]));
      expect(body.files.entries.some((entry: JsonBody) => entry.name === "README.md")).toBe(false);
    });

    it("rejects file browser path escapes", async () => {
      const res = await app.request("/api/workflows/files?dir=..");
      expect(res.status).toBe(400);
      const body = await res.json() as JsonBody;
      expect(body.error.code).toBe("invalid_workflow_path");
    });

    it("returns static workflow contract data from visualization", async () => {
      const visualizeApp = createWebApp({ cwd: process.cwd() });
      const res = await visualizeApp.request("/api/workflows/visualize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: {
            kind: "file",
            path: "packages/workflow-compiler/test/fixtures/workflows/orchestration.workflow.ts",
          },
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body.result.status).toBe("ready");
      expect(body.result.contract.inputSchema).toMatchObject({ kind: "object" });
      expect(body.result.contract.outputs).toEqual(expect.objectContaining({
        approved: expect.any(Object),
        first_lane: expect.any(Object),
      }));
    });

    it("rejects invalid visualization bodies", async () => {
      const res = await app.request("/api/workflows/visualize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: { kind: "file" } }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as JsonBody;
      expect(body.error.code).toBe("invalid_visualization_source");
    });
  });

  describe("error handling", () => {
    it("returns 500 for unexpected errors", async () => {
      mockGetRuntimeHealth.mockRejectedValue(new Error("db corrupted"));
      const res = await app.request("/api/health");
      expect(res.status).toBe(500);
      const body = await res.json() as JsonBody;
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("internal_error");
    });

    it("returns 404 for unknown routes", async () => {
      const res = await app.request("/api/unknown");
      expect(res.status).toBe(404);
      const body = await res.json() as JsonBody;
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("not_found");
    });
  });
});

function inspectionOk(value: JsonBody) {
  return {
    value,
    isOk: () => true,
    isErr: () => false,
  };
}

function inspectionErr(error: JsonBody) {
  return {
    error,
    isOk: () => false,
    isErr: () => true,
  };
}

function targetInspection(overrides: { progress?: JsonBody[] } = {}): JsonBody {
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
      agent: {
        key: "reviewer",
        backend: { kind: "use", name: "claude" },
        turnCount: 1,
        tools: { totalCallCount: 1, recent: [{ command: "Read", status: "completed" }] },
      },
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
    executionMetadata: [],
    progress: overrides.progress ?? [],
    artifacts: [],
  };
}
