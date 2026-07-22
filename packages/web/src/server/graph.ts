import type { WorkflowIR } from "@acpus/core/ir";
import { createWorkflowVisualizationOverlay, type NodeDetail as RuntimeNodeDetail, type WorkflowVisualizationOverlay } from "@acpus/runtime";
import type { ExprIR } from "@acpus/expression/ir";
import type {
  NodeDetail,
  WebGraph,
  WebGraphContainer,
  WebGraphEdge,
  WebGraphFanoutOccurrence,
  WebGraphNode,
  WebGraphRuntimeState,
  WebGraphSelection,
  WebGraphSelector,
  WebGraphSelectorOption,
} from "../graph-types.js";
import { renderExpr } from "./expression-format.js";

export type { WebGraph } from "../graph-types.js";

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
  const fanoutOccurrences = mode === "runtime" ? graphFanoutOccurrences(source, containers) : [];
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
    fanoutOccurrences,
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

function graphFanoutOccurrences(
  source: WorkflowVisualizationOverlay,
  containers: WebGraphContainer[],
): WebGraphFanoutOccurrence[] {
  const containerByOwnerAndSegment = containerLookup(containers);
  return source.groups.flatMap(group => {
    if (group.kind !== "fanout") return [];
    const context = runtimeSelections(group.instancePath)
      .filter(selection => selection.kind !== "fanout" || selection.nodeId !== group.nodeId);
    return [{
      id: group.groupKey,
      nodeId: group.nodeId,
      targetId: containerByOwnerAndSegment.get(containerKey(group.nodeId, "do"))?.id ?? group.nodeId,
      context,
      status: group.status,
      items: group.members
        .filter(member => member.memberKind === "fanout_item")
        .sort((left, right) => left.itemIndex - right.itemIndex || left.memberKey.localeCompare(right.memberKey))
        .map(member => ({
          id: member.memberKey,
          itemIndex: member.itemIndex,
          label: `item[${member.itemIndex}]`,
          status: member.status,
          context: [...context, { nodeId: group.nodeId, kind: "fanout" as const, itemIndex: member.itemIndex }],
        })),
    }];
  });
}

function graphSelectors(
  source: WorkflowVisualizationOverlay,
  containers: WebGraphContainer[],
): WebGraphSelector[] {
  const selectors: WebGraphSelector[] = [];
  const containerByOwnerAndSegment = containerLookup(containers);

  for (const node of source.nodes) {
    if (node.detail?.kind !== "loop") continue;
    const targetId = containerByOwnerAndSegment.get(containerKey(node.nodeId, "do"))?.id ?? node.nodeId;
    selectors.push(...loopSelectors(node, targetId));
  }

  return selectors;
}

type PendingLoopSelector = {
  id: string;
  context: WebGraphSelection[];
  options: Array<WebGraphSelectorOption & { status: string }>;
};

function loopSelectors(node: OverlayNode, targetId: string): WebGraphSelector[] {
  const selectors = new Map<string, PendingLoopSelector>();
  const selectorByContext = new Map<string, PendingLoopSelector>();

  for (const frame of node.frames) {
    if (frame.frameKind !== "loop") continue;
    const context = parentContext(frame.instancePath, node.nodeId, "loop");
    const selector: PendingLoopSelector = { id: frame.frameKey, context, options: [] };
    selectors.set(selector.id, selector);
    selectorByContext.set(contextKey(context), selector);
  }

  for (const frame of node.frames) {
    if (frame.frameKind !== "loop_iteration") continue;
    const iteration = loopIteration(frame);
    if (iteration === undefined) continue;
    const context = parentContext(frame.instancePath, node.nodeId, "loop");
    const selector = (frame.parentFrameKey ? selectors.get(frame.parentFrameKey) : undefined)
      ?? selectorByContext.get(contextKey(context))
      ?? createFallbackLoopSelector(node.nodeId, frame.parentFrameKey, context, selectors, selectorByContext);
    selector.options.push({
      id: frame.frameKey,
      iteration,
      context: [...context, { nodeId: node.nodeId, kind: "loop", iteration }],
      status: frame.status,
    });
  }

  return [...selectors.values()].flatMap(selector => {
    if (selector.options.length === 0) return [];
    const options = selector.options
      .sort((left, right) => left.iteration - right.iteration || left.id.localeCompare(right.id));
    const defaultOptionId = options.find(option => option.status === "running" || option.status === "awaiting")?.id
      ?? options.at(-1)?.id;
    return [{
      id: selector.id,
      nodeId: node.nodeId,
      kind: "loop" as const,
      targetId,
      context: selector.context,
      ...(defaultOptionId === undefined ? {} : { defaultOptionId }),
      options: options.map(({ status: _status, ...option }) => option),
    }];
  });
}

function createFallbackLoopSelector(
  nodeId: string,
  parentFrameKey: string | undefined,
  context: WebGraphSelection[],
  selectors: Map<string, PendingLoopSelector>,
  selectorByContext: Map<string, PendingLoopSelector>,
): PendingLoopSelector {
  const id = parentFrameKey ?? `loop:${nodeId}:${encodeURIComponent(contextKey(context))}`;
  const selector: PendingLoopSelector = { id, context, options: [] };
  selectors.set(id, selector);
  selectorByContext.set(contextKey(context), selector);
  return selector;
}

function graphRuntimeStates(
  source: WorkflowVisualizationOverlay,
  containers: WebGraphContainer[],
  detailById: ReadonlyMap<string, NodeDetail | undefined>,
): WebGraphRuntimeState[] {
  const states: WebGraphRuntimeState[] = [];
  const containerByOwnerAndSegment = containerLookup(containers);
  const instancePathByNodeKey = new Map(source.nodes.flatMap(node => node.instances.flatMap(instance =>
    instance.instancePath === undefined ? [] : [[instance.nodeKey, instance.instancePath] as const],
  )));

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
      states.push(stateForSignalWait(node.nodeId, wait, instancePathByNodeKey.get(wait.nodeKey)));
    }
  }

  return states;
}

function stateForFrame(targetId: string, frame: OverlayFrame): WebGraphRuntimeState {
  return {
    targetId,
    status: frame.status,
    context: runtimeSelections(frame.instancePath),
  };
}

function stateForInstance(targetId: string, instance: OverlayInstance): WebGraphRuntimeState {
  return {
    targetId,
    status: instance.status,
    context: runtimeSelections(instance.instancePath),
  };
}

function stateForSignalWait(
  targetId: string,
  wait: OverlaySignalWait,
  instancePath: InstancePath | undefined,
): WebGraphRuntimeState {
  return {
    targetId,
    status: wait.status,
    context: runtimeSelections(instancePath),
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

function parentContext(
  path: InstancePath | undefined,
  nodeId: string,
  kind: WebGraphSelection["kind"],
): WebGraphSelection[] {
  return runtimeSelections(path).filter(selection => selection.kind !== kind || selection.nodeId !== nodeId);
}

function contextKey(context: WebGraphSelection[]): string {
  return JSON.stringify(context);
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
    return Number.isSafeInteger(index) && index >= 0 ? `case ${index}` : segment;
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
