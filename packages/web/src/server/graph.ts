import type { WorkflowIR } from "@acpus/core/ir";
import { createWorkflowVisualizationOverlay, type NodeDetail as RuntimeNodeDetail, type WorkflowVisualizationOverlay } from "@acpus/runtime";
import type { ExprIR } from "@acpus/expression/ir";
import { renderExpr } from "./expression-format.js";

type NodeDetail =
  | { kind: "task"; inputs: string[]; target: "inline" | "module" }
  | { kind: "agent"; agent: string; use?: string; command?: string; model?: string; outputSchema?: string }
  | { kind: "signal"; outputSchema?: string }
  | { kind: "assert"; condition: string; message?: string }
  | { kind: "if"; condition: string }
  | { kind: "switch"; cases: string[]; hasDefault: boolean }
  | { kind: "parallel"; branches: string[]; strategy: "all" | "race"; maxConcurrency?: string }
  | { kind: "fanout"; over: string; strategy: "all" | "quorum"; count?: string; maxConcurrency?: string }
  | { kind: "loop"; state: string };

export type WebGraph = {
  workflow: {
    name: string;
    runId?: string;
    status?: string;
  };
  mode: "static" | "runtime";
  nodes: WebGraphNode[];
  containers: WebGraphContainer[];
  edges: WebGraphEdge[];
  selectors: WebGraphSelector[];
  runtimeStates: WebGraphRuntimeState[];
};

type WebGraphNode = {
  id: string;
  nodeId: string;
  kind: string;
  label: string;
  path: string[];
  parentId?: string;
  detail?: NodeDetail;
  status: string;
};

type WebGraphContainer = {
  id: string;
  nodeId: string;
  kind: "branch" | "scope";
  label: string;
  path: string[];
  parentId: string;
  status: string;
};

type WebGraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: "sequence" | "branch" | "loop";
};

type WebGraphSelector = {
  nodeId: string;
  kind: "fanout" | "loop";
  targetId: string;
  defaultOptionId?: string;
  options: WebGraphSelectorOption[];
};

type WebGraphSelectorOptionBase = {
  id: string;
  parentSelections: WebGraphSelection[];
};

type WebGraphFanoutSelectorOption = WebGraphSelectorOptionBase & { label: string; itemIndex: number };
type WebGraphLoopSelectorOption = WebGraphSelectorOptionBase & { iteration: number };
type WebGraphSelectorOption = WebGraphFanoutSelectorOption | WebGraphLoopSelectorOption;

type WebGraphRuntimeState = {
  targetId: string;
  status: string;
  selectors: WebGraphSelection[];
};

type WebGraphSelection =
  | { nodeId: string; kind: "fanout"; itemIndex: number }
  | { nodeId: string; kind: "loop"; iteration: number };

type OverlayNode = WorkflowVisualizationOverlay["nodes"][number];
type OverlayFrame = OverlayNode["frames"][number];
type OverlayInstance = OverlayNode["instances"][number];
type OverlaySignalWait = OverlayNode["signalWaits"][number];
type InstancePath = NonNullable<OverlayFrame["instancePath"]>;
type InstancePathEntry = InstancePath[number];

export function graphFromOverlay(
  overlay: WorkflowVisualizationOverlay,
  mode: "static" | "runtime",
): WebGraph {
  const source = mode === "static" ? staticOverlay(overlay) : overlay;
  const nodes = source.nodes.map(staticGraphNode);
  const detailById = new Map(nodes.map(node => [node.id, node.detail]));
  const authoredParentByNodeId = new Map(source.nodes.flatMap(node =>
    node.parentNodeId === undefined ? [] : [[node.nodeId, node.parentNodeId] as const],
  ));
  const containers = graphContainers(nodes, detailById, authoredParentByNodeId);
  const parentByNodeId = graphNodeParents(nodes, containers, authoredParentByNodeId);
  const edges = graphEdges(nodes, containers, parentByNodeId);
  const selectors = mode === "runtime" ? graphSelectors(source, containers) : [];
  const runtimeStates = mode === "runtime" ? graphRuntimeStates(source, containers, detailById) : [];

  return {
    workflow: {
      name: source.workflow.name,
      ...(source.workflow.runId === undefined ? {} : { runId: source.workflow.runId }),
      ...(source.workflow.status === undefined ? {} : { status: source.workflow.status }),
    },
    mode,
    nodes: nodes.map(node => graphNodeWithParent(node, parentByNodeId)),
    containers,
    edges,
    selectors,
    runtimeStates,
  };
}

export function workflowIrToWebGraph(ir: WorkflowIR): WebGraph {
  return graphFromOverlay(createWorkflowVisualizationOverlay(ir), "static");
}

function graphNodeWithParent(node: WebGraphNode, parentByNodeId: ReadonlyMap<string, string>): WebGraphNode {
  const parentId = parentByNodeId.get(node.id);
  return parentId === undefined ? node : { ...node, parentId };
}

function staticGraphNode(node: OverlayNode): WebGraphNode {
  return {
    id: node.nodeId,
    nodeId: node.nodeId,
    kind: node.kind,
    label: node.nodeId,
    path: node.path,
    ...(node.detail === undefined ? {} : { detail: formatNodeDetail(node.detail) }),
    status: node.status,
  };
}

function graphContainers(
  nodes: WebGraphNode[],
  detailById: ReadonlyMap<string, NodeDetail | undefined>,
  authoredParentByNodeId: ReadonlyMap<string, string>,
): WebGraphContainer[] {
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const containers = new Map<string, WebGraphContainer>();

  for (const node of nodes) {
    const detail = detailById.get(node.id);
    for (const segment of authoredContainerSegments(detail)) {
      const id = containerId(node.id, segment);
      if (containers.has(id)) continue;
      containers.set(id, {
        id,
        nodeId: node.id,
        kind: segment === "do" ? "scope" : "branch",
        label: containerLabel(detail, segment),
        path: [...node.path, segment],
        parentId: node.id,
        status: "not_started",
      });
    }
  }

  for (const node of nodes) {
    const parentNodeId = authoredParentByNodeId.get(node.id);
    if (!parentNodeId) continue;
    const parent = nodeById.get(parentNodeId);
    if (!parent) continue;
    const segment = scopeSegment(parent.path, node.path);
    if (!segment) continue;
    const id = containerId(parent.id, segment);
    if (containers.has(id)) continue;
    const detail = detailById.get(parent.id);
    containers.set(id, {
      id,
      nodeId: parent.id,
      kind: segment === "do" ? "scope" : "branch",
      label: containerLabel(detail, segment),
      path: [...parent.path, segment],
      parentId: parent.id,
      status: "not_started",
    });
  }

  return [...containers.values()];
}

function authoredContainerSegments(detail: NodeDetail | undefined): string[] {
  if (!detail) return [];
  switch (detail.kind) {
    case "parallel":
      return detail.branches.map(branch => normalizeBranchSegment(detail, branch));
    case "switch":
      return [
        ...detail.cases.map((_, index) => `case:${index}`),
        ...(detail.hasDefault ? ["default"] : []),
      ];
    case "if":
      return ["then"];
    case "fanout":
    case "loop":
      return ["do"];
    default:
      return [];
  }
}

function graphNodeParents(
  nodes: WebGraphNode[],
  containers: WebGraphContainer[],
  authoredParentByNodeId: ReadonlyMap<string, string>,
): Map<string, string> {
  const containerByPath = new Map(containers.map(container => [container.path.join("\0"), container.id]));
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const parents = new Map<string, string>();

  for (const node of nodes) {
    const parentNodeId = authoredParentByNodeId.get(node.id);
    if (!parentNodeId) continue;
    const parent = nodeById.get(parentNodeId);
    if (!parent) continue;
    const segment = scopeSegment(parent.path, node.path);
    const container = segment ? containerByPath.get([...parent.path, segment].join("\0")) : undefined;
    parents.set(node.id, container ?? parentNodeId);
  }

  return parents;
}

function graphEdges(
  nodes: WebGraphNode[],
  containers: WebGraphContainer[],
  parentByNodeId: ReadonlyMap<string, string>,
): WebGraphEdge[] {
  const edges: WebGraphEdge[] = [];
  const nodeChildrenByParent = new Map<string, WebGraphNode[]>();
  const nodesById = new Map(nodes.map(node => [node.id, node]));

  for (const node of nodes) {
    const parent = parentByNodeId.get(node.id) ?? "";
    nodeChildrenByParent.set(parent, [...(nodeChildrenByParent.get(parent) ?? []), node]);
  }

  for (const [parent, children] of nodeChildrenByParent) {
    if (parent && !nodesById.has(parent) && !containers.some(container => container.id === parent)) continue;
    for (let index = 1; index < children.length; index += 1) {
      edges.push({
        id: `sequence:${children[index - 1]!.id}->${children[index]!.id}`,
        source: children[index - 1]!.id,
        target: children[index]!.id,
        kind: "sequence",
      });
    }
  }

  for (const container of containers) {
    const children = nodeChildrenByParent.get(container.id) ?? [];
    if (children[0]) {
      edges.push({
        id: `branch:${container.id}->${children[0].id}`,
        source: container.id,
        target: children[0].id,
        kind: "branch",
      });
    }
    if (container.kind === "scope" && container.path.at(-1) === "do") {
      const owner = nodesById.get(container.nodeId);
      if (owner?.detail?.kind === "loop" && children.length > 1) {
        edges.push({
          id: `loop:${children.at(-1)!.id}->${children[0]!.id}`,
          source: children.at(-1)!.id,
          target: children[0]!.id,
          kind: "loop",
        });
      }
    }
  }

  const ids = new Set([...nodesById.keys(), ...containers.map(container => container.id)]);
  return uniqueEdges(edges).filter(edge => ids.has(edge.source) && ids.has(edge.target));
}

function graphSelectors(
  source: WorkflowVisualizationOverlay,
  containers: WebGraphContainer[],
): WebGraphSelector[] {
  const selectors: WebGraphSelector[] = [];
  const containerByOwnerAndSegment = containerLookup(containers);
  const fanoutOptionsByNode = new Map<string, WebGraphFanoutSelectorOption[]>();
  const fanoutStatusByOptionId = new Map<string, string>();

  for (const group of source.groups) {
    if (group.kind !== "fanout") continue;
    const parentSelections = runtimeSelections(group.instancePath).filter(selection => selection.nodeId !== group.nodeId);
    const members = group.members
      .filter(member => member.memberKind === "fanout_item")
      .sort((a, b) => a.itemIndex - b.itemIndex);
    const options = members
      .map(member => ({
        id: member.memberKey,
        label: `item[${member.itemIndex}]`,
        itemIndex: member.itemIndex,
        parentSelections,
      }));
    for (const member of members) fanoutStatusByOptionId.set(member.memberKey, member.status);
    const current = fanoutOptionsByNode.get(group.nodeId) ?? [];
    fanoutOptionsByNode.set(group.nodeId, [...current, ...options]);
  }

  for (const [nodeId, options] of fanoutOptionsByNode) {
    const defaultOptionId = options.find(option => {
      const status = fanoutStatusByOptionId.get(option.id);
      return status === "running" || status === "awaiting";
    })?.id ?? options.at(-1)?.id;
    selectors.push({
      nodeId,
      kind: "fanout",
      targetId: containerByOwnerAndSegment.get(containerKey(nodeId, "do"))?.id ?? nodeId,
      ...(defaultOptionId === undefined ? {} : { defaultOptionId }),
      options,
    });
  }

  for (const node of source.nodes) {
    if (node.detail?.kind !== "loop") continue;
    const frames = node.frames
      .filter(frame => frame.frameKind === "loop_iteration")
      .sort((a, b) => (loopIteration(a) ?? 0) - (loopIteration(b) ?? 0));
    const options = frames
      .flatMap(frame => {
        const iteration = loopIteration(frame);
        if (iteration === undefined) return [];
        return [{
          id: frame.frameKey,
          iteration,
          parentSelections: runtimeSelections(frame.instancePath).filter(selection => selection.nodeId !== node.nodeId),
        }];
      });
    if (options.length > 0) {
      const defaultOptionId = frames.find(frame => frame.status === "running" || frame.status === "awaiting")?.frameKey
        ?? frames.at(-1)?.frameKey;
      selectors.push({
        nodeId: node.nodeId,
        kind: "loop",
        targetId: containerByOwnerAndSegment.get(containerKey(node.nodeId, "do"))?.id ?? node.nodeId,
        ...(defaultOptionId === undefined ? {} : { defaultOptionId }),
        options,
      });
    }
  }

  return selectors;
}

function graphRuntimeStates(
  source: WorkflowVisualizationOverlay,
  containers: WebGraphContainer[],
  detailById: ReadonlyMap<string, NodeDetail | undefined>,
): WebGraphRuntimeState[] {
  const states: WebGraphRuntimeState[] = [];
  const containerByOwnerAndSegment = containerLookup(containers);

  for (const node of source.nodes) {
    for (const frame of node.frames) {
      if (frame.frameKind === "node" || frame.frameKind === "loop") {
        states.push(stateForFrame(node.nodeId, frame));
      } else if (frame.frameKind === "branch") {
        const branch = branchEntry(frame.instancePath, frame.nodeId);
        const segment = branch ? normalizeBranchSegment(detailById.get(frame.nodeId ?? ""), branch.branchId) : undefined;
        const target = segment ? containerByOwnerAndSegment.get(containerKey(frame.nodeId ?? "", segment)) : undefined;
        if (target) states.push(stateForFrame(target.id, frame));
      } else if (frame.frameKind === "fanout_item") {
        const target = containerByOwnerAndSegment.get(containerKey(node.nodeId, "do"));
        if (target) states.push(stateForFrame(target.id, frame));
      } else if (frame.frameKind === "loop_iteration") {
        const target = containerByOwnerAndSegment.get(containerKey(node.nodeId, "do"));
        if (target) states.push(stateForFrame(target.id, frame));
      }
    }
    for (const instance of node.instances) {
      states.push(stateForInstance(node.nodeId, instance));
    }
    for (const wait of node.signalWaits) {
      states.push(stateForSignalWait(node.nodeId, wait));
    }
  }

  return states;
}

function stateForFrame(targetId: string, frame: OverlayFrame): WebGraphRuntimeState {
  return {
    targetId,
    status: frame.status,
    selectors: runtimeSelections(frame.instancePath),
  };
}

function stateForInstance(targetId: string, instance: OverlayInstance): WebGraphRuntimeState {
  return {
    targetId,
    status: instance.status,
    selectors: runtimeSelections(instance.instancePath),
  };
}

function stateForSignalWait(targetId: string, wait: OverlaySignalWait): WebGraphRuntimeState {
  return {
    targetId,
    status: wait.status,
    selectors: [],
  };
}

function runtimeSelections(path: InstancePath | undefined): WebGraphSelection[] {
  if (!path) return [];
  const selections: WebGraphSelection[] = [];
  for (const entry of path) {
    if (entry.kind === "fanout") {
      selections.push({
        nodeId: entry.nodeId,
        kind: "fanout",
        itemIndex: entry.itemIndex,
      });
    }
    if (entry.kind === "loop") {
      selections.push({
        nodeId: entry.nodeId,
        kind: "loop",
        iteration: entry.iter,
      });
    }
  }
  return selections;
}

function branchEntry(path: InstancePath | undefined, nodeId: string | undefined): Extract<InstancePathEntry, { kind: "branch" }> | undefined {
  if (!path) return undefined;
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const entry = path[index]!;
    if (entry.kind === "branch" && entry.nodeId === nodeId) return entry;
  }
  return undefined;
}

function loopIteration(frame: OverlayFrame): number | undefined {
  const path = frame.instancePath;
  if (!path) return undefined;
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const entry = path[index]!;
    if (entry.kind === "loop") return entry.iter;
  }
  return undefined;
}

function scopeSegment(parentPath: string[], childPath: string[]): string | undefined {
  return childPath.length > parentPath.length ? childPath[parentPath.length] : undefined;
}

function containerId(nodeId: string, segment: string): string {
  return `${nodeId}::${encodeURIComponent(segment)}`;
}

function containerKey(nodeId: string, segment: string): string {
  return `${nodeId}\0${segment}`;
}

function containerLookup(containers: WebGraphContainer[]): Map<string, WebGraphContainer> {
  return new Map(containers.map(container => [containerKey(container.nodeId, container.path.at(-1) ?? ""), container]));
}

function containerLabel(detail: NodeDetail | undefined, segment: string): string {
  if (segment === "do") return "do";
  if (detail?.kind === "parallel") {
    const id = segment.replace(/^branch:/, "");
    return `branch: ${id}`;
  }
  if (detail?.kind === "if") {
    return segment === "then" ? "then" : "else";
  }
  if (detail?.kind === "switch") {
    if (segment === "default") return "default";
    const index = Number(segment.replace(/^case:/, ""));
    const when = detail.cases[index];
    return when ? `case: ${when}` : segment;
  }
  return segment;
}

function normalizeBranchSegment(detail: NodeDetail | undefined, branchId: string): string {
  if (detail?.kind === "parallel" && !branchId.startsWith("branch:")) return `branch:${branchId}`;
  return branchId;
}

function staticOverlay(overlay: WorkflowVisualizationOverlay): WorkflowVisualizationOverlay {
  return {
    workflow: {
      name: overlay.workflow.name,
    },
    nodes: overlay.nodes.map(node => ({
      nodeId: node.nodeId,
      kind: node.kind,
      path: node.path,
      ...(node.parentNodeId === undefined ? {} : { parentNodeId: node.parentNodeId }),
      ...(node.detail === undefined ? {} : { detail: node.detail }),
      instances: [],
      frames: [],
      attempts: [],
      signalWaits: [],
      status: "not_started" as const,
    })),
    groups: [],
  };
}

function uniqueEdges(edges: WebGraphEdge[]): WebGraphEdge[] {
  const seen = new Set<string>();
  return edges.filter(edge => {
    if (edge.source === edge.target || seen.has(edge.id)) return false;
    seen.add(edge.id);
    return true;
  });
}

function formatNodeDetail(detail: RuntimeNodeDetail): NodeDetail {
  switch (detail.kind) {
    case "task":
      return detail;
    case "agent":
      return {
        kind: "agent",
        agent: detail.agent,
        ...(detail.use === undefined ? {} : { use: detail.use }),
        ...(detail.command === undefined ? {} : { command: detail.command }),
        ...(detail.model === undefined ? {} : { model: detail.model }),
        ...(detail.outputSchema === undefined ? {} : { outputSchema: printSchema(detail.outputSchema) }),
      };
    case "signal":
      return {
        kind: "signal",
        ...(detail.outputSchema === undefined ? {} : { outputSchema: printSchema(detail.outputSchema) }),
      };
    case "assert":
      return {
        kind: "assert",
        condition: printExpr(detail.condition),
        ...(detail.message === undefined ? {} : { message: printExpr(detail.message) }),
      };
    case "if":
      return { kind: "if", condition: printExpr(detail.condition) };
    case "switch":
      return { kind: "switch", cases: detail.cases.map(printExpr), hasDefault: detail.hasDefault };
    case "parallel":
      return {
        kind: "parallel",
        branches: detail.branches,
        strategy: detail.strategy,
        ...(detail.maxConcurrency === undefined ? {} : { maxConcurrency: printExpr(detail.maxConcurrency) }),
      };
    case "fanout":
      return {
        kind: "fanout",
        over: printExpr(detail.over),
        strategy: detail.strategy,
        ...(detail.count === undefined ? {} : { count: printExpr(detail.count) }),
        ...(detail.maxConcurrency === undefined ? {} : { maxConcurrency: printExpr(detail.maxConcurrency) }),
      };
    case "loop":
      return {
        kind: "loop",
        state: printExpr(detail.state),
      };
  }
}

type SchemaDetail = NonNullable<Extract<RuntimeNodeDetail, { kind: "agent" }>["outputSchema"]>;

function printSchema(schema: SchemaDetail): string {
  switch (schema.kind) {
    case "object": {
      const names = Object.keys(schema.fields);
      if (names.length === 0) return "{}";
      const required = new Set(schema.required);
      return `{ ${names.map(name => (required.has(name) ? name : `${name}?`)).join(", ")} }`;
    }
    case "array":
      return `${printSchema(schema.item)}[]`;
    case "record":
      return `record<${printSchema(schema.value)}>`;
    case "union":
      return schema.variants.map(printSchema).join(" | ");
    case "enum":
      return schema.values.map(value => JSON.stringify(value)).join(" | ");
    case "literal":
      return JSON.stringify(schema.value);
    default:
      return schema.kind;
  }
}

function printExpr(expr: ExprIR): string {
  return truncate(renderExpr(expr), 80);
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 3))}...` : text;
}
