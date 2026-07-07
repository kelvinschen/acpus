import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import {
  applyRunControl,
  applySignalRunControl,
  getArtifact,
  getRun,
  getRunInspection,
  getRunVisualizationSnapshot,
  getRuntimeHealth,
  listArtifacts,
  listRuns,
  RuntimeUseCaseException,
  type RuntimeMutationAction,
} from "@acpus/runtime";
import type { JsonValue } from "@acpus/expression/ir";
import type { AccessPolicy } from "./security.js";
import { requireToken } from "./security.js";
import { graphFromOverlay } from "./graph.js";
import { inspectNode, inspectNodeExecution, type NodeInspectionContext } from "./node-inspection.js";
import { listProjectWorkflowCatalog, listWorkflowFiles, visualizeWorkflowSource, type WorkflowVisualizationSource } from "./workflows.js";
import { ApiError, apiError } from "./errors.js";
import { mountStaticAssets } from "./assets.js";

type WebRuntimeControlAction = Exclude<RuntimeMutationAction, "fork">;

export type WebAppOptions = {
  cwd: string;
  access?: AccessPolicy;
  staticDir?: string;
  port?: number;
  ensureDaemonRunning?: (cwd: string) => void;
};

export function createWebApp(options: WebAppOptions): Hono {
  const app = new Hono();

  app.use("*", requireToken(options.access ?? {}));

  app.get("/api/health", async (context) => {
    return context.json({ ok: true, health: await getRuntimeHealth(options.cwd) });
  });

  app.get("/api/runs", async (context) => {
    const runs = await listRuns(options.cwd);
    return context.json({ ok: true, runs, total: runs.length, order: "updatedAt DESC" });
  });

  app.get("/api/runs/:id", async (context) => {
    const run = await getRun(options.cwd, context.req.param("id"));
    if (!run) apiError(404, "run_not_found", `Run '${context.req.param("id")}' was not found.`);
    return context.json({ ok: true, run });
  });

  app.get("/api/runs/:id/runtime-snapshot", async (context) => {
    const snapshot = await getRunVisualizationSnapshot(options.cwd, context.req.param("id"));
    if (!snapshot) apiError(404, "run_not_found", `Run '${context.req.param("id")}' was not found.`);
    return context.json({ ok: true, run: snapshot.run, graph: graphFromOverlay(snapshot.overlay, "runtime") });
  });

  app.get("/api/runs/:id/nodes/:target/execution", async (context) => {
    const runId = context.req.param("id");
    const inspection = await getRunInspection(options.cwd, context.req.param("id"));
    if (!inspection) apiError(404, "run_not_found", `Run '${context.req.param("id")}' was not found.`);
    return context.json({
      ok: true,
      execution: await inspectNodeExecution(
        inspection,
        context.req.param("target"),
        inspectionContext(context.req.query("context")),
        artifactRef => readRunJsonArtifact(options.cwd, runId, artifactRef),
      ),
    });
  });

  app.get("/api/runs/:id/nodes/:target", async (context) => {
    const inspection = await getRunInspection(options.cwd, context.req.param("id"));
    if (!inspection) apiError(404, "run_not_found", `Run '${context.req.param("id")}' was not found.`);
    const artifacts = await listArtifacts(options.cwd, context.req.param("id"));
    return context.json({ ok: true, inspection: inspectNode(inspection, context.req.param("target"), artifacts, inspectionContext(context.req.query("context"))) });
  });

  app.post("/api/runs/:id/controls", async (context) => {
    const body = await context.req.json().catch(() =>
      apiError(400, "invalid_json", "Control body must be JSON."),
    );
    const result = await submitControl(options, context.req.param("id"), body);
    if (!result) apiError(404, "run_not_found", `Run '${context.req.param("id")}' was not found.`);
    if (result.run.status === "pending" || result.run.status === "running")
      options.ensureDaemonRunning?.(options.cwd);
    return context.json({ ok: true, result });
  });

  app.get("/api/runs/:id/artifacts/:artifactId/preview", async (context) => {
    const runId = context.req.param("id");
    const artifactId = context.req.param("artifactId");
    const artifact = await getArtifact(options.cwd, runId, artifactId);
    if (!artifact) apiError(404, "artifact_not_found", `Artifact '${artifactId}' was not found.`);
    const runDir = resolve(options.cwd, ".acpus", ".local", "runs", runId);
    const filePath = resolve(runDir, artifact.relativePath);
    if (!filePath.startsWith(runDir + "/")) apiError(403, "path_escape", "Artifact path escapes run directory.");
    const bytes = await readFile(filePath).catch(() => apiError(404, "artifact_read_failed", "Artifact file could not be read."));
    const maxPreview = 128 * 1024;
    const truncated = bytes.length > maxPreview;
    const body = truncated ? bytes.slice(0, maxPreview) : bytes;
    context.header("content-type", mediaType(artifact.relativePath));
    context.header("x-artifact-size", String(bytes.length));
    if (truncated) context.header("x-artifact-truncated", "true");
    return context.newResponse(body);
  });

  app.get("/api/workflows/catalog", async (context) => {
    return context.json({ ok: true, catalog: await listProjectWorkflowCatalog(options.cwd) });
  });

  app.get("/api/workflows/files", async (context) => {
    const dir = context.req.query("dir") ?? "";
    try {
      return context.json({ ok: true, files: await listWorkflowFiles(options.cwd, dir) });
    } catch (error) {
      apiError(400, "invalid_workflow_path", error instanceof Error ? error.message : String(error));
    }
  });

  app.post("/api/workflows/visualize", async (context) => {
    const body = await context.req.json().catch(() =>
      apiError(400, "invalid_json", "Visualization body must be JSON."),
    );
    const source = parseWorkflowVisualizationSource(body);
    return context.json({ ok: true, result: await visualizeWorkflowSource(options.cwd, source) });
  });

  app.get("/api/config", (context) => {
    return context.json({
      ok: true,
      config: {
        cwd: options.cwd,
        access: options.access?.tokenHash !== undefined ? "token" : "open",
        port: options.port ?? null,
      },
    });
  });

  mountStaticAssets(app, options.staticDir);

  app.notFound(context => {
    context.status(404);
    return context.json({ ok: false, error: { code: "not_found", message: "Route not found." } });
  });

  app.onError((error, context) => {
    if (error instanceof ApiError) {
      context.status(error.status as any);
      return context.json({ ok: false, error: { code: error.code, message: error.message } });
    }
    context.status(500);
    return context.json({
      ok: false,
      error: { code: "internal_error", message: error instanceof Error ? error.message : String(error) },
    });
  });

  return app;
}

async function submitControl(
  options: WebAppOptions,
  runId: string,
  body: unknown,
) {
  const command = parseControlBody(body);
  try {
    if (command.type === "signal")
      return await applySignalRunControl(options.cwd, runId, command.target, command.payload as JsonValue);
    return await applyRunControl(options.cwd, runId, command.type, command.input);
  } catch (error) {
    if (error instanceof RuntimeUseCaseException) {
      apiError(400, error.failure.type, error.failure.message);
    }
    throw error;
  }
}

function parseControlBody(body: unknown):
  | { type: WebRuntimeControlAction; input: { target?: string } }
  | { type: "signal"; target: string; payload: unknown }
{
  if (!body || typeof body !== "object") apiError(400, "invalid_command", "Control body must be an object.");
  const record = body as Record<string, unknown>;

  if (record.type === "pause" || record.type === "resume" || record.type === "retry" || record.type === "cancel") {
    return {
      type: record.type,
      input: typeof record.target === "string" && record.target.length > 0 ? { target: record.target } : {},
    };
  }
  if (record.type === "signal") {
    if (typeof record.target !== "string" || record.target.length === 0)
      apiError(400, "invalid_command", "Signal control requires a non-empty target.");
    if (record.payload === undefined)
      apiError(400, "invalid_command", "Signal control requires a payload.");
    return { type: "signal", target: record.target, payload: record.payload };
  }
  apiError(400, "invalid_command", "Unsupported control type.");
}

function mediaType(path: string): string {
  switch (extname(path)) {
    case ".json": return "application/json; charset=utf-8";
    case ".html": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".txt": case ".md": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

async function readRunJsonArtifact(cwd: string, runId: string, artifactRef: unknown): Promise<unknown | undefined> {
  if (!artifactRef || typeof artifactRef !== "object" || Array.isArray(artifactRef)) return undefined;
  const relativePath = (artifactRef as Record<string, unknown>).relativePath;
  if (typeof relativePath !== "string" || relativePath.length === 0) return undefined;
  const runDir = resolve(cwd, ".acpus", ".local", "runs", runId);
  const filePath = resolve(runDir, relativePath);
  if (!filePath.startsWith(runDir + "/")) return undefined;
  const bytes = await readFile(filePath).catch(() => undefined);
  if (!bytes) return undefined;
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function inspectionContext(value: string | undefined): NodeInspectionContext {
  if (!value) return [];
  try {
    const json = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) apiError(400, "invalid_context", "Inspection context must be an array.");
    return parsed.flatMap((item): NodeInspectionContext => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      if (typeof record.nodeId !== "string") return [];
      if (record.kind === "fanout") {
        return [{
          nodeId: record.nodeId,
          kind: "fanout" as const,
          ...(typeof record.itemKey === "string" ? { itemKey: record.itemKey } : {}),
          ...(typeof record.itemIndex === "number" ? { itemIndex: record.itemIndex } : {}),
        }];
      }
      if (record.kind === "loop") {
        return [{
          nodeId: record.nodeId,
          kind: "loop" as const,
          ...(typeof record.iteration === "number" ? { iteration: record.iteration } : {}),
        }];
      }
      return [];
    });
  } catch {
    apiError(400, "invalid_context", "Inspection context must be base64url JSON.");
  }
}

function parseWorkflowVisualizationSource(body: unknown): WorkflowVisualizationSource {
  if (!body || typeof body !== "object") apiError(400, "invalid_visualization_source", "Visualization body must be an object.");
  const record = body as Record<string, unknown>;
  const source = record.source;
  if (!source || typeof source !== "object") apiError(400, "invalid_visualization_source", "Visualization body requires a source object.");
  const value = source as Record<string, unknown>;
  if (value.kind === "catalog" && typeof value.name === "string" && value.name.length > 0) {
    return { kind: "catalog", name: value.name };
  }
  if (value.kind === "file" && typeof value.path === "string" && value.path.length > 0) {
    return { kind: "file", path: value.path };
  }
  apiError(400, "invalid_visualization_source", "Visualization source must be a catalog name or workspace file path.");
}
