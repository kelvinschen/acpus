import type { AgentDefinitionIR, ExprIR, NodeIR, SchemaIR, ScopeIR, TemplateIR, WorkflowIR } from "@acpus/core/ir";
import type {
  RunDynamicAttempt,
  RunDynamicFrame,
  RunDynamicGroupMember,
  RunDynamicNodeInstance,
  RunDynamicSignalWait,
} from "../store/store.js";

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
  | { kind: "task"; inputs: string[]; target: "inline" | "module" }
  | { kind: "agent"; agent: string; use?: string; command?: string; model?: string; outputSchema?: SchemaIR }
  | { kind: "signal"; outputSchema?: SchemaIR }
  | { kind: "assert"; condition: ExprIR; message?: TemplateIR }
  | { kind: "if"; condition: ExprIR }
  | { kind: "switch"; cases: ExprIR[]; hasDefault: boolean }
  | { kind: "parallel"; branches: string[]; strategy: "all" | "race" }
  | { kind: "fanout"; over: ExprIR; strategy: "all" | "quorum"; count?: number }
  | { kind: "loop"; state: ExprIR };

export type WorkflowVisualizationNode = {
  nodeId: string;
  kind: NodeIR["kind"];
  path: string[];
  parentNodeId?: string;
  detail?: NodeDetail;
  instances: RunDynamicNodeInstance[];
  frames: RunDynamicFrame[];
  attempts: RunDynamicAttempt[];
  signalWaits: RunDynamicSignalWait[];
  status: "not_started" | "pending" | "ready" | "running" | "awaiting" | "completed" | "failed" | "cancelled" | "mixed";
};

export type WorkflowVisualizationGroup = {
  nodeId: string;
  groupKey: string;
  kind: "parallel" | "fanout" | string;
  status: string;
  strategy?: string;
  members: RunDynamicGroupMember[];
};

type WorkflowVisualizationDynamicInput = {
  version: number;
  frames: RunDynamicFrame[];
  nodeInstances: RunDynamicNodeInstance[];
  attempts: RunDynamicAttempt[];
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

function flattenScope(scope: ScopeIR, path: string[] = ["root"], parentNodeId?: string): StaticNode[] {
  return scope.nodes.flatMap(node => [
    {
      node,
      path: [...path, node.id],
      ...(parentNodeId === undefined ? {} : { parentNodeId }),
    },
    ...childScopes(node).flatMap(child => flattenScope(child.scope, [...path, node.id, child.label], node.id)),
  ]);
}

function childScopes(node: NodeIR): Array<{ label: string; scope: ScopeIR }> {
  if (node.kind === "if") return [
    { label: "then", scope: node.then },
    ...(node.else ? [{ label: "else", scope: node.else }] : []),
  ];
  if (node.kind === "switch") return [
    ...node.cases.map((branch, index) => ({ label: `case:${index}`, scope: branch.then })),
    ...(node.default ? [{ label: "default", scope: node.default }] : []),
  ];
  if (node.kind === "parallel") return Object.entries(node.branches).map(([branchId, branch]) => ({ label: `branch:${branchId}`, scope: branch.scope }));
  if (node.kind === "fanout") return [{ label: "do", scope: node.do }];
  if (node.kind === "loop") return [{ label: "do", scope: node.do }];
  return [];
}

function nodeOverlay(node: StaticNode, dynamic: WorkflowVisualizationDynamicInput | undefined, agents: WorkflowIR["agents"]): WorkflowVisualizationNode {
  const instances = dynamic?.nodeInstances.filter(instance => instance.nodeId === node.node.id) ?? [];
  const frames = dynamic?.frames.filter(frame => frame.nodeId === node.node.id) ?? [];
  const attempts = dynamic?.attempts.filter(attempt => attempt.nodeId === node.node.id) ?? [];
  const signalWaits = dynamic?.signalWaits.filter(wait => wait.nodeId === node.node.id) ?? [];
  const primaryFrames = frames.filter(frame => frame.frameKind === "node" || frame.frameKind === "loop");
  const currentStatuses = [...instances.map(instance => instance.status), ...primaryFrames.map(frame => frame.status), ...signalWaits.map(wait => wait.status)];
  const attemptStatuses = attempts.map(attempt => attempt.status);
  const detail = safeNodeDetail(node.node, agents);
  return {
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
      return { kind: "task", inputs: Object.keys(node.run.input), target: node.run.target.kind };
    case "agent": {
      const definition: AgentDefinitionIR | undefined = agents[node.run.agent];
      return {
        kind: "agent",
        agent: node.run.agent,
        ...(definition?.kind === "agent_definition" ? { use: definition.use } : {}),
        ...(definition?.kind === "agent_command" ? { command: definition.command } : {}),
        ...(definition?.model === undefined ? {} : { model: definition.model }),
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
      return { kind: "parallel", branches: Object.keys(node.branches), strategy: node.strategy };
    case "fanout":
      return { kind: "fanout", over: node.over, strategy: node.strategy, ...(node.strategy === "quorum" ? { count: node.count } : {}) };
    case "loop":
      return { kind: "loop", state: node.state };
  }
}

function groupOverlays(dynamic: WorkflowVisualizationDynamicInput | undefined, staticNodeById: ReadonlyMap<string, NodeIR>): WorkflowVisualizationGroup[] {
  if (!dynamic) return [];
  return dynamic.frames
    .filter(frame => {
      if (frame.frameKind !== "node" || frame.nodeId === undefined) return false;
      const staticNode = staticNodeById.get(frame.nodeId);
      return staticNode?.kind === "parallel" || staticNode?.kind === "fanout";
    })
    .map(frame => {
      const members = dynamic.groupMembers.filter(member => member.groupKey === frame.frameKey);
      const staticNode = staticNodeById.get(frame.nodeId!);
      return {
        nodeId: frame.nodeId!,
        groupKey: frame.frameKey,
        kind: staticNode?.kind ?? groupKind(members),
        status: frame.status,
        ...(frame.strategy === undefined ? {} : { strategy: frame.strategy }),
        members,
      };
    });
}

function groupKind(members: RunDynamicGroupMember[]): WorkflowVisualizationGroup["kind"] {
  if (members.some(member => member.memberKind === "fanout_item")) return "fanout";
  if (members.some(member => member.memberKind === "branch")) return "parallel";
  return "parallel";
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
