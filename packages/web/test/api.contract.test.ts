import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errAsync, okAsync } from "neverthrow";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockGetRuntimeHealth = vi.fn();
const mockListRuns = vi.fn();
const mockGetRunVisualizationSnapshot = vi.fn();
const mockInspectNode = vi.fn();
const mockInspectAgentExecution = vi.fn();
const mockReadArtifact = vi.fn();
const mockRequestDaemonControl = vi.fn();
const mockEnsureDaemonRunning = vi.fn();
const mockTryVisualizeWorkflowSource = vi.fn();

vi.mock("@acpus/runtime", () => ({
  getRuntimeHealth: (...args: unknown[]) => mockGetRuntimeHealth(...args),
  listRuns: (...args: unknown[]) => mockListRuns(...args),
  createWorkflowVisualizationOverlay: (ir: any) => ({ workflow: { name: ir.name }, nodes: [], groups: [] }),
  getRunVisualizationSnapshot: (...args: unknown[]) => mockGetRunVisualizationSnapshot(...args),
  inspectNode: (...args: unknown[]) => mockInspectNode(...args),
  inspectAgentExecution: (...args: unknown[]) => mockInspectAgentExecution(...args),
  readArtifact: (...args: unknown[]) => mockReadArtifact(...args),
  requestDaemonControl: (...args: unknown[]) => mockRequestDaemonControl(...args),
}));

vi.mock("../src/server/workflows.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/server/workflows.js")>(),
  tryVisualizeWorkflowSource: (...args: unknown[]) => mockTryVisualizeWorkflowSource(...args),
}));

import { createWebApp } from "../src/server/app.js";
import { createAccessPolicy } from "../src/server/security.js";

type JsonBody = Record<string, any>;

describe("web API contract", () => {
  const app = createWebApp({ cwd: "/tmp/acpus-web-test", ensureDaemonRunning: mockEnsureDaemonRunning });

  beforeEach(() => {
    vi.clearAllMocks();
    mockTryVisualizeWorkflowSource.mockReset();
  });

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
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

  it("sanitizes unexpected server failures", async () => {
    mockListRuns.mockRejectedValue(new Error("/secret/runtime.db EACCES"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await app.request("/api/runs");
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        ok: false,
        error: { code: "internal_error", message: "Internal server error." },
      });
      expect(logged).toHaveBeenCalledOnce();
    } finally {
      logged.mockRestore();
    }
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
          nodes: [{ nodeId: "step_1", target: "step_1", kind: "task", path: ["step_1"], instances: [], frames: [], attempts: [], signalWaits: [], status: "completed" }],
          groups: [],
        },
        controls: {
          canCancelRun: true,
          runtimeOnly: "not-public",
          retryTargets: [{
            target: "step_1#node",
            kind: "node",
            nodeId: "step_1",
            runtimeOnly: "not-public",
          }],
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
        runtimeVersion: 7,
      });
      expect(body.graph).toBeDefined();
      expect(body.controls).toEqual({
        canCancelRun: true,
        retryTargets: [{ target: "step_1#node", kind: "node", nodeId: "step_1" }],
      });
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
    it("requests the Runtime execution projection by canonical target and performs no artifact reads", async () => {
      mockInspectAgentExecution.mockResolvedValue(inspectionOk(executionInspection()));

      const res = await app.request("/api/runs/run_1/nodes/%401a2b3c4d5e6f/execution");

      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body).toEqual({
        ok: true,
        execution: {
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
        },
      });
      expect(mockInspectAgentExecution).toHaveBeenCalledWith("/tmp/acpus-web-test", {
        runId: "run_1",
        target: "@1a2b3c4d5e6f",
      });
      expect(mockReadArtifact).not.toHaveBeenCalled();
    });

    it("maps Runtime execution unavailability to Web-owned copy", async () => {
      mockInspectAgentExecution.mockResolvedValue(inspectionOk({
        ...executionInspection(),
        available: false,
        reason: "not-started",
        summary: { status: "not_started" },
        recentTools: [],
      }));

      const res = await app.request("/api/runs/run_1/nodes/review~abc/execution");

      expect(res.status).toBe(200);
      expect((await res.json() as JsonBody).execution).toMatchObject({
        available: false,
        reason: "No agent execution metadata exists for the selected scope.",
        lastObservedAt: "2026-07-01T00:00:02.000Z",
        summary: { status: "not_started" },
      });
    });

    it("returns a conflict for an ambiguous execution target", async () => {
      mockInspectAgentExecution.mockResolvedValue(inspectionErr({
        type: "target-ambiguous",
        runId: "run_1",
        target: "review",
        candidates: {
          kind: "candidates",
          run: { id: "run_1", status: "running" },
          target: "review",
          entries: [
            { selector: "@000000000001", status: "running", breadcrumb: "batch[0] › review" },
            { selector: "@000000000002", status: "running", breadcrumb: "batch[1] › review" },
          ],
        },
        message: "Run target 'review' matches multiple occurrences.",
      }));

      const res = await app.request("/api/runs/run_1/nodes/review/execution");

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        ok: false,
        error: {
          code: "target_ambiguous",
          message: "Run target 'review' matches multiple occurrences.",
        },
      });
    });

    it("delegates a deep canonical target to narrow runtime inspection", async () => {
      mockInspectNode.mockResolvedValue(inspectionOk(targetInspection()));
      const res = await app.request("/api/runs/run_1/nodes/%401a2b3c4d5e6f");

      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body).toEqual({
        ok: true,
        inspection: {
          nodeId: "review",
          nodeKey: "review~abc",
          cancelTarget: "review~abc",
          staticKind: "agent",
          runStartedAt: "2026-07-01T00:00:00.000Z",
          agent: { key: "reviewer" },
          artifacts: [],
        },
      });
      expect(mockInspectNode).toHaveBeenCalledWith("/tmp/acpus-web-test", {
        runId: "run_1",
        target: "@1a2b3c4d5e6f",
      });
    });

    it("loads the exact prompt field from a turn artifact without the preview size limit", async () => {
      const cwd = "/virtual/acpus-web-turn-prompt";
      const path = `${cwd}/runs/run_1/artifacts/turn-001.json`;
      const prompt = `${"p".repeat(130 * 1024)}PROMPT_TAIL`;
      const bytes = Buffer.from(JSON.stringify({ prompt, response: "done", summary: {} }));
      const artifact = {
        id: "turn-1",
        runId: "run_1",
        nodeKey: "review~abc",
        attempt: 1,
        mediaType: "application/json",
        digest: "sha256:verified",
        size: bytes.byteLength,
        path,
      };
      mockInspectNode.mockResolvedValue(inspectionOk(targetInspection({
        prompt: { kind: "artifact", artifactId: artifact.id, path, mediaType: artifact.mediaType, field: "prompt" },
        artifacts: [artifact],
      })));
      mockReadArtifact.mockResolvedValue({ artifact, bytes });
      const artifactApp = createWebApp({ cwd, ensureDaemonRunning: mockEnsureDaemonRunning });

      const res = await artifactApp.request("/api/runs/run_1/nodes/review~abc");

      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body.inspection.prompt).toEqual({
        kind: "artifact",
        text: prompt,
        artifactId: artifact.id,
        mediaType: artifact.mediaType,
      });
      expect(body.inspection.prompt.text.endsWith("PROMPT_TAIL")).toBe(true);
      expect(mockReadArtifact).toHaveBeenCalledOnce();
      expect(mockReadArtifact).toHaveBeenCalledWith(cwd, "run_1", artifact.id);
    });

    it("returns 404 for unknown run", async () => {
      mockInspectNode.mockResolvedValue(inspectionErr({
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
      mockInspectNode.mockResolvedValue(inspectionErr({
        type: "target-not-found",
        runId: "run_1",
        target: "missing",
        message: "Target 'missing' was not found.",
      }));

      const res = await app.request("/api/runs/run_1/nodes/missing");

      expect(res.status).toBe(404);
      expect((await res.json() as JsonBody).error.code).toBe("target_not_found");
    });

    it("does not expose inspection storage failures", async () => {
      const cause = new Error("/secret/runtime.db EIO");
      mockInspectNode.mockResolvedValue(inspectionErr({
        type: "inspection-read-failed",
        runId: "run_1",
        message: cause.message,
        cause,
      }));
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const res = await app.request("/api/runs/run_1/nodes/review");
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({
          ok: false,
          error: { code: "internal_error", message: "Internal server error." },
        });
        expect(logged).toHaveBeenCalledWith("Acpus WebUI request failed:", cause);
      } finally {
        logged.mockRestore();
      }
    });
  });

  describe("GET /api/runs/:id/artifacts/:artifactId/preview", () => {
    it("returns at most 128 KiB with the artifact media type", async () => {
      const cwd = "/virtual/acpus-web-artifact-preview";
      const path = `${cwd}/runs/run_1/artifacts/output.txt`;
      const bytes = Buffer.alloc(128 * 1024 + 7, "a");
      const artifact = {
        id: "artifact_1",
        runId: "run_1",
        nodeKey: "task_1",
        attempt: 1,
        digest: "sha256:verified",
        size: bytes.byteLength,
        path,
      };
      mockReadArtifact.mockResolvedValue({ artifact, bytes });
      const artifactApp = createWebApp({ cwd, ensureDaemonRunning: mockEnsureDaemonRunning });

      const res = await artifactApp.request("/api/runs/run_1/artifacts/artifact_1/preview");

      expect(res.status).toBe(200);
      expect(Object.fromEntries(res.headers)).toEqual({ "content-type": "text/plain; charset=utf-8" });
      expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes.subarray(0, 128 * 1024));
      expect(mockReadArtifact).toHaveBeenCalledWith(cwd, "run_1", "artifact_1");
    });

    it("returns 404 when the verified reader finds no registered artifact", async () => {
      mockReadArtifact.mockResolvedValue(undefined);

      const res = await app.request("/api/runs/run_1/artifacts/artifact_1/preview");

      expect(res.status).toBe(404);
      expect((await res.json() as JsonBody).error.code).toBe("artifact_not_found");
    });

    it("redacts verified reader failures as internal errors", async () => {
      mockReadArtifact.mockRejectedValue(new Error("/secret/artifacts/output.txt failed verification"));
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const res = await app.request("/api/runs/run_1/artifacts/artifact_1/preview");
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({
          ok: false,
          error: { code: "internal_error", message: "Internal server error." },
        });
        expect(logged).toHaveBeenCalledOnce();
      } finally {
        logged.mockRestore();
      }
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

    it.each([
      { type: "retry", target: "   " },
      { type: "cancel", target: "   " },
      { type: "signal", target: "   ", payload: {} },
    ])("rejects a blank $type target before daemon startup", async command => {
      const res = await app.request("/api/runs/run_1/controls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      });

      expect(res.status).toBe(400);
      expect((await res.json() as JsonBody).error.code).toBe("invalid_command");
      expect(mockEnsureDaemonRunning).not.toHaveBeenCalled();
      expect(mockRequestDaemonControl).not.toHaveBeenCalled();
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
      mockRequestDaemonControl.mockReturnValue(okAsync({ run: { id: "run_1", status: "paused" } }));
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
      mockRequestDaemonControl.mockReturnValue(okAsync({ run: { id: "run_1", status: "running" } }));
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
      mockRequestDaemonControl.mockReturnValue(okAsync({ run: { id: "run_1", status: "canceled" } }));
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
      mockRequestDaemonControl.mockReturnValue(okAsync({ run: { id: "run_1", status: "running" } }));
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
      mockRequestDaemonControl.mockReturnValue(errAsync({ type: "rejected", code: "RUN_NOT_CONTROLLABLE", message: "Run cannot be paused." }));
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
      mockRequestDaemonControl.mockReturnValue(errAsync({ type: "rejected", code: "RUN_NOT_FOUND", message: "Run 'nonexistent' was not found." }));
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
      const cwd = await temporaryDirectory("acpus-web-catalog-");
      await mkdir(join(cwd, ".acpus", "workflows", "release"), { recursive: true });
      await writeFile(join(cwd, ".acpus", "workflows", "release", "workflow.ts"), "throw new Error('must not import');\n");
      await mkdir(join(cwd, ".acpus", "workflows", "bad-name!"), { recursive: true });
      await writeFile(join(cwd, ".acpus", "workflows", "bad-name!", "workflow.ts"), "export default {};\n");
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

    it("does not treat a catalog symlink loop as an absent workflow", async () => {
      const cwd = await temporaryDirectory("acpus-web-catalog-loop-");
      const packageRoot = join(cwd, ".acpus", "workflows", "loop");
      await mkdir(packageRoot, { recursive: true });
      await symlink("workflow.ts", join(packageRoot, "workflow.ts"));
      const catalogApp = createWebApp({ cwd, ensureDaemonRunning: mockEnsureDaemonRunning });
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const res = await catalogApp.request("/api/workflows/catalog");
        expect(res.status).toBe(500);
        expect((await res.json() as JsonBody).error).toEqual({ code: "internal_error", message: "Internal server error." });
      } finally {
        logged.mockRestore();
      }
    });

    it("lists only safe workflow files under the workspace", async () => {
      const cwd = await temporaryDirectory("acpus-web-files-");
      await writeFile(join(cwd, "workflow.ts"), "export default {};\n");
      await writeFile(join(cwd, "README.md"), "ignore\n");
      await mkdir(join(cwd, "nested"), { recursive: true });
      const filesApp = createWebApp({ cwd, ensureDaemonRunning: mockEnsureDaemonRunning });
      const res = await filesApp.request("/api/workflows/files");
      expect(res.status).toBe(200);
      const body = await res.json() as JsonBody;
      expect(body.files).toEqual({
        dir: "",
        entries: [
          { name: "nested", path: "nested", kind: "directory" },
          { name: "workflow.ts", path: "workflow.ts", kind: "workflow" },
        ],
      });
    });

    it("rejects file browser path escapes", async () => {
      const res = await app.request("/api/workflows/files?dir=..");
      expect(res.status).toBe(400);
      const body = await res.json() as JsonBody;
      expect(body.error.code).toBe("invalid_workflow_path");
    });

    it("rejects file-browser symlinks that resolve outside the workspace", async () => {
      const cwd = await temporaryDirectory("acpus-web-files-symlink-");
      const outside = await temporaryDirectory("acpus-web-files-outside-");
      await symlink(outside, join(cwd, "outside"));
      const filesApp = createWebApp({ cwd, ensureDaemonRunning: mockEnsureDaemonRunning });

      const res = await filesApp.request("/api/workflows/files?dir=outside");

      expect(res.status).toBe(400);
      expect((await res.json() as JsonBody).error.code).toBe("invalid_workflow_path");
    });

    it("does not report a file-browser symlink loop as a user path error", async () => {
      const cwd = await temporaryDirectory("acpus-web-files-loop-");
      await symlink("loop", join(cwd, "loop"));
      const filesApp = createWebApp({ cwd, ensureDaemonRunning: mockEnsureDaemonRunning });
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const res = await filesApp.request("/api/workflows/files?dir=loop");
        expect(res.status).toBe(500);
        expect((await res.json() as JsonBody).error.code).toBe("internal_error");
      } finally {
        logged.mockRestore();
      }
    });

    it("delegates a validated source and returns its visualization", async () => {
      const result = {
        status: "ready",
        graph: { nodes: [], edges: [] },
        workflow: { name: "release", irVersion: 7, nodeCount: 0 },
        contract: {
          output: { kind: "object", fields: {} },
          outputShape: { kind: "object", possibleKeys: [] },
        },
        sourceGraphDigest: "sha256:source",
      };
      mockTryVisualizeWorkflowSource.mockReturnValue(okAsync(result));
      const cwd = "/virtual/acpus-web-visualize";
      const visualizeApp = createWebApp({ cwd, ensureDaemonRunning: mockEnsureDaemonRunning });
      const source = { kind: "file", path: "release.workflow.ts" };
      const res = await visualizeApp.request("/api/workflows/visualize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, result });
      expect(mockTryVisualizeWorkflowSource).toHaveBeenCalledOnce();
      expect(mockTryVisualizeWorkflowSource).toHaveBeenCalledWith(cwd, source);
    });

    it.each(["source", "check", "compile", "lock", "validate"] as const)(
      "preserves a %s visualization failure at the HTTP adapter",
      async phase => {
        mockTryVisualizeWorkflowSource.mockReturnValue(errAsync({
          type: "test-preparation-failure",
          phase,
          message: `${phase} preparation failed`,
        }));
        const visualizeApp = createWebApp({
          cwd: "/virtual/acpus-web-visualize",
          ensureDaemonRunning: mockEnsureDaemonRunning,
        });

        const res = await visualizeApp.request("/api/workflows/visualize", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source: { kind: "file", path: "release.workflow.ts" } }),
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          ok: true,
          result: {
            status: "failed",
            phase,
            message: `${phase} preparation failed`,
          },
        });
      },
    );

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

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

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

function executionInspection(): JsonBody {
  return {
    schemaVersion: 2,
    kind: "execution",
    run: {
      id: "run_1",
      status: "running",
      updatedAt: "2026-07-01T00:00:02.000Z",
      runtimeOnly: "private",
    },
    subject: {
      targetKind: "dynamic-node",
      id: "review~abc",
      label: "review",
      kind: "agent",
      nodeId: "review",
      nodeKey: "review~abc",
      runtimeOnly: "private",
    },
    available: true,
    summary: {
      status: "running",
      sessionName: "review-session",
      turnCount: 2,
      message: "working",
      runtimeOnly: "private",
    },
    lastObservedAt: "2026-07-01T00:00:02.000Z",
    contextWindow: {
      used: 2_500,
      size: 10_000,
      percent: 25,
      runtimeOnly: "private",
    },
    tokenUsage: {
      source: "usage_update",
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
      runtimeOnly: "private",
    },
    output: {
      tail: "partial response",
      totalBytes: 16,
      truncated: false,
      runtimeOnly: "private",
    },
    recentTools: [{
      turn: 2,
      toolCallId: "tool_1",
      toolName: "read_file",
      status: "running",
      durationMs: 20,
      inputPreview: "README.md",
      runtimeOnly: "private",
    }],
    runtimeOnly: "private",
  };
}

function targetInspection(overrides: {
  prompt?: JsonBody;
  artifacts?: JsonBody[];
  summary?: JsonBody;
  availableControls?: JsonBody[];
} = {}): JsonBody {
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
      ...overrides.summary,
      ...(overrides.prompt ? { prompt: overrides.prompt } : {}),
      artifacts: overrides.artifacts ?? [],
    },
    artifacts: overrides.artifacts ?? [],
    availableControls: overrides.availableControls ?? [{ type: "cancel", target: "review~abc" }],
  };
}
