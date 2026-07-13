import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockGetRuntimeHealth = vi.fn();
const mockListRuns = vi.fn();
const mockGetRunVisualizationSnapshot = vi.fn();
const mockGetRunInspection = vi.fn();
const mockGetArtifact = vi.fn();
const mockRequestDaemonControl = vi.fn();
const mockEnsureDaemonRunning = vi.fn();

vi.mock("@acpus/runtime", () => ({
  getRuntimeHealth: (...args: unknown[]) => mockGetRuntimeHealth(...args),
  listRuns: (...args: unknown[]) => mockListRuns(...args),
  createWorkflowVisualizationOverlay: (ir: any) => ({ workflow: { name: ir.name }, nodes: [], groups: [] }),
  getRunVisualizationSnapshot: (...args: unknown[]) => mockGetRunVisualizationSnapshot(...args),
  getRunInspection: (...args: unknown[]) => mockGetRunInspection(...args),
  getArtifact: (...args: unknown[]) => mockGetArtifact(...args),
  requestDaemonControl: (...args: unknown[]) => mockRequestDaemonControl(...args),
  DaemonRequestError: class extends Error {
    constructor(readonly code: string, message: string) {
      super(message);
    }
  },
}));

import { createWebApp } from "../src/server/app.js";
import { createAccessPolicy } from "../src/server/security.js";

type JsonBody = Record<string, any>;

describe("web API contract", () => {
  const app = createWebApp({ cwd: "/tmp/acpus-web-test", ensureDaemonRunning: mockEnsureDaemonRunning });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/health", () => {
    it("returns the health fields rendered by the status popover", async () => {
      mockGetRuntimeHealth.mockResolvedValue({
        ok: true,
        phase: "doctor",
        state: "ready",
        checks: [{ area: "daemon", status: "ok", message: "Daemon is healthy.", details: { pid: 42 } }],
      });
      const res = await app.request("/api/health");
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body).toEqual({
        ok: true,
        health: { checks: [{ area: "daemon", status: "ok", message: "Daemon is healthy." }] },
      });
      expect(mockGetRuntimeHealth).toHaveBeenCalledWith("/tmp/acpus-web-test");
    });
  });

  describe("GET /api/config", () => {
    it("reports open access by default", async () => {
      const res = await app.request("/api/config");
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body.config).toEqual({ cwd: "/tmp/acpus-web-test", access: "open" });
    });

    it("reports token access when token policy is enabled", async () => {
      const access = createAccessPolicy({ enabled: true });
      const protectedApp = createWebApp({
        cwd: "/tmp/acpus-web-test",
        access,
        ensureDaemonRunning: mockEnsureDaemonRunning,
      });
      const res = await protectedApp.request("/api/config", {
        headers: { authorization: `Bearer ${access.token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body.config.access).toBe("token");
    });
  });

  describe("GET /api/runs", () => {
    it("returns the run selector projection", async () => {
      mockListRuns.mockResolvedValue([{
        id: "run_1",
        name: "release",
        status: "running",
        workflowEntry: "release.workflow.ts",
        sourceGraphDigest: "sha256:source",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:01.000Z",
      }]);
      const res = await app.request("/api/runs");
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body).toEqual({ ok: true, runs: [{ id: "run_1", name: "release", status: "running" }] });
      expect(mockListRuns).toHaveBeenCalledWith("/tmp/acpus-web-test");
    });
  });

  describe("GET /api/runs/:id/runtime-snapshot", () => {
    it("returns run and graph from the same runtime snapshot", async () => {
      mockGetRunVisualizationSnapshot.mockResolvedValue({
        run: {
          id: "run_1",
          name: "test",
          status: "running",
          input: { release: true },
          createdAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:00:01.000Z",
          dynamic: {
            version: 7,
            frames: [
              { frameKey: "step_1#frame", nodeId: "step_1", frameKind: "node", status: "failed", createdAt: "ignored" },
              { frameKey: "done#frame", nodeId: "done", frameKind: "node", status: "completed" },
            ],
            nodeInstances: [{ nodeKey: "step_1#node", nodeId: "step_1", status: "failed", createdAt: "ignored" }],
            groupMembers: [{ groupKey: "group", memberKey: "member", memberKind: "branch", branchId: "main", status: "failed" }],
          },
        },
        overlay: {
          workflow: { name: "test", runId: "run_1", status: "running", dynamicVersion: 7 },
          nodes: [{ nodeId: "step_1", kind: "task", path: ["step_1"], instances: [], frames: [], attempts: [], signalWaits: [], status: "completed" }],
          groups: [],
        },
      });
      const res = await app.request("/api/runs/run_1/runtime-snapshot");
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body.run).toEqual({
        id: "run_1",
        name: "test",
        status: "running",
        input: { release: true },
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:01.000Z",
        dynamic: {
          version: 7,
          frames: [{ frameKey: "step_1#frame", nodeId: "step_1", frameKind: "node", status: "failed" }],
          nodeInstances: [{ nodeKey: "step_1#node", nodeId: "step_1", status: "failed" }],
          groupMembers: [{ memberKey: "member", memberKind: "branch", branchId: "main", status: "failed" }],
        },
      });
      expect(body.graph).toBeDefined();
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

  describe("GET /api/runs/:id/artifacts/:artifactId/preview", () => {
    it("returns at most 128 KiB with the artifact media type", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "acpus-web-artifact-preview-"));
      const artifactDir = join(cwd, ".acpus", ".local", "runs", "run_1", "artifacts");
      const path = join(artifactDir, "output.txt");
      const bytes = Buffer.alloc(128 * 1024 + 7, "a");
      await mkdir(artifactDir, { recursive: true });
      await writeFile(path, bytes);
      mockGetArtifact.mockResolvedValue({ path });
      const artifactApp = createWebApp({ cwd, ensureDaemonRunning: mockEnsureDaemonRunning });

      const res = await artifactApp.request("/api/runs/run_1/artifacts/artifact_1/preview");

      expect(res.status).toBe(200);
      expect(Object.fromEntries(res.headers)).toEqual({ "content-type": "text/plain; charset=utf-8" });
      expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes.subarray(0, 128 * 1024));
      expect(mockGetArtifact).toHaveBeenCalledWith(cwd, "run_1", "artifact_1");
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

    it("requires a retry target", async () => {
      const res = await app.request("/api/runs/run_1/controls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "retry" }),
      });
      expect(res.status).toBe(400);
      expect((await res.json() as JsonBody).error.code).toBe("invalid_command");
    });

    it("rejects fields outside the selected control shape", async () => {
      const res = await app.request("/api/runs/run_1/controls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "pause", target: "step_1" }),
      });
      expect(res.status).toBe(400);
      expect((await res.json() as JsonBody).error.code).toBe("invalid_command");
    });

    it("accepts pause control", async () => {
      mockRequestDaemonControl.mockResolvedValue({ run: { id: "run_1", status: "paused" } });
      const res = await app.request("/api/runs/run_1/controls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "pause" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body).toEqual({ ok: true });
      expect(mockEnsureDaemonRunning).toHaveBeenCalledOnce();
      expect(mockEnsureDaemonRunning).toHaveBeenCalledWith("/tmp/acpus-web-test");
      expect(mockRequestDaemonControl).toHaveBeenCalledWith("/tmp/acpus-web-test", {
        requestId: expect.stringMatching(/^web:[0-9a-f-]+$/),
        type: "pause",
        runId: "run_1",
      });
      expect(mockEnsureDaemonRunning.mock.invocationCallOrder[0]).toBeLessThan(mockRequestDaemonControl.mock.invocationCallOrder[0]!);
    });

    it("maps a retry target directly onto the daemon intent", async () => {
      mockRequestDaemonControl.mockResolvedValue({ run: { id: "run_1", status: "running" } });
      const res = await app.request("/api/runs/run_1/controls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "retry", target: "step_1" }),
      });
      expect(res.status).toBe(200);
      expect(mockRequestDaemonControl).toHaveBeenCalledWith("/tmp/acpus-web-test", {
        requestId: expect.stringMatching(/^web:[0-9a-f-]+$/),
        type: "retry",
        runId: "run_1",
        target: "step_1",
      });
    });

    it.each([
      [{ type: "cancel" }, undefined],
      [{ type: "cancel", target: "step_1" }, "step_1"],
    ])("maps cancel target %s onto the daemon intent", async (command, target) => {
      mockRequestDaemonControl.mockResolvedValue({ run: { id: "run_1", status: "canceled" } });
      const res = await app.request("/api/runs/run_1/controls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      });

      expect(res.status).toBe(200);
      const intent = mockRequestDaemonControl.mock.calls[0]![1] as JsonBody;
      expect(intent).toMatchObject({ type: "cancel", runId: "run_1" });
      expect(intent.target).toBe(target);
      expect(Object.hasOwn(intent, "target")).toBe(target !== undefined);
    });

    it("accepts signal control", async () => {
      mockRequestDaemonControl.mockResolvedValue({ run: { id: "run_1", status: "running" } });
      const res = await app.request("/api/runs/run_1/controls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "signal", target: "step_1", payload: { value: 42 } }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body).toEqual({ ok: true });
      expect(mockRequestDaemonControl).toHaveBeenCalledWith("/tmp/acpus-web-test", {
        requestId: expect.stringMatching(/^web:[0-9a-f-]+$/),
        type: "signal",
        runId: "run_1",
        nodeId: "step_1",
        payload: { value: 42 },
      });
      expect(mockEnsureDaemonRunning).toHaveBeenCalledOnce();
    });

    it("maps daemon control errors to the existing HTTP error contract", async () => {
      const { DaemonRequestError } = await import("@acpus/runtime");
      mockRequestDaemonControl.mockRejectedValue(new DaemonRequestError("RUN_NOT_CONTROLLABLE", "Run cannot be paused."));
      const res = await app.request("/api/runs/run_1/controls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "pause" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as JsonBody;
      expect(body.ok).toBe(false);
      expect(body.error).toEqual({ code: "run_not_controllable", message: "Run cannot be paused." });
    });

    it("returns 404 for unknown run", async () => {
      const { DaemonRequestError } = await import("@acpus/runtime");
      mockRequestDaemonControl.mockRejectedValue(new DaemonRequestError("RUN_NOT_FOUND", "Run 'nonexistent' was not found."));
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
      const catalogApp = createWebApp({ cwd, ensureDaemonRunning: mockEnsureDaemonRunning });
      const res = await catalogApp.request("/api/workflows/catalog");
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body.ok).toBe(true);
      expect(body.catalog).toEqual([{
        name: "release",
        entryPath: join(cwd, ".acpus", "workflows", "release", "workflow.ts"),
      }]);
    });

    it("lists only safe workflow files under the workspace", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "acpus-web-files-"));
      await writeFile(join(cwd, "workflow.ts"), "export default {};\n");
      await writeFile(join(cwd, "README.md"), "ignore\n");
      await mkdir(join(cwd, "nested"), { recursive: true });
      const filesApp = createWebApp({ cwd, ensureDaemonRunning: mockEnsureDaemonRunning });
      const res = await filesApp.request("/api/workflows/files");
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body.files.entries).toEqual(expect.arrayContaining([
        { name: "nested", path: "nested", kind: "directory" },
        { name: "workflow.ts", path: "workflow.ts", kind: "workflow" },
      ]));
      expect(body.files.dir).toBe("");
      expect(body.files.entries.some((entry: JsonBody) => entry.name === "README.md")).toBe(false);
    });

    it("rejects file browser path escapes", async () => {
      const res = await app.request("/api/workflows/files?dir=..");
      expect(res.status).toBe(400);
      const body = await res.json() as JsonBody;
      expect(body.error.code).toBe("invalid_workflow_path");
    });

    it("returns static workflow contract data from visualization", async () => {
      const visualizeApp = createWebApp({ cwd: process.cwd(), ensureDaemonRunning: mockEnsureDaemonRunning });
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
      expect(body.result.contract).toMatchObject({
        inputSchema: { kind: "object" },
        output: { kind: "object" },
        outputShape: { kind: "object" },
      });
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
