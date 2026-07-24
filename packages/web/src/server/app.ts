import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import {
  getRunInspection,
  getRunVisualizationSnapshot,
  getRuntimeHealth,
  listRuns,
  readArtifact,
  requestDaemonControl,
  type DaemonControlIntent,
  type RunInspectionContext,
  type RunInspectionError,
  type RunInspectionTargetDocument,
} from "@acpus/runtime";
import type { JsonValue } from "@acpus/expression/ir";
import type { AccessPolicy } from "./security.js";
import { requireToken } from "./security.js";
import { graphFromOverlay } from "./graph.js";
import { inspectNodeExecution } from "./node-inspection.js";
import { listProjectWorkflowCatalog, listWorkflowFiles, visualizeWorkflowSource, type WorkflowVisualizationSource } from "./workflows.js";
import { ApiError, apiError } from "./errors.js";

type WebControlCommand =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "retry"; target: string }
  | { type: "cancel"; target?: string }
  | { type: "signal"; target: string; payload: unknown };

export type WebAppOptions = {
  cwd: string;
  access?: AccessPolicy;
  ensureDaemonRunning(cwd: string): void | Promise<void>;
};

export function createWebApp(options: WebAppOptions): Hono {
  const app = new Hono();

  app.use("*", requireToken(options.access ?? {}));

  app.get("/api/health", async (context) => {
    const health = await getRuntimeHealth(options.cwd);
    return context.json({
      ok: true,
      health: {
        checks: health.checks.map(({ area, status, message }) => ({ area, status, message })),
      },
    });
  });

  app.get("/api/runs", async (context) => {
    const runs = await listRuns(options.cwd);
    return context.json({
      ok: true,
      runs: runs.map(({ id, name, status }) => ({ id, name, status })),
    });
  });

  app.get("/api/runs/:id/runtime-snapshot", async (context) => {
    const snapshot = await getRunVisualizationSnapshot(options.cwd, context.req.param("id"));
    if (!snapshot) apiError(404, "run_not_found", `Run '${context.req.param("id")}' was not found.`);
    const dynamic = snapshot.run.dynamic;
    return context.json({
      ok: true,
      run: {
        id: snapshot.run.id,
        name: snapshot.run.name,
        status: snapshot.run.status,
        input: snapshot.run.input,
        ...(snapshot.run.output === undefined ? {} : { output: snapshot.run.output }),
        createdAt: snapshot.run.createdAt,
        updatedAt: snapshot.run.updatedAt,
        ...(dynamic === undefined ? {} : {
          dynamic: {
            version: dynamic.version,
            frames: dynamic.frames.filter(frame => frame.status === "failed").map(({ frameKey, nodeId, frameKind, status }) => ({
              frameKey,
              ...(nodeId === undefined ? {} : { nodeId }),
              ...(frameKind === undefined ? {} : { frameKind }),
              status,
            })),
            nodeInstances: dynamic.nodeInstances.filter(instance => instance.status === "failed").map(({ nodeKey, nodeId, status }) => ({ nodeKey, nodeId, status })),
            groupMembers: dynamic.groupMembers.filter(member => member.status === "failed").map(member => ({
              memberKey: member.memberKey,
              status: member.status,
              ...(member.memberKind === "branch"
                ? { memberKind: "branch" as const, branchId: member.branchId }
                : { memberKind: "fanout_item" as const, itemIndex: member.itemIndex }),
            })),
          },
        }),
      },
      graph: graphFromOverlay(snapshot.overlay, "runtime"),
    });
  });

  app.get("/api/runs/:id/nodes/:target/execution", async (context) => {
    const runId = context.req.param("id");
    const inspection = await readNodeInspection(
      options.cwd,
      runId,
      context.req.param("target"),
      inspectionContext(context.req.query("context")),
    );
    return context.json({
      ok: true,
      execution: await inspectNodeExecution(
        inspection,
        artifactRef => readRunJsonArtifact(options.cwd, inspection.artifacts, artifactRef),
      ),
    });
  });

  app.get("/api/runs/:id/nodes/:target", async (context) => {
    const inspection = await readNodeInspection(
      options.cwd,
      context.req.param("id"),
      context.req.param("target"),
      inspectionContext(context.req.query("context")),
    );
    return context.json({ ok: true, inspection: await loadInspectionPrompt(options.cwd, inspection) });
  });

  app.post("/api/runs/:id/controls", async (context) => {
    const body = await context.req.json().catch(() =>
      apiError(400, "invalid_json", "Control body must be JSON."),
    );
    await submitControl(options, context.req.param("id"), body);
    return context.json({ ok: true });
  });

  app.get("/api/runs/:id/artifacts/:artifactId/preview", async (context) => {
    const runId = context.req.param("id");
    const artifactId = context.req.param("artifactId");
    const verified = await readArtifact(options.cwd, runId, artifactId);
    if (!verified) apiError(404, "artifact_not_found", `Artifact '${artifactId}' was not found.`);
    const { artifact, bytes } = verified;
    context.header("content-type", artifact.mediaType ?? mediaType(artifact.path));
    return context.newResponse(Uint8Array.from(bytes.subarray(0, 128 * 1024)));
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
    return context.json({ ok: true, result: await visualizeWorkflowSource(options.cwd, source) });
  });

  app.get("/api/config", (context) => {
    return context.json({
      ok: true,
      config: {
        cwd: options.cwd,
        access: options.access?.tokenHash !== undefined ? "token" : "open",
      },
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
  runId: string,
  body: unknown,
) {
  const command = parseControlBody(body);
  await options.ensureDaemonRunning(options.cwd);
  const base = { requestId: `web:${randomUUID()}`, runId };
  const intent: DaemonControlIntent = command.type === "signal"
      ? { ...base, type: "signal", nodeId: command.target, payload: command.payload as JsonValue }
      : command.type === "pause" || command.type === "resume"
        ? { ...base, type: command.type }
        : command.type === "retry"
          ? { ...base, type: "retry", target: command.target }
          : { ...base, type: "cancel", ...(command.target === undefined ? {} : { target: command.target }) };
  const controlled = await requestDaemonControl(options.cwd, intent);
  if (controlled.isErr()) {
    if (controlled.error.type === "rejected") {
      apiError(controlled.error.code === "RUN_NOT_FOUND" ? 404 : 400, controlled.error.code.toLowerCase(), controlled.error.message);
    }
    throw new Error(controlled.error.message);
  }
}

function parseControlBody(body: unknown): WebControlCommand {
  if (!body || typeof body !== "object" || Array.isArray(body)) apiError(400, "invalid_command", "Control body must be an object.");
  const record = body as Record<string, unknown>;

  if (record.type === "pause" || record.type === "resume") {
    requireControlKeys(record, ["type"]);
    return { type: record.type };
  }
  if (record.type === "retry") {
    requireControlKeys(record, ["type", "target"]);
    if (typeof record.target !== "string" || record.target.length === 0)
      apiError(400, "invalid_command", "Retry control requires a non-empty target.");
    return { type: "retry", target: record.target };
  }
  if (record.type === "cancel") {
    requireControlKeys(record, ["type", "target"]);
    if (record.target === undefined) return { type: "cancel" };
    if (typeof record.target !== "string" || record.target.length === 0)
      apiError(400, "invalid_command", "Cancel target must be a non-empty string.");
    return { type: "cancel", target: record.target };
  }
  if (record.type === "signal") {
    requireControlKeys(record, ["type", "target", "payload"]);
    if (typeof record.target !== "string" || record.target.length === 0)
      apiError(400, "invalid_command", "Signal control requires a non-empty target.");
    if (!("payload" in record))
      apiError(400, "invalid_command", "Signal control requires a payload.");
    return { type: "signal", target: record.target, payload: record.payload };
  }
  apiError(400, "invalid_command", "Unsupported control type.");
}

function requireControlKeys(record: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(record).some(key => !allowed.includes(key)))
    apiError(400, "invalid_command", "Control body contains unsupported fields.");
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

async function readRunJsonArtifact(cwd: string, artifacts: RunInspectionTargetDocument["artifacts"], artifactRef: unknown): Promise<unknown | undefined> {
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

async function loadInspectionPrompt(cwd: string, inspection: RunInspectionTargetDocument): Promise<RunInspectionTargetDocument> {
  const prompt = inspection.summary.prompt;
  if (prompt?.kind !== "artifact" || prompt.field !== "prompt") return inspection;
  const artifact = await readRunJsonArtifact(cwd, inspection.artifacts, prompt);
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new Error(`Registered Agent prompt artifact '${prompt.artifactId}' is unavailable.`);
  }
  const text = (artifact as Record<string, unknown>)[prompt.field];
  if (typeof text !== "string") throw new Error(`Registered Agent prompt artifact '${prompt.artifactId}' has no string prompt.`);
  return {
    ...inspection,
    summary: { ...inspection.summary, prompt: { ...prompt, text } },
  };
}

async function readNodeInspection(
  cwd: string,
  runId: string,
  target: string,
  context: RunInspectionContext,
): Promise<RunInspectionTargetDocument> {
  const result = await getRunInspection(cwd, {
    runId,
    mode: "target",
    target,
    ...(context.length === 0 ? {} : { context }),
  });
  if (result.isErr()) inspectionError(result.error);
  if (result.value.kind !== "target") throw new Error("Runtime returned a non-target inspection document.");
  return result.value;
}

function inspectionError(error: RunInspectionError): never {
  if (error.type === "run-not-found" || error.type === "runtime-store-not-found") {
    apiError(404, "run_not_found", error.message);
  }
  if (error.type === "target-not-found") apiError(404, "target_not_found", error.message);
  if (error.type === "invalid-query") apiError(400, "invalid_inspection_query", error.message);
  throw error.cause ?? new Error(error.message);
}

function inspectionContext(value: string | undefined): RunInspectionContext {
  if (!value) return [];
  let parsed: unknown;
  try {
    const json = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    parsed = JSON.parse(json) as unknown;
  } catch {
    apiError(400, "invalid_context", "Inspection context must be base64url JSON.");
  }
  if (!Array.isArray(parsed)) apiError(400, "invalid_context", "Inspection context must be an array.");
  return parsed.map((item, index): RunInspectionContext[number] => {
    if (!item || typeof item !== "object") {
      apiError(400, "invalid_context", `Inspection context entry ${index} must be an object.`);
    }
    const record = item as Record<string, unknown>;
    if (typeof record.nodeId !== "string" || record.nodeId.length === 0) {
      apiError(400, "invalid_context", `Inspection context entry ${index} requires nodeId.`);
    }
    if (record.kind === "fanout" && isOccurrenceIndex(record.itemIndex)) {
      return { nodeId: record.nodeId, kind: "fanout", itemIndex: record.itemIndex };
    }
    if (record.kind === "loop" && isOccurrenceIndex(record.iteration)) {
      return { nodeId: record.nodeId, kind: "loop", iteration: record.iteration };
    }
    apiError(400, "invalid_context", `Inspection context entry ${index} must identify a fanout item or loop iteration.`);
  });
}

function isOccurrenceIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
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
