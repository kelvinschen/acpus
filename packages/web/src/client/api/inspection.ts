import { isJsonValue } from "@acpus/expression/ir";
import type {
  NodeExecutionInspection,
  NodeInspection,
  NodeInspectionFailure,
  NodeRuntimeValues,
} from "../../api-types.js";
import { workspaceRunUrl } from "./runs.js";
import { decodeField, requestJson } from "./transport.js";
import {
  hasOnlyKeys,
  isControlTarget,
  isFiniteNumber,
  isNonNegativeInteger,
  isOptionalBoolean,
  isOptionalNonNegativeInteger,
  isOptionalNumber,
  isOptionalString,
  isRecord,
  isStringArray,
} from "./wire.js";

export async function getNodeInspection(
  workspaceKey: string,
  runId: string,
  target: string,
): Promise<NodeInspection> {
  return requestJson(
    nodeInspectionUrl(workspaceKey, runId, target),
    undefined,
    decodeField("inspection", isNodeInspection),
  );
}

export async function getNodeRuntimeValues(
  workspaceKey: string,
  runId: string,
  target: string,
): Promise<NodeRuntimeValues> {
  return requestJson(
    nodeInspectionUrl(workspaceKey, runId, target, "/runtime-values"),
    undefined,
    decodeField("runtimeValues", isNodeRuntimeValues),
  );
}

export async function getNodeExecutionInspection(
  workspaceKey: string,
  runId: string,
  target: string,
): Promise<NodeExecutionInspection> {
  return requestJson(
    nodeInspectionUrl(workspaceKey, runId, target, "/execution"),
    undefined,
    decodeField("execution", isNodeExecutionInspection),
  );
}

function nodeInspectionUrl(
  workspaceKey: string,
  runId: string,
  target: string,
  suffix = "",
): string {
  return `${workspaceRunUrl(workspaceKey, runId)}/nodes/${encodeURIComponent(target)}${suffix}`;
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

function isOptionalNonNegativeNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value) && value >= 0;
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
