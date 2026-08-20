import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import type { JsonValue } from "@acpus/expression/ir";
import {
  inspectAgentExecution,
  inspectNode,
  readArtifact,
  readInspection,
  requestDaemonControl,
  requestDaemonInspection,
  type DaemonClientFailure,
  type DaemonControlIntent,
  type InspectionError,
  type InspectionForensicsView,
  type RunInspectionAgentExecutionDocument,
  type RunInspectionError,
  type RunInspectionNodeDocument,
} from "@acpus/runtime";
import type { WebControlCommand } from "../../api-types.js";
import { apiError, runtimeReadError } from "../errors.js";
import { projectNodeExecution, projectNodeInspection, projectNodeRuntimeValues } from "../node-inspection.js";
import type { EnsureRuntimeAuthority } from "../runtime-authority.js";
import type { WebWorkspaceContext } from "../workspace-context.js";

type InspectionControlRouteOptions = {
  ensureDaemonRunning: EnsureRuntimeAuthority;
};

export function registerInspectionControlRoutes(
  app: Hono,
  options: InspectionControlRouteOptions,
  workspaces: WebWorkspaceContext,
): void {
  app.get("/api/workspaces/:workspaceKey/runs/:id/nodes/:target/execution", async (context) => {
    const workspace = await workspaces.resolve(context.req.param("workspaceKey"));
    const execution = await readNodeExecution(
      workspace.canonicalPath,
      context.req.param("id"),
      context.req.param("target"),
    );
    return context.json({ ok: true, execution: projectNodeExecution(execution) });
  });

  app.get("/api/workspaces/:workspaceKey/runs/:id/nodes/:target/runtime-values", async (context) => {
    const workspace = await workspaces.resolve(context.req.param("workspaceKey"));
    const view = await readNodeRuntimeValues(
      workspace.canonicalPath,
      context.req.param("id"),
      context.req.param("target"),
    );
    return context.json({ ok: true, runtimeValues: projectNodeRuntimeValues(view) });
  });

  app.get("/api/workspaces/:workspaceKey/runs/:id/nodes/:target", async (context) => {
    const workspace = await workspaces.resolve(context.req.param("workspaceKey"));
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
    const workspace = await workspaces.resolve(context.req.param("workspaceKey"));
    if (workspace.workspaceKey !== await workspaces.launchKey()) {
      apiError(403, "workspace_read_only", "Runs outside the launch workspace are read-only.");
    }
    const body = await context.req.json<JsonValue>().catch(() =>
      apiError(400, "invalid_json", "Control body must be JSON."),
    );
    await submitControl(options, workspace.canonicalPath, context.req.param("id"), body);
    return context.json({ ok: true });
  });
}

async function submitControl(
  options: InspectionControlRouteOptions,
  cwd: string,
  runId: string,
  body: JsonValue,
): Promise<void> {
  const command = parseControlBody(body);
  const readiness = await options.ensureDaemonRunning(cwd);
  if (!readiness.ok) {
    if (readiness.code === "RUNTIME_UPDATE_BLOCKED") {
      apiError(409, "runtime_update_blocked", readiness.message);
    }
    if (readiness.code === "RUNTIME_STORE_REPAIR_REQUIRED") {
      apiError(409, "runtime_store_fix_required", readiness.message);
    }
    if (readiness.code === "RUNTIME_STORE_UNSUPPORTED") {
      apiError(422, "runtime_store_unavailable", readiness.message);
    }
    apiError(503, "runtime_unavailable", readiness.message);
  }
  const base = { requestId: `web:${randomUUID()}`, runId };
  const intent: DaemonControlIntent = command.type === "signal"
    ? { ...base, type: "signal", nodeId: command.target, payload: command.payload }
    : command.type === "pause" || command.type === "resume"
      ? { ...base, type: command.type }
      : command.type === "retry"
        ? { ...base, type: "retry", target: command.target }
        : command.type === "steer"
              ? { ...base, type: "steer", target: command.target, instruction: command.instruction }
              : { ...base, type: "cancel", ...(command.target === undefined ? {} : { target: command.target }) };
  const controlled = await requestDaemonControl(cwd, intent);
  if (controlled.isErr()) {
    if (controlled.error.type === "rejected") {
      apiError(
        controlled.error.code === "RUN_NOT_FOUND"
          ? 404
          : 400,
        controlled.error.code.toLowerCase(),
        controlled.error.message,
      );
    }
    throw new Error(controlled.error.message);
  }
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
    return { type: record.type, target: record.target };
  }
  if (record.type === "steer") {
    requireControlKeys(record, ["type", "target", "instruction"]);
    if (typeof record.target !== "string" || record.target.trim().length === 0
      || typeof record.instruction !== "string" || record.instruction.trim().length === 0) {
      apiError(400, "invalid_command", "Steer control requires a non-empty target and instruction.");
    }
    return { type: "steer", target: record.target, instruction: record.instruction };
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

async function readRunJsonArtifact(
  cwd: string,
  artifacts: RunInspectionNodeDocument["artifacts"],
  artifactRef: unknown,
): Promise<unknown | undefined> {
  if (!artifactRef || typeof artifactRef !== "object" || Array.isArray(artifactRef)) return undefined;
  const artifactId = (artifactRef as Record<string, unknown>).artifactId;
  if (typeof artifactId !== "string" || artifactId.length === 0) return undefined;
  const artifact = artifacts.find(item => item.id === artifactId);
  if (!artifact) throw new Error(`Registered Agent artifact '${artifactId}' is missing from the run projection.`);
  const read = await readArtifact(cwd, artifact.runId, artifact.id);
  if (read.isErr()) runtimeReadError(read.error);
  const verified = read.value;
  if (!verified) throw new Error(`Registered Agent artifact '${artifactId}' is missing from the runtime registry.`);
  const parsed = JSON.parse(verified.bytes.toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Registered Agent artifact '${artifactId}' is not a JSON object.`);
  }
  return parsed;
}

async function readNodeInspection(cwd: string, runId: string, target: string): Promise<RunInspectionNodeDocument> {
  const result = await inspectNode(cwd, { runId, target });
  if (result.isErr()) inspectionError(result.error);
  const inspection = result.value;
  const live = await requestDaemonInspection(cwd, { kind: "target", runId, target, detail: "summary" });
  if (live.isErr()) {
    if (allowsOfflineInspection(live.error)) return inspection;
    apiError(503, "runtime_unavailable", live.error.message);
  }
  if (live.value.kind !== "target" || live.value.detail !== "summary") {
    return inspection;
  }
  return {
    ...inspection,
    availableControls: live.value.availableControls ?? [],
    summary: {
      ...inspection.summary,
      ...(live.value.agentSession === undefined ? {} : { agentSession: live.value.agentSession }),
      ...(live.value.steer === undefined ? {} : { steer: live.value.steer }),
    },
  };
}

function allowsOfflineInspection(error: DaemonClientFailure): boolean {
  return error.type === "transport" && (error.reason === "not-found" || error.reason === "refused")
    || error.type === "rejected" && error.code === "RUN_NOT_FOUND";
}

async function readNodeRuntimeValues(cwd: string, runId: string, target: string): Promise<InspectionForensicsView> {
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

async function readNodeExecution(cwd: string, runId: string, target: string): Promise<RunInspectionAgentExecutionDocument> {
  const result = await inspectAgentExecution(cwd, { runId, target });
  if (result.isErr()) inspectionError(result.error);
  return result.value;
}

function inspectionError(error: RunInspectionError): never {
  mapRuntimeReadError(error);
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
  mapRuntimeReadError(error);
  if (error.type === "run-not-found" || error.type === "runtime-store-not-found") {
    apiError(404, "run_not_found", error.message);
  }
  if (error.type === "target-not-found") apiError(404, "target_not_found", error.message);
  if (error.type === "target-ambiguous") apiError(409, "target_ambiguous", error.message);
  if (error.type === "invalid-query") apiError(400, "invalid_inspection_query", error.message);
  throw new Error(error.message);
}

function mapRuntimeReadError(error: RunInspectionError | InspectionError): void {
  if (error.type === "runtime-store-repair-required"
    || error.type === "runtime-store-unsupported"
    || error.type === "runtime-store-unavailable") {
    runtimeReadError(error);
  }
}
