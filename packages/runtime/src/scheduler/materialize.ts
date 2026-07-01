import type { FanoutNodeIR, LoopNodeIR, NodeIR, ParallelNodeIR, WorkflowIR } from "@acpus/core/ir";
import type { JsonObject, JsonValue } from "@acpus/expression/ir";
import { evaluateExpr, renderTemplate, type EvaluationScope } from "../evaluation/evaluator.js";
import { appendBranch, appendFanoutItem, appendLoopIteration, appendNode, deriveInstanceKey } from "./identity.js";
import type { SchedulerEvent } from "./events.js";
import type { GroupMember, InstancePath, SchedulerProjection } from "./types.js";
import { nextLoopStep } from "./transitions.js";

export function bootstrapRootEvents(runId: string, ir: WorkflowIR, scope: EvaluationScope = {}): SchedulerEvent[] {
  const first = ir.root.nodes[0];
  const firstEvents = first ? materializeRootNodeEvents(runId, first, scope, 1) : [];
  const firstNodeKey = first ? materializedRootNodeKey(first, firstEvents) : undefined;
  const events: SchedulerEvent[] = [
    {
      type: "frame.started",
      payload: {
        runId,
        frameKey: "root",
        frameKind: "root",
        scope: firstNodeKey && first ? { [first.id]: firstNodeKey } : {},
      },
    },
  ];
  return [...events, ...firstEvents];
}

export function continueRootEvents(ir: WorkflowIR, projection: SchedulerProjection, scope: EvaluationScope = {}): SchedulerEvent[] {
  const rootTerminal = rootTerminalEvents(ir, projection, scope);
  if (rootTerminal.length > 0) return rootTerminal;

  const nodeScope = rootNodeScope(ir, projection, scope);
  const compositeFrameEvents = continueCompositeFrameEvents(ir, projection, nodeScope);
  if (compositeFrameEvents.length > 0) return compositeFrameEvents;

  const loopEvents = continueRootLoopEvents(ir, projection, nodeScope);
  if (loopEvents.length > 0) return loopEvents;

  return materializeNextRootNodeEvents(ir, projection, scope);
}

function continueCompositeFrameEvents(ir: WorkflowIR, projection: SchedulerProjection, scope: EvaluationScope): SchedulerEvent[] {
  for (const frame of Object.values(projection.frames).filter(frame => frame.status === "running")) {
    const frameScope = compositeFrameScope(ir, projection, frame, scope);
    if (!frameScope) continue;
    const member = projection.groupMembers[frame.frameKey];
    if (member?.status === "cancelled") return [{ type: "frame.cancelled", payload: { frameKey: frame.frameKey, cancelReason: member.terminalReason === "quorum_reached" ? "quorum_reached" : member.terminalReason === "race_lost" ? "race_lost" : "parent_failed" } }];
    const events = continueSequentialFrameEvents(frameScope, projection);
    if (events.length > 0) return events;
  }
  return [];
}

function continueSequentialFrameEvents(input: {
  runId: string;
  frameKey: string;
  nodes: readonly NodeIR[];
  outputs: WorkflowIR["root"]["outputs"];
  basePath: InstancePath;
  scope: EvaluationScope;
  member?: GroupMember;
} , projection: SchedulerProjection): SchedulerEvent[] {
  const completedNodes: Record<string, { status: string; output?: unknown }> = {};
  for (let index = 0; index < input.nodes.length; index += 1) {
    const node = input.nodes[index]!;
    const nodePath = appendNode(input.basePath, node.id);
    const nodeKey = deriveInstanceKey(nodePath);
    const instance = projection.instances[nodeKey];
    if (!instance) {
      return schedulerLeafEvents({
        runId: input.runId,
        node,
        nodeKey,
        instancePath: nodePath,
        parentFrameKey: input.frameKey,
        readinessSequence: nextFrameReadiness(input.member, index),
      });
    }
    if (instance.status === "failed") return terminalFrameMemberEvents(input, "failed", instance.error ?? { reason: "node_failed" }, instance.statusReason ?? "node_failed");
    if (instance.status === "cancelled") return terminalFrameMemberEvents(input, "cancelled", undefined, instance.statusReason ?? "parent_failed");
    if (instance.status !== "completed") return [];
    completedNodes[node.id] = { status: "completed", output: instance.output };
  }
  const result = evaluateOutputs(input.outputs ?? {}, {
    ...input.scope,
    nodes: {
      ...input.scope.nodes,
      ...completedNodes,
    },
  });
  const events: SchedulerEvent[] = [
    { type: "frame.completed", payload: { frameKey: input.frameKey, result, terminalReason: "frame_completed" } },
  ];
  if (input.member && (input.member.status === "ready" || input.member.status === "running")) {
    events.push({
      type: "group.member_completed",
      payload: {
        memberKey: input.member.memberKey,
        completionSequence: nextCompletionSequence(projection),
        output: result,
      },
    });
  }
  return events;
}

function continueRootLoopEvents(ir: WorkflowIR, projection: SchedulerProjection, scope: EvaluationScope): SchedulerEvent[] {
  const loop = ir.root.nodes.find(node => node.kind === "loop" && isSupportedRootLoop(node) && projection.frames[deriveInstanceKey(appendNode([], node.id))]?.status === "running") as LoopNodeIR | undefined;
  if (!loop) return [];
  const loopKey = deriveInstanceKey(appendNode([], loop.id));
  const frame = projection.frames[loopKey];
  if (!frame || frame.status !== "running") return [];
  const iter = frame.loop?.iter ?? 0;
  const result = currentLoopIterationResult(loop, projection, iter, scope);
  if (result.status === "running") return [];
  if (result.status === "failed") return [{ type: "frame.failed", payload: { frameKey: loopKey, error: result.error, terminalReason: result.terminalReason } }];
  if (result.status === "cancelled") return [{ type: "frame.cancelled", payload: { frameKey: loopKey, cancelReason: result.cancelReason } }];

  const previous = frame.loop?.previous;
  const iterationScope: EvaluationScope = {
    ...scope,
    loop: {
      ...scope.loop,
      [loop.id]: {
        iter,
        ...(previous === undefined ? {} : { previous }),
      },
    },
  };
  const loopScope: EvaluationScope = {
    ...iterationScope,
    loop: {
      ...iterationScope.loop,
      [loop.id]: {
        iter,
        ...(previous === undefined ? {} : { previous }),
        result: result.output,
      },
    },
  };
  const stop = evaluateExpr(loop.stopWhen, loopScope);
  if (typeof stop !== "boolean") throw new Error(`Loop node '${loop.id}' condition must evaluate to boolean.`);
  const step = nextLoopStep({
    iter,
    maxIterations: loop.maxIterations,
    stop,
    result: result.output,
    ...(previous === undefined ? {} : { previous }),
    ...(loop.onExhausted === undefined ? {} : { onExhausted: loop.onExhausted }),
  });
  const events: SchedulerEvent[] = [
    {
      type: "frame.loop_advanced",
      payload: {
        frameKey: loopKey,
        iter,
        ...(previous === undefined ? {} : { previous }),
        result: result.output,
      },
    },
  ];
  if (step.action === "complete") {
    events.push({ type: "frame.completed", payload: { frameKey: loopKey, result: step.output, terminalReason: step.terminalReason } });
    return events;
  }
  if (step.action === "fail") {
    events.push({ type: "frame.failed", payload: { frameKey: loopKey, error: step.error, terminalReason: step.terminalReason } });
    return events;
  }
  if (loopIterationStarted(loop, projection, step.iter)) return [];
  events.push(
    {
      type: "frame.loop_advanced",
      payload: {
        frameKey: loopKey,
        iter: step.iter,
        ...(step.previous === undefined ? {} : { previous: step.previous }),
      },
    },
    ...materializeLoopIterationEvents(projection.run.runId, loop, step.iter, step.iter + 1),
  );
  return events;
}

function loopIterationStarted(loop: LoopNodeIR, projection: SchedulerProjection, iter: number): boolean {
  const iterationPath = appendLoopIteration([], loop.id, iter);
  if (loop.do.nodes.length > 1) return projection.frames[deriveInstanceKey(iterationPath)] !== undefined;
  const leaf = loop.do.nodes[0];
  return leaf ? projection.instances[deriveInstanceKey(appendNode(iterationPath, leaf.id))] !== undefined : false;
}

function currentLoopIterationResult(loop: LoopNodeIR, projection: SchedulerProjection, iter: number, scope: EvaluationScope):
  | { status: "running" }
  | { status: "completed"; output: JsonValue }
  | { status: "failed"; error: JsonObject; terminalReason: string }
  | { status: "cancelled"; cancelReason: "parent_failed" | "race_lost" | "quorum_reached" | "paused" | "superseded" } {
  if (loop.do.nodes.length === 1) {
    const leaf = loop.do.nodes[0]!;
    const currentPath = appendNode(appendLoopIteration([], loop.id, iter), leaf.id);
    const current = projection.instances[deriveInstanceKey(currentPath)];
    if (current?.status === "failed") return { status: "failed", error: current.error ?? { reason: "node_failed" }, terminalReason: current.statusReason ?? "node_failed" };
    if (current?.status === "cancelled") return { status: "cancelled", cancelReason: cancellationReason(current.statusReason ?? "parent_failed") };
    if (current?.status !== "completed") return { status: "running" };
    const iterationScope: EvaluationScope = {
      ...scope,
      nodes: { ...scope.nodes, [leaf.id]: { status: "completed", output: current.output } },
    };
    return { status: "completed", output: evaluateOutputs(loop.do.outputs ?? {}, iterationScope) };
  }
  const iterationFrame = projection.frames[deriveInstanceKey(appendLoopIteration([], loop.id, iter))];
  if (iterationFrame?.status === "failed") return { status: "failed", error: iterationFrame.error ?? { reason: "iteration_failed" }, terminalReason: iterationFrame.terminalReason ?? "iteration_failed" };
  if (iterationFrame?.status === "cancelled") return { status: "cancelled", cancelReason: cancellationReason(iterationFrame.terminalReason ?? "parent_failed") };
  if (iterationFrame?.status !== "completed") return { status: "running" };
  return { status: "completed", output: iterationFrame.result ?? {} };
}

function materializeNextRootNodeEvents(ir: WorkflowIR, projection: SchedulerProjection, scope: EvaluationScope): SchedulerEvent[] {
  const root = projection.frames.root;
  if (!root || root.status !== "running") return [];
  for (let index = 0; index < ir.root.nodes.length; index += 1) {
    const node = ir.root.nodes[index]!;
    const status = rootNodeStatus(node, projection);
    if (status === "completed") continue;
    if (status === "running" || status === "failed" || status === "cancelled") return [];
    return materializeRootNodeEvents(projection.run.runId, node, rootNodeScope(ir, projection, scope), index + 1);
  }
  return [];
}

function rootTerminalEvents(ir: WorkflowIR, projection: SchedulerProjection, scope: EvaluationScope): SchedulerEvent[] {
  const root = projection.frames.root;
  if (!root || root.status !== "running") return [];
  const first = ir.root.nodes[0];
  if (!first) return [{ type: "frame.completed", payload: { frameKey: "root", result: evaluateOutputs(ir.outputs, scope), terminalReason: "root_completed" } }];
  const nodeScope = rootNodeScope(ir, projection, scope);

  for (const node of ir.root.nodes) {
    const events = rootNodeTerminalEvents(node, projection, nodeScope);
    if (events.length > 0) return events;
  }

  if (ir.root.nodes.every(node => rootNodeStatus(node, projection) === "completed")) {
    return [{ type: "frame.completed", payload: { frameKey: "root", result: evaluateOutputs(ir.outputs, nodeScope), terminalReason: "root_completed" } }];
  }
  return [];
}

function rootNodeTerminalEvents(node: NodeIR, projection: SchedulerProjection, scope: EvaluationScope): SchedulerEvent[] {
  const nodeKey = deriveInstanceKey(appendNode([], node.id));
  if (isSchedulerLeaf(node)) {
    const instance = projection.instances[nodeKey];
    if (instance?.status === "failed") return [{ type: "frame.failed", payload: { frameKey: "root", error: instance.error ?? { reason: "node_failed" }, terminalReason: instance.statusReason ?? "node_failed" } }];
    if (instance?.status === "cancelled") return [{ type: "frame.cancelled", payload: { frameKey: "root", cancelReason: "parent_failed" } }];
    return [];
  }

  const frame = projection.frames[nodeKey];
  if (frame?.status === "failed") return [{ type: "frame.failed", payload: { frameKey: "root", error: frame.error ?? { reason: "frame_failed" }, terminalReason: frame.terminalReason ?? "frame_failed" } }];
  if (frame?.status === "cancelled") return [{ type: "frame.cancelled", payload: { frameKey: "root", cancelReason: "parent_failed" } }];
  if (frame?.status === "completed") return [];
  if ((node.kind === "if" || node.kind === "switch") && frame?.status === "running") return conditionalTerminalEvents(node, projection, scope);

  const group = projection.groups[nodeKey];
  if (group?.status === "completed") {
    const result = compositeGroupResult(node, group.result, projection, scope);
    return [{ type: "frame.completed", payload: { frameKey: nodeKey, ...(result === undefined ? {} : { result }), terminalReason: "group_completed" } }];
  }
  if (group?.status === "failed") {
    const error = group.error ?? { reason: "group_failed" };
    return [
      { type: "frame.failed", payload: { frameKey: nodeKey, error, terminalReason: "group_failed" } },
      { type: "frame.failed", payload: { frameKey: "root", error, terminalReason: "group_failed" } },
    ];
  }
  if (group?.status === "cancelled") {
    return [
      { type: "frame.cancelled", payload: { frameKey: nodeKey, cancelReason: "parent_failed" } },
      { type: "frame.cancelled", payload: { frameKey: "root", cancelReason: "parent_failed" } },
    ];
  }
  return [];
}

function rootNodeStatus(node: NodeIR, projection: SchedulerProjection): "not_started" | "running" | "completed" | "failed" | "cancelled" {
  const nodeKey = deriveInstanceKey(appendNode([], node.id));
  if (isSchedulerLeaf(node)) {
    const status = projection.instances[nodeKey]?.status;
    if (!status) return "not_started";
    return status === "pending" || status === "ready" || status === "awaiting" ? "running" : status;
  }
  const frame = projection.frames[nodeKey];
  if (frame) return frame.status === "ready" || frame.status === "awaiting" ? "running" : frame.status;
  return projection.groups[nodeKey] ? "running" : "not_started";
}

function rootNodeScope(ir: WorkflowIR, projection: SchedulerProjection, scope: EvaluationScope): EvaluationScope {
  const nodes: Record<string, { status?: string; output?: unknown }> = { ...scope.nodes };
  for (const node of ir.root.nodes) {
    const key = deriveInstanceKey(appendNode([], node.id));
    const instance = projection.instances[key];
    const frame = projection.frames[key];
    if (instance?.status === "completed") nodes[node.id] = { status: "completed", output: instance.output };
    else if (frame?.status === "completed") nodes[node.id] = { status: "completed", output: frame.result };
  }
  return { ...scope, nodes };
}

function compositeFrameScope(
  ir: WorkflowIR,
  projection: SchedulerProjection,
  frame: SchedulerProjection["frames"][string],
  scope: EvaluationScope,
): {
  runId: string;
  frameKey: string;
  nodes: readonly NodeIR[];
  outputs: WorkflowIR["root"]["outputs"];
  basePath: InstancePath;
  scope: EvaluationScope;
  member?: GroupMember;
} | undefined {
  const path = frame.instancePath;
  const segment = path?.[path.length - 1];
  if (!path || !segment) return undefined;
  if (frame.frameKind === "branch" && segment.kind === "branch") {
    const parallel = ir.root.nodes.find((node): node is ParallelNodeIR => node.kind === "parallel" && node.id === segment.nodeId);
    const branch = parallel?.branches[segment.branchId];
    if (branch && isSupportedSequentialScope(branch.scope)) {
      return {
        runId: projection.run.runId,
        frameKey: frame.frameKey,
        nodes: branch.scope.nodes,
        outputs: branch.scope.outputs,
        basePath: path,
        scope,
        ...(projection.groupMembers[frame.frameKey] ? { member: projection.groupMembers[frame.frameKey] } : {}),
      };
    }
    const conditional = ir.root.nodes.find((node): node is Extract<NodeIR, { kind: "if" | "switch" }> => (node.kind === "if" || node.kind === "switch") && node.id === segment.nodeId);
    const selected = conditional ? conditionalBranchById(conditional, segment.branchId) : undefined;
    if (!selected || !isSupportedSequentialScope(selected.scope)) return undefined;
    return {
      runId: projection.run.runId,
      frameKey: frame.frameKey,
      nodes: selected.scope.nodes,
      outputs: selected.scope.outputs,
      basePath: path,
      scope,
    };
  }
  if (frame.frameKind === "fanout_item" && segment.kind === "fanout") {
    const fanout = ir.root.nodes.find((node): node is FanoutNodeIR => node.kind === "fanout" && node.id === segment.nodeId);
    if (!fanout || !isSupportedSequentialScope(fanout.do)) return undefined;
    const member = projection.groupMembers[frame.frameKey];
    return {
      runId: projection.run.runId,
      frameKey: frame.frameKey,
      nodes: fanout.do.nodes,
      outputs: fanout.do.outputs,
      basePath: path,
      scope: {
        ...scope,
        fanout: {
          ...scope.fanout,
          [fanout.id]: {
            item: member?.item,
            itemIndex: segment.itemIndex,
          },
        },
      },
      ...(member ? { member } : {}),
    };
  }
  if (frame.frameKind === "loop_iteration" && segment.kind === "loop") {
    const loop = ir.root.nodes.find((node): node is LoopNodeIR => node.kind === "loop" && node.id === segment.nodeId);
    if (!loop || loop.do.nodes.length <= 1 || !isSupportedSequentialScope(loop.do)) return undefined;
    const loopFrame = projection.frames[deriveInstanceKey(appendNode([], loop.id))];
    return {
      runId: projection.run.runId,
      frameKey: frame.frameKey,
      nodes: loop.do.nodes,
      outputs: loop.do.outputs,
      basePath: path,
      scope: {
        ...scope,
        loop: {
          ...scope.loop,
          [loop.id]: {
            iter: segment.iter,
            ...(loopFrame?.loop?.previous === undefined ? {} : { previous: loopFrame.loop.previous }),
          },
        },
      },
    };
  }
  return undefined;
}

function terminalFrameMemberEvents(
  input: { frameKey: string; member?: GroupMember },
  status: "failed" | "cancelled",
  error: JsonObject | undefined,
  reason: string,
): SchedulerEvent[] {
  const cancelReason = cancellationReason(reason);
  const events: SchedulerEvent[] = status === "failed"
    ? [{ type: "frame.failed", payload: { frameKey: input.frameKey, error: error ?? { reason }, terminalReason: reason } }]
    : [{ type: "frame.cancelled", payload: { frameKey: input.frameKey, cancelReason } }];
  if (input.member && (input.member.status === "ready" || input.member.status === "running")) {
    events.push(status === "failed"
      ? { type: "group.member_failed", payload: { memberKey: input.member.memberKey, error: error ?? { reason }, terminalReason: reason } }
      : { type: "group.member_cancelled", payload: { memberKey: input.member.memberKey, cancelReason } });
  }
  return events;
}

function cancellationReason(reason: string): "parent_failed" | "race_lost" | "quorum_reached" | "paused" | "superseded" {
  return reason === "race_lost" || reason === "quorum_reached" || reason === "paused" || reason === "superseded"
    ? reason
    : "parent_failed";
}

function nextFrameReadiness(member: GroupMember | undefined, index: number): number {
  return (member?.readinessSequence ?? 0) + index + 1;
}

function nextCompletionSequence(projection: SchedulerProjection): number {
  return Math.max(0, ...Object.values(projection.groupMembers).map(member => member.completionSequence ?? 0)) + 1;
}

function compositeGroupResult(node: NodeIR, result: JsonValue | undefined, projection: SchedulerProjection, scope: EvaluationScope): JsonValue | undefined {
  if (node.kind === "parallel" && node.strategy === "all") {
    return Object.fromEntries(Object.keys(node.branches).map(branchId => {
      const member = requireCompletedBranchMember(projection, deriveInstanceKey(appendNode([], node.id)), branchId);
      return [branchId, parallelBranchOutput(node, branchId, member, scope)];
    }));
  }
  if (node.kind === "parallel" && node.strategy === "race") {
    const winner = Object.values(projection.groupMembers)
      .filter(member => member.groupKey === deriveInstanceKey(appendNode([], node.id)) && member.memberKind === "branch" && member.status === "completed")
      .sort(byCompletionSequence)[0];
    if (!winner?.branchId) return result;
    return { winner: winner.branchId, result: parallelBranchOutput(node, winner.branchId, winner, scope) };
  }
  if (node.kind === "fanout" && node.strategy === "all") {
    return Object.values(projection.groupMembers)
      .filter(member => member.groupKey === deriveInstanceKey(appendNode([], node.id)))
      .filter(member => member.memberKind === "fanout_item")
      .sort((left, right) => left.itemIndex! - right.itemIndex!)
      .map(member => fanoutItemOutput(node, member, scope));
  }
  if (node.kind === "fanout" && node.strategy === "quorum") {
    const completed = Object.values(projection.groupMembers)
      .filter(member => member.groupKey === deriveInstanceKey(appendNode([], node.id)))
      .filter(member => member.memberKind === "fanout_item" && member.status === "completed")
      .sort((left, right) => left.completionSequence! - right.completionSequence!)
      .map(member => fanoutItemOutput(node, member, scope));
    return { accepted: completed.slice(0, node.count), completed };
  }
  return result;
}

function parallelBranchOutput(node: ParallelNodeIR, branchId: string, member: GroupMember, scope: EvaluationScope): JsonObject {
  const branch = node.branches[branchId];
  const leaf = branch?.scope.nodes[0];
  if (!branch || !leaf || !isSchedulerLeaf(leaf)) throw new Error(`Parallel branch '${branchId}' is not a supported scheduler branch.`);
  if (branch.scope.nodes.length > 1) return requireObjectOutput(member.output, `Parallel branch '${branchId}'`);
  return evaluateOutputs(branch.scope.outputs ?? {}, {
    ...scope,
    nodes: {
      ...scope.nodes,
      [leaf.id]: { status: "completed", output: member.output },
    },
  });
}

function fanoutItemOutput(node: FanoutNodeIR, member: GroupMember, scope: EvaluationScope): JsonObject {
  const leaf = node.do.nodes[0];
  if (!leaf || !isSchedulerLeaf(leaf)) throw new Error(`Fanout node '${node.id}' is not a supported scheduler fanout.`);
  if (node.do.nodes.length > 1) return requireObjectOutput(member.output, `Fanout item '${member.memberKey}'`);
  return evaluateOutputs(node.do.outputs ?? {}, {
    ...scope,
    nodes: {
      ...scope.nodes,
      [leaf.id]: { status: "completed", output: member.output },
    },
    fanout: {
      ...scope.fanout,
      [node.id]: {
        item: member.item,
        itemIndex: member.itemIndex,
      },
    },
  });
}

function requireObjectOutput(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} output is not an object.`);
  return value as JsonObject;
}

function conditionalTerminalEvents(node: Extract<NodeIR, { kind: "if" | "switch" }>, projection: SchedulerProjection, scope: EvaluationScope): SchedulerEvent[] {
  const nodeKey = deriveInstanceKey(appendNode([], node.id));
  const branchId = projection.branchDecisions[nodeKey];
  if (!branchId) return [];
  const selected = conditionalBranchById(node, branchId);
  if (!selected) return [];
  const branchFrameKey = deriveInstanceKey(appendBranch([], node.id, branchId));
  const branchFrame = projection.frames[branchFrameKey];
  if (!branchFrame) return [];
  if (branchFrame.status === "completed") {
    return [{ type: "frame.completed", payload: { frameKey: nodeKey, ...(branchFrame.result === undefined ? {} : { result: branchFrame.result }), terminalReason: "branch_completed" } }];
  }
  if (branchFrame.status === "failed") {
    const error = branchFrame.error ?? { reason: "branch_failed" };
    return [
      { type: "frame.failed", payload: { frameKey: nodeKey, error, terminalReason: "branch_failed" } },
      { type: "frame.failed", payload: { frameKey: "root", error, terminalReason: "branch_failed" } },
    ];
  }
  if (branchFrame.status === "cancelled") {
    return [
      { type: "frame.cancelled", payload: { frameKey: nodeKey, cancelReason: "parent_failed" } },
      { type: "frame.cancelled", payload: { frameKey: "root", cancelReason: "parent_failed" } },
    ];
  }
  if (selected.scope.nodes.length > 1) return [];
  const leaf = selected.scope.nodes[0];
  if (!leaf || !isSchedulerLeaf(leaf)) return [];
  const leafKey = deriveInstanceKey(appendNode(appendBranch([], node.id, branchId), leaf.id));
  const instance = projection.instances[leafKey];
  if (instance?.status === "completed") {
    return [{
      type: "frame.completed",
      payload: {
        frameKey: branchFrameKey,
        result: evaluateOutputs(selected.scope.outputs ?? {}, { ...scope, nodes: { ...scope.nodes, [leaf.id]: { status: "completed", output: instance.output } } }),
        terminalReason: "branch_completed",
      },
    }];
  }
  if (instance?.status === "failed") {
    const error = instance.error ?? { reason: "node_failed" };
    return [
      { type: "frame.failed", payload: { frameKey: branchFrameKey, error, terminalReason: instance.statusReason ?? "node_failed" } },
      { type: "frame.failed", payload: { frameKey: nodeKey, error, terminalReason: instance.statusReason ?? "node_failed" } },
      { type: "frame.failed", payload: { frameKey: "root", error, terminalReason: instance.statusReason ?? "node_failed" } },
    ];
  }
  if (instance?.status === "cancelled") {
    return [
      { type: "frame.cancelled", payload: { frameKey: branchFrameKey, cancelReason: "parent_failed" } },
      { type: "frame.cancelled", payload: { frameKey: nodeKey, cancelReason: "parent_failed" } },
      { type: "frame.cancelled", payload: { frameKey: "root", cancelReason: "parent_failed" } },
    ];
  }
  return [];
}

function selectConditionalBranch(node: Extract<NodeIR, { kind: "if" | "switch" }>, scope: EvaluationScope): { branchId: string; scope: WorkflowIR["root"] } {
  if (node.kind === "if") {
    const condition = evaluateExpr(node.condition, scope);
    if (typeof condition !== "boolean") throw new Error(`If node '${node.id}' condition must evaluate to boolean.`);
    return condition ? { branchId: "then", scope: node.then } : { branchId: "else", scope: node.else ?? emptyScope() };
  }
  const selected = node.cases.findIndex(c => {
    const condition = evaluateExpr(c.when, scope);
    if (typeof condition !== "boolean") throw new Error(`Switch node '${node.id}' case condition must evaluate to boolean.`);
    return condition;
  });
  return selected >= 0
    ? { branchId: `case_${selected}`, scope: node.cases[selected]!.then }
    : { branchId: "default", scope: node.default ?? emptyScope() };
}

function conditionalBranchById(node: Extract<NodeIR, { kind: "if" | "switch" }>, branchId: string): { branchId: string; scope: WorkflowIR["root"] } | undefined {
  if (node.kind === "if") {
    if (branchId === "then") return { branchId, scope: node.then };
    if (branchId === "else") return { branchId, scope: node.else ?? emptyScope() };
    return undefined;
  }
  if (branchId === "default") return { branchId, scope: node.default ?? emptyScope() };
  const match = /^case_(\d+)$/.exec(branchId);
  if (!match) return undefined;
  const index = Number(match[1]);
  const found = node.cases[index];
  return found ? { branchId, scope: found.then } : undefined;
}

function isSupportedBranchScope(scope: WorkflowIR["root"]): boolean {
  return scope.nodes.length === 0 || isSupportedSequentialScope(scope);
}

function isSupportedSequentialScope(scope: WorkflowIR["root"]): boolean {
  return scope.nodes.length > 0 && scope.nodes.every(isSchedulerLeaf);
}

function scopeMapForSequentialNodes(basePath: InstancePath, nodes: readonly NodeIR[]): Record<string, string> {
  return Object.fromEntries(nodes.map(node => [node.id, deriveInstanceKey(appendNode(basePath, node.id))]));
}

function emptyScope(): WorkflowIR["root"] {
  return { nodes: [], outputs: {} };
}

function renderAssertFailure(node: Extract<NodeIR, { kind: "assert" }>, scope: EvaluationScope): string {
  return node.message ? renderTemplate(node.message, scope) : `Assert node '${node.id}' failed.`;
}

function requireCompletedBranchMember(projection: SchedulerProjection, groupKey: string, branchId: string): GroupMember {
  const member = Object.values(projection.groupMembers).find(member => member.groupKey === groupKey && member.branchId === branchId);
  if (!member || member.status !== "completed") throw new Error(`Parallel branch '${branchId}' has no completed group member.`);
  return member;
}

function byCompletionSequence(left: GroupMember, right: GroupMember): number {
  return (left.completionSequence ?? Number.MAX_SAFE_INTEGER) - (right.completionSequence ?? Number.MAX_SAFE_INTEGER);
}

function evaluateOutputs(outputs: NonNullable<WorkflowIR["root"]["outputs"]>, scope: EvaluationScope): JsonObject {
  return Object.fromEntries(Object.entries(outputs).map(([key, expr]) => [key, evaluateExpr(expr, scope) as JsonValue]));
}

function materializeRootNodeEvents(runId: string, node: NodeIR, scope: EvaluationScope, readinessSequence: number): SchedulerEvent[] {
  if (node.kind === "assert") return materializeRootAssertEvents(runId, node, scope);
  if (node.kind === "if" || node.kind === "switch") return materializeRootConditionalEvents(runId, node, scope, readinessSequence);
  if (isSchedulerLeaf(node)) {
    const nodePath = appendNode([], node.id);
    return schedulerLeafEvents({
      runId,
      node,
      nodeKey: deriveInstanceKey(nodePath),
      instancePath: nodePath,
      parentFrameKey: "root",
      readinessSequence,
    });
  }
  if (node.kind === "parallel") return materializeRootParallelEvents(runId, node, readinessSequence);
  if (node.kind === "fanout") return materializeRootFanoutEvents(runId, node, scope);
  if (node.kind === "loop") return materializeRootLoopEvents(runId, node, readinessSequence);
  return [];
}

function materializeRootAssertEvents(runId: string, node: Extract<NodeIR, { kind: "assert" }>, scope: EvaluationScope): SchedulerEvent[] {
  const nodePath = appendNode([], node.id);
  const nodeKey = deriveInstanceKey(nodePath);
  const start = { type: "frame.started", payload: { runId, frameKey: nodeKey, frameKind: "node" as const, instancePath: nodePath, parentFrameKey: "root", nodeKey, nodeId: node.id } } satisfies SchedulerEvent;
  const passed = evaluateExpr(node.condition, scope);
  if (typeof passed !== "boolean") throw new Error(`Assert node '${node.id}' condition must evaluate to boolean.`);
  if (passed) return [start, { type: "frame.completed", payload: { frameKey: nodeKey, result: {}, terminalReason: "assert_passed" } }];
  return [start, { type: "frame.failed", payload: { frameKey: nodeKey, error: { message: renderAssertFailure(node, scope) }, terminalReason: "assert_failed" } }];
}

function materializeRootConditionalEvents(runId: string, node: Extract<NodeIR, { kind: "if" | "switch" }>, scope: EvaluationScope, readinessSequence: number): SchedulerEvent[] {
  const nodePath = appendNode([], node.id);
  const nodeKey = deriveInstanceKey(nodePath);
  const selected = selectConditionalBranch(node, scope);
  if (!isSupportedBranchScope(selected.scope)) {
    return [];
  }
  const branchPath = appendBranch([], node.id, selected.branchId);
  const branchFrameKey = deriveInstanceKey(branchPath);
  const leaf = selected.scope.nodes[0];
  const leafPath = leaf && isSchedulerLeaf(leaf) ? appendNode(branchPath, leaf.id) : undefined;
  const leafNodeKey = leafPath ? deriveInstanceKey(leafPath) : undefined;
  const events: SchedulerEvent[] = [
    { type: "frame.started", payload: { runId, frameKey: nodeKey, frameKind: "node", instancePath: nodePath, parentFrameKey: "root", nodeKey, nodeId: node.id } },
    { type: "branch.decided", payload: { frameKey: nodeKey, branchId: selected.branchId } },
    {
      type: "frame.started",
      payload: {
        runId,
        frameKey: branchFrameKey,
        frameKind: "branch",
        instancePath: branchPath,
        parentFrameKey: nodeKey,
        nodeId: node.id,
        scope: scopeMapForSequentialNodes(branchPath, selected.scope.nodes),
      },
    },
  ];
  if (!leaf || !leafPath || !leafNodeKey) {
    events.push({ type: "frame.completed", payload: { frameKey: branchFrameKey, result: evaluateOutputs(selected.scope.outputs ?? {}, scope), terminalReason: "branch_completed" } });
    return events;
  }
  events.push(...schedulerLeafEvents({
    runId,
    node: leaf,
    nodeKey: leafNodeKey,
    instancePath: leafPath,
    parentFrameKey: branchFrameKey,
    readinessSequence,
  }));
  return events;
}

function materializeRootLoopEvents(runId: string, node: LoopNodeIR, readinessSequence: number): SchedulerEvent[] {
  if (!isSupportedRootLoop(node)) return [];
  const nodePath = appendNode([], node.id);
  const nodeKey = deriveInstanceKey(nodePath);
  return [
    { type: "frame.started", payload: { runId, frameKey: nodeKey, frameKind: "loop", instancePath: nodePath, parentFrameKey: "root", nodeKey, nodeId: node.id } },
    ...materializeLoopIterationEvents(runId, node, 0, readinessSequence),
  ];
}

function isSupportedRootLoop(node: LoopNodeIR): boolean {
  return isSupportedSequentialScope(node.do);
}

function materializeLoopIterationEvents(runId: string, node: LoopNodeIR, iter: number, readinessSequence: number): SchedulerEvent[] {
  const leaf = node.do.nodes[0]!;
  const iterationPath = appendLoopIteration([], node.id, iter);
  const leafPath = appendNode(iterationPath, leaf.id);
  const leafNodeKey = deriveInstanceKey(leafPath);
  if (node.do.nodes.length === 1) {
    return schedulerLeafEvents({
      runId,
      node: leaf,
      nodeKey: leafNodeKey,
      instancePath: leafPath,
      parentFrameKey: deriveInstanceKey(appendNode([], node.id)),
      readinessSequence,
    });
  }
  const iterationFrameKey = deriveInstanceKey(iterationPath);
  return [
    {
      type: "frame.started",
      payload: {
        runId,
        frameKey: iterationFrameKey,
        frameKind: "loop_iteration",
        instancePath: iterationPath,
        parentFrameKey: deriveInstanceKey(appendNode([], node.id)),
        nodeId: node.id,
        scope: scopeMapForSequentialNodes(iterationPath, node.do.nodes),
      },
    },
    ...schedulerLeafEvents({
      runId,
      node: leaf,
      nodeKey: leafNodeKey,
      instancePath: leafPath,
      parentFrameKey: iterationFrameKey,
      readinessSequence,
    }),
  ];
}

function materializeRootFanoutEvents(runId: string, node: FanoutNodeIR, scope: EvaluationScope): SchedulerEvent[] {
  const items = evaluateExpr(node.over, scope);
  if (!Array.isArray(items) || !isSupportedSequentialScope(node.do)) {
    return [];
  }
  const nodePath = appendNode([], node.id);
  const nodeKey = deriveInstanceKey(nodePath);
  const leaf = node.do.nodes[0]!;
  const events: SchedulerEvent[] = [
    {
      type: "frame.started",
      payload: {
        runId,
        frameKey: nodeKey,
        frameKind: "node",
        instancePath: nodePath,
        parentFrameKey: "root",
        nodeKey,
        nodeId: node.id,
        strategy: node.strategy,
      },
    },
    node.strategy === "quorum"
      ? { type: "group.started", payload: { runId, groupKey: nodeKey, nodeKey, nodeId: node.id, kind: "fanout", strategy: "quorum", quorumCount: node.count } }
      : { type: "group.started", payload: { runId, groupKey: nodeKey, nodeKey, nodeId: node.id, kind: "fanout", strategy: "all" } },
  ];

  const seenItemKeys = new Set<string>();
  for (const [itemIndex, item] of items.entries()) {
    const itemKey = fanoutItemKey(node, scope, item, itemIndex);
    const normalizedItemKey = String(itemKey);
    if (seenItemKeys.has(normalizedItemKey)) throw new Error(`Fanout group '${nodeKey}' has duplicate item key '${normalizedItemKey}'.`);
    seenItemKeys.add(normalizedItemKey);
    const itemPath = appendFanoutItem([], node.id, itemKey, itemIndex);
    const itemFrameKey = deriveInstanceKey(itemPath);
    const leafPath = appendNode(itemPath, leaf.id);
    const leafNodeKey = deriveInstanceKey(leafPath);
    const memberKey = node.do.nodes.length === 1 ? leafNodeKey : itemFrameKey;
    events.push(
      {
        type: "frame.started",
        payload: {
          runId,
          frameKey: itemFrameKey,
          frameKind: "fanout_item",
          instancePath: itemPath,
          parentFrameKey: nodeKey,
          nodeId: node.id,
          strategy: node.strategy,
          scope: scopeMapForSequentialNodes(itemPath, node.do.nodes),
        },
      },
      {
        type: "group.member_ready",
        payload: {
          runId,
          groupKey: nodeKey,
          memberKey,
          memberKind: "fanout_item",
          itemKey,
          itemIndex,
          item: item as JsonValue,
          readinessSequence: itemIndex + 1,
        },
      },
      ...schedulerLeafEvents({
        runId,
        node: leaf,
        nodeKey: leafNodeKey,
        instancePath: leafPath,
        parentFrameKey: itemFrameKey,
        readinessSequence: itemIndex + 1,
      }),
    );
  }
  return events;
}

function fanoutItemKey(node: FanoutNodeIR, scope: EvaluationScope, item: unknown, itemIndex: number): string | number {
  if (!node.key) return itemIndex;
  return renderTemplate(node.key, {
    ...scope,
    fanout: {
      ...scope.fanout,
      [node.id]: { item, itemIndex },
    },
  });
}

function materializeRootParallelEvents(runId: string, node: ParallelNodeIR, readinessSequenceStart: number): SchedulerEvent[] {
  if (!isSupportedRootParallel(node)) {
    return [];
  }
  const nodePath = appendNode([], node.id);
  const nodeKey = deriveInstanceKey(nodePath);
  const events: SchedulerEvent[] = [
    {
      type: "frame.started",
      payload: {
        runId,
        frameKey: nodeKey,
        frameKind: "node",
        instancePath: nodePath,
        parentFrameKey: "root",
        nodeKey,
        nodeId: node.id,
        strategy: node.strategy,
      },
    },
    {
      type: "group.started",
      payload: {
        runId,
        groupKey: nodeKey,
        nodeKey,
        nodeId: node.id,
        kind: "parallel",
        strategy: node.strategy,
      },
    },
  ];

  let readinessSequence = readinessSequenceStart;
  for (const [branchId, branch] of Object.entries(node.branches)) {
    const branchPath = appendBranch([], node.id, branchId);
    const branchFrameKey = deriveInstanceKey(branchPath);
    const first = branch.scope.nodes[0];
    const firstPath = first && isSchedulerLeaf(first) ? appendNode(branchPath, first.id) : undefined;
    const firstNodeKey = firstPath ? deriveInstanceKey(firstPath) : undefined;
    const memberKey = branch.scope.nodes.length === 1 && firstNodeKey ? firstNodeKey : branchFrameKey;
    events.push({
      type: "frame.started",
      payload: {
        runId,
        frameKey: branchFrameKey,
        frameKind: "branch",
        instancePath: branchPath,
        parentFrameKey: nodeKey,
        nodeId: node.id,
        strategy: node.strategy,
        scope: scopeMapForSequentialNodes(branchPath, branch.scope.nodes),
      },
    });
    if (!first || !firstPath || !firstNodeKey) continue;
    events.push({
      type: "group.member_ready",
      payload: {
        runId,
        groupKey: nodeKey,
        memberKey,
        memberKind: "branch",
        branchId,
        readinessSequence,
      },
    });
    events.push(...schedulerLeafEvents({
      runId,
      node: first,
      nodeKey: firstNodeKey,
      instancePath: firstPath,
      parentFrameKey: branchFrameKey,
      readinessSequence,
    }));
    readinessSequence += 1;
  }
  return events;
}

function isSupportedRootParallel(node: ParallelNodeIR): boolean {
  const branches = Object.values(node.branches);
  return branches.length > 0 && branches.every(branch => isSupportedSequentialScope(branch.scope));
}

function schedulerLeafEvents(input: {
  runId: string;
  node: NodeIR;
  nodeKey: string;
  instancePath: InstancePath;
  parentFrameKey: string;
  readinessSequence: number;
  groupKey?: string;
  branchId?: string;
}): SchedulerEvent[] {
  const events: SchedulerEvent[] = [];
  if (input.groupKey && input.branchId) {
    events.push({
      type: "group.member_ready",
      payload: {
        runId: input.runId,
        groupKey: input.groupKey,
        memberKey: input.nodeKey,
        memberKind: "branch",
        branchId: input.branchId,
        readinessSequence: input.readinessSequence,
      },
    });
  }
  events.push({
    type: "instance.ready",
    payload: {
      runId: input.runId,
      nodeKey: input.nodeKey,
      nodeId: input.node.id,
      instancePath: input.instancePath,
      parentFrameKey: input.parentFrameKey,
      readinessSequence: input.readinessSequence,
    },
  });
  if (input.node.kind === "signal") {
    // Deadline calculation needs an admission clock; bootstrap only records the open wait.
    events.push(
      { type: "instance.awaiting", payload: { nodeKey: input.nodeKey, statusReason: "signal" } },
      { type: "signal.awaiting", payload: { runId: input.runId, nodeKey: input.nodeKey, nodeId: input.node.id } },
    );
  }
  return events;
}

function materializedRootNodeKey(node: NodeIR, events: readonly SchedulerEvent[]): string | undefined {
  const frame = events.find(event =>
    event.type === "frame.started" &&
    event.payload.parentFrameKey === "root" &&
    event.payload.nodeId === node.id &&
    event.payload.nodeKey,
  );
  if (frame?.type === "frame.started") return frame.payload.nodeKey;
  const instance = events.find(event =>
    event.type === "instance.ready" &&
    event.payload.parentFrameKey === "root" &&
    event.payload.nodeId === node.id,
  );
  return instance?.type === "instance.ready" ? instance.payload.nodeKey : undefined;
}

function isSchedulerLeaf(node: NodeIR): boolean {
  return node.kind === "task" || node.kind === "agent" || node.kind === "signal";
}
