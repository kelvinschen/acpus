import type { NodeKeyDynamic } from "@acpus/bindings";

export type {
  AcpusIr,
  AgentAttemptTelemetry,
  AgentAttemptTelemetryState,
  AgentContextUsage,
  AgentIoPreview,
  AgentOverrideWarning,
  AgentOverrides,
  AgentTelemetry,
  AgentTokenUsage,
  AgentToolCallTelemetry,
  AgentToolsTelemetry,
  ApiErrorBody,
  ApiErrorCode,
  ArtifactRef,
  ForkPlan,
  ForkRequest,
  IrBranch,
  IrNode,
  IrNodeKind,
  JsonObject,
  NodeExecutionState,
  NodeDynamicContext,
  NodeId,
  NodeKey,
  NodeKeyDynamic,
  NodeKeyTemplate,
  NodeState,
  OutputMerge,
  ReplayMismatch,
  ReplayRequest,
  ReplayResult,
  RetryRequest,
  RunCleanItem,
  RunCleanResult,
  RunEvent,
  RunId,
  RunLineage,
  RunState,
  RunStatus,
  RunSummary,
  SignalRequest,
  SupervisorHealth,
  Timestamp
} from "@acpus/bindings";

export {
  ForkRejectedError,
  RunSupervisorClient,
  SupervisorHttpError
} from "@acpus/bindings";

export interface ParsedNodeKey {
  nodeKey: string;
  staticPath: string;
  staticSegments: string[];
  dynamic: NodeKeyDynamic;
  dynamicFrames: NodeKeyDynamic[];
}

const DYNAMIC_SEGMENT = /^(item|lane|round|branch):/u;

export function parseNodeKey(nodeKey: string): ParsedNodeKey {
  const segments = nodeKey.split("/");
  const staticSegments: string[] = [];
  const dynamicSegments: string[] = [];

  for (const segment of segments) {
    if (DYNAMIC_SEGMENT.test(segment)) {
      dynamicSegments.push(segment);
    } else {
      staticSegments.push(segment);
    }
  }

  return {
    nodeKey,
    staticPath: staticSegments.join("/"),
    staticSegments,
    dynamic: dynamicFromSegments(dynamicSegments),
    dynamicFrames: dynamicFramesFromSegments(dynamicSegments)
  };
}

function dynamicFromSegments(segments: string[]): NodeKeyDynamic {
  const dynamic: NodeKeyDynamic = {};
  for (const segment of segments) {
    addDynamicSegment(dynamic, segment);
  }
  return dynamic;
}

function dynamicFramesFromSegments(segments: string[]): NodeKeyDynamic[] {
  const frames: NodeKeyDynamic[] = [];
  let current: NodeKeyDynamic = {};

  for (const segment of segments) {
    const [kind] = segment.split(":");
    if ((kind === "item" || kind === "branch" || kind === "round") && !isEmptyDynamic(current)) {
      frames.push(current);
      current = {};
    }
    addDynamicSegment(current, segment);
  }

  if (!isEmptyDynamic(current)) frames.push(current);
  return frames;
}

function addDynamicSegment(dynamic: NodeKeyDynamic, segment: string): void {
  const [kind, ...rest] = segment.split(":");
  const value = rest.join(":");
  if (kind === "item") dynamic.fanoutItemId = value;
  if (kind === "lane") dynamic.laneId = value;
  if (kind === "branch") dynamic.parallelBranchId = value;
  if (kind === "round") dynamic.loopRound = Number(value);
}

function isEmptyDynamic(dynamic: NodeKeyDynamic): boolean {
  return (
    dynamic.fanoutItemId === undefined &&
    dynamic.laneId === undefined &&
    dynamic.parallelBranchId === undefined &&
    dynamic.loopRound === undefined
  );
}
