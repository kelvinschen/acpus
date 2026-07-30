import { basename } from "node:path";
import { childScopes, walkNodes, type ExprIR, type NodeIR, type ScopeIR, type WorkflowIR } from "@acpus/core/ir";
import { isJsonValue, type JsonPrimitive, type JsonValue, type TemplateIR } from "@acpus/expression/ir";
import type { CommittedRuntimeEventRow } from "../hooks/events.js";
import type {
  ArtifactRecord,
  RunDetails,
  RunDynamicAttempt,
  RunDynamicFrame,
  RunDynamicGroup,
  RunDynamicGroupMember,
  RunDynamicNodeInstance,
  RunDynamicSignalWait,
  RunExecutionMetadata,
  RunNodeProgress,
} from "../store/store.js";
import { appendBranch, appendFanoutItem, appendLoopIteration, appendNode, deriveInstanceKey } from "../scheduler/identity.js";
import { deriveOccurrenceRef, occurrenceRefSelector } from "../scheduler/occurrence-ref.js";
import type { InstancePath, InstancePathSegment } from "../scheduler/types.js";
import { compactSchemaSummary } from "../schema-summary.js";
import type {
  AgentDecisionState,
  AgentInspectionState,
  RunInspectionOverviewAction,
  RunInspectionChange,
  RunInspectionControl,
  RunInspectionDetailedFailure,
  RunInspectionItem,
  RunInspectionRunSummary,
  RunInspectionSnapshot,
  RunInspectionStaticNode,
  RunInspectionStatus,
  RunInspectionStatusCounts,
  RunInspectionTarget,
} from "./types.js";
import type { ResolvedTargetState } from "./resolved-target.js";

const schedulerFailureReasons = new Set([
  "assert_failed",
  "attempt_timeout",
  "branch_failed",
  "deadline_out_of_range",
  "expression_failed",
  "expression_resolution_failed",
  "fanout_over_not_array",
  "group_failed",
  "invalid_loop_transition",
  "iteration_failed",
  "node_failed",
  "parent_failed",
  "quorum_impossible",
  "race_no_success",
  "scheduler_failed",
  "signal_timeout",
]);

export function projectRunSnapshot(input: {
  ir: WorkflowIR;
  run: RunDetails;
  includeAllTopology?: boolean;
  availableControls?: readonly RunInspectionControl[];
}): RunInspectionSnapshot {
  return projectSnapshot(
    input.ir,
    input.run,
    inspectionStaticNodes(input.ir),
    input.includeAllTopology === true,
    input.availableControls ?? [],
  )!;
}

export function resolveTargetState(input: {
  ir: WorkflowIR;
  run: RunDetails;
  artifacts: ArtifactRecord[];
  target: string;
  availableControls?: readonly RunInspectionControl[];
}): ResolvedTargetState | undefined {
  return projectTarget(
    input.ir,
    input.run,
    input.artifacts,
    inspectionStaticNodes(input.ir),
    input.target,
    input.availableControls ?? [],
  );
}

export function semanticChanges(
  events: readonly CommittedRuntimeEventRow[],
  document: Pick<RunInspectionSnapshot, "items" | "run"> | Pick<ResolvedTargetState, "items" | "run">,
  run?: RunDetails,
): RunInspectionChange[] {
  const items = inspectionItems(document);
  const itemByIdentity = new Map<string, RunInspectionItem>();
  const itemsByNodeId = new Map<string, RunInspectionItem[]>();
  const itemOccurrenceCounts = new Map<string, number>();
  for (const item of items) {
    for (const key of [item.nodeKey, item.frameKey, item.attemptId]) if (key) itemByIdentity.set(key, item);
    if (item.nodeId) addToMapArray(itemsByNodeId, item.nodeId, item);
    if (item.nodeId && (item.role === "instance" || item.role === "frame")) {
      itemOccurrenceCounts.set(item.nodeId, (itemOccurrenceCounts.get(item.nodeId) ?? 0) + 1);
    }
  }
  const frames = new Map(run?.dynamic?.frames.map(frame => [frame.frameKey, frame]) ?? []);
  const instances = new Map(run?.dynamic?.nodeInstances.map(instance => [instance.nodeKey, instance]) ?? []);
  const attempts = new Map(run?.dynamic?.attempts.map(attempt => [attempt.attemptId, attempt]) ?? []);
  const occurrenceCounts = new Map<string, number>();
  for (const instance of instances.values()) occurrenceCounts.set(instance.nodeId, (occurrenceCounts.get(instance.nodeId) ?? 0) + 1);
  for (const frame of frames.values()) {
    if (frame.nodeId && (frame.frameKind === "node" || frame.frameKind === "loop")) {
      occurrenceCounts.set(frame.nodeId, (occurrenceCounts.get(frame.nodeId) ?? 0) + 1);
    }
  }
  const visibility = eventVisibilityIndex(events);
  const contexts = new Map(events.map(event => [event.sequence, eventContext(event, frames, instances, attempts, occurrenceCounts)]));
  return events.filter(event => operatorVisibleEvent(event, contexts.get(event.sequence)!, visibility)).map(event => {
    const context = contexts.get(event.sequence)!;
    const baseEntity = eventEntity(event);
    const entity = context.nodeId && !baseEntity.nodeId ? { ...baseEntity, nodeId: context.nodeId } : baseEntity;
    const item = [context.nodeKey, context.frameKey, context.attemptId, entity.id]
      .flatMap(key => key ? [itemByIdentity.get(key)] : [])
      .find((value): value is RunInspectionItem => value !== undefined)
      ?? (context.nodeId && itemsByNodeId.get(context.nodeId)?.length === 1 ? itemsByNodeId.get(context.nodeId)![0] : undefined);
    const action = eventAction(event.type);
    const message = eventMessage(event.payload, action);
    const status = eventStatus(action);
    return {
      sequence: event.sequence,
      at: event.createdAt,
      entity,
      subject: eventSubject(document, context, item, itemOccurrenceCounts),
      action,
      ...(status ? { status } : {}),
      ...(typeof event.payload.attemptNo === "number" ? { attemptNo: event.payload.attemptNo } : {}),
      ...(item ? { itemKey: item.key } : {}),
      ...(message ? { message } : {}),
    };
  });
}

function inspectionItems(document: Pick<RunInspectionSnapshot, "items" | "run"> | Pick<ResolvedTargetState, "items" | "run">): RunInspectionItem[] {
  return document.items;
}

export function inspectionStaticNodes(ir: WorkflowIR): RunInspectionStaticNode[] {
  return Array.from(walkNodes(ir.root), ({ node, ancestry }, order) => ({
    nodeId: node.id,
    kind: node.kind,
    order,
    path: [...ancestry.map(item => item.owner.id), node.id],
    ...(ancestry.at(-1)?.owner.id ? { parentNodeId: ancestry.at(-1)!.owner.id } : {}),
    ...(node.kind === "agent" || node.kind === "signal" ? { prompt: node.run.prompt } : {}),
    ...(node.kind === "signal" ? { outputSchema: node.outputSchema } : {}),
    ...(node.kind === "agent" ? { agent: node.run.agent, ...(ir.agents[node.run.agent] ? { agentDefinition: ir.agents[node.run.agent] } : {}) } : {}),
  }));
}

export function terminalRun(status: string): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

function projectSnapshot(
  ir: WorkflowIR,
  run: RunDetails,
  staticNodes: RunInspectionStaticNode[],
  all: boolean,
  availableControls: readonly RunInspectionControl[],
  scopeTarget?: string,
): RunInspectionSnapshot | undefined {
  const indexes = snapshotIndexes(run, staticNodes);
  const rawTree = occurrenceTree(ir, indexes);
  const scoped = scopeTarget === undefined ? undefined : scopedOccurrenceTree(rawTree, run, scopeTarget);
  if (scopeTarget !== undefined && !scoped) return undefined;
  const tree = scoped?.tree ?? rawTree;
  const itemByKey = new Map(tree.items.map(item => [item.key, item]));
  const actions: RunInspectionOverviewAction[] = [];
  for (const wait of run.dynamic?.signalWaits ?? []) {
    if (wait.status === "awaiting") {
      const itemKey = tree.itemKeyByNodeKey.get(wait.nodeKey);
      const ref = itemKey ? itemByKey.get(itemKey)?.ref : undefined;
      if (!itemKey || !ref) continue;
      const outputSchema = indexes.staticById.get(wait.nodeId)?.outputSchema;
      actions.push({ kind: "signal", target: ref, itemKey, ...(outputSchema ? { schemaSummary: compactSchemaSummary(outputSchema) } : {}) });
    }
  }
  actions.push(...projectControlActions(availableControls, tree.items));
  return {
    schemaVersion: 2,
    kind: "snapshot",
    run: runSummary(ir, run, false),
    counts: inspectionStatusCounts(tree.executionStatuses),
    items: tree.items,
    availableActions: actions,
    ...(terminalRun(run.status) && run.hooks.length > 0 ? { hooks: run.hooks } : {}),
    ...(terminalRun(run.status) && run.output !== undefined ? { output: run.output } : {}),
    ...(all ? { all: true } : {}),
    ...(scoped?.ref ? { scope: { ref: scoped.ref } } : {}),
  };
}

function projectControlActions(
  controls: readonly RunInspectionControl[],
  items: readonly RunInspectionItem[],
): RunInspectionOverviewAction[] {
  const itemByTarget = new Map<string, RunInspectionItem>();
  for (const item of items) {
    for (const target of [item.nodeKey, item.frameKey, item.attemptId]) {
      if (target) itemByTarget.set(target, item);
    }
  }
  const actions: RunInspectionOverviewAction[] = [];
  for (const control of controls) {
    if (control.type === "cancel" && control.target === undefined) {
      actions.push({ kind: "cancel" });
      continue;
    }
    if (control.target === undefined) continue;
    const item = itemByTarget.get(control.target);
    if (!item?.ref) continue;
    if (control.type === "steer") {
      if (item.attemptNo === undefined) continue;
      actions.push({
        kind: "steer",
        target: occurrenceRefSelector(item.ref as `@${string}`, item.attemptNo),
        itemKey: item.key,
      });
      continue;
    }
    actions.push({ kind: control.type, target: item.ref, itemKey: item.key });
  }
  return actions;
}

type SnapshotIndexes = {
  staticById: Map<string, RunInspectionStaticNode>;
  framesByKey: Map<string, RunDynamicFrame>;
  framesByPath: Map<number, RunDynamicFrame>;
  framesByNodeId: Map<string, RunDynamicFrame[]>;
  instancesByKey: Map<string, RunDynamicNodeInstance>;
  instancesByPath: Map<number, RunDynamicNodeInstance>;
  instancesByNodeId: Map<string, RunDynamicNodeInstance[]>;
  attemptsByNodeKey: Map<string, RunDynamicAttempt[]>;
  waitsByNodeKey: Map<string, RunDynamicSignalWait>;
  progressByNodeKey: Map<string, RunNodeProgress>;
  metadataByAttemptId: Map<string, RunExecutionMetadata>;
  groupsByNodeKey: Map<string, RunDynamicGroup>;
  membersByGroupKey: Map<string, RunDynamicGroupMember[]>;
  memberByBranch: Map<string, RunDynamicGroupMember>;
  memberByItem: Map<string, RunDynamicGroupMember>;
  contextValues: Map<string, Map<string, InstancePathSegment>>;
  materializedContextPaths: Set<number>;
  pathIndex: InstancePathIndex;
  rootFrame?: RunDynamicFrame;
};

type OccurrenceTree = {
  items: RunInspectionItem[];
  executionStatuses: RunInspectionStatus[];
  executionItemKeys: Set<string>;
  itemKeyByNodeKey: Map<string, string>;
};

function scopedOccurrenceTree(
  tree: OccurrenceTree,
  run: RunDetails,
  target: string,
): { tree: OccurrenceTree; ref?: string } | undefined {
  const occurrenceTarget = run.dynamic?.attempts.find(attempt => attempt.attemptId === target)?.nodeKey ?? target;
  const roots = tree.items.filter(item =>
    item.nodeKey === target
      || item.frameKey === target
      || item.attemptId === target
      || item.nodeKey === occurrenceTarget
      || item.nodeId === target);
  if (roots.length !== 1) return undefined;
  const root = roots[0]!;
  const keys = new Set([root.key]);
  for (const item of tree.items) if (item.parentKey && keys.has(item.parentKey)) keys.add(item.key);
  const items = tree.items.flatMap(item => {
    if (!keys.has(item.key)) return [];
    if (item.key !== root.key) return [item];
    const { parentKey: _parentKey, ...scopedRoot } = item;
    return [scopedRoot];
  });
  const executionItemKeys = new Set([...tree.executionItemKeys].filter(key => keys.has(key)));
  return {
    tree: {
      items,
      executionStatuses: items.filter(item => executionItemKeys.has(item.key)).map(item => item.status),
      executionItemKeys,
      itemKeyByNodeKey: new Map([...tree.itemKeyByNodeKey].filter(([, key]) => keys.has(key))),
    },
    ...(root.ref ? { ref: root.ref } : {}),
  };
}

function snapshotIndexes(run: RunDetails, staticNodes: RunInspectionStaticNode[]): SnapshotIndexes {
  const dynamic = run.dynamic;
  const framesByKey = new Map((dynamic?.frames ?? []).map(frame => [frame.frameKey, frame]));
  const framesByPath = new Map<number, RunDynamicFrame>();
  const framesByNodeId = new Map<string, RunDynamicFrame[]>();
  const instancesByKey = new Map((dynamic?.nodeInstances ?? []).map(instance => [instance.nodeKey, instance]));
  const instancesByPath = new Map<number, RunDynamicNodeInstance>();
  const instancesByNodeId = new Map<string, RunDynamicNodeInstance[]>();
  const attemptsByNodeKey = new Map<string, RunDynamicAttempt[]>();
  const waitsByNodeKey = new Map<string, RunDynamicSignalWait>();
  const progressByNodeKey = new Map<string, RunNodeProgress>();
  const metadataByAttemptId = new Map<string, RunExecutionMetadata>();
  const groupsByNodeKey = new Map<string, RunDynamicGroup>();
  const membersByGroupKey = new Map<string, RunDynamicGroupMember[]>();
  const memberByBranch = new Map<string, RunDynamicGroupMember>();
  const memberByItem = new Map<string, RunDynamicGroupMember>();
  const contextValues = new Map<string, Map<string, InstancePathSegment>>();
  const materializedContextPaths = new Set<number>();
  const pathIndex = createInstancePathIndex();
  const indexPath = (path: InstancePath): number => {
    let prefixId = pathIndex.rootId;
    for (const segment of path) {
      if (segment.kind !== "node") {
        const owner = contextOwnerKey(prefixId, segment.kind, segment.nodeId);
        const values = contextValues.get(owner) ?? new Map<string, InstancePathSegment>();
        values.set(contextValueKey(segment), segment);
        contextValues.set(owner, values);
      }
      prefixId = pathIndex.append(prefixId, segment);
      if (segment.kind !== "node") materializedContextPaths.add(prefixId);
    }
    return prefixId;
  };
  for (const frame of dynamic?.frames ?? []) {
    if (frame.instancePath) {
      const pathId = indexPath(frame.instancePath);
      framesByPath.set(pathId, newer(framesByPath.get(pathId), frame));
    }
    if (frame.nodeId) addToMapArray(framesByNodeId, frame.nodeId, frame);
  }
  for (const instance of dynamic?.nodeInstances ?? []) {
    if (instance.instancePath) {
      const pathId = indexPath(instance.instancePath);
      instancesByPath.set(pathId, newer(instancesByPath.get(pathId), instance));
    }
    addToMapArray(instancesByNodeId, instance.nodeId, instance);
  }
  for (const attempt of dynamic?.attempts ?? []) addToMapArray(attemptsByNodeKey, attempt.nodeKey, attempt);
  for (const attempts of attemptsByNodeKey.values()) attempts.sort((left, right) => right.attemptNo - left.attemptNo);
  for (const wait of dynamic?.signalWaits ?? []) waitsByNodeKey.set(wait.nodeKey, newer(waitsByNodeKey.get(wait.nodeKey), wait));
  for (const progress of dynamic?.progress ?? []) progressByNodeKey.set(progress.nodeKey, newer(progressByNodeKey.get(progress.nodeKey), progress));
  for (const metadata of dynamic?.executionMetadata ?? []) if (metadata.attemptId) metadataByAttemptId.set(metadata.attemptId, newerCreated(metadataByAttemptId.get(metadata.attemptId), metadata));
  for (const group of dynamic?.groups ?? []) groupsByNodeKey.set(group.nodeKey, group);
  for (const member of dynamic?.groupMembers ?? []) {
    addToMapArray(membersByGroupKey, member.groupKey, member);
    if (member.memberKind === "branch") memberByBranch.set(`${member.groupKey}\0${member.branchId}`, member);
    else memberByItem.set(`${member.groupKey}\0${member.itemIndex}`, member);
  }
  return {
    staticById: new Map(staticNodes.map(node => [node.nodeId, node])),
    framesByKey,
    framesByPath,
    framesByNodeId,
    instancesByKey,
    instancesByPath,
    instancesByNodeId,
    attemptsByNodeKey,
    waitsByNodeKey,
    progressByNodeKey,
    metadataByAttemptId,
    groupsByNodeKey,
    membersByGroupKey,
    memberByBranch,
    memberByItem,
    contextValues,
    materializedContextPaths,
    pathIndex,
    ...((dynamic?.frames ?? []).find(frame => frame.frameKind === "root") ? { rootFrame: (dynamic?.frames ?? []).find(frame => frame.frameKind === "root")! } : {}),
  };
}

function occurrenceTree(ir: WorkflowIR, indexes: SnapshotIndexes): OccurrenceTree {
  const items: RunInspectionItem[] = [];
  const executionStatuses: RunInspectionStatus[] = [];
  const executionItemKeys = new Set<string>();
  const itemKeyByNodeKey = new Map<string, string>();

  const visitScope = (scope: ScopeIR, basePath: InstancePath, parentKey: string | undefined, parentFrame: RunDynamicFrame | undefined): RunInspectionStatus[] => {
    const scopeStatuses: RunInspectionStatus[] = [];
    for (const node of scope.nodes) {
      const nodePath = appendNode(basePath, node.id);
      const key = occurrenceNodeKey(nodePath);
      const instance = occurrenceInstance(indexes, nodePath, node.id, parentFrame);
      const frame = occurrenceNodeFrame(indexes, nodePath, node.id, parentFrame);
      const item = snapshotNodeItem(indexes, node, nodePath, key, parentKey, instance, frame);
      items.push(item);
      if (item.nodeKey) itemKeyByNodeKey.set(item.nodeKey, key);

      let childStatuses: RunInspectionStatus[] = [];
      if (node.kind === "if" || node.kind === "switch") {
        const children = childScopes(node).filter(child => child.kind === "if" || child.kind === "switch");
        const selected = children.find(child => indexes.materializedContextPaths.has(indexes.pathIndex.id(appendBranch(basePath, node.id, child.branchId))));
        for (const child of children) {
          const branchPath = appendBranch(basePath, node.id, child.branchId);
          const branchFrame = occurrenceContextFrame(indexes, branchPath);
          const selection = selected ? child.branchId === selected.branchId ? "selected" : "not_selected" : "undecided";
          const branchItem = snapshotScopeItem(node, branchPath, key, branchFrame, child.scope.nodes.length === 0, {
            kind: "branch",
            ownerKind: node.kind,
            branchId: child.branchId,
            selection,
            empty: child.scope.nodes.length === 0,
          }, selection === "not_selected" ? "not_selected" : selection === "undecided" ? "not_started" : undefined);
          items.push(branchItem);
          if (selection === "selected") {
            const statuses = visitScope(child.scope, branchPath, branchItem.key, branchFrame);
            childStatuses.push(...statuses);
            if (!branchFrame && statuses.length > 0) branchItem.status = aggregateInspectionStatus(statuses);
          }
        }
      } else if (node.kind === "parallel") {
        const group = occurrenceGroup(indexes, item.nodeKey);
        for (const child of childScopes(node)) {
          if (child.kind !== "parallel") continue;
          const branchPath = appendBranch(basePath, node.id, child.branchId);
          const branchFrame = occurrenceContextFrame(indexes, branchPath);
          const member = group ? indexes.memberByBranch.get(`${group.groupKey}\0${child.branchId}`) : undefined;
          const materialized = Boolean(branchFrame || member || indexes.materializedContextPaths.has(indexes.pathIndex.id(branchPath)));
          const branchItem = snapshotScopeItem(node, branchPath, key, branchFrame, child.scope.nodes.length === 0, {
            kind: "branch",
            ownerKind: "parallel",
            branchId: child.branchId,
            empty: child.scope.nodes.length === 0,
          }, member ? normalizeInspectionStatus(member.status) : undefined);
          items.push(branchItem);
          if (materialized) {
            const statuses = visitScope(child.scope, branchPath, branchItem.key, branchFrame);
            childStatuses.push(...statuses);
            if (!branchFrame && !member && statuses.length > 0) branchItem.status = aggregateInspectionStatus(statuses);
          }
        }
      } else if (node.kind === "fanout") {
        const group = occurrenceGroup(indexes, item.nodeKey);
        const itemIndexes = contextNumbers(indexes, basePath, node.id, "fanout");
        for (const member of group ? indexes.membersByGroupKey.get(group.groupKey) ?? [] : []) if (member.memberKind === "fanout_item") itemIndexes.add(member.itemIndex);
        if (!frame && itemIndexes.size === 0) executionStatuses.push(...unmaterializedExecutionStatuses(node.do));
        for (const itemIndex of [...itemIndexes].sort((left, right) => left - right)) {
          const itemPath = appendFanoutItem(basePath, node.id, itemIndex);
          const itemFrame = occurrenceContextFrame(indexes, itemPath);
          const member = group ? indexes.memberByItem.get(`${group.groupKey}\0${itemIndex}`) : undefined;
          const scopeItem = snapshotScopeItem(node, itemPath, key, itemFrame, node.do.nodes.length === 0, {
            kind: "fanout_item",
            itemIndex,
            empty: node.do.nodes.length === 0,
          }, member ? normalizeInspectionStatus(member.status) : undefined);
          items.push(scopeItem);
          const statuses = visitScope(node.do, itemPath, scopeItem.key, itemFrame);
          childStatuses.push(...statuses);
          if (!itemFrame && !member && statuses.length > 0) scopeItem.status = aggregateInspectionStatus(statuses);
        }
      } else if (node.kind === "loop") {
        const iterations = contextNumbers(indexes, basePath, node.id, "loop");
        if (!frame && iterations.size === 0) executionStatuses.push(...unmaterializedExecutionStatuses(node.do));
        for (const iteration of [...iterations].sort((left, right) => left - right)) {
          const iterationPath = appendLoopIteration(basePath, node.id, iteration);
          const iterationFrame = occurrenceContextFrame(indexes, iterationPath);
          const scopeItem = snapshotScopeItem(node, iterationPath, key, iterationFrame, node.do.nodes.length === 0, {
            kind: "loop_iteration",
            iteration,
            round: iteration + 1,
            empty: node.do.nodes.length === 0,
          });
          items.push(scopeItem);
          const statuses = visitScope(node.do, iterationPath, scopeItem.key, iterationFrame);
          childStatuses.push(...statuses);
          if (!iterationFrame && statuses.length > 0) scopeItem.status = aggregateInspectionStatus(statuses);
        }
      }

      const executable = node.kind === "agent" || node.kind === "task" || node.kind === "signal" || node.kind === "assert";
      if (executable) {
        executionStatuses.push(item.status);
        executionItemKeys.add(item.key);
        scopeStatuses.push(item.status);
      } else {
        if (!instance && !frame && childStatuses.length > 0) item.status = aggregateInspectionStatus(childStatuses);
        scopeStatuses.push(...childStatuses);
      }
    }
    return scopeStatuses;
  };

  visitScope(ir.root, [], undefined, indexes.rootFrame);
  return { items, executionStatuses, executionItemKeys, itemKeyByNodeKey };
}

function snapshotNodeItem(
  indexes: SnapshotIndexes,
  node: NodeIR,
  path: InstancePath,
  key: string,
  parentKey: string | undefined,
  instance: RunDynamicNodeInstance | undefined,
  frame: RunDynamicFrame | undefined,
): RunInspectionItem {
  if (instance) {
    const state = indexedInstanceState(indexes, instance);
    const progress = indexes.progressByNodeKey.get(instance.nodeKey);
    return {
      key,
      role: "instance",
      ...(parentKey ? { parentKey } : {}),
      path: inspectionPath(path),
      label: node.id,
      kind: node.kind,
      status: state.status,
      nodeId: node.id,
      ref: deriveOccurrenceRef(path),
      nodeKey: instance.nodeKey,
      ...(state.attempt?.attemptId ? { attemptId: state.attempt.attemptId } : {}),
      ...(state.attempt?.attemptNo === undefined ? {} : { attemptNo: state.attempt.attemptNo }),
      ...(instance.statusReason ? { statusReason: instance.statusReason } : {}),
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt,
      ...(state.attempt?.startedAt ? { startedAt: state.attempt.startedAt } : {}),
      ...(state.attempt?.finishedAt ? { finishedAt: state.attempt.finishedAt } : {}),
      ...(state.attempt?.deadlineAt ? { deadlineAt: state.attempt.deadlineAt } : {}),
      ...failureDetails(node, instance.error ?? state.attempt?.error, instance.statusReason ?? state.attempt?.terminalReason),
      ...(node.kind === "agent" ? { agent: agentDecisionState(node, progress) } : {}),
      ...(node.kind === "task" ? { task: { target: node.run.target.kind } } : {}),
      ...(node.kind === "signal" ? { signal: {
        target: instance.nodeKey,
        ...(state.wait?.deadlineAt ? { deadlineAt: state.wait.deadlineAt } : {}),
        ...(state.wait?.renderedPrompt ? { promptPreview: boundedSummary(state.wait.renderedPrompt, 160) } : {}),
        ...(node.outputSchema ? { schemaSummary: compactSchemaSummary(node.outputSchema) } : {}),
      } } : {}),
    };
  }
  if (frame) {
    const status = normalizeInspectionStatus(frame.status);
    return {
      key,
      role: "frame",
      ...(parentKey ? { parentKey } : {}),
      path: inspectionPath(path),
      label: node.id,
      kind: node.kind,
      status,
      nodeId: node.id,
      ref: deriveOccurrenceRef(path),
      ...(frame.nodeKey ? { nodeKey: frame.nodeKey } : {}),
      frameKey: frame.frameKey,
      ...(frame.terminalReason ? { statusReason: frame.terminalReason } : {}),
      createdAt: frame.createdAt,
      updatedAt: frame.updatedAt,
      ...(terminalItem(status) ? { finishedAt: frame.updatedAt } : {}),
      ...failureDetails(node, frame.error, frame.terminalReason),
      ...occurrenceCompositeDetails(indexes, node, frame),
    };
  }
  return {
    key,
    role: "static",
    ...(parentKey ? { parentKey } : {}),
    path: inspectionPath(path),
    label: node.id,
    kind: node.kind,
    status: "not_started",
    nodeId: node.id,
    ...occurrenceCompositeDetails(indexes, node),
  };
}

function snapshotScopeItem(
  owner: NodeIR,
  path: InstancePath,
  parentKey: string,
  frame: RunDynamicFrame | undefined,
  empty: boolean,
  scope: NonNullable<RunInspectionItem["scope"]>,
  statusOverride?: RunInspectionStatus,
): RunInspectionItem {
  const status = statusOverride ?? (frame ? normalizeInspectionStatus(frame.status) : "not_started");
  const label = scope.kind === "branch"
    ? owner.kind === "switch" && scope.branchId.startsWith("case:") ? `case ${Number(scope.branchId.slice(5)) + 1}` : scope.branchId
    : scope.kind === "fanout_item" ? `item[${scope.itemIndex}]` : `round ${scope.round}`;
  return {
    key: occurrenceScopeKey(path),
    role: "context",
    parentKey,
    path: inspectionPath(path),
    label,
    kind: scope.kind,
    status,
    nodeId: owner.id,
    ...(frame ? { ref: deriveOccurrenceRef(path) } : {}),
    ...(frame?.frameKey ? { frameKey: frame.frameKey } : {}),
    ...(frame?.terminalReason ? { statusReason: frame.terminalReason } : {}),
    ...(frame?.createdAt ? { createdAt: frame.createdAt } : {}),
    ...(frame?.updatedAt ? { updatedAt: frame.updatedAt } : {}),
    ...(frame && terminalItem(status) ? { finishedAt: frame.updatedAt } : {}),
    ...failureDetails(owner, frame?.error, frame?.terminalReason),
    scope: { ...scope, empty },
  };
}

function occurrenceCompositeDetails(indexes: SnapshotIndexes, node: NodeIR, frame?: RunDynamicFrame): Pick<RunInspectionItem, "composite"> | {} {
  if (!["if", "switch", "parallel", "fanout", "loop"].includes(node.kind)) return {};
  const group = occurrenceGroup(indexes, frame?.nodeKey);
  const members = group ? indexes.membersByGroupKey.get(group.groupKey) ?? [] : [];
  return {
    composite: {
      ...(group?.strategy ? { strategy: group.strategy } : node.kind === "parallel" || node.kind === "fanout" ? { strategy: node.strategy } : {}),
      ...(group?.quorumCount === undefined ? {} : { quorumCount: group.quorumCount }),
      ...(group?.maxConcurrency === undefined ? {} : { maxConcurrency: group.maxConcurrency }),
      ...(frame?.loop?.iter === undefined ? {} : { currentIteration: frame.loop.iter }),
      ...(group ? { counts: inspectionStatusCounts(members.map(member => normalizeInspectionStatus(member.status))) } : {}),
    },
  };
}

function occurrenceInstance(indexes: SnapshotIndexes, path: InstancePath, nodeId: string, parentFrame: RunDynamicFrame | undefined): RunDynamicNodeInstance | undefined {
  const exact = indexes.instancesByPath.get(indexes.pathIndex.id(path));
  if (exact) return exact;
  const scopedKey = parentFrame?.scope?.[nodeId];
  if (scopedKey) return indexes.instancesByKey.get(scopedKey);
  const matches = indexes.instancesByNodeId.get(nodeId) ?? [];
  return path.length === 1 && matches.length === 1 ? matches[0] : undefined;
}

function occurrenceNodeFrame(indexes: SnapshotIndexes, path: InstancePath, nodeId: string, parentFrame: RunDynamicFrame | undefined): RunDynamicFrame | undefined {
  const exact = indexes.framesByPath.get(indexes.pathIndex.id(path));
  if (exact && (exact.frameKind === "node" || exact.frameKind === "loop")) return exact;
  const scopedKey = parentFrame?.scope?.[nodeId];
  if (scopedKey) {
    const scoped = indexes.framesByKey.get(scopedKey);
    if (scoped && (scoped.frameKind === "node" || scoped.frameKind === "loop")) return scoped;
  }
  const matches = (indexes.framesByNodeId.get(nodeId) ?? []).filter(frame => frame.frameKind === "node" || frame.frameKind === "loop");
  return path.length === 1 && matches.length === 1 ? matches[0] : undefined;
}

function occurrenceContextFrame(indexes: SnapshotIndexes, path: InstancePath): RunDynamicFrame | undefined {
  const frame = indexes.framesByPath.get(indexes.pathIndex.id(path));
  return frame && frame.frameKind !== "node" && frame.frameKind !== "loop" && frame.frameKind !== "root" ? frame : undefined;
}

function occurrenceGroup(indexes: SnapshotIndexes, nodeKey: string | undefined): RunDynamicGroup | undefined {
  return nodeKey ? indexes.groupsByNodeKey.get(nodeKey) : undefined;
}

function indexedInstanceState(indexes: SnapshotIndexes, instance: RunDynamicNodeInstance) {
  const attempts = indexes.attemptsByNodeKey.get(instance.nodeKey) ?? [];
  const attempt = instance.acceptedAttemptId ? attempts.find(item => item.attemptId === instance.acceptedAttemptId) ?? attempts[0] : attempts[0];
  const wait = indexes.waitsByNodeKey.get(instance.nodeKey);
  const signalStatus = wait?.status === "awaiting" || wait?.status === "timed_out" ? wait.status : undefined;
  return { attempt, wait, status: normalizeInspectionStatus(signalStatus ?? (attempt?.status === "timed_out" ? "timed_out" : instance.status)) };
}

function contextNumbers(indexes: SnapshotIndexes, basePath: InstancePath, nodeId: string, kind: "fanout" | "loop"): Set<number> {
  const values = indexes.contextValues.get(contextOwnerKey(indexes.pathIndex.id(basePath), kind, nodeId));
  return new Set([...(values?.values() ?? [])].flatMap(segment => segment.kind === "fanout" ? [segment.itemIndex] : segment.kind === "loop" ? [segment.iter] : []));
}

function contextOwnerKey(basePathId: number, kind: "branch" | "fanout" | "loop", nodeId: string): string {
  return JSON.stringify([basePathId, kind, nodeId]);
}

function contextValueKey(segment: Exclude<InstancePathSegment, { kind: "node" }>): string {
  return segment.kind === "branch" ? segment.branchId : segment.kind === "fanout" ? String(segment.itemIndex) : String(segment.iter);
}

type InstancePathIndex = {
  rootId: number;
  append(parentId: number, segment: InstancePathSegment): number;
  id(path: InstancePath): number;
};

function createInstancePathIndex(): InstancePathIndex {
  const rootId = 0;
  let nextId = 1;
  const children = new Map<number, Map<string, number>>();
  const append = (parentId: number, segment: InstancePathSegment): number => {
    const siblings = children.get(parentId) ?? new Map<string, number>();
    children.set(parentId, siblings);
    const key = JSON.stringify(segment.kind === "node" ? ["node", segment.nodeId]
      : segment.kind === "branch" ? ["branch", segment.nodeId, segment.branchId]
        : segment.kind === "fanout" ? ["fanout", segment.nodeId, segment.itemIndex]
          : ["loop", segment.nodeId, segment.iter]);
    const existing = siblings.get(key);
    if (existing !== undefined) return existing;
    const id = nextId++;
    siblings.set(key, id);
    return id;
  };
  return {
    rootId,
    append,
    id: path => path.reduce((parentId, segment) => append(parentId, segment), rootId),
  };
}

function occurrenceNodeKey(path: InstancePath): string {
  return `node:${deriveInstanceKey(path)}`;
}

function occurrenceScopeKey(path: InstancePath): string {
  return `scope:${deriveInstanceKey(path)}`;
}

function addToMapArray<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function newer<T extends { updatedAt: string }>(current: T | undefined, candidate: T): T {
  return !current || candidate.updatedAt.localeCompare(current.updatedAt) >= 0 ? candidate : current;
}

function newerCreated<T extends { createdAt: string }>(current: T | undefined, candidate: T): T {
  return !current || candidate.createdAt.localeCompare(current.createdAt) >= 0 ? candidate : current;
}

function unmaterializedExecutionStatuses(scope: ScopeIR): RunInspectionStatus[] {
  return Array.from(walkNodes(scope)).flatMap(({ node }) => node.kind === "agent" || node.kind === "task" || node.kind === "signal" || node.kind === "assert" ? ["not_started" as const] : []);
}

function instanceItem(
  ir: WorkflowIR,
  instance: RunDynamicNodeInstance,
  indexes: SnapshotIndexes,
  nodesById: ReadonlyMap<string, NodeIR>,
  staticById: Map<string, RunInspectionStaticNode>,
): RunInspectionItem<AgentInspectionState> {
  const node = nodesById.get(instance.nodeId);
  const { attempt, wait, status } = indexedInstanceState(indexes, instance);
  const progress = indexes.progressByNodeKey.get(instance.nodeKey);
  const metadata = attempt?.attemptId ? indexes.metadataByAttemptId.get(attempt.attemptId) : undefined;
  const parentContext = lastContextKey(instance.instancePath);
  const parentNodeId = staticById.get(instance.nodeId)?.parentNodeId;
  return {
    key: `instance:${instance.nodeKey}`,
    role: "instance",
    ...(parentContext || parentNodeId ? { parentKey: parentContext ?? `static:${parentNodeId}` } : {}),
    path: inspectionPath(instance.instancePath),
    label: instance.nodeId,
    kind: node?.kind ?? staticById.get(instance.nodeId)?.kind ?? "node",
    status,
    nodeId: instance.nodeId,
    ...(instance.instancePath ? { ref: deriveOccurrenceRef(instance.instancePath) } : {}),
    nodeKey: instance.nodeKey,
    ...(attempt?.attemptId ? { attemptId: attempt.attemptId } : {}),
    ...(attempt?.attemptNo === undefined ? {} : { attemptNo: attempt.attemptNo }),
    ...(instance.statusReason ? { statusReason: instance.statusReason } : {}),
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
    ...(attempt?.startedAt ? { startedAt: attempt.startedAt } : {}),
    ...(attempt?.finishedAt ? { finishedAt: attempt.finishedAt } : {}),
    ...(attempt?.deadlineAt ? { deadlineAt: attempt.deadlineAt } : {}),
    ...failureDetails(node, instance.error ?? attempt?.error, instance.statusReason ?? attempt?.terminalReason),
    ...(node?.kind === "agent" ? { agent: agentDetails(ir, node, metadata, progress) } : {}),
    ...(node?.kind === "task" ? { task: { target: node.run.target.kind } } : {}),
    ...(node?.kind === "signal" ? { signal: {
      target: instance.nodeKey,
      ...(wait?.deadlineAt ? { deadlineAt: wait.deadlineAt } : {}),
      ...(wait?.renderedPrompt ? { promptPreview: boundedSummary(wait.renderedPrompt, 160) } : {}),
      ...(node.outputSchema ? { schemaSummary: compactSchemaSummary(node.outputSchema) } : {}),
    } } : {}),
  };
}

function projectTarget(
  ir: WorkflowIR,
  run: RunDetails,
  artifacts: ArtifactRecord[],
  staticNodes: RunInspectionStaticNode[],
  targetId: string,
  availableControls: readonly RunInspectionControl[],
): ResolvedTargetState | undefined {
  const dynamic = run.dynamic;
  const staticById = new Map(staticNodes.map(item => [item.nodeId, item]));
  const indexes = snapshotIndexes(run, staticNodes);
  const rootFrame = targetId === "root"
    ? dynamic?.frames.find(item => item.frameKind === "root")
    : undefined;
  const staticNode = staticNodes.find(item => item.nodeId === targetId);
  const exactInstance = dynamic?.nodeInstances.find(item => item.nodeKey === targetId);
  const exactFrame = rootFrame ?? dynamic?.frames.find(item => item.frameKey === targetId);
  const exactAttempt = dynamic?.attempts.find(item => item.attemptId === targetId);
  const targetPath = exactInstance?.instancePath
    ?? exactFrame?.instancePath
    ?? (exactAttempt
      ? dynamic?.nodeInstances.find(instance => instance.nodeKey === exactAttempt.nodeKey)?.instancePath
      : undefined);
  const targetRef = targetId === "root" || !targetPath ? undefined : deriveOccurrenceRef(targetPath);
  const target: RunInspectionTarget | undefined = exactAttempt ? { kind: "attempt", id: targetId, ...(targetRef ? { ref: targetRef } : {}) }
    : exactInstance ? { kind: "dynamic-node", id: targetId, ...(targetRef ? { ref: targetRef } : {}) }
      : targetId === "root" ? { kind: "frame", id: targetId, ...(targetRef ? { ref: targetRef } : {}) }
        : exactFrame ? { kind: "frame", id: targetId, ...(targetRef ? { ref: targetRef } : {}) }
        : staticNode ? { kind: "static-node", id: targetId }
          : undefined;
  if (!target) return undefined;
  const instances = dynamic?.nodeInstances.filter(item =>
    item.nodeKey === targetId || item.nodeId === targetId || item.nodeKey === exactAttempt?.nodeKey) ?? [];
  const instanceKeys = new Set(instances.map(item => item.nodeKey));
  const frames = dynamic?.frames.filter(item =>
    item.frameKey === targetId
      || item.nodeKey === targetId
      || item.nodeId === targetId
      || item.frameKey === exactFrame?.frameKey
      || targetId === "root" && item.frameKind === "root") ?? [];
  const attempts = dynamic?.attempts.filter(item =>
    item.attemptId === targetId || item.nodeKey === targetId || item.nodeId === targetId || instanceKeys.has(item.nodeKey)) ?? [];
  const attemptIds = new Set(attempts.map(item => item.attemptId));
  const signalWaits = dynamic?.signalWaits.filter(item =>
    item.nodeKey === targetId
      || instanceKeys.has(item.nodeKey)
      || item.nodeId === targetId) ?? [];
  const executionMetadata = dynamic?.executionMetadata.filter(item => item.attemptId !== undefined && attemptIds.has(item.attemptId)) ?? [];
  const progress = dynamic?.progress.filter(item => instanceKeys.has(item.nodeKey) || attemptIds.has(item.attemptId ?? "") || item.nodeId === targetId) ?? [];
  const targetKeys = new Set([targetId, ...instanceKeys, ...frames.map(item => item.frameKey), ...attempts.map(item => item.nodeKey)]);
  const targetArtifacts = artifacts.filter(item => targetKeys.has(item.nodeKey));
  const latestAttempt = exactAttempt ?? latestAttemptByNumber(attempts);
  const latestInstance = latest(instances, item => item.updatedAt);
  const latestFrame = latest(frames, item => item.updatedAt);
  const latestWait = latest(signalWaits, item => item.updatedAt);
  const resolvedStatic = staticNode ?? staticNodes.find(item => item.nodeId === latestInstance?.nodeId || item.nodeId === latestAttempt?.nodeId || item.nodeId === latestFrame?.nodeId);
  const node = resolvedStatic ? nodeById(ir, resolvedStatic.nodeId) : undefined;
  const metadata = latestAttempt
    ? latest(executionMetadata.filter(item => item.attemptId === latestAttempt.attemptId), item => item.createdAt)
    : latest(executionMetadata, item => item.createdAt);
  const currentProgress = latestAttempt
    ? latest(progress.filter(item => item.attemptId === latestAttempt.attemptId), item => item.updatedAt)
    : latest(progress, item => item.updatedAt);
  const turnArtifact = [...targetArtifacts]
    .filter(item => latestAttempt === undefined || item.attempt === latestAttempt.attemptNo)
    .sort((left, right) => left.path.localeCompare(right.path))
    .find(item => /^turn-\d+\.json$/.test(basename(item.path)));
  const authoredInput = node?.kind === "task" ? renderExpr(node.run.input) : undefined;
  const runtimeInput = record(metadata?.metadata)?.input as JsonValue | undefined;
  const loopProgress = summarizeLoopProgress(frames);
  const signalStatus = node?.kind === "signal" && (latestWait?.status === "awaiting" || latestWait?.status === "timed_out")
    ? latestWait.status
    : undefined;
  const staticStatuses = target.kind === "static-node" ? staticTargetStatuses(node, indexes, instances, frames) : [];
  const staticAggregate = staticStatuses.length > 1;
  const status = staticAggregate
    ? aggregateInspectionStatus(staticStatuses)
    : target.kind === "attempt"
      ? latestAttempt?.status ?? "not_started"
      : signalStatus ?? latestInstance?.status ?? latestAttempt?.status ?? latestFrame?.status ?? "not_started";
  const agent = node?.kind === "agent" ? agentDetails(ir, node, metadata, currentProgress) : undefined;
  const signal = node?.kind === "signal" ? {
    target: latestWait?.nodeKey ?? latestInstance?.nodeKey ?? targetId,
    ...(latestWait?.deadlineAt ? { deadlineAt: latestWait.deadlineAt } : {}),
    ...(latestWait?.renderedPrompt ? { promptPreview: latestWait.renderedPrompt } : {}),
    ...(node.outputSchema
      ? {
          outputSchema: node.outputSchema,
          schemaSummary: compactSchemaSummary(node.outputSchema),
        }
      : {}),
  } : undefined;
  const targetFailure = detailedFailure(
    node,
    target.kind === "attempt"
      ? latestAttempt?.error
      : latestInstance?.error ?? latestAttempt?.error ?? latestFrame?.error,
    target.kind === "attempt"
      ? latestAttempt?.cancelReason ?? latestAttempt?.terminalReason
      : latestInstance?.statusReason ?? latestAttempt?.terminalReason ?? latestFrame?.terminalReason,
  );
  const items = targetInspectionItems(ir, run, indexes, instances, frames, resolvedStatic, staticById);
  return {
    run: runSummary(ir, run, true),
    target,
    ...(resolvedStatic ? { staticNode: resolvedStatic } : {}),
    summary: {
      targetKind: target.kind,
      targetId,
      runStatus: run.status,
      runStartedAt: run.createdAt,
      ...(terminalRun(run.status) ? { runFinishedAt: run.updatedAt, runDurationMs: durationMs(run.createdAt, run.updatedAt) } : {}),
      ...(resolvedStatic ? { nodeId: resolvedStatic.nodeId, staticKind: resolvedStatic.kind, staticOrder: resolvedStatic.order } : {}),
      ...(!staticAggregate && latestInstance?.nodeKey ? { nodeKey: latestInstance.nodeKey } : !staticAggregate && latestAttempt?.nodeKey ? { nodeKey: latestAttempt.nodeKey } : {}),
      ...(!staticAggregate && latestFrame?.frameKey ? { frameKey: latestFrame.frameKey } : {}),
      nodeStatus: status,
      ...(staticAggregate ? { counts: inspectionStatusCounts(staticStatuses) } : {}),
      ...(!staticAggregate && runtimeInput !== undefined ? { input: { kind: "runtime", value: runtimeInput } } : !staticAggregate && authoredInput !== undefined ? { input: { kind: "authored", value: authoredInput } } : {}),
      ...(!staticAggregate && target.kind === "attempt" && latestAttempt?.result !== undefined
        ? { output: latestAttempt.result }
        : !staticAggregate && target.kind !== "attempt" && latestInstance?.output !== undefined
          ? { output: latestInstance.output }
          : !staticAggregate && latestAttempt?.result !== undefined
            ? { output: latestAttempt.result }
            : !staticAggregate && latestFrame?.result !== undefined
              ? { output: latestFrame.result }
              : {}),
      ...(!staticAggregate && targetFailure ? { failure: targetFailure } : {}),
      ...(!staticAggregate && latestWait?.renderedPrompt ? { prompt: { kind: "signal", text: latestWait.renderedPrompt } }
        : !staticAggregate && turnArtifact ? { prompt: { kind: "artifact", artifactId: turnArtifact.id, path: turnArtifact.path, ...(turnArtifact.mediaType ? { mediaType: turnArtifact.mediaType } : {}), field: "prompt" } }
          : !staticAggregate && (node?.kind === "agent" || node?.kind === "signal") ? { prompt: { kind: node.kind === "signal" ? "signal" : "authored", text: renderPromptExpr(node.run.prompt) } } : {}),
      ...(!staticAggregate && latestAttempt ? { latestAttempt: { attemptId: latestAttempt.attemptId, attemptNo: latestAttempt.attemptNo, status: latestAttempt.status, startedAt: latestAttempt.startedAt, ...(latestAttempt.finishedAt ? { finishedAt: latestAttempt.finishedAt } : {}), ...(latestAttempt.error !== undefined ? { error: latestAttempt.error } : {}), ...(latestAttempt.result !== undefined ? { result: latestAttempt.result } : {}) } } : {}),
      ...(!staticAggregate && loopProgress ? { loopProgress } : {}),
      ...(!staticAggregate && agent ? { agent } : {}),
      ...(!staticAggregate && node?.kind === "agent" && ir.agents[node.run.agent] ? { agentDefinition: ir.agents[node.run.agent] } : {}),
      ...(!staticAggregate && signal ? { signal } : {}),
      artifacts: targetArtifacts,
    },
    items,
    instances,
    frames,
    attempts,
    signalWaits,
    executionMetadata,
    progress,
    artifacts: targetArtifacts,
    availableControls: [...availableControls],
  };
}

function staticTargetStatuses(
  node: NodeIR | undefined,
  indexes: SnapshotIndexes,
  instances: RunDynamicNodeInstance[],
  frames: RunDynamicFrame[],
): RunInspectionStatus[] {
  if (!node) return [];
  if (instances.length > 0) return instances.map(item => indexedInstanceState(indexes, item).status);
  return frames
    .filter(item => item.nodeId === node.id && (item.frameKind === "node" || item.frameKind === "loop"))
    .map(item => normalizeInspectionStatus(item.status));
}

function targetInspectionItems(
  ir: WorkflowIR,
  run: RunDetails,
  indexes: SnapshotIndexes,
  instances: RunDynamicNodeInstance[],
  frames: RunDynamicFrame[],
  staticNode: RunInspectionStaticNode | undefined,
  staticById: Map<string, RunInspectionStaticNode>,
): RunInspectionItem<AgentInspectionState>[] {
  const nodesById = new Map(Array.from(walkNodes(ir.root), ({ node }) => [node.id, node]));
  const items = instances.map(instance => instanceItem(ir, instance, indexes, nodesById, staticById));
  const frameKeys = new Set(frames.map(frame => frame.frameKey));
  for (const frame of frames) {
    const node = frame.nodeId ? nodesById.get(frame.nodeId) : undefined;
    items.push({
      key: `frame:${frame.frameKey}`,
      role: "frame",
      ...(frame.parentFrameKey && frameKeys.has(frame.parentFrameKey) ? { parentKey: `frame:${frame.parentFrameKey}` } : {}),
      path: inspectionPath(frame.instancePath),
      label: frame.nodeId ?? frame.frameKey,
      kind: node?.kind ?? frame.frameKind,
      status: normalizeInspectionStatus(frame.status),
      ...(frame.nodeId ? { nodeId: frame.nodeId } : {}),
      ...(frame.instancePath ? { ref: deriveOccurrenceRef(frame.instancePath) } : {}),
      ...(frame.nodeKey ? { nodeKey: frame.nodeKey } : {}),
      frameKey: frame.frameKey,
      ...(frame.terminalReason ? { statusReason: frame.terminalReason } : {}),
      createdAt: frame.createdAt,
      updatedAt: frame.updatedAt,
      ...failureDetails(node, frame.error, frame.terminalReason),
      ...(node ? occurrenceCompositeDetails(indexes, node, frame) : {}),
    });
  }
  if (items.length > 0 || !staticNode) return items.sort((left, right) => left.key.localeCompare(right.key));

  const node = nodeById(ir, staticNode.nodeId);
  const progress = latest(run.dynamic?.progress.filter(item => item.nodeId === staticNode.nodeId) ?? [], item => item.updatedAt);
  const metadata = progress?.attemptId
    ? latest(run.dynamic?.executionMetadata.filter(item => item.attemptId === progress.attemptId) ?? [], item => item.createdAt)
    : undefined;
  return [{
    key: `static:${staticNode.nodeId}`,
    role: "static",
    path: staticNode.path,
    label: staticNode.nodeId,
    kind: staticNode.kind,
    status: aggregateInspectionStatus(relatedStatuses(run, staticNode.nodeId)),
    nodeId: staticNode.nodeId,
    ...(node?.kind === "agent" ? { agent: agentDetails(ir, node, metadata, progress) } : {}),
    ...(node ? compositeDetails(run, node) : {}),
  }];
}

function runSummary(ir: WorkflowIR, run: RunDetails, includeAgentUsage: boolean): RunInspectionRunSummary {
  const agentUsage = includeAgentUsage ? runAgentUsage(ir, run) : undefined;
  const rootFrame = run.status === "failed"
    ? run.dynamic?.frames.find(frame => frame.frameKind === "root")
    : undefined;
  return {
    id: run.id,
    name: run.name,
    status: run.status,
    workflowEntry: run.workflowEntry,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(terminalRun(run.status) ? { durationMs: durationMs(run.createdAt, run.updatedAt) } : {}),
    execution: run.execution,
    ...(rootFrame ? failureDetails(undefined, rootFrame.error, rootFrame.terminalReason) : {}),
    ...(run.fork ? { fork: run.fork } : {}),
    ...(agentUsage ? { agentUsage } : {}),
  };
}

function runAgentUsage(ir: WorkflowIR, run: RunDetails): NonNullable<RunInspectionRunSummary["agentUsage"]> | undefined {
  const agentNodeIds = new Set(Array.from(walkNodes(ir.root), ({ node }) => node.kind === "agent" ? node.id : undefined)
    .filter((nodeId): nodeId is string => nodeId !== undefined));
  if (agentNodeIds.size === 0) return undefined;
  const instances = run.dynamic?.nodeInstances.filter(item => agentNodeIds.has(item.nodeId)) ?? [];
  const attempts = run.dynamic?.attempts.filter(item => agentNodeIds.has(item.nodeId)) ?? [];
  const metadataByAttempt = new Map<string, RunExecutionMetadata>();
  for (const item of run.dynamic?.executionMetadata ?? []) {
    if (item.kind === "agent_attempt" && item.attemptId) metadataByAttempt.set(item.attemptId, item);
  }
  const progressByAttempt = new Map((run.dynamic?.progress ?? [])
    .filter(item => item.kind === "agent" && item.attemptId)
    .map(item => [item.attemptId!, item]));
  const turns = attempts.reduce((total, attempt) => {
    const metadata = record(metadataByAttempt.get(attempt.attemptId)?.metadata);
    const tools = record(progressByAttempt.get(attempt.attemptId)?.tools);
    return total + Math.max(number(metadata?.turnCount) ?? 0, number(tools?.turn) ?? 0);
  }, 0);
  return { instances: instances.length, attempts: attempts.length, turns };
}

function relatedStatuses(run: RunDetails, nodeId: string): RunInspectionStatus[] {
  return [
    ...(run.dynamic?.nodeInstances.filter(item => item.nodeId === nodeId).map(item => normalizeInspectionStatus(item.status)) ?? []),
    ...(run.dynamic?.frames.filter(item => item.nodeId === nodeId && (item.frameKind === "node" || item.frameKind === "loop")).map(item => normalizeInspectionStatus(item.status)) ?? []),
  ];
}

function compositeDetails(run: RunDetails, node: NodeIR, nodeKey?: string): Pick<RunInspectionItem, "composite"> | {} {
  if (!["if", "switch", "parallel", "fanout", "loop"].includes(node.kind)) return {};
  const groups = run.dynamic?.groups.filter(item => item.nodeId === node.id) ?? [];
  const group = (nodeKey ? groups.find(item => item.nodeKey === nodeKey) : undefined) ?? groups.at(-1);
  const matchingFrames = run.dynamic?.frames.filter(item => item.nodeId === node.id && (!nodeKey || item.nodeKey === nodeKey)) ?? [];
  const frame = latest(matchingFrames, item => item.updatedAt);
  const members = group ? run.dynamic?.groupMembers.filter(item => item.groupKey === group.groupKey) ?? [] : [];
  return {
    composite: {
      ...(group?.strategy ? { strategy: group.strategy } : node.kind === "parallel" || node.kind === "fanout" ? { strategy: node.strategy } : {}),
      ...(group?.quorumCount === undefined ? {} : { quorumCount: group.quorumCount }),
      ...(group?.maxConcurrency === undefined ? {} : { maxConcurrency: group.maxConcurrency }),
      ...(frame?.loop?.iter === undefined ? {} : { currentIteration: frame.loop.iter }),
      ...(members.length === 0 ? {} : { counts: inspectionStatusCounts(members.map(item => normalizeInspectionStatus(item.status))) }),
    },
  };
}

function agentDecisionState(
  node: Extract<NodeIR, { kind: "agent" }>,
  progress: RunNodeProgress | undefined,
): AgentDecisionState {
  const tools = record(progress?.tools);
  const calls = Array.isArray(tools?.lastCalls) ? tools.lastCalls : [];
  const activeCall = [...calls].reverse().map(record).find(call => {
    const status = string(call?.status);
    return call !== undefined && !["completed", "failed", "cancelled", "canceled"].includes(status ?? "");
  });
  const command = activeCall ? toolLabel(activeCall) : undefined;
  const status = activeCall ? string(activeCall.status) : undefined;
  const turn = number(tools?.turn);
  return {
    key: node.run.agent,
    ...(turn === undefined ? {} : { turn }),
    ...(command
      ? { activeTool: { command, ...(status ? { status: normalizeToolStatus(status) } : {}) } }
      : {}),
  };
}

function agentDetails(
  ir: WorkflowIR,
  node: Extract<NodeIR, { kind: "agent" }>,
  metadata: RunExecutionMetadata | undefined,
  progress: RunNodeProgress | undefined,
): AgentInspectionState {
  const configured = ir.agents[node.run.agent];
  const model = configured?.config?.model ?? configured?.model;
  const agentState = agentInspectionState(metadata, progress);
  return {
    key: node.run.agent,
    ...(configured?.kind === "agent_definition" ? { backend: { kind: "use" as const, name: configured.use } }
      : configured?.kind === "agent_command" ? { backend: { kind: "command" as const } }
        : {}),
    ...(model === undefined ? {} : { model }),
    ...agentState,
  };
}

function agentInspectionState(
  metadata: RunExecutionMetadata | undefined,
  progress: RunNodeProgress | undefined,
): Omit<AgentInspectionState, "key" | "backend" | "model"> {
  const data = record(metadata?.metadata);
  const tools = record(progress?.tools);
  const turnsData = Array.isArray(data?.turns) ? data.turns : [];
  const lastTurn = record(turnsData.at(-1));
  const turnSummary = record(lastTurn?.summary);
  const metadataContext = record(turnSummary?.context);
  const turns = [number(data?.turnCount), number(tools?.turn)].filter((value): value is number => value !== undefined);
  const turnCount = turns.length > 0 ? Math.max(...turns) : undefined;
  const stopReason = string(data?.stopReason) ?? string(turnSummary?.stopReason);
  const context = inspectionContext(progress?.context) ?? inspectionContext(turnSummary?.context);
  const tokenUsage = inspectionTokenUsage(progress?.tokenUsage) ?? inspectionTokenUsage(turnSummary?.tokenUsage);
  const persistedAvailability = inspectionAvailability(turnSummary?.availability);
  const availability = {
    context: context ? "available" as const : persistedAvailability?.context ?? "unavailable" as const,
    tokenUsage: tokenUsage?.totalTokens !== undefined
      ? "available" as const
      : tokenUsage
        ? "partial" as const
        : persistedAvailability?.tokenUsage ?? "unavailable" as const,
  };
  const lastObservedAt = [progress?.updatedAt, string(metadataContext?.updatedAt), metadata?.createdAt]
    .filter((value): value is string => value !== undefined)
    .sort()
    .at(-1);
  return {
    availability,
    ...(turnCount === undefined ? {} : { turnCount }),
    ...(lastObservedAt ? { lastObservedAt } : {}),
    ...(context ? { context } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
    ...(stopReason ? { stopReason } : {}),
  };
}

function inspectionAvailability(value: unknown): AgentInspectionState["availability"] | undefined {
  const data = record(value);
  const context = data?.context;
  const tokenUsage = data?.tokenUsage;
  if (context !== "available" && context !== "unavailable") return undefined;
  if (tokenUsage !== "available" && tokenUsage !== "partial" && tokenUsage !== "unavailable") return undefined;
  return { context, tokenUsage };
}

function inspectionContext(value: unknown): NonNullable<AgentInspectionState["context"]> | undefined {
  const data = record(value);
  const used = number(data?.used);
  const size = number(data?.size);
  return used === undefined || size === undefined ? undefined : { used, size };
}

function inspectionTokenUsage(value: unknown): NonNullable<AgentInspectionState["tokenUsage"]> | undefined {
  const data = record(value);
  const tokenUsage = {
    ...(number(data?.inputTokens) === undefined ? {} : { inputTokens: number(data?.inputTokens)! }),
    ...(number(data?.outputTokens) === undefined ? {} : { outputTokens: number(data?.outputTokens)! }),
    ...(number(data?.cachedReadTokens) === undefined ? {} : { cachedReadTokens: number(data?.cachedReadTokens)! }),
    ...(number(data?.cachedWriteTokens) === undefined ? {} : { cachedWriteTokens: number(data?.cachedWriteTokens)! }),
    ...(number(data?.thoughtTokens) === undefined ? {} : { thoughtTokens: number(data?.thoughtTokens)! }),
    ...(number(data?.totalTokens) === undefined ? {} : { totalTokens: number(data?.totalTokens)! }),
  };
  return Object.keys(tokenUsage).length > 0 ? tokenUsage : undefined;
}

function toolLabel(call: Record<string, unknown>): string | undefined {
  const toolName = string(call.toolName);
  const title = string(call.title);
  const kind = string(call.kind);
  const name = toolName ?? title ?? kind;
  if (!name) return undefined;
  const normalized = name.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  const characters = Array.from(normalized);
  return characters.length > 160 ? `${characters.slice(0, 159).join("").trimEnd()}…` : normalized;
}

function normalizeToolStatus(status: string): string {
  return status === "canceled" ? "cancelled" : status;
}

function failureDetails(node: NodeIR | undefined, error: unknown, statusReason?: string): Pick<RunInspectionItem, "failure"> | {} {
  const detailed = detailedFailure(node, error, statusReason);
  if (!detailed) return {};
  const upstream = detailed.upstream;
  if (!upstream) return { failure: detailed };
  const { data: _data, ...compactUpstream } = upstream;
  return { failure: { ...detailed, upstream: compactUpstream } };
}

function detailedFailure(node: NodeIR | undefined, error: unknown, statusReason?: string): RunInspectionDetailedFailure | undefined {
  if (error === undefined) return undefined;
  const value = record(error);
  const reasons = [statusReason, string(value?.reason)].filter((reason): reason is string => reason !== undefined);
  const explicitOrigin = string(value?.origin);
  const origin = explicitOrigin === "provider" || explicitOrigin === "runtime" || explicitOrigin === "scheduler" || explicitOrigin === "task" || explicitOrigin === "signal" || explicitOrigin === "unknown"
    ? explicitOrigin
    : reasons.some(schedulerFailureReason)
      ? "scheduler"
      : node?.kind === "agent" ? "provider" : node?.kind === "task" ? "task" : node?.kind === "signal" ? "signal" : "scheduler";
  const code = [string(value?.code), statusReason, string(value?.reason)].find(stableFailureCode);
  const upstream = record(value?.upstream);
  const protocol = record(upstream?.protocol);
  const protocolCode = string(protocol?.code) ?? number(protocol?.code);
  const upstreamData = isJsonValue(upstream?.data) ? upstream.data : undefined;
  const upstreamOperation = string(upstream?.operation);
  const upstreamExitCode = number(upstream?.exitCode);
  const upstreamCode = string(upstream?.code);
  const upstreamOrigin = string(upstream?.origin);
  const protocolMessage = string(protocol?.message);
  const failure: RunInspectionDetailedFailure = {
    origin,
    ...(code ? { code } : {}),
    message: string(value?.message) ?? string(value?.reason) ?? (typeof error === "string" ? error : "Target failed."),
    ...(upstream?.source === "acpx" ? {
      upstream: {
        source: "acpx",
        ...(upstreamOperation ? { operation: upstreamOperation } : {}),
        ...(upstreamExitCode === undefined ? {} : { exitCode: upstreamExitCode }),
        ...(upstreamCode ? { code: upstreamCode } : {}),
        ...(upstreamOrigin ? { origin: upstreamOrigin } : {}),
        ...(protocol?.name === "json-rpc" ? {
          protocol: {
            name: "json-rpc",
            ...(protocolCode === undefined ? {} : { code: protocolCode }),
            ...(protocolMessage ? { message: protocolMessage } : {}),
          },
        } : {}),
        ...(upstreamData === undefined ? {} : { data: upstreamData }),
      },
    } : {}),
  };
  return failure;
}

function schedulerFailureReason(reason: string): boolean {
  return schedulerFailureReasons.has(reason);
}

function stableFailureCode(value: string | undefined): value is string {
  return value !== undefined && /^[a-z][a-z0-9_.-]*$/i.test(value);
}

function boundedSummary(value: string, limit: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const characters = Array.from(normalized);
  return characters.length <= limit ? normalized : `${characters.slice(0, limit - 1).join("")}…`;
}

function aggregateInspectionStatus(statuses: RunInspectionStatus[]): RunInspectionStatus {
  if (statuses.length === 0) return "not_started";
  const unique = new Set(statuses);
  if (unique.size === 1) return statuses[0]!;
  for (const candidate of ["failed", "timed_out", "awaiting", "running", "ready", "starting", "pending"] as const) if (unique.has(candidate)) return candidate;
  return "mixed";
}

function inspectionStatusCounts(statuses: RunInspectionStatus[]): RunInspectionStatusCounts {
  const counts: RunInspectionStatusCounts = { total: statuses.length };
  const keys: Record<RunInspectionStatus, keyof RunInspectionStatusCounts> = {
    not_started: "notStarted", not_selected: "notSelected", pending: "pending", starting: "starting", ready: "ready", running: "running", awaiting: "awaiting", completed: "completed", failed: "failed", timed_out: "timedOut", cancelled: "cancelled", mixed: "mixed",
  };
  for (const status of statuses) {
    const key = keys[status];
    (counts[key] as number | undefined) = Number(counts[key] ?? 0) + 1;
  }
  return counts;
}

export function normalizeInspectionStatus(status: string): RunInspectionStatus {
  if (status === "canceled" || status === "cancelled" || status === "superseded") return "cancelled";
  if (status === "started") return "running";
  if (["not_started", "not_selected", "pending", "starting", "ready", "running", "awaiting", "completed", "failed", "timed_out", "mixed"].includes(status)) return status as RunInspectionStatus;
  return "mixed";
}

function terminalItem(status: RunInspectionStatus): boolean {
  return status === "completed" || status === "failed" || status === "timed_out" || status === "cancelled" || status === "not_selected";
}

function lastContextKey(path: RunDynamicNodeInstance["instancePath"]): string | undefined {
  const parts: string[] = [];
  for (const segment of path ?? []) {
    if (segment.kind === "node") continue;
    parts.push(segment.kind === "branch" ? `branch:${segment.nodeId}:${segment.branchId}` : segment.kind === "fanout" ? `fanout:${segment.nodeId}:${segment.itemIndex}` : `loop:${segment.nodeId}:${segment.iter}`);
  }
  return parts.length > 0 ? `context:${parts.join("/")}` : undefined;
}

function inspectionPath(path: RunDynamicNodeInstance["instancePath"]): string[] {
  return (path ?? []).map(segment => segment.kind === "node" ? segment.nodeId : segment.kind === "branch" ? `${segment.nodeId}.${segment.branchId}` : segment.kind === "fanout" ? `${segment.nodeId}[${segment.itemIndex}]` : `${segment.nodeId}#${segment.iter}`);
}

function nodeById(ir: WorkflowIR, nodeId: string): NodeIR | undefined {
  for (const visit of walkNodes(ir.root)) if (visit.node.id === nodeId) return visit.node;
  return undefined;
}

function summarizeLoopProgress(frames: RunDynamicFrame[]): ResolvedTargetState["summary"]["loopProgress"] | undefined {
  const frame = latest(frames.filter(item => item.frameKind === "loop" && item.loop), item => item.updatedAt);
  if (!frame?.loop) return undefined;
  const active = frames.find(item => item.frameKind === "loop_iteration" && item.instancePath?.some(segment => segment.kind === "loop" && segment.nodeId === frame.nodeId && segment.iter === frame.loop!.iter));
  return {
    frameKey: frame.frameKey,
    index: frame.loop.index,
    round: frame.loop.round,
    ...(frame.loop.state === undefined ? {} : { state: frame.loop.state }),
    ...(record(frame.loop.transition)?.stop === undefined ? {} : { stop: Boolean(record(frame.loop.transition)?.stop) }),
    ...(frame.loop.transition === undefined ? {} : { transition: frame.loop.transition }),
    ...(active?.frameKey ? { activeIterationFrameKey: active.frameKey } : {}),
    activeChildNodeKeys: Object.values(active?.scope ?? {}).sort(),
  };
}

type EventContext = {
  nodeId?: string;
  nodeKey?: string;
  frameKey?: string;
  frameKind?: string;
  attemptId?: string;
  path?: RunDynamicNodeInstance["instancePath"];
  repeated?: boolean;
};

function eventContext(
  event: CommittedRuntimeEventRow,
  frames: Map<string, RunDynamicFrame>,
  instances: Map<string, RunDynamicNodeInstance>,
  attempts: Map<string, RunDynamicAttempt>,
  occurrenceCounts: ReadonlyMap<string, number>,
): EventContext {
  const attemptId = string(event.payload.attemptId);
  const attempt = attemptId ? attempts.get(attemptId) : undefined;
  const frameKey = string(event.payload.frameKey);
  const frame = frameKey ? frames.get(frameKey) : undefined;
  const nodeKey = string(event.payload.nodeKey) ?? event.nodeKey ?? attempt?.nodeKey ?? frame?.nodeKey;
  const instance = nodeKey ? instances.get(nodeKey) : undefined;
  const nodeId = string(event.payload.nodeId) ?? instance?.nodeId ?? attempt?.nodeId ?? frame?.nodeId;
  const frameKind = frame?.frameKind ?? string(event.payload.frameKind);
  const occurrenceCount = nodeId ? occurrenceCounts.get(nodeId) ?? 0 : 0;
  return {
    ...(nodeId ? { nodeId } : {}),
    ...(nodeKey ? { nodeKey } : {}),
    ...(frameKey ? { frameKey } : {}),
    ...(frameKind ? { frameKind } : {}),
    ...(attemptId ? { attemptId } : {}),
    ...(instance?.instancePath ?? frame?.instancePath ? { path: instance?.instancePath ?? frame?.instancePath } : {}),
    ...(occurrenceCount > 0 ? { repeated: occurrenceCount > 1 } : {}),
  };
}

type EventVisibilityIndex = {
  byTypeAndNodeKey: Set<string>;
  retryStartsByNodeKey: Set<string>;
};

function eventVisibilityIndex(events: readonly CommittedRuntimeEventRow[]): EventVisibilityIndex {
  const byTypeAndNodeKey = new Set<string>();
  const retryStartsByNodeKey = new Set<string>();
  for (const event of events) {
    const nodeKey = string(event.payload.nodeKey) ?? event.nodeKey;
    if (!nodeKey) continue;
    byTypeAndNodeKey.add(`${event.type}\0${nodeKey}`);
    if (event.type === "attempt.started" && Number(event.payload.attemptNo ?? 1) > 1) retryStartsByNodeKey.add(nodeKey);
  }
  return { byTypeAndNodeKey, retryStartsByNodeKey };
}

function operatorVisibleEvent(event: CommittedRuntimeEventRow, context: EventContext, visibility: EventVisibilityIndex): boolean {
  const type = event.type;
  if (type.startsWith("group.") || type === "branch.decided") return false;
  if (type === "attempt.completed" || type === "attempt.cancelled") return false;
  if (type === "attempt.superseded" && event.payload.cancelReason === "operator_steered") return false;
  if (type === "instance.requeued" && event.payload.reason === "steered") return false;
  if (type === "attempt.started") return Number(event.payload.attemptNo ?? 1) > 1;
  if (type.startsWith("attempt.")) return true;
  if (type === "instance.awaiting" && matchingEvent(visibility, "signal.awaiting", context.nodeKey)) return false;
  if (type === "instance.completed" && matchingEvent(visibility, "signal.consumed", context.nodeKey)) return false;
  if ((type === "instance.started" || type === "instance.failed" || type === "instance.timed_out")
    && matchingAttemptEvent(visibility, context.nodeKey, type === "instance.started" ? "attempt.started" : type.replace("instance.", "attempt."))) return false;
  if (type.startsWith("instance.") || type.startsWith("signal.")) return true;
  if (type === "frame.loop_advanced") return context.frameKind === "loop";
  if (type.startsWith("frame.")) {
    const actionableScopeFailure = type === "frame.failed"
      && (context.frameKind === "branch" || context.frameKind === "fanout_item" || context.frameKind === "loop_iteration");
    return context.frameKey !== "root" && (context.frameKind === "node" || context.frameKind === "loop" || actionableScopeFailure);
  }
  return type.startsWith("run.") || type.startsWith("control.");
}

function matchingEvent(index: EventVisibilityIndex, type: string, nodeKey: string | undefined): boolean {
  return Boolean(nodeKey && index.byTypeAndNodeKey.has(`${type}\0${nodeKey}`));
}

function matchingAttemptEvent(index: EventVisibilityIndex, nodeKey: string | undefined, type: string): boolean {
  return Boolean(nodeKey && (type === "attempt.started"
    ? index.retryStartsByNodeKey.has(nodeKey)
    : index.byTypeAndNodeKey.has(`${type}\0${nodeKey}`)));
}

function eventSubject(
  document: Pick<RunInspectionSnapshot, "items" | "run"> | Pick<ResolvedTargetState, "items" | "run">,
  context: EventContext,
  item: RunInspectionItem | undefined,
  itemOccurrenceCounts: ReadonlyMap<string, number>,
): string {
  const path = context.path ? semanticPath(context.path) : item?.path.join(" › ");
  if (!context.nodeId) return path || item?.label || document.run.id;
  const itemOccurrences = itemOccurrenceCounts.get(context.nodeId) ?? 0;
  const subject = (context.repeated ?? itemOccurrences > 1) && path ? path : context.nodeId;
  return subject;
}

function semanticPath(path: RunDynamicNodeInstance["instancePath"]): string {
  return (path ?? []).map(segment => segment.kind === "node" ? segment.nodeId
    : segment.kind === "branch" ? `${segment.nodeId}.${segment.branchId}`
      : segment.kind === "fanout" ? `${segment.nodeId}[${segment.itemIndex}]`
        : `${segment.nodeId} round ${segment.iter + 1}`).join(" › ");
}

function eventEntity(event: CommittedRuntimeEventRow): RunInspectionChange["entity"] {
  const payload = event.payload;
  const id = string(payload.attemptId) ?? string(payload.frameKey) ?? string(payload.groupKey) ?? string(payload.memberKey) ?? string(payload.nodeKey) ?? event.nodeKey ?? event.runId;
  const kind = event.type.startsWith("attempt.") ? "attempt" : event.type.startsWith("frame.") ? "frame" : event.type.startsWith("group.member_") ? "group-member" : event.type.startsWith("group.") ? "group" : event.type.startsWith("signal.") ? "signal" : event.type.startsWith("control.") ? "control" : event.type.startsWith("instance.") ? "node" : "run";
  const nodeId = string(payload.nodeId);
  return { kind, id, ...(nodeId ? { nodeId } : {}) };
}

function eventAction(type: string): RunInspectionChange["action"] {
  if (type === "control.agent_steer_requested") return "steered";
  const suffix = type.split(".").at(-1);
  if (suffix === "ready") return "ready";
  if (suffix === "started") return "started";
  if (suffix === "awaiting") return "awaiting";
  if (suffix === "requeued") return "requeued";
  if (suffix === "retry_requested") return "retrying";
  if (suffix === "completed") return "completed";
  if (suffix === "failed") return "failed";
  if (suffix === "timed_out") return "timed_out";
  if (suffix === "cancelled" || suffix === "canceled") return "cancelled";
  if (suffix === "paused") return "paused";
  if (suffix === "resumed") return "resumed";
  if (suffix === "consumed") return "consumed";
  if (suffix === "loop_advanced") return "advanced";
  if (type === "run.admitted") return "admitted";
  return "updated";
}

function eventStatus(action: RunInspectionChange["action"]): RunInspectionStatus | undefined {
  if (action === "admitted" || action === "retrying") return "pending";
  if (action === "steered") return "ready";
  if (action === "ready" || action === "requeued") return "ready";
  if (action === "started" || action === "resumed" || action === "advanced") return "running";
  if (action === "awaiting") return "awaiting";
  if (action === "completed" || action === "consumed") return "completed";
  if (action === "failed") return "failed";
  if (action === "timed_out") return "timed_out";
  if (action === "cancelled") return "cancelled";
  return undefined;
}

function eventMessage(payload: Record<string, unknown>, action: RunInspectionChange["action"]): string | undefined {
  if (action === "steered") return undefined;
  const error = record(payload.error);
  const transition = record(payload.transition);
  return string(error?.message) ?? string(payload.message) ?? string(payload.statusReason) ?? string(payload.terminalReason) ?? string(payload.cancelReason) ?? string(payload.reason)
    ?? (action === "advanced" && typeof payload.iter === "number"
      ? `round=${payload.iter + 1} ${transition ? `completed${transition.stop === true ? " stop" : ""}` : "started"}`
      : undefined);
}

function renderExpr(expr: ExprIR): string {
  if (expr.kind === "literal") return renderLiteral(expr.value);
  if (expr.kind === "ref") return expr.path.join(".");
  if (expr.kind === "array") return `[${expr.items.map(renderExpr).join(", ")}]`;
  if (expr.kind === "object") return `{ ${Object.entries(expr.fields).map(([key, value]) => `${key}: ${renderExpr(value)}`).join(", ")} }`;
  if (expr.kind === "template") return `\`${renderTemplate(expr)}\``;
  return `${expr.fn}(${expr.args.map(renderExpr).join(", ")})`;
}

function renderPromptExpr(expr: ExprIR): string {
  if (expr.kind === "literal" && typeof expr.value === "string") return expr.value;
  if (expr.kind === "template") return renderTemplate(expr);
  return renderExpr(expr);
}

function renderTemplate(template: TemplateIR): string {
  return template.parts.map(part => part.kind === "text" ? part.value : `\${${renderExpr(part.expr)}}`).join("").replace(/\s+/g, " ").trim();
}

function renderLiteral(value: JsonPrimitive): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  return String(value);
}

function durationMs(start: string, end: string): number {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}

function latest<T>(items: T[], field: (item: T) => string | undefined): T | undefined {
  return [...items].sort((left, right) => (field(right) ?? "").localeCompare(field(left) ?? ""))[0];
}

function latestAttemptByNumber(attempts: RunDynamicAttempt[]): RunDynamicAttempt | undefined {
  return [...attempts].sort((left, right) =>
    right.attemptNo - left.attemptNo
      || right.startedAt.localeCompare(left.startedAt)
      || right.attemptId.localeCompare(left.attemptId))[0];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
