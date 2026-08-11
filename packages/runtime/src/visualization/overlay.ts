import { walkNodes, type AgentDefinitionIR, type ExprIR, type NodeChildScope, type NodeIR, type SchemaIR, type WorkflowIR } from "@acpus/core/ir";
import type {
  RunDynamicAttempt,
  RunDynamicFrame,
  RunDynamicGroup,
  RunDynamicGroupMember,
  RunDynamicNodeInstance,
  RunDynamicSignalWait,
} from "../store/inspection-read-model.js";
import { deriveOccurrenceRef } from "../scheduler/occurrence-ref.js";

export type WorkflowVisualizationInstance = RunDynamicNodeInstance & { target: string };
export type WorkflowVisualizationFrame = RunDynamicFrame & { target: string };
export type WorkflowVisualizationAttempt = RunDynamicAttempt & { target: string };
export type WorkflowVisualizationSignalWait = RunDynamicSignalWait & { target: string };

export type WorkflowVisualizationOverlay = {
  workflow: {
    name: string;
    description?: string;
    runId?: string;
    status?: string;
    dynamicVersion?: number;
  };
  nodes: WorkflowVisualizationNode[];
  groups: WorkflowVisualizationGroup[];
};

// Semantic summary of a node's authored configuration, rendered by browser-facing packages.
export type NodeDetail =
  | { kind: "task"; input: ExprIR; target: "inline" | "module" }
  | { kind: "agent"; agent: string; use?: string; command?: string; model?: string; outputSchema?: SchemaIR }
  | { kind: "signal"; outputSchema?: SchemaIR }
  | { kind: "assert"; condition: ExprIR; message?: ExprIR }
  | { kind: "if"; condition: ExprIR }
  | { kind: "switch"; cases: ExprIR[]; hasDefault: boolean }
  | { kind: "parallel"; branches: string[]; strategy: "all" | "race"; maxConcurrency?: ExprIR }
  | { kind: "fanout"; over: ExprIR; strategy: "all" | "quorum"; count?: ExprIR; maxConcurrency?: ExprIR }
  | { kind: "loop"; state: ExprIR };

export type WorkflowVisualizationNode = {
  /** Authored selector for static/unmaterialized nodes. */
  target: string;
  nodeId: string;
  kind: NodeIR["kind"];
  path: string[];
  parentNodeId?: string;
  detail?: NodeDetail;
  instances: WorkflowVisualizationInstance[];
  frames: WorkflowVisualizationFrame[];
  attempts: WorkflowVisualizationAttempt[];
  signalWaits: WorkflowVisualizationSignalWait[];
  status: "not_started" | "pending" | "ready" | "running" | "awaiting" | "completed" | "failed" | "cancelled" | "mixed";
};

export type WorkflowVisualizationGroup = {
  nodeId: string;
  groupKey: string;
  kind: "parallel" | "fanout";
  status: string;
  strategy?: string;
  quorumCount?: number;
  maxConcurrency?: number;
  instancePath?: RunDynamicFrame["instancePath"];
  members: RunDynamicGroupMember[];
};

type WorkflowVisualizationDynamicInput = {
  version: number;
  frames: RunDynamicFrame[];
  nodeInstances: RunDynamicNodeInstance[];
  attempts: RunDynamicAttempt[];
  groups: RunDynamicGroup[];
  groupMembers: RunDynamicGroupMember[];
  signalWaits: RunDynamicSignalWait[];
};

export function createWorkflowVisualizationOverlay(
  ir: WorkflowIR,
  dynamic?: WorkflowVisualizationDynamicInput,
  options: { runId?: string; status?: string } = {},
): WorkflowVisualizationOverlay {
  const staticNodes = flattenScope(ir.root);
  const staticNodeById = new Map(staticNodes.map(node => [node.node.id, node.node]));
  return {
    workflow: {
      name: ir.name,
      ...(ir.description === undefined ? {} : { description: ir.description }),
      ...(options.runId === undefined ? {} : { runId: options.runId }),
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(dynamic === undefined ? {} : { dynamicVersion: dynamic.version }),
    },
    nodes: staticNodes.map(node => nodeOverlay(node, dynamic, ir.agents)),
    groups: groupOverlays(dynamic, staticNodeById),
  };
}

type StaticNode = {
  node: NodeIR;
  path: string[];
  parentNodeId?: string;
};

function flattenScope(scope: WorkflowIR["root"]): StaticNode[] {
  return Array.from(walkNodes(scope), ({ node, ancestry }) => {
    const parentNodeId = ancestry.at(-1)?.owner.id;
    return {
      node,
      path: ["root", ...ancestry.flatMap(child => [child.owner.id, visualizationScopeLabel(child)]), node.id],
      ...(parentNodeId === undefined ? {} : { parentNodeId }),
    };
  });
}

function visualizationScopeLabel(child: NodeChildScope): string {
  if (child.kind === "parallel") return `branch:${child.branchId}`;
  if (child.kind === "fanout" || child.kind === "loop") return "do";
  return child.branchId;
}

function nodeOverlay(node: StaticNode, dynamic: WorkflowVisualizationDynamicInput | undefined, agents: WorkflowIR["agents"]): WorkflowVisualizationNode {
  const rawInstances = dynamic?.nodeInstances.filter(instance => instance.nodeId === node.node.id) ?? [];
  const targetsByNodeKey = new Map(rawInstances.map(instance => [instance.nodeKey, occurrenceTarget(instance.instancePath, node.node.id)]));
  const instances = rawInstances.map(instance => ({
    ...instance,
    target: targetsByNodeKey.get(instance.nodeKey)!,
  }));
  const frames = (dynamic?.frames.filter(frame => frame.nodeId === node.node.id) ?? []).map(frame => ({
    ...frame,
    target: frame.frameKind === "root" ? "root" : occurrenceTarget(frame.instancePath, node.node.id),
  }));
  const attempts = (dynamic?.attempts.filter(attempt => attempt.nodeId === node.node.id) ?? []).map(attempt => ({
    ...attempt,
    target: targetsByNodeKey.get(attempt.nodeKey) ?? node.node.id,
  }));
  const signalWaits = (dynamic?.signalWaits.filter(wait => wait.nodeId === node.node.id) ?? []).map(wait => ({
    ...wait,
    target: targetsByNodeKey.get(wait.nodeKey) ?? node.node.id,
  }));
  const primaryFrames = frames.filter(frame => frame.frameKind === "node" || frame.frameKind === "loop");
  const currentStatuses = [...instances.map(instance => instance.status), ...primaryFrames.map(frame => frame.status), ...signalWaits.map(wait => wait.status)];
  const attemptStatuses = attempts.map(attempt => attempt.status);
  const detail = safeNodeDetail(node.node, agents);
  return {
    target: node.node.id,
    nodeId: node.node.id,
    kind: node.node.kind,
    path: node.path,
    ...(node.parentNodeId === undefined ? {} : { parentNodeId: node.parentNodeId }),
    ...(detail === undefined ? {} : { detail }),
    instances,
    frames,
    attempts,
    signalWaits,
    status: overlayStatus(currentStatuses.length > 0 ? currentStatuses : attemptStatuses),
  };
}

function occurrenceTarget(
  path: RunDynamicNodeInstance["instancePath"] | RunDynamicFrame["instancePath"],
  fallback: string,
): string {
  return path ? deriveOccurrenceRef(path) : fallback;
}

// Enrichment reads untrusted frozen-run JSON, so any malformed node yields no detail.
function safeNodeDetail(node: NodeIR, agents: WorkflowIR["agents"]): NodeDetail | undefined {
  try {
    return nodeDetail(node, agents ?? {});
  } catch {
    return undefined;
  }
}

function nodeDetail(node: NodeIR, agents: WorkflowIR["agents"]): NodeDetail {
  switch (node.kind) {
    case "task":
      return { kind: "task", input: node.run.input, target: node.run.target.kind };
    case "agent": {
      const definition: AgentDefinitionIR | undefined = agents[node.run.agent];
      const model = definition?.config?.model ?? definition?.model;
      return {
        kind: "agent",
        agent: node.run.agent,
        ...(definition?.kind === "agent_definition" ? { use: definition.use } : {}),
        ...(definition?.kind === "agent_command" ? { command: definition.command } : {}),
        ...(model === undefined ? {} : { model }),
        ...(node.outputSchema === undefined ? {} : { outputSchema: node.outputSchema }),
      };
    }
    case "signal":
      return { kind: "signal", ...(node.outputSchema === undefined ? {} : { outputSchema: node.outputSchema }) };
    case "assert":
      return { kind: "assert", condition: node.condition, ...(node.message === undefined ? {} : { message: node.message }) };
    case "if":
      return { kind: "if", condition: node.condition };
    case "switch":
      return { kind: "switch", cases: node.cases.map(branch => branch.when), hasDefault: node.default.nodes.length > 0 };
    case "parallel":
      return { kind: "parallel", branches: Object.keys(node.branches), strategy: node.strategy, ...(node.maxConcurrency === undefined ? {} : { maxConcurrency: node.maxConcurrency }) };
    case "fanout":
      return { kind: "fanout", over: node.over, strategy: node.strategy, ...(node.strategy === "quorum" ? { count: node.count } : {}), ...(node.maxConcurrency === undefined ? {} : { maxConcurrency: node.maxConcurrency }) };
    case "loop":
      return { kind: "loop", state: node.state };
  }
}

function groupOverlays(dynamic: WorkflowVisualizationDynamicInput | undefined, staticNodeById: ReadonlyMap<string, NodeIR>): WorkflowVisualizationGroup[] {
  if (!dynamic) return [];
  return dynamic.frames.flatMap(frame => {
    if (frame.frameKind !== "node" || frame.nodeId === undefined) return [];
    const staticNode = staticNodeById.get(frame.nodeId);
    if (staticNode?.kind !== "parallel" && staticNode?.kind !== "fanout") return [];
    const effective = dynamic.groups.find(group => group.groupKey === frame.frameKey);
    return [{
      nodeId: frame.nodeId,
      groupKey: frame.frameKey,
      kind: staticNode.kind,
      status: frame.status,
      ...(frame.strategy === undefined ? {} : { strategy: frame.strategy }),
      ...(effective?.quorumCount === undefined ? {} : { quorumCount: effective.quorumCount }),
      ...(effective?.maxConcurrency === undefined ? {} : { maxConcurrency: effective.maxConcurrency }),
      ...(frame.instancePath === undefined ? {} : { instancePath: frame.instancePath }),
      members: dynamic.groupMembers.filter(member => member.groupKey === frame.frameKey),
    }];
  });
}

function overlayStatus(statuses: string[]): WorkflowVisualizationNode["status"] {
  const meaningful = statuses.flatMap(status => {
    if (status === "consumed" || status === "superseded") return [];
    if (status === "started") return ["running"];
    if (status === "timed_out") return ["failed"];
    return [status];
  });
  if (meaningful.length === 0) return "not_started";
  const unique = [...new Set(meaningful)];
  return unique.length === 1 && isOverlayStatus(unique[0]!) ? unique[0]! : "mixed";
}

function isOverlayStatus(status: string): status is WorkflowVisualizationNode["status"] {
  return status === "pending"
    || status === "ready"
    || status === "running"
    || status === "awaiting"
    || status === "completed"
    || status === "failed"
    || status === "cancelled";
}
