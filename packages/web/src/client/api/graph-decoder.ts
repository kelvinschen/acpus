import type {
  NodeDetail,
  WebGraph,
  WebGraphSelection,
} from "../../graph-types.js";
import {
  hasOnlyKeys,
  isControlTarget,
  isNonNegativeInteger,
  isOptionalBoolean,
  isOptionalString,
  isRecord,
  isStringArray,
} from "./wire.js";

export function isWebGraph(value: unknown): value is WebGraph {
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
        && isOptionalBoolean(value.unbound)
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
    && hasOnlyKeys(value, ["targetId", "target", "status", "context"])
    && typeof value.targetId === "string"
    && isControlTarget(value.target)
    && typeof value.status === "string"
    && isWebGraphContext(value.context);
}

function isOccurrenceIndex(value: unknown): value is number {
  return isNonNegativeInteger(value);
}
