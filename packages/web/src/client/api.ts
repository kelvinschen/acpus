import { isJsonValue } from "@acpus/expression/ir";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import type {
  HealthReport,
  NodeExecutionInspection,
  NodeInspection,
  NodeInspectionFailure,
  ProjectWorkflowCatalogEntry,
  RunControlTarget,
  RunDetails,
  RunRecord,
  RunRuntimeControls,
  RunRuntimeSnapshot,
  ServerConfig,
  WebControlCommand,
  WorkflowFileEntry,
  WorkflowFiles,
  WorkflowVisualizationResult,
  WorkflowVisualizationSource,
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
  ProjectWorkflowCatalogEntry,
  RunControlTarget,
  RunDetails,
  RunRecord,
  RunRuntimeSnapshot,
  ServerConfig,
  WebControlCommand,
  WorkflowFileEntry,
  WorkflowFiles,
  WorkflowVisualizationResult,
  WorkflowVisualizationSource,
};
export type {
  NodeDetail,
  WebGraph,
  WebGraphNode,
  WebGraphSelection,
} from "../graph-types.js";

export type ArtifactPreview = {
  text: string;
  mediaType: string;
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

export async function listRuns(): Promise<RunRecord[]> {
  return queryPromise(requestJson("/api/runs", undefined, decodeField("runs", isRunRecords)));
}

export async function getRunRuntimeSnapshot(runId: string): Promise<RunRuntimeSnapshot> {
  return queryPromise(requestJson(
    `/api/runs/${encodeURIComponent(runId)}/runtime-snapshot`,
    undefined,
    decodeRuntimeSnapshot,
  ));
}

export async function getNodeInspection(runId: string, target: string, context?: WebGraphSelection[]): Promise<NodeInspection> {
  return queryPromise(requestJson(
    nodeInspectionUrl(runId, target, context),
    undefined,
    decodeField("inspection", isNodeInspection),
  ));
}

export async function getNodeExecutionInspection(runId: string, target: string, context?: WebGraphSelection[]): Promise<NodeExecutionInspection> {
  return queryPromise(requestJson(
    nodeInspectionUrl(runId, target, context, "/execution"),
    undefined,
    decodeField("execution", isNodeExecutionInspection),
  ));
}

function nodeInspectionUrl(runId: string, target: string, context?: WebGraphSelection[], suffix = ""): string {
  const base = `/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(target)}${suffix}`;
  if (!context || context.length === 0) return base;
  return `${base}?context=${encodeURIComponent(encodeContext(context))}`;
}

function encodeContext(context: WebGraphSelection[]): string {
  const json = JSON.stringify(context);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function getArtifactPreview(runId: string, artifactId: string): Promise<ArtifactPreview> {
  const url = `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/preview`;
  return queryPromise(new ResultAsync((async (): Promise<Result<ArtifactPreview, WebApiFailure>> => {
    let response: Response;
    try {
      response = await fetch(url);
    } catch (cause) {
      return err({ type: "network-failed", message: errorMessage(cause, "Artifact preview request failed.") });
    }
    if (!response.ok) {
      let text: string;
      try {
        text = await response.text();
      } catch (cause) {
        return err({ type: "network-failed", message: errorMessage(cause, "Artifact preview error body could not be read.") });
      }
      let body: unknown;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        return err({ type: "response-invalid-json", status: response.status, message: "Artifact preview error response was not valid JSON." });
      }
      const failure = isRecord(body) && body.ok === false && isRecord(body.error) ? body.error : undefined;
      if (typeof failure?.code === "string" && typeof failure.message === "string") {
        return err({ type: "request-failed", status: response.status, code: failure.code, message: failure.message });
      }
      return err({ type: "response-invalid-envelope", status: response.status, message: "Artifact preview error response did not contain a valid error envelope." });
    }
    try {
      return ok({ text: await response.text(), mediaType: response.headers.get("content-type") ?? "text/plain" });
    } catch (cause) {
      return err({ type: "network-failed", message: errorMessage(cause, "Artifact preview body could not be read.") });
    }
  })()));
}

export async function submitRunCommand(
  runId: string,
  command: WebControlCommand,
): Promise<void> {
  await queryPromise(requestJson<void>(`/api/runs/${encodeURIComponent(runId)}/controls`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  }, body => Object.keys(body).length === 1 ? undefined : invalidPayload));
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
  return hasOnlyKeys(body, ["ok", "run", "graph", "controls"])
    && isRunDetails(body.run)
    && isWebGraph(body.graph)
    && isRunRuntimeControls(body.controls)
    ? { run: body.run, graph: body.graph, controls: body.controls }
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

function isRunRecords(value: unknown): value is RunRecord[] {
  return Array.isArray(value) && value.every(isRunRecord);
}

function isRunRecord(value: unknown): value is RunRecord {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.status === "string";
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
      "runStartedAt",
      "runDurationMs",
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
    && typeof value.runStartedAt === "string"
    && isOptionalString(value.nodeId)
    && isOptionalString(value.nodeKey)
    && isOptionalString(value.frameKey)
    && (value.cancelTarget === undefined || isControlTarget(value.cancelTarget))
    && isOptionalString(value.staticKind)
    && isOptionalNumber(value.runDurationMs)
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
      "toolCallCount",
      "lastToolCalls",
      "recentToolsIncomplete",
    ])
    && typeof value.available === "boolean"
    && (value.available ? value.reason === undefined : typeof value.reason === "string")
    && isExecutionSummary(value.summary)
    && isOptionalString(value.lastObservedAt)
    && (value.contextWindow === undefined || isExecutionContextWindow(value.contextWindow))
    && (value.tokenUsage === undefined || isExecutionTokenUsage(value.tokenUsage))
    && (value.output === undefined || isExecutionOutput(value.output))
    && isOptionalNonNegativeInteger(value.toolCallCount)
    && Array.isArray(value.lastToolCalls)
    && value.lastToolCalls.length <= 3
    && value.lastToolCalls.every(isExecutionToolCall)
    && typeof value.recentToolsIncomplete === "boolean";
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
    && typeof value.workflow.name === "string"
    && isOptionalString(value.workflow.description)
    && isFiniteNumber(value.workflow.irVersion)
    && isFiniteNumber(value.workflow.nodeCount)
    && isWorkflowContract(value.contract)
    && typeof value.sourceGraphDigest === "string";
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
      return isStringArray(value.inputs) && (value.target === "inline" || value.target === "module");
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
