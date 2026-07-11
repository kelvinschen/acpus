import { childScopes, walkNodes, type ExprIR, type NodeIR, type SchemaIR, type ScopeIR, type WorkflowIR } from "@acpus/core/ir";
import type { JsonValue, TemplateIR } from "@acpus/expression/ir";
import type { CommittedRuntimeEventRow } from "../hooks/events.js";
import type {
  ArtifactRecord,
  RunDetails,
  RunDynamicAttempt,
  RunDynamicFrame,
  RunDynamicNodeInstance,
  RunExecutionMetadata,
  RunNodeProgress,
} from "../store/store.js";
import type {
  AgentInspectionState,
  RunInspectionAction,
  RunInspectionChange,
  RunInspectionContext,
  RunInspectionCursor,
  RunInspectionDocument,
  RunInspectionDetailedFailure,
  RunInspectionItem,
  RunInspectionQuery,
  RunInspectionRunSummary,
  RunInspectionSnapshot,
  RunInspectionStaticNode,
  RunInspectionStatus,
  RunInspectionStatusCounts,
  RunInspectionTarget,
  RunInspectionTargetDocument,
} from "./types.js";

const overviewContextLimit = 20;
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

export function projectRunInspection(input: {
  ir: WorkflowIR;
  run: RunDetails;
  artifacts: ArtifactRecord[];
  cursor: RunInspectionCursor;
  query: RunInspectionQuery;
}): RunInspectionDocument | undefined {
  if (input.query.mode === "raw") {
    return { schemaVersion: 1, kind: "raw", cursor: input.cursor, run: input.run, workflow: input.ir, artifacts: input.artifacts };
  }
  const staticNodes = inspectionStaticNodes(input.ir);
  if (input.query.mode === "target") {
    return projectTarget(input.ir, input.run, input.artifacts, input.cursor, staticNodes, input.query.target, input.query.context ?? []);
  }
  return projectSnapshot(input.ir, input.run, input.cursor, staticNodes, input.query.mode === "all");
}

export function semanticChanges(events: readonly CommittedRuntimeEventRow[], document: RunInspectionDocument, run?: RunDetails): RunInspectionChange[] {
  const items = inspectionItems(document);
  const itemByIdentity = new Map<string, RunInspectionItem>();
  const itemsByNodeId = new Map<string, RunInspectionItem[]>();
  for (const item of items) {
    for (const key of [item.nodeKey, item.frameKey, item.attemptId]) if (key) itemByIdentity.set(key, item);
    if (item.nodeId) itemsByNodeId.set(item.nodeId, [...(itemsByNodeId.get(item.nodeId) ?? []), item]);
  }
  const frames = new Map(run?.dynamic?.frames.map(frame => [frame.frameKey, frame]) ?? []);
  const instances = new Map(run?.dynamic?.nodeInstances.map(instance => [instance.nodeKey, instance]) ?? []);
  const attempts = new Map(run?.dynamic?.attempts.map(attempt => [attempt.attemptId, attempt]) ?? []);
  const contexts = new Map(events.map(event => [event.sequence, eventContext(event, frames, instances, attempts)]));
  return events.filter(event => operatorVisibleEvent(event, contexts.get(event.sequence)!, events)).map(event => {
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
      subject: eventSubject(document, context, action, item, itemsByNodeId),
      action,
      ...(status ? { status } : {}),
      ...(typeof event.payload.attemptNo === "number" ? { attemptNo: event.payload.attemptNo } : {}),
      ...(item ? { itemKey: item.key } : {}),
      ...(message ? { message } : {}),
    };
  });
}

export function progressChanges(previous: RunInspectionDocument, current: RunInspectionDocument): RunInspectionChange[] {
  if (current.cursor.progressVersion === previous.cursor.progressVersion) return [];
  const beforeItems = new Map(inspectionItems(previous).map(item => [item.key, item]));
  const afterItems = inspectionItems(current);
  const agentChanges = afterItems.filter(item => item.agent && meaningfulAgentProgressChanged(beforeItems.get(item.key)?.agent, item.agent));
  const changes: RunInspectionChange[] = agentChanges.map(item => ({
    at: item.agent!.lastActivityAt ?? item.updatedAt ?? current.run.updatedAt,
    entity: { kind: "progress", id: item.nodeKey ?? item.key, ...(item.nodeId ? { nodeId: item.nodeId } : {}) },
    subject: progressSubject(item, afterItems),
    action: "progress",
    status: item.status,
    ...(item.attemptNo === undefined ? {} : { attemptNo: item.attemptNo }),
    progressVersion: current.cursor.progressVersion,
    itemKey: item.key,
  }));
  if (current.kind !== "target") return changes;

  const previousProgress = new Map(previous.kind === "target" ? previous.progress.map(item => [item.nodeKey, item]) : []);
  const currentItemsByNodeKey = new Map(afterItems.flatMap(item => item.nodeKey ? [[item.nodeKey, item] as const] : []));
  for (const value of current.progress) {
    if (value.kind === "agent") continue;
    const before = previousProgress.get(value.nodeKey);
    if (before && JSON.stringify(progressState(before)) === JSON.stringify(progressState(value))) continue;
    const item = currentItemsByNodeKey.get(value.nodeKey);
    changes.push({
      at: value.updatedAt,
      entity: { kind: "progress", id: value.nodeKey, ...(value.nodeId ? { nodeId: value.nodeId } : {}) },
      subject: item ? progressSubject(item, afterItems) : value.nodeId || value.nodeKey,
      action: "progress",
      status: normalizeStatus(value.status),
      ...(value.attemptNo === undefined ? {} : { attemptNo: value.attemptNo }),
      progressVersion: current.cursor.progressVersion,
      ...(item ? { itemKey: item.key } : {}),
      ...(value.message ? { message: value.message } : {}),
    });
  }
  return changes;
}

export function inspectionItems(document: RunInspectionDocument): RunInspectionItem[] {
  return document.kind === "snapshot" || document.kind === "target" ? document.items : [];
}

export function meaningfulAgentProgressChanged(
  previous: RunInspectionItem["agent"] | undefined,
  current: NonNullable<RunInspectionItem["agent"]>,
): boolean {
  if (!previous) return true;
  const { lastActivityAt: _previousActivity, ...previousState } = previous;
  const { lastActivityAt: _currentActivity, ...currentState } = current;
  return JSON.stringify(previousState) !== JSON.stringify(currentState);
}

export type NormalizedAgentProgressState = {
  itemKey: string;
  nodeKey: string;
  nodeId: string;
  attemptId?: string;
  attemptNo?: number;
  status: RunInspectionStatus;
  message?: string;
  updatedAt: string;
  telemetry: Omit<AgentInspectionState, "key" | "backend" | "model">;
};

export function normalizedAgentProgressStates(run: RunDetails): NormalizedAgentProgressState[] {
  return (run.dynamic?.progress ?? []).filter(progress => progress.kind === "agent").map(progress => {
    const metadata = progress.attemptId
      ? latest(run.dynamic?.executionMetadata.filter(item => item.attemptId === progress.attemptId) ?? [], item => item.createdAt)
      : undefined;
    return {
      itemKey: `instance:${progress.nodeKey}`,
      nodeKey: progress.nodeKey,
      nodeId: progress.nodeId,
      ...(progress.attemptId ? { attemptId: progress.attemptId } : {}),
      ...(progress.attemptNo === undefined ? {} : { attemptNo: progress.attemptNo }),
      status: normalizeStatus(progress.status),
      ...(progress.message ? { message: progress.message } : {}),
      updatedAt: progress.updatedAt,
      telemetry: agentTelemetry(metadata, progress),
    };
  });
}

function progressSubject(item: RunInspectionItem, items: readonly RunInspectionItem[]): string {
  if (!item.nodeId) return item.nodeKey ?? item.key;
  const occurrences = items.filter(value => value.nodeId === item.nodeId && (value.role === "instance" || value.role === "frame"));
  return occurrences.length > 1 && item.path.length > 0 ? item.path.join(" › ") : item.nodeId;
}

function inspectionStaticNodes(ir: WorkflowIR): RunInspectionStaticNode[] {
  return Array.from(walkNodes(ir.root), ({ node, ancestry }, order) => ({
    nodeId: node.id,
    kind: node.kind,
    order,
    path: [...ancestry.map(item => item.owner.id), node.id],
    ...(ancestry.at(-1)?.owner.id ? { parentNodeId: ancestry.at(-1)!.owner.id } : {}),
    ...(node.kind === "task" ? { input: node.run.input } : {}),
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
  cursor: RunInspectionCursor,
  staticNodes: RunInspectionStaticNode[],
  all: boolean,
): RunInspectionSnapshot {
  const dynamic = run.dynamic;
  const instances = dynamic?.nodeInstances ?? [];
  const frames = dynamic?.frames ?? [];
  const attempts = dynamic?.attempts ?? [];
  const materialized = new Set([...instances.map(item => item.nodeId), ...frames.flatMap(item => item.nodeId ? [item.nodeId] : [])]);
  const branchMaterialized = new Set<string>();
  for (const item of [...instances, ...frames]) {
    for (const segment of item.instancePath ?? []) if (segment.kind === "branch") branchMaterialized.add(`${segment.nodeId}:${segment.branchId}`);
  }

  const structural = structuralItems(ir.root, run, staticNodes, materialized, branchMaterialized);
  const staticById = new Map(staticNodes.map(item => [item.nodeId, item]));
  const instanceStatuses = new Map(instances.map(instance => [instance.nodeKey, instanceInspectionState(run, instance, attempts).status]));
  const repeated = new Map<string, RunDynamicNodeInstance[]>();
  for (const instance of instances) {
    const key = `${instance.nodeId}:${instanceStatuses.get(instance.nodeKey)}`;
    const bucket = repeated.get(key) ?? [];
    bucket.push(instance);
    repeated.set(key, bucket);
  }
  const foldedKeys = new Set<string>();
  const foldItems: RunInspectionItem[] = [];
  if (!all) {
    for (const bucket of repeated.values()) {
      const status = instanceStatuses.get(bucket[0]!.nodeKey) ?? "mixed";
      if ((bucket.length <= 3 && instances.length <= overviewContextLimit) || !foldableStatus(status)) continue;
      for (const item of bucket) foldedKeys.add(item.nodeKey);
      const nodeId = bucket[0]!.nodeId;
      const parentNodeId = nearestCompositeParent(staticById.get(nodeId), staticById);
      foldItems.push({
        key: `fold:${nodeId}:${status}`,
        role: "fold",
        ...(parentNodeId ? { parentKey: `static:${parentNodeId}` } : {}),
        path: [...(parentNodeId ? staticById.get(parentNodeId)?.path ?? [parentNodeId] : []), `${nodeId}:${status}:${bucket.length}`],
        label: `${nodeId} ${status}`,
        kind: staticById.get(nodeId)?.kind ?? "node",
        status,
        nodeId,
        fold: { count: bucket.length, counts: statusCounts(bucket.map(item => instanceStatuses.get(item.nodeKey) ?? "mixed")) },
      });
    }
  }

  const candidates = instances.filter(item => !foldedKeys.has(item.nodeKey));
  const selected = all ? candidates : [...candidates]
    .sort((left, right) => priority(instanceStatuses.get(left.nodeKey) ?? "mixed") - priority(instanceStatuses.get(right.nodeKey) ?? "mixed")
      || (staticById.get(left.nodeId)?.order ?? Number.MAX_SAFE_INTEGER) - (staticById.get(right.nodeId)?.order ?? Number.MAX_SAFE_INTEGER)
      || pathKey(left.instancePath).localeCompare(pathKey(right.instancePath))
      || left.nodeKey.localeCompare(right.nodeKey))
    .slice(0, overviewContextLimit);
  const selectedKeys = new Set(selected.map(item => item.nodeKey));
  const omittedInstances = candidates.filter(item => !selectedKeys.has(item.nodeKey));
  const omittedKeys = new Set(omittedInstances.map(item => item.nodeKey));
  const omittedAgentTelemetry = dynamic?.progress.filter(item => item.kind === "agent" && omittedKeys.has(item.nodeKey)).length ?? 0;
  const contexts = contextItems(selected, frames);
  const instanceItems = selected.map(instance => instanceItem(ir, run, instance, attempts, staticById));
  const items = orderProjectionItems([...structural, ...contexts, ...instanceItems, ...foldItems], staticById);
  const executionStatuses = operatorVisibleExecutionStatuses(staticNodes, structural, instances, frames, instanceStatuses);
  const hiddenCount = omittedInstances.length;
  const hasFolds = foldItems.length > 0;
  const actions: RunInspectionAction[] = [];
  if (hiddenCount > 0 || hasFolds) actions.push({ kind: "inspect-all", omitted: hiddenCount + [...foldedKeys].length });
  for (const wait of dynamic?.signalWaits ?? []) {
    if (wait.status === "awaiting") {
      const outputSchema = staticById.get(wait.nodeId)?.outputSchema;
      actions.push({ kind: "signal", target: wait.nodeKey, ...(outputSchema ? { schemaSummary: compactSchemaSummary(outputSchema) } : {}) });
    }
  }
  for (const item of instanceItems) if (["failed", "timed_out", "awaiting"].includes(item.status)) actions.push({ kind: "inspect-target", target: item.nodeKey! });
  return {
    schemaVersion: 1,
    kind: "snapshot",
    cursor,
    run: runSummary(run),
    counts: statusCounts(executionStatuses),
    items,
    actions,
    ...(hiddenCount === 0 ? {} : {
      omitted: {
        reason: "context-limit",
        limit: overviewContextLimit,
        dynamicContexts: hiddenCount,
        counts: statusCounts(omittedInstances.map(item => instanceStatuses.get(item.nodeKey) ?? "mixed")),
        ...(omittedAgentTelemetry > 0 ? { agentTelemetry: { tracked: omittedAgentTelemetry } } : {}),
      },
    }),
    ...(terminalRun(run.status) && run.hooks.length > 0 ? { hooks: run.hooks } : {}),
    ...(terminalRun(run.status) && run.output !== undefined ? { output: run.output } : {}),
  };
}

function operatorVisibleExecutionStatuses(
  staticNodes: RunInspectionStaticNode[],
  structural: RunInspectionItem[],
  instances: RunDynamicNodeInstance[],
  frames: RunDynamicFrame[],
  instanceStatuses: ReadonlyMap<string, RunInspectionStatus>,
): RunInspectionStatus[] {
  const assertNodeIds = new Set(staticNodes.filter(node => node.kind === "assert").map(node => node.nodeId));
  const assertFrames = frames.filter(frame => frame.frameKind === "node" && frame.nodeId !== undefined && assertNodeIds.has(frame.nodeId));
  const materialized = new Set([...instances.map(instance => instance.nodeId), ...assertFrames.map(frame => frame.nodeId!)]);
  const staticItems = new Map(structural.flatMap(item => item.role === "static" && item.nodeId ? [[item.nodeId, item] as const] : []));
  const authoredLeaves = staticNodes.filter(node => ["agent", "task", "signal", "assert"].includes(node.kind) && !materialized.has(node.nodeId));
  return [
    ...instances.map(instance => instanceStatuses.get(instance.nodeKey) ?? "mixed"),
    ...assertFrames.map(frame => normalizeStatus(frame.status)),
    ...authoredLeaves.map(node => staticItems.get(node.nodeId)?.status ?? "not_selected"),
  ];
}

function nearestCompositeParent(node: RunInspectionStaticNode | undefined, staticById: Map<string, RunInspectionStaticNode>): string | undefined {
  for (const nodeId of [...(node?.path ?? [])].reverse().slice(1)) {
    const kind = staticById.get(nodeId)?.kind;
    if (kind && ["if", "switch", "parallel", "fanout", "loop"].includes(kind)) return nodeId;
  }
  return undefined;
}

function structuralItems(
  scope: ScopeIR,
  run: RunDetails,
  staticNodes: RunInspectionStaticNode[],
  materialized: Set<string>,
  branchMaterialized: Set<string>,
): RunInspectionItem[] {
  void staticNodes;
  const items: RunInspectionItem[] = [];
  const visit = (current: ScopeIR, parentKey?: string, path: string[] = []): void => {
    for (const node of current.nodes) {
      const key = `static:${node.id}`;
      const instanceLeaf = node.kind === "agent" || node.kind === "task" || node.kind === "signal";
      if (instanceLeaf && materialized.has(node.id)) continue;
      const related = relatedStatuses(run, node.id);
      const frame = latest(run.dynamic?.frames.filter(value => value.nodeId === node.id && (value.frameKind === "node" || value.frameKind === "loop")) ?? [], value => value.updatedAt);
      const status = related.length > 0
        ? aggregateStatus(related)
        : run.status === "pending" && Date.now() - Date.parse(run.createdAt) < 5_000
          ? "starting"
          : "not_started";
      const item: RunInspectionItem = {
        key,
        role: "static",
        ...(parentKey ? { parentKey } : {}),
        path: [...path, node.id],
        label: node.id,
        kind: node.kind,
        status,
        nodeId: node.id,
        ...(frame?.nodeKey ? { nodeKey: frame.nodeKey } : {}),
        ...(frame?.frameKey ? { frameKey: frame.frameKey } : {}),
        ...(frame?.createdAt ? { createdAt: frame.createdAt } : {}),
        ...(frame?.updatedAt ? { updatedAt: frame.updatedAt } : {}),
        ...(frame && terminalItem(normalizeStatus(frame.status)) ? { finishedAt: frame.updatedAt } : {}),
        ...(frame?.terminalReason ? { statusReason: frame.terminalReason } : {}),
        ...failureDetails(node, frame?.error, frame?.terminalReason),
        ...compositeDetails(run, node, frame?.nodeKey),
      };
      items.push(item);
      for (const child of childScopes(node)) {
        if (child.kind === "fanout" || child.kind === "loop") {
          visit(child.scope, key, [...path, node.id]);
          continue;
        }
        const branchKey = `branch:${node.id}:${child.branchId}`;
        const chosen = branchMaterialized.has(`${node.id}:${child.branchId}`);
        const branchDescendants = Array.from(walkNodes(child.scope), value => value.node.id);
        const branchStatus: RunInspectionStatus = chosen
          ? aggregateStatus(branchDescendants.flatMap(id => relatedStatuses(run, id)))
          : terminalRun(run.status) || relatedStatuses(run, node.id).some(terminalItem)
            ? "not_selected"
            : "not_started";
        if (!chosen) {
          items.push({
            key: branchKey,
            role: "context",
            parentKey: key,
            path: [...path, node.id, child.branchId],
            label: `branch ${child.branchId}`,
            kind: "branch",
            status: branchStatus,
            nodeId: node.id,
          });
          if (branchStatus === "not_selected") continue;
        }
        visit(child.scope, chosen ? key : branchKey, [...path, node.id, child.branchId]);
      }
    }
  };
  visit(scope);
  return items;
}

function contextItems(instances: RunDynamicNodeInstance[], frames: RunDynamicFrame[]): RunInspectionItem[] {
  const result = new Map<string, RunInspectionItem>();
  for (const instance of instances) {
    let parentKey: string | undefined;
    const keyParts: string[] = [];
    const displayPath: string[] = [];
    for (const segment of instance.instancePath ?? []) {
      if (segment.kind === "node") continue;
      const segmentId = segment.kind === "branch" ? `branch:${segment.nodeId}:${segment.branchId}`
        : segment.kind === "fanout" ? `fanout:${segment.nodeId}:${segment.itemIndex}`
          : `loop:${segment.nodeId}:${segment.iter}`;
      keyParts.push(segmentId);
      displayPath.push(segment.kind === "branch" ? `${segment.nodeId}.${segment.branchId}` : segment.kind === "fanout" ? `${segment.nodeId}[${segment.itemIndex}]` : `${segment.nodeId}#${segment.iter}`);
      const key = `context:${keyParts.join("/")}`;
      if (!result.has(key)) {
        const label = segment.kind === "branch" ? `${segment.nodeId} / branch ${segment.branchId}` : segment.kind === "fanout" ? `${segment.nodeId} / item ${segment.itemIndex}` : `${segment.nodeId} / round ${segment.iter + 1}`;
        const matching = frames.filter(frame => pathMatches(frame.instancePath, instance.instancePath?.filter((_, index) => index <= (instance.instancePath?.indexOf(segment) ?? -1)) ?? []));
        result.set(key, {
          key,
          role: "context",
          parentKey: parentKey ?? `static:${segment.nodeId}`,
          path: [...displayPath],
          label,
          kind: segment.kind === "fanout" ? "fanout_item" : segment.kind === "loop" ? "loop_iteration" : "branch",
          status: aggregateStatus(matching.map(frame => normalizeStatus(frame.status))),
          nodeId: segment.nodeId,
        });
      }
      parentKey = key;
    }
  }
  return [...result.values()];
}

function instanceItem(
  ir: WorkflowIR,
  run: RunDetails,
  instance: RunDynamicNodeInstance,
  attempts: RunDynamicAttempt[],
  staticById: Map<string, RunInspectionStaticNode>,
): RunInspectionItem {
  const node = nodeById(ir, instance.nodeId);
  const { attempt, wait, status } = instanceInspectionState(run, instance, attempts);
  const progress = latest(run.dynamic?.progress.filter(item => item.nodeKey === instance.nodeKey) ?? [], item => item.updatedAt);
  const metadata = latest(run.dynamic?.executionMetadata.filter(item => item.attemptId && item.attemptId === attempt?.attemptId) ?? [], item => item.createdAt);
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
    ...(node?.kind === "agent" ? { agent: agentDetails(ir, run, node, metadata, progress) } : {}),
    ...(node?.kind === "task" ? { task: { target: node.run.target.kind } } : {}),
    ...(node?.kind === "signal" ? { signal: {
      target: instance.nodeKey,
      ...(wait?.deadlineAt ? { deadlineAt: wait.deadlineAt } : {}),
      ...(wait?.renderedPrompt ? { promptPreview: boundedSummary(wait.renderedPrompt, 160) } : {}),
      ...(node.outputSchema ? { schemaSummary: compactSchemaSummary(node.outputSchema) } : {}),
    } } : {}),
  };
}

function instanceInspectionState(run: RunDetails, instance: RunDynamicNodeInstance, attempts: RunDynamicAttempt[]) {
  const relevantAttempts = attempts.filter(item => item.nodeKey === instance.nodeKey).sort((left, right) => right.attemptNo - left.attemptNo);
  const attempt = instance.acceptedAttemptId
    ? relevantAttempts.find(item => item.attemptId === instance.acceptedAttemptId) ?? relevantAttempts[0]
    : relevantAttempts[0];
  const wait = run.dynamic?.signalWaits.find(item => item.nodeKey === instance.nodeKey && item.status === "awaiting");
  return {
    attempt,
    wait,
    status: normalizeStatus(wait?.status ?? (attempt?.status === "timed_out" ? "timed_out" : instance.status)),
  };
}

function projectTarget(
  ir: WorkflowIR,
  run: RunDetails,
  artifacts: ArtifactRecord[],
  cursor: RunInspectionCursor,
  staticNodes: RunInspectionStaticNode[],
  targetId: string,
  context: RunInspectionContext,
): RunInspectionTargetDocument | undefined {
  const dynamic = run.dynamic;
  const staticById = new Map(staticNodes.map(item => [item.nodeId, item]));
  const staticNode = staticNodes.find(item => item.nodeId === targetId);
  const exactInstance = dynamic?.nodeInstances.find(item => item.nodeKey === targetId);
  const exactFrame = dynamic?.frames.find(item => item.frameKey === targetId);
  const exactAttempt = dynamic?.attempts.find(item => item.attemptId === targetId);
  const target: RunInspectionTarget | undefined = exactAttempt ? { kind: "attempt", id: targetId }
    : exactInstance ? { kind: "dynamic-node", id: targetId }
      : exactFrame ? { kind: "frame", id: targetId }
        : staticNode ? { kind: "static-node", id: targetId }
          : undefined;
  if (!target) return undefined;
  const scoped = context.length > 0;
  const instances = dynamic?.nodeInstances.filter(item =>
    (item.nodeKey === targetId || item.nodeId === targetId || item.nodeKey === exactAttempt?.nodeKey)
      && (!scoped || contextMatches(item.instancePath, context))) ?? [];
  const instanceKeys = new Set(instances.map(item => item.nodeKey));
  const frames = dynamic?.frames.filter(item =>
    (item.frameKey === targetId || item.nodeKey === targetId || item.nodeId === targetId || item.frameKey === exactFrame?.frameKey)
      && (!scoped || contextMatches(item.instancePath, context))) ?? [];
  const attempts = dynamic?.attempts.filter(item =>
    (item.attemptId === targetId || item.nodeKey === targetId || item.nodeId === targetId || instanceKeys.has(item.nodeKey))
      && (!scoped || instanceKeys.has(item.nodeKey))) ?? [];
  const attemptIds = new Set(attempts.map(item => item.attemptId));
  const signalWaits = dynamic?.signalWaits.filter(item => item.nodeKey === targetId || item.nodeId === targetId || instanceKeys.has(item.nodeKey)) ?? [];
  const executionMetadata = dynamic?.executionMetadata.filter(item => item.attemptId !== undefined && attemptIds.has(item.attemptId)) ?? [];
  const progress = dynamic?.progress.filter(item => instanceKeys.has(item.nodeKey) || attemptIds.has(item.attemptId ?? "") || (!scoped && item.nodeId === targetId)) ?? [];
  const targetKeys = new Set([targetId, ...instanceKeys, ...frames.map(item => item.frameKey), ...attempts.map(item => item.nodeKey)]);
  const targetArtifacts = artifacts.filter(item => targetKeys.has(item.nodeKey));
  const latestAttempt = latest(attempts, item => item.startedAt);
  const latestInstance = latest(instances, item => item.updatedAt);
  const latestFrame = latest(frames, item => item.updatedAt);
  const latestWait = latest(signalWaits, item => item.updatedAt);
  const resolvedStatic = staticNode ?? staticNodes.find(item => item.nodeId === latestInstance?.nodeId || item.nodeId === latestAttempt?.nodeId || item.nodeId === latestFrame?.nodeId);
  const node = resolvedStatic ? nodeById(ir, resolvedStatic.nodeId) : undefined;
  const metadata = latest(executionMetadata, item => item.createdAt);
  const currentProgress = latest(progress, item => item.updatedAt);
  const promptArtifact = targetArtifacts.find(item => item.relativePath.endsWith("prompt.md")) ?? targetArtifacts.find(item => item.relativePath.includes("/prompt."));
  const authoredInput = node?.kind === "task" ? Object.fromEntries(Object.entries(node.run.input).map(([key, expr]) => [key, renderExpr(expr)])) : undefined;
  const runtimeInput = record(metadata?.metadata)?.input;
  const loopProgress = summarizeLoopProgress(frames);
  const status = latestInstance?.status ?? latestAttempt?.status ?? latestFrame?.status ?? "not_started";
  const agent = node?.kind === "agent" ? agentDetails(ir, run, node, metadata, currentProgress) : undefined;
  const signal = node?.kind === "signal" ? {
    target: latestWait?.nodeKey ?? latestInstance?.nodeKey ?? targetId,
    ...(latestWait?.deadlineAt ? { deadlineAt: latestWait.deadlineAt } : {}),
    ...(latestWait?.renderedPrompt ? { promptPreview: latestWait.renderedPrompt } : {}),
    ...(node.outputSchema ? { outputSchema: node.outputSchema } : {}),
  } : undefined;
  const targetFailure = detailedFailure(
    node,
    latestInstance?.error ?? latestAttempt?.error ?? latestFrame?.error,
    latestInstance?.statusReason ?? latestAttempt?.terminalReason ?? latestFrame?.terminalReason,
  );
  const items = targetInspectionItems(ir, run, instances, frames, attempts, resolvedStatic, staticById);
  return {
    schemaVersion: 1,
    kind: "target",
    cursor,
    run: runSummary(run),
    target,
    ...(resolvedStatic ? { staticNode: resolvedStatic } : {}),
    summary: {
      targetKind: target.kind,
      targetId,
      runStatus: run.status,
      runStartedAt: run.createdAt,
      ...(terminalRun(run.status) ? { runFinishedAt: run.updatedAt, runDurationMs: durationMs(run.createdAt, run.updatedAt) } : {}),
      ...(resolvedStatic ? { nodeId: resolvedStatic.nodeId, staticKind: resolvedStatic.kind, staticOrder: resolvedStatic.order } : {}),
      ...(latestInstance?.nodeKey ? { nodeKey: latestInstance.nodeKey } : latestAttempt?.nodeKey ? { nodeKey: latestAttempt.nodeKey } : {}),
      ...(latestFrame?.frameKey ? { frameKey: latestFrame.frameKey } : {}),
      nodeStatus: status,
      ...(runtimeInput !== undefined ? { input: { kind: "runtime", value: runtimeInput } } : authoredInput !== undefined ? { input: { kind: "authored", value: authoredInput } } : {}),
      ...(latestInstance?.output !== undefined ? { output: latestInstance.output } : latestAttempt?.result !== undefined ? { output: latestAttempt.result } : latestFrame?.result !== undefined ? { output: latestFrame.result } : {}),
      ...(targetFailure ? { failure: targetFailure } : {}),
      ...(latestWait?.renderedPrompt ? { prompt: { kind: "signal", text: latestWait.renderedPrompt } }
        : promptArtifact ? { prompt: { kind: "artifact", artifactId: promptArtifact.id, relativePath: promptArtifact.relativePath, ...(promptArtifact.mediaType ? { mediaType: promptArtifact.mediaType } : {}) } }
          : node?.kind === "agent" || node?.kind === "signal" ? { prompt: { kind: node.kind === "signal" ? "signal" : "authored", text: renderPromptExpr(node.run.prompt) } } : {}),
      ...(latestAttempt ? { latestAttempt: { attemptId: latestAttempt.attemptId, attemptNo: latestAttempt.attemptNo, status: latestAttempt.status, startedAt: latestAttempt.startedAt, ...(latestAttempt.finishedAt ? { finishedAt: latestAttempt.finishedAt } : {}), ...(latestAttempt.error !== undefined ? { error: latestAttempt.error } : {}), ...(latestAttempt.result !== undefined ? { result: latestAttempt.result } : {}) } } : {}),
      ...(loopProgress ? { loopProgress } : {}),
      ...(agent ? { agent } : {}),
      ...(node?.kind === "agent" && ir.agents[node.run.agent] ? { agentDefinition: ir.agents[node.run.agent] } : {}),
      ...(signal ? { signal } : {}),
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
  };
}

function targetInspectionItems(
  ir: WorkflowIR,
  run: RunDetails,
  instances: RunDynamicNodeInstance[],
  frames: RunDynamicFrame[],
  attempts: RunDynamicAttempt[],
  staticNode: RunInspectionStaticNode | undefined,
  staticById: Map<string, RunInspectionStaticNode>,
): RunInspectionItem[] {
  const items = instances.map(instance => instanceItem(ir, run, instance, attempts, staticById));
  const frameKeys = new Set(frames.map(frame => frame.frameKey));
  for (const frame of frames) {
    const node = frame.nodeId ? nodeById(ir, frame.nodeId) : undefined;
    items.push({
      key: `frame:${frame.frameKey}`,
      role: "frame",
      ...(frame.parentFrameKey && frameKeys.has(frame.parentFrameKey) ? { parentKey: `frame:${frame.parentFrameKey}` } : {}),
      path: inspectionPath(frame.instancePath),
      label: frame.nodeId ?? frame.frameKey,
      kind: node?.kind ?? frame.frameKind,
      status: normalizeStatus(frame.status),
      ...(frame.nodeId ? { nodeId: frame.nodeId } : {}),
      ...(frame.nodeKey ? { nodeKey: frame.nodeKey } : {}),
      frameKey: frame.frameKey,
      ...(frame.terminalReason ? { statusReason: frame.terminalReason } : {}),
      createdAt: frame.createdAt,
      updatedAt: frame.updatedAt,
      ...failureDetails(node, frame.error, frame.terminalReason),
      ...(node ? compositeDetails(run, node, frame.nodeKey) : {}),
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
    status: aggregateStatus(relatedStatuses(run, staticNode.nodeId)),
    nodeId: staticNode.nodeId,
    ...(node?.kind === "agent" ? { agent: agentDetails(ir, run, node, metadata, progress) } : {}),
    ...(node ? compositeDetails(run, node) : {}),
  }];
}

function runSummary(run: RunDetails): RunInspectionRunSummary {
  return {
    id: run.id,
    name: run.name,
    status: run.status,
    workflowEntry: run.workflowEntry,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(terminalRun(run.status) ? { durationMs: durationMs(run.createdAt, run.updatedAt) } : {}),
    execution: run.execution,
  };
}

function relatedStatuses(run: RunDetails, nodeId: string): RunInspectionStatus[] {
  return [
    ...(run.dynamic?.nodeInstances.filter(item => item.nodeId === nodeId).map(item => normalizeStatus(item.status)) ?? []),
    ...(run.dynamic?.frames.filter(item => item.nodeId === nodeId && (item.frameKind === "node" || item.frameKind === "loop")).map(item => normalizeStatus(item.status)) ?? []),
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
      ...(members.length === 0 ? {} : { counts: statusCounts(members.map(item => normalizeStatus(item.status))) }),
    },
  };
}

function agentDetails(
  ir: WorkflowIR,
  run: RunDetails,
  node: Extract<NodeIR, { kind: "agent" }>,
  metadata: RunExecutionMetadata | undefined,
  progress: RunNodeProgress | undefined,
): NonNullable<RunInspectionItem["agent"]> {
  void run;
  const configured = ir.agents[node.run.agent];
  const telemetry = agentTelemetry(metadata, progress);
  return {
    key: node.run.agent,
    ...(configured?.kind === "agent_definition" ? { backend: { kind: "use" as const, name: configured.use } }
      : configured?.kind === "agent_command" ? { backend: { kind: "command" as const } }
        : {}),
    ...(configured?.model ? { model: configured.model } : {}),
    ...telemetry,
  };
}

function agentTelemetry(
  metadata: RunExecutionMetadata | undefined,
  progress: RunNodeProgress | undefined,
): Omit<AgentInspectionState, "key" | "backend" | "model"> {
  const data = record(metadata?.metadata);
  const tools = record(progress?.tools);
  const turnsData = Array.isArray(data?.turns) ? data.turns : [];
  const lastTurn = record(turnsData.at(-1));
  const turnTelemetry = record(lastTurn?.telemetry);
  const metadataTools = record(turnTelemetry?.tools);
  const metadataContext = record(turnTelemetry?.context);
  const turns = [number(data?.turnCount), number(tools?.turn)].filter((value): value is number => value !== undefined);
  const turnCount = turns.length > 0 ? Math.max(...turns) : undefined;
  const recentTools = Array.isArray(tools?.lastCalls)
    ? tools.lastCalls.slice(-3).flatMap(value => {
      const call = record(value);
      if (!call) return [];
      const command = normalizedToolCommand(call);
      if (!command) return [];
      const status = string(call.status);
      return [{ command, ...(status ? { status: normalizeToolStatus(status) } : {}) }];
    })
    : [];
  const toolCallCount = number(tools?.totalToolCallCount) ?? number(metadataTools?.totalToolCallCount);
  const stopReason = string(data?.stopReason) ?? string(turnTelemetry?.stopReason);
  const context = inspectionContext(progress?.context) ?? inspectionContext(turnTelemetry?.context);
  const tokenUsage = inspectionTokenUsage(progress?.tokenUsage) ?? inspectionTokenUsage(turnTelemetry?.tokenUsage);
  const lastActivityAt = [progress?.updatedAt, string(metadataContext?.updatedAt), metadata?.createdAt]
    .filter((value): value is string => value !== undefined)
    .sort()
    .at(-1);
  return {
    ...(turnCount === undefined ? {} : { turnCount }),
    ...(lastActivityAt ? { lastActivityAt } : {}),
    ...(context ? { context } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
    ...(toolCallCount === undefined && recentTools.length === 0 ? {} : { tools: { totalCallCount: toolCallCount ?? recentTools.length, recent: recentTools } }),
    ...(stopReason ? { stopReason } : {}),
  };
}

function inspectionContext(value: unknown): NonNullable<NonNullable<RunInspectionItem["agent"]>["context"]> | undefined {
  const data = record(value);
  const used = number(data?.used);
  const size = number(data?.size);
  return used === undefined || size === undefined ? undefined : { used, size };
}

function inspectionTokenUsage(value: unknown): NonNullable<NonNullable<RunInspectionItem["agent"]>["tokenUsage"]> | undefined {
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

function normalizedToolCommand(call: Record<string, unknown>): string | undefined {
  const toolName = string(call.toolName);
  const kind = string(call.kind);
  const title = string(call.title);
  const name = toolName ?? kind ?? title;
  if (!name) return undefined;
  const shell = shellToolName(name);
  if (!shell) return truncateToolCommand(name);
  const executable = shellExecutable(string(call.inputPreview));
  return truncateToolCommand(executable ? `${shell}: ${executable}` : shell);
}

function shellToolName(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "bash") return "Bash";
  if (normalized === "shell") return "Shell";
  if (normalized === "terminal") return "Terminal";
  return undefined;
}

function shellExecutable(preview: string | undefined): string | undefined {
  if (!preview) return undefined;
  let input: Record<string, unknown> | undefined;
  try {
    input = record(JSON.parse(preview));
  } catch {
    return undefined;
  }
  const command = string(input?.cmd) ?? string(input?.command);
  if (!command) return undefined;
  const words = shellWords(command);
  if (!words) return undefined;
  let index = 0;
  while (index < words.length) {
    while (shellAssignment(words[index])) index += 1;
    const candidate = words[index];
    if (!candidate) return undefined;
    const basename = executableBasename(candidate);
    if (basename !== "env" && basename !== "sudo") return basename;
    const next = skipWrapperOptions(words, index + 1, basename);
    if (next === undefined) return undefined;
    index = next;
  }
  return undefined;
}

function shellWords(value: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (const character of value.trim()) {
    if (escaped) {
      word += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else word += character;
    } else if (character === "'" || character === "\"") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (word) words.push(word);
      word = "";
    } else {
      word += character;
    }
  }
  if (quote || escaped) return undefined;
  if (word) words.push(word);
  return words;
}

function shellAssignment(value: string | undefined): boolean {
  return Boolean(value && /^[A-Za-z_][A-Za-z0-9_]*=/.test(value));
}

function skipWrapperOptions(words: string[], start: number, wrapper: "env" | "sudo"): number | undefined {
  const optionsWithValue = wrapper === "env"
    ? new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"])
    : new Set(["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--close-from", "-R", "--chroot", "-D", "--chdir"]);
  const optionsWithoutValue = wrapper === "env"
    ? new Set(["-i", "--ignore-environment", "-0", "--null"])
    : new Set(["-n", "--non-interactive", "-E", "--preserve-env", "-H", "--set-home", "-S", "--stdin", "-b", "--background", "-k", "-K"]);
  let index = start;
  while (words[index]?.startsWith("-")) {
    const option = words[index]!;
    if (option === "--") return index + 1;
    const exact = option.split("=", 1)[0]!;
    if (optionsWithValue.has(exact)) {
      index += option.includes("=") || /^-[A-Za-z].+/.test(option) ? 1 : 2;
      continue;
    }
    if (!optionsWithoutValue.has(option)) return undefined;
    index += 1;
  }
  return index;
}

function executableBasename(value: string): string | undefined {
  if (!value || /[;&|<>$`(){}]/.test(value)) return undefined;
  const basename = value.split("/").filter(Boolean).at(-1);
  return basename && basename !== "." && basename !== ".." ? basename : undefined;
}

function truncateToolCommand(value: string): string | undefined {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  const words = normalized.split(" ");
  const selected = words.slice(0, 3).join(" ");
  const characters = Array.from(selected);
  const truncated = words.length > 3 || Array.from(normalized).length > 32;
  return truncated ? `${characters.slice(0, 31).join("").trimEnd()}…` : selected;
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
  const origin = explicitOrigin === "provider" || explicitOrigin === "scheduler" || explicitOrigin === "task" || explicitOrigin === "signal" || explicitOrigin === "unknown"
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
    message: string(value?.message) ?? string(value?.reason) ?? (typeof error === "string" ? error : JSON.stringify(error)),
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

function compactSchemaSummary(schema: SchemaIR): string {
  return boundedSummary(schemaSummary(schema), 160);
}

function schemaSummary(schema: SchemaIR): string {
  if (schema.kind === "array") return `${schemaSummary(schema.item)}[]`;
  if (schema.kind === "union") return schema.variants.map(schemaSummary).join(" | ");
  if (schema.kind === "literal") return JSON.stringify(schema.value);
  if (schema.kind === "enum") return schema.values.map(value => JSON.stringify(value)).join(" | ");
  if (schema.kind === "record") return `record<${schemaSummary(schema.value)}>`;
  if (schema.kind !== "object") return schema.kind;
  const required = new Set(schema.required);
  return `{ ${Object.entries(schema.fields).map(([name, field]) => `${name}: ${schemaSummary(field)}${required.has(name) ? "" : "?"}`).join(", ")} }`;
}

function boundedSummary(value: string, limit: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const characters = Array.from(normalized);
  return characters.length <= limit ? normalized : `${characters.slice(0, limit - 1).join("")}…`;
}

function aggregateStatus(statuses: RunInspectionStatus[]): RunInspectionStatus {
  if (statuses.length === 0) return "not_started";
  const unique = new Set(statuses);
  if (unique.size === 1) return statuses[0]!;
  for (const candidate of ["failed", "timed_out", "awaiting", "running", "ready", "starting", "pending"] as const) if (unique.has(candidate)) return candidate;
  return "mixed";
}

function statusCounts(statuses: RunInspectionStatus[]): RunInspectionStatusCounts {
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

function normalizeStatus(status: string): RunInspectionStatus {
  if (status === "canceled" || status === "cancelled" || status === "superseded") return "cancelled";
  if (status === "started") return "running";
  if (["not_started", "not_selected", "pending", "starting", "ready", "running", "awaiting", "completed", "failed", "timed_out", "mixed"].includes(status)) return status as RunInspectionStatus;
  return "mixed";
}

function priority(status: RunInspectionStatus): number {
  return ({ failed: 0, timed_out: 1, awaiting: 2, running: 3, ready: 4, starting: 5, pending: 6, mixed: 7, completed: 8, cancelled: 9, not_selected: 10, not_started: 11 })[status];
}

function terminalItem(status: RunInspectionStatus): boolean {
  return status === "completed" || status === "failed" || status === "timed_out" || status === "cancelled" || status === "not_selected";
}

function foldableStatus(status: RunInspectionStatus): boolean {
  return status === "completed" || status === "cancelled";
}

function orderProjectionItems(items: RunInspectionItem[], staticById: Map<string, RunInspectionStaticNode>): RunInspectionItem[] {
  void staticById;
  const rank = new Map(items.map((item, index) => [item.key, index]));
  const byKey = new Map(items.map(item => [item.key, item]));
  const children = new Map<string, RunInspectionItem[]>();
  const roots: RunInspectionItem[] = [];
  for (const item of items) {
    if (!item.parentKey || !byKey.has(item.parentKey)) roots.push(item);
    else {
      const bucket = children.get(item.parentKey) ?? [];
      bucket.push(item);
      children.set(item.parentKey, bucket);
    }
  }
  const ordered: RunInspectionItem[] = [];
  const visit = (item: RunInspectionItem): void => {
    ordered.push(item);
    for (const child of (children.get(item.key) ?? []).sort((left, right) => rank.get(left.key)! - rank.get(right.key)!)) visit(child);
  };
  for (const root of roots.sort((left, right) => rank.get(left.key)! - rank.get(right.key)!)) visit(root);
  return ordered;
}

function lastContextKey(path: RunDynamicNodeInstance["instancePath"]): string | undefined {
  const parts: string[] = [];
  for (const segment of path ?? []) {
    if (segment.kind === "node") continue;
    parts.push(segment.kind === "branch" ? `branch:${segment.nodeId}:${segment.branchId}` : segment.kind === "fanout" ? `fanout:${segment.nodeId}:${segment.itemIndex}` : `loop:${segment.nodeId}:${segment.iter}`);
  }
  return parts.length > 0 ? `context:${parts.join("/")}` : undefined;
}

function pathKey(path: RunDynamicNodeInstance["instancePath"]): string {
  return inspectionPath(path).join("/");
}

function inspectionPath(path: RunDynamicNodeInstance["instancePath"]): string[] {
  return (path ?? []).map(segment => segment.kind === "node" ? segment.nodeId : segment.kind === "branch" ? `${segment.nodeId}.${segment.branchId}` : segment.kind === "fanout" ? `${segment.nodeId}[${segment.itemIndex}]` : `${segment.nodeId}#${segment.iter}`);
}

function contextMatches(path: RunDynamicNodeInstance["instancePath"], context: RunInspectionContext): boolean {
  return context.every(selection => path?.some(segment => selection.kind === "fanout"
    ? segment.kind === "fanout" && segment.nodeId === selection.nodeId && segment.itemIndex === selection.itemIndex
    : segment.kind === "loop" && segment.nodeId === selection.nodeId && segment.iter === selection.iteration));
}

function pathMatches(left: RunDynamicFrame["instancePath"], right: RunDynamicNodeInstance["instancePath"]): boolean {
  if (!left || !right) return false;
  return right.every((segment, index) => JSON.stringify(left[index]) === JSON.stringify(segment));
}

function nodeById(ir: WorkflowIR, nodeId: string): NodeIR | undefined {
  for (const visit of walkNodes(ir.root)) if (visit.node.id === nodeId) return visit.node;
  return undefined;
}

function summarizeLoopProgress(frames: RunDynamicFrame[]): RunInspectionTargetDocument["summary"]["loopProgress"] | undefined {
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
): EventContext {
  const attemptId = string(event.payload.attemptId);
  const attempt = attemptId ? attempts.get(attemptId) : undefined;
  const frameKey = string(event.payload.frameKey);
  const frame = frameKey ? frames.get(frameKey) : undefined;
  const nodeKey = string(event.payload.nodeKey) ?? event.nodeKey ?? attempt?.nodeKey ?? frame?.nodeKey;
  const instance = nodeKey ? instances.get(nodeKey) : undefined;
  const nodeId = string(event.payload.nodeId) ?? instance?.nodeId ?? attempt?.nodeId ?? frame?.nodeId;
  const frameKind = frame?.frameKind ?? string(event.payload.frameKind);
  const occurrenceCount = nodeId ? [
    ...[...instances.values()].filter(value => value.nodeId === nodeId),
    ...[...frames.values()].filter(value => value.nodeId === nodeId && (value.frameKind === "node" || value.frameKind === "loop")),
  ].length : 0;
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

function operatorVisibleEvent(event: CommittedRuntimeEventRow, context: EventContext, events: readonly CommittedRuntimeEventRow[]): boolean {
  const type = event.type;
  if (type.startsWith("group.") || type === "branch.decided") return false;
  if (type === "attempt.completed" || type === "attempt.cancelled") return false;
  if (type === "attempt.started") return Number(event.payload.attemptNo ?? 1) > 1;
  if (type.startsWith("attempt.")) return true;
  if (type === "instance.awaiting" && matchingEvent(events, "signal.awaiting", context.nodeKey)) return false;
  if (type === "instance.completed" && matchingEvent(events, "signal.consumed", context.nodeKey)) return false;
  if ((type === "instance.started" || type === "instance.failed" || type === "instance.timed_out")
    && matchingAttemptEvent(events, context.nodeKey, type === "instance.started" ? "attempt.started" : type.replace("instance.", "attempt."))) return false;
  if (type.startsWith("instance.") || type.startsWith("signal.")) return true;
  if (type === "frame.loop_advanced") return context.frameKind === "loop";
  if (type.startsWith("frame.")) return context.frameKey !== "root" && (context.frameKind === "node" || context.frameKind === "loop");
  return type.startsWith("run.") || type.startsWith("control.");
}

function matchingEvent(events: readonly CommittedRuntimeEventRow[], type: string, nodeKey: string | undefined): boolean {
  return Boolean(nodeKey && events.some(event => event.type === type && (string(event.payload.nodeKey) ?? event.nodeKey) === nodeKey));
}

function matchingAttemptEvent(events: readonly CommittedRuntimeEventRow[], nodeKey: string | undefined, type: string): boolean {
  return Boolean(nodeKey && events.some(event => event.type === type
    && (string(event.payload.nodeKey) ?? event.nodeKey) === nodeKey
    && (type !== "attempt.started" || Number(event.payload.attemptNo ?? 1) > 1)));
}

function eventSubject(
  document: RunInspectionDocument,
  context: EventContext,
  action: RunInspectionChange["action"],
  item: RunInspectionItem | undefined,
  itemsByNodeId: Map<string, RunInspectionItem[]>,
): string {
  if (!context.nodeId) return context.nodeKey ?? context.frameKey ?? document.run.id;
  const itemOccurrences = itemsByNodeId.get(context.nodeId)?.filter(value => value.role === "instance" || value.role === "frame").length ?? 0;
  const path = context.path ? semanticPath(context.path) : item?.path.join(" › ");
  const subject = (context.repeated ?? itemOccurrences > 1) && path ? path : context.nodeId;
  const actionable = action === "awaiting" || action === "failed" || action === "timed_out" || action === "retrying" || action === "requeued";
  return actionable && context.nodeKey && context.nodeKey !== subject ? `${subject} (${context.nodeKey})` : subject;
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
  const error = record(payload.error);
  const transition = record(payload.transition);
  return string(error?.message) ?? string(payload.message) ?? string(payload.statusReason) ?? string(payload.terminalReason) ?? string(payload.cancelReason) ?? string(payload.reason)
    ?? (action === "advanced" && typeof payload.iter === "number"
      ? `round=${payload.iter + 1} ${transition ? `completed${transition.stop === true ? " stop" : ""}` : "started"}`
      : undefined);
}

function progressState(progress: RunNodeProgress): Pick<RunNodeProgress, "status" | "message" | "attemptNo"> {
  return {
    status: progress.status,
    ...(progress.message ? { message: progress.message } : {}),
    ...(progress.attemptNo === undefined ? {} : { attemptNo: progress.attemptNo }),
  };
}

function renderExpr(expr: ExprIR): string {
  if (expr.kind === "literal") return renderLiteral(expr.value);
  if (expr.kind === "ref") return expr.path.join(".");
  if (expr.kind === "array") return `[${expr.items.map(renderExpr).join(", ")}]`;
  if (expr.kind === "object") return `{ ${Object.entries(expr.fields).map(([key, value]) => `${key}: ${renderExpr(value)}`).join(", ")} }`;
  if (expr.kind === "template") return `\`${renderTemplate(expr.template)}\``;
  return `${expr.fn}(${expr.args.map(renderExpr).join(", ")})`;
}

function renderPromptExpr(expr: ExprIR): string {
  if (expr.kind === "literal" && typeof expr.value === "string") return expr.value;
  if (expr.kind === "template") return renderTemplate(expr.template);
  return renderExpr(expr);
}

function renderTemplate(template: TemplateIR): string {
  return template.parts.map(part => part.kind === "text" ? part.value : `\${${renderExpr(part.expr)}}`).join("").replace(/\s+/g, " ").trim();
}

function renderLiteral(value: JsonValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(renderLiteral).join(", ")}]`;
  if (typeof value === "object") return `{ ${Object.entries(value).map(([key, item]) => `${key}: ${renderLiteral(item)}`).join(", ")} }`;
  return String(value);
}

function durationMs(start: string, end: string): number {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}

function latest<T>(items: T[], field: (item: T) => string | undefined): T | undefined {
  return [...items].sort((left, right) => (field(right) ?? "").localeCompare(field(left) ?? ""))[0];
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

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return Boolean(value && typeof value === "object" && Object.values(value).every(isJsonValue));
}
