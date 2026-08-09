import { isJsonValue } from "@acpus/expression/ir";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import type {
  HealthReport,
  NodeExecutionInspection,
  NodeInspection,
  NodeInspectionFailure,
  NodeRuntimeValues,
  ProjectWorkflowCatalogEntry,
  RunControlTarget,
  RunDetails,
  RunRecord,
  RunRuntimeControls,
  RunRuntimeSnapshot,
  ServerConfig,
  WebControlCommand,
  WorkspaceCatalog,
  WorkspaceSummary,
  WorkflowFileEntry,
  WorkflowFiles,
  WorkflowVisualizationResult,
  WorkflowVisualizationSource,
  WorkflowContext,
} from "../api-types.js";
import type {
  NodeDetail,
  WebGraph,
  WebGraphSelection,
} from "../graph-types.js";
export type {
  HealthReport,
  NodeExecutionInspection,
  NodeInspection,
  NodeInspectionFailure,
  NodeRuntimeValues,
  ProjectWorkflowCatalogEntry,
  RunControlTarget,
  RunDetails,
  RunRecord,
  RunRuntimeSnapshot,
  ServerConfig,
  WebControlCommand,
  WorkspaceCatalog,
  WorkspaceSummary,
  WorkflowFileEntry,
  WorkflowFiles,
  WorkflowVisualizationResult,
  WorkflowVisualizationSource,
  WorkflowContext,
};
export type {
  NodeDetail,
  WebGraph,
  WebGraphNode,
} from "../graph-types.js";

export type ArtifactPreview = {
  text: string;
  mediaType: string;
  size: number;
  truncated: boolean;
};

export type ArtifactContent = {
  bytes: Uint8Array;
  mediaType: string;
  size: number;
  fileName: string;
};

export type WebApiFailure =
  | { type: "network-failed"; message: string }
  | { type: "response-invalid-json"; status: number; message: string }
  | { type: "response-invalid-envelope"; status: number; message: string }
  | { type: "request-failed"; status: number; code: string; message: string };

export class WebApiError extends Error {
  constructor(readonly failure: WebApiFailure) {
    super(failure.message);
  }
}

type JsonRecord = Record<string, unknown>;
const invalidPayload: unique symbol = Symbol("invalid-payload");
type InvalidPayload = typeof invalidPayload;
type EndpointDecoder<T> = (body: JsonRecord) => T | InvalidPayload;

function requestJson<T>(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  decode: EndpointDecoder<T>,
): ResultAsync<T, WebApiFailure> {
  return ResultAsync.fromPromise(fetch(input, init), cause => ({
    type: "network-failed" as const,
    message: errorMessage(cause, "Network request failed."),
  })).andThen(response => ResultAsync.fromPromise(response.text(), cause => ({
    type: "network-failed" as const,
    message: errorMessage(cause, "Response body could not be read."),
  })).andThen(text => {
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      return err({
        type: "response-invalid-json" as const,
        status: response.status,
        message: `Response from ${requestLabel(input)} was not valid JSON.`,
      });
    }
    if (!isRecord(body)) {
      return err({
        type: "response-invalid-envelope" as const,
        status: response.status,
        message: `Response from ${requestLabel(input)} was not an object envelope.`,
      });
    }
    if (!response.ok || body.ok !== true) {
      const failure = isRecord(body.error) ? body.error : undefined;
      if (body.ok === false && typeof failure?.code === "string" && typeof failure.message === "string") {
        return err({ type: "request-failed" as const, status: response.status, code: failure.code, message: failure.message });
      }
      return err({
        type: "response-invalid-envelope" as const,
        status: response.status,
        message: `Response from ${requestLabel(input)} did not contain a valid error envelope.`,
      });
    }
    let payload: T | InvalidPayload;
    try {
      payload = decode(body);
    } catch (cause) {
      if (!(cause instanceof RangeError)) throw cause;
      payload = invalidPayload;
    }
    if (payload === invalidPayload) {
      return err({
        type: "response-invalid-envelope" as const,
        status: response.status,
        message: `Response from ${requestLabel(input)} did not contain the expected result.`,
      });
    }
    return ok(payload);
  }));
}

function queryPromise<T>(result: ResultAsync<T, WebApiFailure>): Promise<T> {
  return result.match(
    value => value,
    failure => { throw new WebApiError(failure); },
  );
}

export async function getHealth(): Promise<HealthReport> {
  return queryPromise(requestJson("/api/health", undefined, decodeField("health", isHealthReport)));
}

export async function listWorkspaces(): Promise<WorkspaceCatalog> {
  return queryPromise(requestJson(
    "/api/workspaces",
    undefined,
    decodeField("catalog", isWorkspaceCatalog),
  ));
}

export async function listRuns(workspaceKey: string): Promise<RunRecord[]> {
  return queryPromise(requestJson(
    workspaceRunsUrl(workspaceKey),
    undefined,
    decodeField("runs", isRunRecords),
  ));
}

export async function getRunRuntimeSnapshot(workspaceKey: string, runId: string): Promise<RunRuntimeSnapshot> {
  return queryPromise(requestJson(
    `${workspaceRunUrl(workspaceKey, runId)}/runtime-snapshot`,
    undefined,
    decodeRuntimeSnapshot,
  ));
}

export async function getNodeInspection(workspaceKey: string, runId: string, target: string): Promise<NodeInspection> {
  return queryPromise(requestJson(
    nodeInspectionUrl(workspaceKey, runId, target),
    undefined,
    decodeField("inspection", isNodeInspection),
  ));
}

export async function getNodeRuntimeValues(workspaceKey: string, runId: string, target: string): Promise<NodeRuntimeValues> {
  return queryPromise(requestJson(
    nodeInspectionUrl(workspaceKey, runId, target, "/runtime-values"),
    undefined,
    decodeField("runtimeValues", isNodeRuntimeValues),
  ));
}

export async function getNodeExecutionInspection(workspaceKey: string, runId: string, target: string): Promise<NodeExecutionInspection> {
  return queryPromise(requestJson(
    nodeInspectionUrl(workspaceKey, runId, target, "/execution"),
    undefined,
    decodeField("execution", isNodeExecutionInspection),
  ));
}

function nodeInspectionUrl(workspaceKey: string, runId: string, target: string, suffix = ""): string {
  return `${workspaceRunUrl(workspaceKey, runId)}/nodes/${encodeURIComponent(target)}${suffix}`;
}

export async function getArtifactPreview(workspaceKey: string, runId: string, artifactId: string): Promise<ArtifactPreview> {
  const url = `${workspaceRunUrl(workspaceKey, runId)}/artifacts/${encodeURIComponent(artifactId)}/preview`;
  const result: ResultAsync<ArtifactPreview, WebApiFailure> = requestArtifactResponse(url).andThen(response => {
    const metadata = parseArtifactMetadata(response, true);
    if (metadata.isErr()) return err(metadata.error);
    return ResultAsync.fromPromise(response.arrayBuffer(), cause => ({
      type: "network-failed" as const,
      message: errorMessage(cause, "Artifact preview body could not be read."),
    })).andThen(buffer => {
      const expectedLength = Math.min(metadata.value.size, 128 * 1024);
      if (buffer.byteLength !== expectedLength || metadata.value.truncated !== (metadata.value.size > expectedLength)) {
        return invalidArtifactMetadata<ArtifactPreview>(response, "Artifact preview body did not match its metadata.");
      }
      return ok({ text: new TextDecoder().decode(buffer), ...metadata.value });
    });
  });
  return queryPromise(result);
}

export async function getArtifactContent(
  workspaceKey: string,
  runId: string,
  artifactId: string,
  signal?: AbortSignal,
): Promise<ArtifactContent> {
  const url = `${workspaceRunUrl(workspaceKey, runId)}/artifacts/${encodeURIComponent(artifactId)}/content`;
  const result: ResultAsync<ArtifactContent, WebApiFailure> = requestArtifactResponse(url, signal).andThen(response => {
    const metadata = parseArtifactMetadata(response, false);
    if (metadata.isErr()) return err(metadata.error);
    return ResultAsync.fromPromise(response.arrayBuffer(), cause => ({
      type: "network-failed" as const,
      message: errorMessage(cause, "Artifact content body could not be read."),
    })).andThen(buffer => buffer.byteLength === metadata.value.size
      ? ok({ bytes: new Uint8Array(buffer), ...metadata.value })
      : invalidArtifactMetadata<ArtifactContent>(response, "Artifact content byte length did not match its metadata."));
  });
  return queryPromise(result);
}

function requestArtifactResponse(url: string, signal?: AbortSignal): ResultAsync<Response, WebApiFailure> {
  return ResultAsync.fromPromise(fetch(url, signal === undefined ? undefined : { signal }), cause => ({
    type: "network-failed" as const,
    message: errorMessage(cause, "Artifact request failed."),
  })).andThen(response => {
    if (response.ok) return ok(response);
    return ResultAsync.fromPromise(response.text(), cause => ({
      type: "network-failed" as const,
      message: errorMessage(cause, "Artifact error body could not be read."),
    })).andThen(text => {
      let body: unknown;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        return err({
          type: "response-invalid-json" as const,
          status: response.status,
          message: "Artifact error response was not valid JSON.",
        });
      }
      const failure = isRecord(body) && body.ok === false && isRecord(body.error) ? body.error : undefined;
      return typeof failure?.code === "string" && typeof failure.message === "string"
        ? err({ type: "request-failed" as const, status: response.status, code: failure.code, message: failure.message })
        : err({
            type: "response-invalid-envelope" as const,
            status: response.status,
            message: "Artifact error response did not contain a valid error envelope.",
          });
    });
  });
}

function parseArtifactMetadata(
  response: Response,
  preview: true,
): Result<Omit<ArtifactPreview, "text">, WebApiFailure>;
function parseArtifactMetadata(
  response: Response,
  preview: false,
): Result<Omit<ArtifactContent, "bytes">, WebApiFailure>;
function parseArtifactMetadata(
  response: Response,
  preview: boolean,
): Result<Omit<ArtifactPreview, "text"> | Omit<ArtifactContent, "bytes">, WebApiFailure> {
  const mediaType = response.headers.get("content-type");
  const sizeText = response.headers.get("x-acpus-artifact-size");
  if (!mediaType?.trim() || sizeText === null || !/^(0|[1-9]\d*)$/.test(sizeText)) {
    return invalidArtifactMetadata(response, "Artifact response metadata was invalid.");
  }
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size)) {
    return invalidArtifactMetadata(response, "Artifact response metadata was invalid.");
  }
  if (preview) {
    const truncated = response.headers.get("x-acpus-artifact-truncated");
    if (truncated !== "true" && truncated !== "false") {
      return invalidArtifactMetadata(response, "Artifact preview truncation metadata was invalid.");
    }
    return ok({ mediaType, size, truncated: truncated === "true" });
  }
  const encodedName = response.headers.get("x-acpus-artifact-name");
  if (encodedName === null) {
    return invalidArtifactMetadata(response, "Artifact content filename metadata was invalid.");
  }
  let fileName: string;
  try {
    fileName = decodeURIComponent(encodedName);
  } catch {
    return invalidArtifactMetadata(response, "Artifact content filename metadata was invalid.");
  }
  if (!fileName || fileName === "." || fileName === ".." || /[\\/\u0000-\u001f\u007f]/.test(fileName)) {
    return invalidArtifactMetadata(response, "Artifact content filename metadata was invalid.");
  }
  return ok({ mediaType, size, fileName });
}

function invalidArtifactMetadata<T>(response: Response, message: string): Result<T, WebApiFailure> {
  return err({ type: "response-invalid-envelope", status: response.status, message });
}

export async function submitRunCommand(
  workspaceKey: string,
  runId: string,
  command: WebControlCommand,
): Promise<void> {
  await queryPromise(requestJson<void>(`${workspaceRunUrl(workspaceKey, runId)}/controls`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  }, body => Object.keys(body).length === 1 ? undefined : invalidPayload));
}

function workspaceRunsUrl(workspaceKey: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceKey)}/runs`;
}

function workspaceRunUrl(workspaceKey: string, runId: string): string {
  return `${workspaceRunsUrl(workspaceKey)}/${encodeURIComponent(runId)}`;
}

export async function listWorkflowCatalog(): Promise<ProjectWorkflowCatalogEntry[]> {
  return queryPromise(requestJson("/api/workflows/catalog", undefined, decodeField("catalog", isWorkflowCatalog)));
}

export async function listWorkflowFiles(dir = ""): Promise<WorkflowFiles> {
  return queryPromise(requestJson(
    `/api/workflows/files?dir=${encodeURIComponent(dir)}`,
    undefined,
    decodeField("files", isWorkflowFiles),
  ));
}

export async function visualizeWorkflow(source: WorkflowVisualizationSource): Promise<WorkflowVisualizationResult> {
  return queryPromise(requestJson("/api/workflows/visualize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source }),
  }, decodeField("result", isWorkflowVisualizationResult)));
}

export async function getConfig(): Promise<ServerConfig> {
  return queryPromise(requestJson("/api/config", undefined, decodeField("config", isServerConfig)));
}

function decodeField<T>(
  key: string,
  guard: (value: unknown) => value is T,
): EndpointDecoder<T> {
  return body => hasOnlyKeys(body, ["ok", key]) && guard(body[key])
    ? body[key]
    : invalidPayload;
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

function isHealthReport(value: unknown): value is HealthReport {
  return isRecord(value)
    && Array.isArray(value.checks)
    && value.checks.every(check => isRecord(check)
      && typeof check.area === "string"
      && (check.status === "ok" || check.status === "warn" || check.status === "fail")
      && typeof check.message === "string");
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
    && isNonNegativeInteger(value.runCount)
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

function isNodeInspection(value: unknown): value is NodeInspection {
  return isRecord(value)
    && hasOnlyKeys(value, [
      "nodeId",
      "nodeKey",
      "frameKey",
      "cancelTarget",
      "staticKind",
      "timing",
      "latestAttempt",
      "agent",
      "input",
      "prompt",
      "loopProgress",
      "output",
      "failure",
      "artifacts",
      "awaitingSignal",
    ])
    && isOptionalString(value.nodeId)
    && isOptionalString(value.nodeKey)
    && isOptionalString(value.frameKey)
    && (value.cancelTarget === undefined || isControlTarget(value.cancelTarget))
    && isOptionalString(value.staticKind)
    && (value.timing === undefined || isNodeTiming(value.timing))
    && (value.latestAttempt === undefined || isRecord(value.latestAttempt)
      && hasOnlyKeys(value.latestAttempt, ["attemptNo", "status"])
      && isNonNegativeInteger(value.latestAttempt.attemptNo)
      && typeof value.latestAttempt.status === "string")
    && (value.agent === undefined || isRecord(value.agent)
      && hasOnlyKeys(value.agent, ["key", "model", "lastObservedAt"])
      && typeof value.agent.key === "string"
      && isOptionalString(value.agent.model)
      && isOptionalString(value.agent.lastObservedAt))
    && (value.input === undefined || isRecord(value.input)
      && hasOnlyKeys(value.input, ["kind", "value"])
      && (value.input.kind === "runtime" || value.input.kind === "authored")
      && Object.hasOwn(value.input, "value"))
    && (value.prompt === undefined || isRecord(value.prompt)
      && hasOnlyKeys(value.prompt, ["kind", "text", "artifactId", "mediaType"])
      && (value.prompt.kind === "signal" || value.prompt.kind === "artifact" || value.prompt.kind === "authored")
      && isOptionalString(value.prompt.text)
      && isOptionalString(value.prompt.artifactId)
      && isOptionalString(value.prompt.mediaType))
    && (value.loopProgress === undefined || isLoopProgress(value.loopProgress))
    && (value.failure === undefined || isNodeInspectionFailure(value.failure))
    && Array.isArray(value.artifacts)
    && value.artifacts.every(isInspectionArtifact)
    && (value.awaitingSignal === undefined || isRecord(value.awaitingSignal)
      && hasOnlyKeys(value.awaitingSignal, ["target", "prompt"])
      && isControlTarget(value.awaitingSignal.target)
      && isOptionalString(value.awaitingSignal.prompt));
}

function isNodeRuntimeValues(value: unknown): value is NodeRuntimeValues {
  if (!isRecord(value) || !hasOnlyKeys(value, ["available", "values", "reason"])) return false;
  if (value.available === true) {
    return value.reason === undefined && isRecord(value.values) && isJsonValue(value.values);
  }
  return value.available === false
    && value.values === undefined
    && (value.reason === "not-composite"
      || value.reason === "not_started"
      || value.reason === "not_selected"
      || value.reason === "not_yet_resolved"
      || value.reason === "resolution_failed"
      || value.reason === "not_recorded");
}

function isNodeTiming(value: unknown): value is NonNullable<NodeInspection["timing"]> {
  return isRecord(value)
    && hasOnlyKeys(value, ["startedAt", "finishedAt", "durationMs"])
    && typeof value.startedAt === "string"
    && isOptionalString(value.finishedAt)
    && isOptionalNonNegativeNumber(value.durationMs);
}

function isLoopProgress(value: unknown): value is NonNullable<NodeInspection["loopProgress"]> {
  return isRecord(value)
    && hasOnlyKeys(value, [
      "frameKey",
      "index",
      "round",
      "state",
      "stop",
      "transition",
      "activeIterationFrameKey",
      "activeChildNodeKeys",
    ])
    && typeof value.frameKey === "string"
    && isNonNegativeInteger(value.index)
    && isNonNegativeInteger(value.round)
    && isOptionalBoolean(value.stop)
    && isOptionalString(value.activeIterationFrameKey)
    && isStringArray(value.activeChildNodeKeys);
}

function isInspectionArtifact(value: unknown): value is NodeInspection["artifacts"][number] {
  return isRecord(value)
    && hasOnlyKeys(value, ["id", "path", "size", "mediaType"])
    && typeof value.id === "string"
    && typeof value.path === "string"
    && isNonNegativeInteger(value.size)
    && isOptionalString(value.mediaType);
}

function isNodeInspectionFailure(value: unknown): value is NodeInspectionFailure {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ["origin", "code", "message", "upstream"])
    || !["provider", "runtime", "scheduler", "task", "signal", "unknown"].includes(String(value.origin))
    || !isOptionalString(value.code)
    || typeof value.message !== "string") return false;
  if (value.upstream === undefined) return true;
  const upstream = value.upstream;
  if (!isRecord(upstream)
    || !hasOnlyKeys(upstream, ["source", "operation", "exitCode", "code", "origin", "protocol", "data"])
    || upstream.source !== "acpx"
    || !isOptionalString(upstream.operation)
    || !isOptionalNumber(upstream.exitCode)
    || !isOptionalString(upstream.code)
    || !isOptionalString(upstream.origin)
    || (upstream.data !== undefined && !isJsonValue(upstream.data))) return false;
  if (upstream.protocol === undefined) return true;
  const protocol = upstream.protocol;
  return isRecord(protocol)
    && hasOnlyKeys(protocol, ["name", "code", "message"])
    && protocol.name === "json-rpc"
    && (protocol.code === undefined || typeof protocol.code === "string" || isFiniteNumber(protocol.code))
    && isOptionalString(protocol.message);
}

function isNodeExecutionInspection(value: unknown): value is NodeExecutionInspection {
  return isRecord(value)
    && hasOnlyKeys(value, [
      "available",
      "reason",
      "summary",
      "lastObservedAt",
      "contextWindow",
      "tokenUsage",
      "output",
      "recentTools",
    ])
    && typeof value.available === "boolean"
    && (value.available ? value.reason === undefined : typeof value.reason === "string")
    && isExecutionSummary(value.summary)
    && isOptionalString(value.lastObservedAt)
    && (value.contextWindow === undefined || isExecutionContextWindow(value.contextWindow))
    && (value.tokenUsage === undefined || isExecutionTokenUsage(value.tokenUsage))
    && (value.output === undefined || isExecutionOutput(value.output))
    && Array.isArray(value.recentTools)
    && value.recentTools.length <= 3
    && value.recentTools.every(isExecutionToolCall);
}

function isExecutionSummary(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ["status", "sessionName", "turnCount", "message"])
    && isExecutionStatus(value.status)
    && isOptionalString(value.sessionName)
    && isOptionalNonNegativeInteger(value.turnCount)
    && isOptionalString(value.message);
}

function isExecutionContextWindow(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ["used", "size", "percent", "updatedAt"])
    && isOptionalNonNegativeNumber(value.used)
    && isOptionalNonNegativeNumber(value.size)
    && isOptionalNonNegativeNumber(value.percent)
    && isOptionalString(value.updatedAt);
}

function isExecutionTokenUsage(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ["source", "inputTokens", "outputTokens", "totalTokens"])
    && (value.source === undefined || value.source === "prompt_response" || value.source === "usage_update")
    && isOptionalNonNegativeInteger(value.inputTokens)
    && isOptionalNonNegativeInteger(value.outputTokens)
    && isOptionalNonNegativeInteger(value.totalTokens);
}

function isExecutionStatus(value: unknown): value is NodeExecutionInspection["summary"]["status"] {
  return value === "not_started"
    || value === "not_selected"
    || value === "pending"
    || value === "starting"
    || value === "ready"
    || value === "running"
    || value === "awaiting"
    || value === "completed"
    || value === "failed"
    || value === "timed_out"
    || value === "cancelled"
    || value === "mixed";
}

function isExecutionOutput(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ["tail", "totalBytes", "truncated"])
    && typeof value.tail === "string"
    && isNonNegativeInteger(value.totalBytes)
    && typeof value.truncated === "boolean";
}

function isExecutionToolCall(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, [
      "turn",
      "toolCallId",
      "toolName",
      "status",
      "durationMs",
      "inputPreview",
    ])
    && isNonNegativeInteger(value.turn)
    && isOptionalString(value.toolCallId)
    && isOptionalString(value.toolName)
    && isOptionalString(value.status)
    && isOptionalNonNegativeNumber(value.durationMs)
    && isOptionalString(value.inputPreview);
}

function isWorkflowCatalog(value: unknown): value is ProjectWorkflowCatalogEntry[] {
  return Array.isArray(value) && value.every(entry => isRecord(entry)
    && typeof entry.name === "string"
    && typeof entry.entryPath === "string");
}

function isWorkflowFiles(value: unknown): value is WorkflowFiles {
  return isRecord(value)
    && typeof value.dir === "string"
    && Array.isArray(value.entries)
    && value.entries.every(entry => isRecord(entry)
      && typeof entry.name === "string"
      && typeof entry.path === "string"
      && (entry.kind === "directory" || entry.kind === "workflow"));
}

function isWorkflowVisualizationResult(value: unknown): value is WorkflowVisualizationResult {
  if (!isRecord(value)) return false;
  if (value.status === "failed") {
    return isWorkflowPreparationPhase(value.phase) && typeof value.message === "string";
  }
  return value.status === "ready"
    && isWebGraph(value.graph)
    && isRecord(value.workflow)
    && hasOnlyKeys(value.workflow, ["name", "description", "agents", "irVersion", "nodeCount"])
    && typeof value.workflow.name === "string"
    && isOptionalString(value.workflow.description)
    && isAgentDefinitions(value.workflow.agents)
    && isFiniteNumber(value.workflow.irVersion)
    && isFiniteNumber(value.workflow.nodeCount)
    && isWorkflowContract(value.contract)
    && typeof value.sourceGraphDigest === "string";
}

function isWorkflowContext(value: unknown): value is WorkflowContext {
  return isRecord(value)
    && hasOnlyKeys(value, ["name", "description", "agents"])
    && typeof value.name === "string"
    && isOptionalString(value.description)
    && isAgentDefinitions(value.agents);
}

function isAgentDefinitions(value: unknown): value is WorkflowContext["agents"] {
  return isRecord(value) && Object.values(value).every(isAgentDefinition);
}

function isAgentDefinition(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const common = isOptionalString(value.model)
    && (value.config === undefined || isStringRecord(value.config))
    && (value.permissionMode === undefined
      || value.permissionMode === "approve-reads"
      || value.permissionMode === "approve-all"
      || value.permissionMode === "deny-all")
    && isOptionalString(value.cwd)
    && (value.env === undefined || isStringRecord(value.env));
  if (!common) return false;
  if (value.kind === "agent_definition") {
    return hasOnlyKeys(value, ["kind", "use", "model", "config", "permissionMode", "cwd", "env"])
      && typeof value.use === "string";
  }
  return value.kind === "agent_command"
    && hasOnlyKeys(value, ["kind", "command", "model", "config", "permissionMode", "cwd", "env"])
    && typeof value.command === "string";
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(item => typeof item === "string");
}

function isWorkflowPreparationPhase(value: unknown): boolean {
  return value === "source"
    || value === "check"
    || value === "compile"
    || value === "lock"
    || value === "validate";
}

function isWorkflowContract(value: unknown): boolean {
  return isRecord(value)
    && isExprIr(value.output)
    && (value.inputSchema === undefined || isSchemaIr(value.inputSchema))
    && isStaticExprShape(value.outputShape);
}

function isExprIr(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "literal":
      return isJsonPrimitive(value.value);
    case "ref":
      return isStringArray(value.path);
    case "call":
      return typeof value.fn === "string"
        && Array.isArray(value.args)
        && value.args.every(isExprIr);
    case "array":
      return Array.isArray(value.items) && value.items.every(isExprIr);
    case "object":
      return isRecord(value.fields) && Object.values(value.fields).every(isExprIr);
    case "template":
      return Array.isArray(value.parts) && value.parts.every(part => isRecord(part)
        && (part.kind === "text"
          ? typeof part.value === "string"
          : part.kind === "expr" && isExprIr(part.expr)));
    default:
      return false;
  }
}

function isSchemaIr(value: unknown): boolean {
  if (!isRecord(value)
    || typeof value.kind !== "string"
    || !isOptionalString(value.description)
    || (value.default !== undefined && !isJsonValue(value.default))
    || !isOptionalBoolean(value.optional)
    || !isOptionalBoolean(value.nullable)) {
    return false;
  }
  switch (value.kind) {
    case "unknown":
    case "string":
    case "number":
    case "boolean":
    case "null":
      return true;
    case "array":
      return isSchemaIr(value.item);
    case "object":
      return isRecord(value.fields)
        && Object.values(value.fields).every(isSchemaIr)
        && isStringArray(value.required)
        && typeof value.additionalProperties === "boolean";
    case "record":
      return isSchemaIr(value.value);
    case "union":
      return Array.isArray(value.variants) && value.variants.every(isSchemaIr);
    case "literal":
      return isJsonPrimitive(value.value);
    case "enum":
      return Array.isArray(value.values) && value.values.every(isJsonPrimitive);
    default:
      return false;
  }
}

function isStaticExprShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "object") return isStringArray(value.possibleKeys);
  return value.kind === "array" || value.kind === "scalar" || value.kind === "dynamic";
}

function isWebGraph(value: unknown): value is WebGraph {
  return isRecord(value)
    && isRecord(value.workflow)
    && typeof value.workflow.name === "string"
    && isOptionalString(value.workflow.runId)
    && isOptionalString(value.workflow.status)
    && (value.mode === "static" || value.mode === "runtime")
    && Array.isArray(value.nodes)
    && value.nodes.every(isWebGraphNode)
    && Array.isArray(value.containers)
    && value.containers.every(isWebGraphContainer)
    && Array.isArray(value.edges)
    && value.edges.every(isWebGraphEdge)
    && Array.isArray(value.fanoutOccurrences)
    && value.fanoutOccurrences.every(isWebGraphFanoutOccurrence)
    && Array.isArray(value.selectors)
    && value.selectors.every(isWebGraphSelector)
    && Array.isArray(value.runtimeStates)
    && value.runtimeStates.every(isWebGraphRuntimeState);
}

function isWebGraphNode(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.nodeId === "string"
    && isControlTarget(value.target)
    && typeof value.kind === "string"
    && typeof value.label === "string"
    && isStringArray(value.path)
    && isOptionalString(value.parentId)
    && (value.detail === undefined || isNodeDetail(value.detail))
    && typeof value.status === "string";
}

function isNodeDetail(value: unknown): value is NodeDetail {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "task":
      return hasOnlyKeys(value, ["kind", "input", "target"])
        && typeof value.input === "string"
        && (value.target === "inline" || value.target === "module");
    case "agent":
      return typeof value.agent === "string"
        && isOptionalString(value.use)
        && isOptionalString(value.command)
        && isOptionalString(value.model)
        && isOptionalString(value.outputSchema);
    case "signal":
      return isOptionalString(value.outputSchema);
    case "assert":
      return typeof value.condition === "string" && isOptionalString(value.message);
    case "if":
      return typeof value.condition === "string";
    case "switch":
      return isStringArray(value.cases) && typeof value.hasDefault === "boolean";
    case "parallel":
      return isStringArray(value.branches)
        && (value.strategy === "all" || value.strategy === "race")
        && isOptionalString(value.maxConcurrency);
    case "fanout":
      return typeof value.over === "string"
        && (value.strategy === "all" || value.strategy === "quorum")
        && isOptionalString(value.count)
        && isOptionalString(value.maxConcurrency);
    case "loop":
      return typeof value.state === "string";
    default:
      return false;
  }
}

function isWebGraphContainer(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.nodeId === "string"
    && (value.kind === "branch" || value.kind === "scope")
    && typeof value.label === "string"
    && isStringArray(value.path)
    && typeof value.parentId === "string"
    && typeof value.status === "string";
}

function isWebGraphEdge(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.source === "string"
    && typeof value.target === "string"
    && (value.kind === "sequence" || value.kind === "branch" || value.kind === "loop");
}

function isWebGraphSelection(value: unknown): value is WebGraphSelection {
  if (!isRecord(value) || typeof value.nodeId !== "string") return false;
  if (value.kind === "fanout") return isOccurrenceIndex(value.itemIndex);
  return value.kind === "loop" && isOccurrenceIndex(value.iteration);
}

function isWebGraphContext(value: unknown): value is WebGraphSelection[] {
  return Array.isArray(value) && value.every(isWebGraphSelection);
}

function isWebGraphFanoutOccurrence(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.nodeId === "string"
    && typeof value.targetId === "string"
    && isWebGraphContext(value.context)
    && typeof value.status === "string"
    && Array.isArray(value.items)
    && value.items.every(item => isRecord(item)
      && typeof item.id === "string"
      && isOccurrenceIndex(item.itemIndex)
      && typeof item.label === "string"
      && typeof item.status === "string"
      && isWebGraphContext(item.context));
}

function isWebGraphSelector(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.nodeId === "string"
    && value.kind === "loop"
    && typeof value.targetId === "string"
    && isWebGraphContext(value.context)
    && isOptionalString(value.defaultOptionId)
    && Array.isArray(value.options)
    && value.options.every(option => isRecord(option)
      && typeof option.id === "string"
      && isOccurrenceIndex(option.iteration)
      && isWebGraphContext(option.context));
}

function isWebGraphRuntimeState(value: unknown): boolean {
  return isRecord(value)
    && typeof value.targetId === "string"
    && isControlTarget(value.target)
    && typeof value.status === "string"
    && isWebGraphContext(value.context);
}

function isServerConfig(value: unknown): value is ServerConfig {
  return isRecord(value)
    && typeof value.cwd === "string"
    && (value.access === "open" || value.access === "token");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isControlTarget(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value);
}

function isOptionalNonNegativeNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value) && value >= 0;
}

function isOptionalNonNegativeInteger(value: unknown): value is number | undefined {
  return value === undefined || isNonNegativeInteger(value);
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isOccurrenceIndex(value: unknown): value is number {
  return isNonNegativeInteger(value);
}

function isJsonPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || isFiniteNumber(value);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: JsonRecord, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

function requestLabel(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input.toString();
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}
