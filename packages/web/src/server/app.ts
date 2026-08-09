import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import {
  getRunVisualizationSnapshot,
  getRuntimeHealth,
  inspectAgentExecution,
  listKnownWorkspaces,
  inspectNode,
  listRuns,
  readArtifact,
  readInspection,
  requestDaemonControl,
  resolveKnownWorkspace,
  type DaemonControlIntent,
  type InspectionError,
  type InspectionForensicsView,
  type RunInspectionError,
  type RunInspectionAgentExecutionDocument,
  type RunInspectionNodeDocument,
} from "@acpus/runtime";
import type { JsonValue } from "@acpus/expression/ir";
import type {
  HealthReport,
  RunDetails,
  RunRecord,
  RunRuntimeSnapshot,
  ServerConfig,
  WebControlCommand,
  WorkspaceCatalog,
  WorkspaceSummary,
  WorkflowVisualizationSource,
} from "../api-types.js";
import type { AccessPolicy } from "./security.js";
import { requireToken } from "./security.js";
import { graphFromOverlay } from "./graph.js";
import { projectNodeExecution, projectNodeInspection, projectNodeRuntimeValues } from "./node-inspection.js";
import { listProjectWorkflowCatalog, listWorkflowFiles, tryVisualizeWorkflowSource } from "./workflows.js";
import { ApiError, apiError } from "./errors.js";

export type WebAppOptions = {
  cwd: string;
  access?: AccessPolicy;
  ensureDaemonRunning(cwd: string): void | Promise<void>;
};

export function createWebApp(options: WebAppOptions): Hono {
  const app = new Hono();
  let launchWorkspaceKey: string | undefined;

  async function getWorkspaceListing() {
    const listing = await listKnownWorkspaces(options.cwd);
    launchWorkspaceKey ??= listing.currentWorkspaceKey;
    return listing;
  }

  async function getLaunchWorkspaceKey(): Promise<string> {
    return launchWorkspaceKey ?? (await getWorkspaceListing()).currentWorkspaceKey;
  }

  app.use("*", requireToken(options.access ?? {}));

  app.get("/api/health", async (context) => {
    const health = await getRuntimeHealth(options.cwd);
    const report = {
      checks: health.checks.map(({ area, status, message }) => ({ area, status, message })),
    } satisfies HealthReport;
    return context.json({
      ok: true,
      health: report,
    });
  });

  app.get("/api/workspaces", async (context) => {
    const listing = await getWorkspaceListing();
    const catalog = {
      currentWorkspaceKey: listing.currentWorkspaceKey,
      workspaces: listing.workspaces.map(workspace => ({
        key: workspace.workspaceKey,
        name: basename(workspace.canonicalPath) || workspace.canonicalPath,
        path: workspace.canonicalPath,
        runCount: workspace.runCount,
        ...(workspace.lastRunUpdatedAt === undefined
          ? {}
          : { lastRunUpdatedAt: workspace.lastRunUpdatedAt }),
      }) satisfies WorkspaceSummary),
    } satisfies WorkspaceCatalog;
    return context.json({ ok: true, catalog });
  });

  app.get("/api/workspaces/:workspaceKey/runs", async (context) => {
    const workspace = await resolveRequestWorkspace(options.cwd, context.req.param("workspaceKey"));
    const runs = await listRuns(workspace.canonicalPath);
    return context.json({
      ok: true,
      runs: runs.map(({ id, name, status, createdAt, updatedAt }) => ({
        id,
        name,
        status,
        createdAt,
        updatedAt,
      }) satisfies RunRecord),
    });
  });

  app.get("/api/workspaces/:workspaceKey/runs/:id/runtime-snapshot", async (context) => {
    const workspace = await resolveRequestWorkspace(options.cwd, context.req.param("workspaceKey"));
    const snapshot = await getRunVisualizationSnapshot(workspace.canonicalPath, context.req.param("id"));
    if (!snapshot) apiError(404, "run_not_found", `Run '${context.req.param("id")}' was not found.`);
    const run = {
      id: snapshot.run.id,
      name: snapshot.run.name,
      status: snapshot.run.status,
      input: snapshot.run.input,
      ...(snapshot.run.output === undefined ? {} : { output: snapshot.run.output }),
      createdAt: snapshot.run.createdAt,
      updatedAt: snapshot.run.updatedAt,
      ...(snapshot.run.dynamic === undefined
        ? {}
        : { runtimeVersion: snapshot.run.dynamic.version }),
    } satisfies RunDetails;
    const response = {
      run,
      workflow: snapshot.workflow,
      graph: graphFromOverlay(snapshot.overlay, "runtime"),
      controls: {
        canCancelRun: snapshot.controls.canCancelRun,
        retryTargets: snapshot.controls.retryTargets.map(target => ({
          target: target.target,
          kind: target.kind,
          ...(target.nodeId === undefined ? {} : { nodeId: target.nodeId }),
        })),
      },
    } satisfies RunRuntimeSnapshot;
    return context.json({
      ok: true,
      ...response,
    });
  });

  app.get("/api/workspaces/:workspaceKey/runs/:id/nodes/:target/execution", async (context) => {
    const workspace = await resolveRequestWorkspace(options.cwd, context.req.param("workspaceKey"));
    const runId = context.req.param("id");
    const execution = await readNodeExecution(
      workspace.canonicalPath,
      runId,
      context.req.param("target"),
    );
    return context.json({
      ok: true,
      execution: projectNodeExecution(execution),
    });
  });

  app.get("/api/workspaces/:workspaceKey/runs/:id/nodes/:target/runtime-values", async (context) => {
    const workspace = await resolveRequestWorkspace(options.cwd, context.req.param("workspaceKey"));
    const view = await readNodeRuntimeValues(
      workspace.canonicalPath,
      context.req.param("id"),
      context.req.param("target"),
    );
    return context.json({
      ok: true,
      runtimeValues: projectNodeRuntimeValues(view),
    });
  });

  app.get("/api/workspaces/:workspaceKey/runs/:id/nodes/:target", async (context) => {
    const workspace = await resolveRequestWorkspace(options.cwd, context.req.param("workspaceKey"));
    const inspection = await readNodeInspection(
      workspace.canonicalPath,
      context.req.param("id"),
      context.req.param("target"),
    );
    return context.json({
      ok: true,
      inspection: await projectNodeInspection(
        inspection,
        artifactRef => readRunJsonArtifact(workspace.canonicalPath, inspection.artifacts, artifactRef),
      ),
    });
  });

  app.post("/api/workspaces/:workspaceKey/runs/:id/controls", async (context) => {
    const workspaceKey = context.req.param("workspaceKey");
    const workspace = await resolveRequestWorkspace(options.cwd, workspaceKey);
    if (workspace.workspaceKey !== await getLaunchWorkspaceKey()) {
      apiError(403, "workspace_read_only", "Runs outside the launch workspace are read-only.");
    }
    const body = await context.req.json<JsonValue>().catch(() =>
      apiError(400, "invalid_json", "Control body must be JSON."),
    );
    await submitControl(options, workspace.canonicalPath, context.req.param("id"), body);
    return context.json({ ok: true });
  });

  app.get("/api/workspaces/:workspaceKey/runs/:id/artifacts/:artifactId/preview", async (context) => {
    const workspace = await resolveRequestWorkspace(options.cwd, context.req.param("workspaceKey"));
    const runId = context.req.param("id");
    const artifactId = context.req.param("artifactId");
    const verified = await readArtifact(workspace.canonicalPath, runId, artifactId);
    if (!verified) apiError(404, "artifact_not_found", `Artifact '${artifactId}' was not found.`);
    const { artifact, bytes } = verified;
    const previewBytes = bytes.subarray(0, artifactPreviewLimit);
    setArtifactResponseHeaders(context, artifact.path, artifact.mediaType, bytes.byteLength, {
      truncated: previewBytes.byteLength < bytes.byteLength,
    });
    return context.newResponse(Uint8Array.from(previewBytes));
  });

  app.get("/api/workspaces/:workspaceKey/runs/:id/artifacts/:artifactId/content", async (context) => {
    const workspace = await resolveRequestWorkspace(options.cwd, context.req.param("workspaceKey"));
    const runId = context.req.param("id");
    const artifactId = context.req.param("artifactId");
    const verified = await readArtifact(workspace.canonicalPath, runId, artifactId);
    if (!verified) apiError(404, "artifact_not_found", `Artifact '${artifactId}' was not found.`);
    const { artifact, bytes } = verified;
    setArtifactResponseHeaders(context, artifact.path, artifact.mediaType, bytes.byteLength, {
      fileName: safeArtifactFileName(artifact.path, artifact.id),
    });
    return context.newResponse(Uint8Array.from(bytes));
  });

  app.get("/api/workflows/catalog", async (context) => {
    return context.json({ ok: true, catalog: await listProjectWorkflowCatalog(options.cwd) });
  });

  app.get("/api/workflows/files", async (context) => {
    const dir = context.req.query("dir") ?? "";
    const files = await listWorkflowFiles(options.cwd, dir);
    if (files.isErr()) apiError(400, "invalid_workflow_path", files.error.message);
    return context.json({ ok: true, files: files.value });
  });

  app.post("/api/workflows/visualize", async (context) => {
    const body = await context.req.json().catch(() =>
      apiError(400, "invalid_json", "Visualization body must be JSON."),
    );
    const source = parseWorkflowVisualizationSource(body);
    const visualization = await tryVisualizeWorkflowSource(options.cwd, source);
    return context.json({
      ok: true,
      result: visualization.match(
        ready => ready,
        failure => ({ status: "failed" as const, phase: failure.phase, message: failure.message }),
      ),
    });
  });

  app.get("/api/config", (context) => {
    const config = {
      cwd: options.cwd,
      access: options.access?.tokenHash !== undefined ? "token" : "open",
    } satisfies ServerConfig;
    return context.json({
      ok: true,
      config,
    });
  });

  app.notFound(context => {
    context.status(404);
    return context.json({ ok: false, error: { code: "not_found", message: "Route not found." } });
  });

  app.onError((error, context) => {
    if (error instanceof ApiError) {
      context.status(error.status as any);
      return context.json({ ok: false, error: { code: error.code, message: error.message } });
    }
    console.error("Acpus WebUI request failed:", error);
    context.status(500);
    return context.json({
      ok: false,
      error: { code: "internal_error", message: "Internal server error." },
    });
  });

  return app;
}

async function submitControl(
  options: WebAppOptions,
  cwd: string,
  runId: string,
  body: JsonValue,
) {
  const command = parseControlBody(body);
  await options.ensureDaemonRunning(cwd);
  const base = { requestId: `web:${randomUUID()}`, runId };
  const intent: DaemonControlIntent = command.type === "signal"
      ? { ...base, type: "signal", nodeId: command.target, payload: command.payload }
      : command.type === "pause" || command.type === "resume"
        ? { ...base, type: command.type }
        : command.type === "retry"
          ? { ...base, type: "retry", target: command.target }
          : { ...base, type: "cancel", ...(command.target === undefined ? {} : { target: command.target }) };
  const controlled = await requestDaemonControl(cwd, intent);
  if (controlled.isErr()) {
    if (controlled.error.type === "rejected") {
      apiError(controlled.error.code === "RUN_NOT_FOUND" ? 404 : 400, controlled.error.code.toLowerCase(), controlled.error.message);
    }
    throw new Error(controlled.error.message);
  }
}

async function resolveRequestWorkspace(cwd: string, workspaceKey: string) {
  const resolved = await resolveKnownWorkspace(cwd, workspaceKey);
  if (resolved.isErr()) {
    apiError(404, "workspace_not_found", `Workspace '${workspaceKey}' was not found.`);
  }
  return resolved.value;
}

function parseControlBody(body: JsonValue): WebControlCommand {
  if (!body || typeof body !== "object" || Array.isArray(body)) apiError(400, "invalid_command", "Control body must be an object.");
  const record = body;

  if (record.type === "pause" || record.type === "resume") {
    requireControlKeys(record, ["type"]);
    return { type: record.type };
  }
  if (record.type === "retry") {
    requireControlKeys(record, ["type", "target"]);
    if (typeof record.target !== "string" || record.target.trim().length === 0)
      apiError(400, "invalid_command", "Retry control requires a non-empty target.");
    return { type: "retry", target: record.target };
  }
  if (record.type === "cancel") {
    requireControlKeys(record, ["type", "target"]);
    if (record.target === undefined) return { type: "cancel" };
    if (typeof record.target !== "string" || record.target.trim().length === 0)
      apiError(400, "invalid_command", "Cancel target must be a non-empty string.");
    return { type: "cancel", target: record.target };
  }
  if (record.type === "signal") {
    requireControlKeys(record, ["type", "target", "payload"]);
    if (typeof record.target !== "string" || record.target.trim().length === 0)
      apiError(400, "invalid_command", "Signal control requires a non-empty target.");
    const payload = record.payload;
    if (payload === undefined)
      apiError(400, "invalid_command", "Signal control requires a payload.");
    return { type: "signal", target: record.target, payload };
  }
  apiError(400, "invalid_command", "Unsupported control type.");
}

function requireControlKeys(record: Record<string, JsonValue>, allowed: string[]): void {
  if (Object.keys(record).some(key => !allowed.includes(key)))
    apiError(400, "invalid_command", "Control body contains unsupported fields.");
}

const artifactPreviewLimit = 128 * 1024;
const artifactHtmlCsp = [
  "sandbox allow-scripts",
  "default-src https: data: blob:",
  "script-src 'unsafe-inline' https: data: blob:",
  "style-src 'unsafe-inline' https: data: blob:",
  "connect-src https: data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function setArtifactResponseHeaders(
  context: Context,
  path: string,
  registeredMediaType: string | undefined,
  size: number,
  options: { truncated?: boolean; fileName?: string },
): void {
  const type = registeredMediaType ?? mediaType(path);
  context.header("content-type", type);
  context.header("cache-control", "no-store");
  context.header("x-content-type-options", "nosniff");
  context.header("referrer-policy", "no-referrer");
  context.header("x-acpus-artifact-size", String(size));
  if (options.truncated !== undefined) {
    context.header("x-acpus-artifact-truncated", String(options.truncated));
  }
  if (options.fileName !== undefined) {
    const encodedName = encodeURIComponent(options.fileName).replace(/[!'()*]/g, character =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    context.header("x-acpus-artifact-name", encodedName);
    context.header("content-disposition", `inline; filename*=UTF-8''${encodedName}`);
  }
  if (type.split(";", 1)[0]?.trim().toLowerCase() === "text/html") {
    context.header("content-security-policy", artifactHtmlCsp);
  }
}

function safeArtifactFileName(path: string, artifactId: string): string {
  const name = (basename(path) || artifactId).replace(/[\\/\u0000-\u001f\u007f]/g, "_");
  return name === "." || name === ".." || name.length === 0 ? "artifact" : name;
}

function mediaType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".json": return "application/json; charset=utf-8";
    case ".html": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".md": case ".markdown": return "text/markdown; charset=utf-8";
    case ".txt": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

async function readRunJsonArtifact(cwd: string, artifacts: RunInspectionNodeDocument["artifacts"], artifactRef: unknown): Promise<unknown | undefined> {
  if (!artifactRef || typeof artifactRef !== "object" || Array.isArray(artifactRef)) return undefined;
  const artifactId = (artifactRef as Record<string, unknown>).artifactId;
  if (typeof artifactId !== "string" || artifactId.length === 0) return undefined;
  const artifact = artifacts.find(item => item.id === artifactId);
  if (!artifact) throw new Error(`Registered Agent artifact '${artifactId}' is missing from the run projection.`);
  const verified = await readArtifact(cwd, artifact.runId, artifact.id);
  if (!verified) throw new Error(`Registered Agent artifact '${artifactId}' is missing from the runtime registry.`);
  const parsed = JSON.parse(verified.bytes.toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Registered Agent artifact '${artifactId}' is not a JSON object.`);
  }
  return parsed;
}

async function readNodeInspection(
  cwd: string,
  runId: string,
  target: string,
): Promise<RunInspectionNodeDocument> {
  const result = await inspectNode(cwd, { runId, target });
  if (result.isErr()) inspectionError(result.error);
  return result.value;
}

async function readNodeRuntimeValues(
  cwd: string,
  runId: string,
  target: string,
): Promise<InspectionForensicsView> {
  const result = await readInspection(cwd, { kind: "target", runId, target, detail: "forensics" });
  if (result.isErr()) coherentInspectionError(result.error);
  const view = result.value;
  if (view.kind === "candidates") {
    apiError(409, "target_ambiguous", `Run target '${target}' matches multiple occurrences.`);
  }
  if (view.kind !== "target" || view.detail !== "forensics") {
    throw new Error("Runtime returned an unexpected inspection view.");
  }
  return view;
}

async function readNodeExecution(
  cwd: string,
  runId: string,
  target: string,
): Promise<RunInspectionAgentExecutionDocument> {
  const result = await inspectAgentExecution(cwd, { runId, target });
  if (result.isErr()) inspectionError(result.error);
  return result.value;
}

function inspectionError(error: RunInspectionError): never {
  if (error.type === "run-not-found" || error.type === "runtime-store-not-found") {
    apiError(404, "run_not_found", error.message);
  }
  if (error.type === "target-not-found") apiError(404, "target_not_found", error.message);
  if (error.type === "target-ambiguous") apiError(409, "target_ambiguous", error.message);
  if (error.type === "target-ref-collision") apiError(409, "target_ref_collision", error.message);
  if (error.type === "invalid-query") apiError(400, "invalid_inspection_query", error.message);
  throw error.type === "inspection-read-failed" && error.cause !== undefined
    ? error.cause
    : new Error(error.message);
}

function coherentInspectionError(error: InspectionError): never {
  if (error.type === "run-not-found" || error.type === "runtime-store-not-found") {
    apiError(404, "run_not_found", error.message);
  }
  if (error.type === "target-not-found") apiError(404, "target_not_found", error.message);
  if (error.type === "target-ambiguous") apiError(409, "target_ambiguous", error.message);
  if (error.type === "invalid-query") apiError(400, "invalid_inspection_query", error.message);
  throw new Error(error.message);
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
