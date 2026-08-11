import type {
  RunControlTarget,
  RunDetails,
  RunRecord,
  RunRuntimeControls,
  RunRuntimeSnapshot,
  WebControlCommand,
  WorkspaceCatalog,
  WorkspaceSummary,
} from "../../api-types.js";
import { isWebGraph } from "./graph-decoder.js";
import {
  decodeEmpty,
  decodeField,
  invalidPayload,
  requestJson,
  type InvalidPayload,
} from "./transport.js";
import {
  hasOnlyKeys,
  isControlTarget,
  isOptionalNonNegativeInteger,
  isOptionalNumber,
  isOptionalString,
  isRecord,
  type JsonRecord,
} from "./wire.js";
import { isWorkflowContext } from "./workflows.js";

export async function listWorkspaces(): Promise<WorkspaceCatalog> {
  return requestJson(
    "/api/workspaces",
    undefined,
    decodeField("catalog", isWorkspaceCatalog),
  );
}

export async function listRuns(workspaceKey: string): Promise<RunRecord[]> {
  return requestJson(
    workspaceRunsUrl(workspaceKey),
    undefined,
    decodeField("runs", isRunRecords),
  );
}

export async function getRunRuntimeSnapshot(
  workspaceKey: string,
  runId: string,
): Promise<RunRuntimeSnapshot> {
  return requestJson(
    `${workspaceRunUrl(workspaceKey, runId)}/runtime-snapshot`,
    undefined,
    decodeRuntimeSnapshot,
  );
}

export async function submitRunCommand(
  workspaceKey: string,
  runId: string,
  command: WebControlCommand,
): Promise<void> {
  await requestJson<void>(`${workspaceRunUrl(workspaceKey, runId)}/controls`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  }, decodeEmpty);
}

export function workspaceRunUrl(workspaceKey: string, runId: string): string {
  return `${workspaceRunsUrl(workspaceKey)}/${encodeURIComponent(runId)}`;
}

function workspaceRunsUrl(workspaceKey: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceKey)}/runs`;
}

function decodeRuntimeSnapshot(body: JsonRecord): RunRuntimeSnapshot | InvalidPayload {
  return hasOnlyKeys(body, ["ok", "run", "workflow", "graph", "controls"])
    && isRunDetails(body.run)
    && isWorkflowContext(body.workflow)
    && isWebGraph(body.graph)
    && isRunRuntimeControls(body.controls)
    ? { run: body.run, workflow: body.workflow, graph: body.graph, controls: body.controls }
    : invalidPayload;
}

function isWorkspaceCatalog(value: unknown): value is WorkspaceCatalog {
  return isRecord(value)
    && hasOnlyKeys(value, ["currentWorkspaceKey", "workspaces"])
    && typeof value.currentWorkspaceKey === "string"
    && Array.isArray(value.workspaces)
    && value.workspaces.every(isWorkspaceSummary);
}

function isWorkspaceSummary(value: unknown): value is WorkspaceSummary {
  return isRecord(value)
    && hasOnlyKeys(value, ["key", "name", "path", "runCount", "lastRunUpdatedAt"])
    && typeof value.key === "string"
    && typeof value.name === "string"
    && typeof value.path === "string"
    && isOptionalNonNegativeInteger(value.runCount)
    && isOptionalString(value.lastRunUpdatedAt);
}

function isRunRecords(value: unknown): value is RunRecord[] {
  return Array.isArray(value) && value.every(isRunRecord);
}

function isRunRecord(value: unknown): value is RunRecord {
  return isRecord(value)
    && hasOnlyKeys(value, ["id", "name", "status", "createdAt", "updatedAt"])
    && typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.status === "string"
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string";
}

function isRunDetails(value: unknown): value is RunDetails {
  return isRecord(value)
    && hasOnlyKeys(value, [
      "id",
      "name",
      "status",
      "input",
      "output",
      "createdAt",
      "updatedAt",
      "runtimeVersion",
    ])
    && typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.status === "string"
    && Object.hasOwn(value, "input")
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string"
    && isOptionalNumber(value.runtimeVersion);
}

function isRunRuntimeControls(value: unknown): value is RunRuntimeControls {
  return isRecord(value)
    && hasOnlyKeys(value, ["canCancelRun", "retryTargets"])
    && typeof value.canCancelRun === "boolean"
    && Array.isArray(value.retryTargets)
    && value.retryTargets.every(isRunControlTarget);
}

function isRunControlTarget(value: unknown): value is RunControlTarget {
  return isRecord(value)
    && hasOnlyKeys(value, ["target", "kind", "nodeId"])
    && isControlTarget(value.target)
    && (value.kind === "node" || value.kind === "frame")
    && isOptionalString(value.nodeId);
}
