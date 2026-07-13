import type { FanoutNodeIR, LoopNodeIR, NodeIR, ParallelNodeIR, WorkflowIR } from "@acpus/core/ir";
import type { JsonObject, JsonValue } from "@acpus/expression/ir";
import { normalizeWorkflowData } from "../evaluation/admissible.js";
import { evaluateExpr, type EvaluationScope } from "../evaluation/evaluator.js";
import { resolutionErrorPayload, tryResolveConcurrencyLimit, tryResolveDuration, tryResolveInteger, tryResolveString } from "../evaluation/resolvable.js";
import { appendBranch, appendFanoutItem, appendLoopIteration, appendNode, deriveInstanceKey } from "./identity.js";
import type { SchedulerEvent } from "./events.js";
import type { FrameKind, GroupMember, InstancePath, InstancePathSegment, SchedulerFrame, SchedulerProjection } from "./types.js";
import { baseScopeForFrame, completedScopeForFrame, scopeWithFanoutItem, scopeWithLoopIteration, scopeWithNodeOutput } from "./scope.js";
import { nextLoopStep } from "./transitions.js";

type ScopeIR = WorkflowIR["root"];
type ScopeFrame = {
  frame: SchedulerFrame;
  scopeIR: ScopeIR;
  basePath: InstancePath;
  scope: EvaluationScope;
  member?: GroupMember;
};
type NodeState =
  | { status: "not_started" }
  | { status: "running" }
  | { status: "completed"; output?: JsonValue }
  | { status: "failed"; error?: JsonObject; reason?: string }
  | { status: "cancelled"; reason?: string };

export function bootstrapRootEvents(runId: string, ir: WorkflowIR, scope: EvaluationScope = {}): SchedulerEvent[] {
  const rootFrame = {
    runId,
    frameKey: "root",
    frameKind: "root" as const,
    status: "running" as const,
    scope: scopeMapForScope([], ir.root),
  };
  return [
    { type: "frame.started", payload: { runId, frameKey: "root", frameKind: "root", scope: rootFrame.scope } },
    ...continueScopeFrameEvents({ frame: rootFrame, scopeIR: ir.root, basePath: [], scope }, emptyProjection(runId)),
  ];
}

export function continueRootEvents(ir: WorkflowIR, projection: SchedulerProjection, scope: EvaluationScope = {}): SchedulerEvent[] {
  for (const frame of runnableFrames(projection)) {
    const events = continueFrameEvents(ir, projection, frame, scope);
    if (events.length > 0) return events;
  }
  return [];
}

function continueFrameEvents(ir: WorkflowIR, projection: SchedulerProjection, frame: SchedulerFrame, baseScope: EvaluationScope): SchedulerEvent[] {
  if (isScopeFrame(frame)) {
    const input = scopeFrame(ir, projection, frame, baseScope);
    return input ? continueScopeFrameEvents(input, projection) : [];
  }
  if (frame.frameKind === "loop") return continueLoopFrameEvents(ir, projection, frame, baseScope);
  return continueNodeFrameEvents(ir, projection, frame);
}

function continueScopeFrameEvents(input: ScopeFrame, projection: SchedulerProjection): SchedulerEvent[] {
  const cancelled = input.member?.status === "cancelled";
  if (cancelled) return [{ type: "frame.cancelled", payload: { frameKey: input.frame.frameKey, cancelReason: cancellationReason(input.member?.terminalReason ?? "parent_failed") } }];

  let scope = input.scope;
  for (let index = 0; index < input.scopeIR.nodes.length; index += 1) {
    const node = input.scopeIR.nodes[index]!;
    const nodePath = appendNode(input.basePath, node.id);
    const state = nodeState(node, nodePath, projection);
    if (state.status === "not_started") return materializeNodeEvents({
      runId: input.frame.runId,
      node,
      parentFrameKey: input.frame.frameKey,
      basePath: input.basePath,
      scope,
      readinessSequence: nextFrameReadiness(input.member, index),
    });
    if (state.status === "failed") return terminalScopeFrameEvents(input, "failed", state.error ?? { reason: "node_failed" }, state.reason ?? "node_failed");
    if (state.status === "cancelled") return terminalScopeFrameEvents(input, "cancelled", undefined, state.reason ?? "parent_failed");
    if (state.status === "running") return [];
    scope = scopeWithNodeOutput(scope, node.id, state.output);
  }

  let result: JsonValue;
  try {
    result = evaluateOutput(input.scopeIR.output, scope);
  } catch (error) {
    return terminalScopeFrameEvents(input, "failed", expressionFailure(error), "expression_failed");
  }
  const events: SchedulerEvent[] = [
    { type: "frame.completed", payload: { frameKey: input.frame.frameKey, result, terminalReason: completionReason(input, projection) } },
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

function continueNodeFrameEvents(ir: WorkflowIR, projection: SchedulerProjection, frame: SchedulerFrame): SchedulerEvent[] {
  const node = nodeForFrame(ir, frame);
  if (!node) return [];
  if (node.kind === "if" || node.kind === "switch") return continueConditionalFrameEvents(node, projection, frame);
  if (node.kind === "parallel" || node.kind === "fanout") return continueGroupFrameEvents(node, projection, frame);
  return [];
}

function continueConditionalFrameEvents(node: Extract<NodeIR, { kind: "if" | "switch" }>, projection: SchedulerProjection, frame: SchedulerFrame): SchedulerEvent[] {
  const branchId = projection.branchDecisions[frame.frameKey];
  if (!branchId || !frame.instancePath) return [];
  const branchFrameKey = deriveInstanceKey(appendBranch(parentPath(frame.instancePath), node.id, branchId));
  const branch = projection.frames[branchFrameKey];
  if (!branch) return [];
  if (branch.status === "completed") {
    return [{ type: "frame.completed", payload: { frameKey: frame.frameKey, ...(branch.result === undefined ? {} : { result: branch.result }), terminalReason: "branch_completed" } }];
  }
  if (branch.status === "failed") {
    return [{ type: "frame.failed", payload: { frameKey: frame.frameKey, error: branch.error ?? { reason: "branch_failed" }, terminalReason: branch.terminalReason ?? "branch_failed" } }];
  }
  if (branch.status === "cancelled") {
    return [{ type: "frame.cancelled", payload: { frameKey: frame.frameKey, cancelReason: cancellationReason(branch.terminalReason ?? "parent_failed") } }];
  }
  return [];
}

function continueGroupFrameEvents(node: ParallelNodeIR | FanoutNodeIR, projection: SchedulerProjection, frame: SchedulerFrame): SchedulerEvent[] {
  const group = projection.groups[frame.frameKey];
  if (!group) return [];
  if (group.status === "completed") {
    try {
      const result = groupResult(node, projection, frame.frameKey);
      return [{ type: "frame.completed", payload: { frameKey: frame.frameKey, ...(result === undefined ? {} : { result }), terminalReason: "group_completed" } }];
    } catch (error) {
      return [{ type: "frame.failed", payload: { frameKey: frame.frameKey, error: expressionFailure(error), terminalReason: "expression_failed" } }];
    }
  }
  if (group.status === "failed") {
    return [{ type: "frame.failed", payload: { frameKey: frame.frameKey, error: group.error ?? { reason: "group_failed" }, terminalReason: "group_failed" } }];
  }
  if (group.status === "cancelled") {
    return [{ type: "frame.cancelled", payload: { frameKey: frame.frameKey, cancelReason: "parent_failed" } }];
  }
  return [];
}

function continueLoopFrameEvents(ir: WorkflowIR, projection: SchedulerProjection, frame: SchedulerFrame, baseScope: EvaluationScope): SchedulerEvent[] {
  const loop = nodeForFrame(ir, frame);
  if (!loop || loop.kind !== "loop" || !frame.instancePath) return [];
  const iter = frame.loop?.iter ?? 0;
  const iterationKey = deriveInstanceKey(appendLoopIteration(parentPath(frame.instancePath), loop.id, iter));
  const iteration = projection.frames[iterationKey];
  if (!iteration || iteration.status === "running" || iteration.status === "ready" || iteration.status === "awaiting") return [];
  if (iteration.status === "failed") {
    return [{ type: "frame.failed", payload: { frameKey: frame.frameKey, error: iteration.error ?? { reason: "iteration_failed" }, terminalReason: iteration.terminalReason ?? "iteration_failed" } }];
  }
  if (iteration.status === "cancelled") {
    return [{ type: "frame.cancelled", payload: { frameKey: frame.frameKey, cancelReason: cancellationReason(iteration.terminalReason ?? "parent_failed") } }];
  }

  const state = frame.loop?.state;
  const nodeScope = scopeForNodeFrame(projection, frame, baseScope);
  const step = nextLoopStep({
    iter,
    ...(iteration.result === undefined ? {} : { transition: iteration.result }),
  });
  const advancedState = step.action === "complete"
    ? step.output
    : step.action === "start_iteration"
      ? step.state
      : undefined;
  const events: SchedulerEvent[] = [
    { type: "frame.loop_advanced", payload: { frameKey: frame.frameKey, iter, ...(advancedState === undefined ? state === undefined ? {} : { state } : { state: advancedState }), ...(iteration.result === undefined ? {} : { transition: iteration.result }) } },
  ];
  if (step.action === "complete") {
    events.push({ type: "frame.completed", payload: { frameKey: frame.frameKey, result: step.output, terminalReason: step.terminalReason } });
    return events;
  }
  if (step.action === "fail") {
    events.push({ type: "frame.failed", payload: { frameKey: frame.frameKey, error: step.error, terminalReason: step.terminalReason } });
    return events;
  }
  events.push(
    { type: "frame.loop_advanced", payload: { frameKey: frame.frameKey, iter: step.iter, ...(step.state === undefined ? {} : { state: step.state }) } },
    ...materializeLoopIterationEvents({
      runId: frame.runId,
      loop,
      loopFrameKey: frame.frameKey,
      basePath: parentPath(frame.instancePath),
      iter: step.iter,
      readinessSequence: step.iter + 1,
      scope: scopeWithLoopIteration(nodeScope, loop.id, step.iter, step.state),
    }),
  );
  return events;
}

function materializeNodeEvents(input: {
  runId: string;
  node: NodeIR;
  parentFrameKey: string;
  basePath: InstancePath;
  scope: EvaluationScope;
  readinessSequence: number;
}): SchedulerEvent[] {
  if (isSchedulerLeaf(input.node)) {
    const nodePath = appendNode(input.basePath, input.node.id);
    return schedulerLeafEvents({
      runId: input.runId,
      node: input.node,
      nodeKey: deriveInstanceKey(nodePath),
      instancePath: nodePath,
      parentFrameKey: input.parentFrameKey,
      readinessSequence: input.readinessSequence,
      scope: input.scope,
    });
  }
  if (input.node.kind === "assert") return materializeAssertEvents({ runId: input.runId, node: input.node, parentFrameKey: input.parentFrameKey, basePath: input.basePath, scope: input.scope });
  if (input.node.kind === "if" || input.node.kind === "switch") return materializeConditionalEvents(input as typeof input & { node: Extract<NodeIR, { kind: "if" | "switch" }> });
  if (input.node.kind === "parallel") return materializeParallelEvents(input as typeof input & { node: ParallelNodeIR });
  if (input.node.kind === "fanout") return materializeFanoutEvents(input as typeof input & { node: FanoutNodeIR });
  if (input.node.kind === "loop") return materializeLoopEvents(input as typeof input & { node: LoopNodeIR });
  return [];
}

function materializeAssertEvents(input: { runId: string; node: Extract<NodeIR, { kind: "assert" }>; parentFrameKey: string; basePath: InstancePath; scope: EvaluationScope }): SchedulerEvent[] {
  const nodePath = appendNode(input.basePath, input.node.id);
  const nodeKey = deriveInstanceKey(nodePath);
  const start = nodeFrameStarted(input.runId, input.node, nodePath, input.parentFrameKey, "node");
  try {
    const passed = evaluateExpr(input.node.condition, input.scope);
    if (typeof passed !== "boolean") throw new Error(`Assert node '${input.node.id}' condition must evaluate to boolean.`);
    if (passed) return [start, { type: "frame.completed", payload: { frameKey: nodeKey, result: {}, terminalReason: "assert_passed" } }];
    if (!input.node.message) return [start, { type: "frame.failed", payload: { frameKey: nodeKey, error: { message: `Assert node '${input.node.id}' failed.` }, terminalReason: "assert_failed" } }];
    return tryResolveString(input.node.message, input.scope, `Assert node '${input.node.id}' message`).match(
      message => [start, { type: "frame.failed", payload: { frameKey: nodeKey, error: { message }, terminalReason: "assert_failed" } }],
      error => [start, { type: "frame.failed", payload: { frameKey: nodeKey, error: resolutionErrorPayload(error), terminalReason: "expression_resolution_failed" } }],
    );
  } catch (error) {
    return [start, { type: "frame.failed", payload: { frameKey: nodeKey, error: expressionFailure(error), terminalReason: "expression_failed" } }];
  }
}

function materializeConditionalEvents(input: { runId: string; node: Extract<NodeIR, { kind: "if" | "switch" }>; parentFrameKey: string; basePath: InstancePath; scope: EvaluationScope; readinessSequence: number }): SchedulerEvent[] {
  const nodePath = appendNode(input.basePath, input.node.id);
  const nodeKey = deriveInstanceKey(nodePath);
  const start = nodeFrameStarted(input.runId, input.node, nodePath, input.parentFrameKey, "node");
  let selected: { branchId: string; scope: ScopeIR };
  try {
    selected = selectConditionalBranch(input.node, input.scope);
  } catch (error) {
    return [start, { type: "frame.failed", payload: { frameKey: nodeKey, error: expressionFailure(error), terminalReason: "expression_failed" } }];
  }
  const branchPath = appendBranch(input.basePath, input.node.id, selected.branchId);
  const branchFrameKey = deriveInstanceKey(branchPath);
  return [
    start,
    { type: "branch.decided", payload: { frameKey: nodeKey, branchId: selected.branchId } },
    {
      type: "frame.started",
      payload: {
        runId: input.runId,
        frameKey: branchFrameKey,
        frameKind: "branch",
        instancePath: branchPath,
        parentFrameKey: nodeKey,
        nodeId: input.node.id,
        scope: scopeMapForScope(branchPath, selected.scope),
      },
    },
    ...materializeScopeStart(input.runId, branchFrameKey, selected.scope, branchPath, input.scope, input.readinessSequence),
  ];
}

function materializeParallelEvents(input: { runId: string; node: ParallelNodeIR; parentFrameKey: string; basePath: InstancePath; scope: EvaluationScope; readinessSequence: number }): SchedulerEvent[] {
  const nodePath = appendNode(input.basePath, input.node.id);
  const nodeKey = deriveInstanceKey(nodePath);
  const start = nodeFrameStarted(input.runId, input.node, nodePath, input.parentFrameKey, "node", input.node.strategy);
  let maxConcurrency: number | undefined;
  if (input.node.maxConcurrency !== undefined) {
    const resolved = tryResolveConcurrencyLimit(input.node.maxConcurrency, input.scope, `Parallel node '${input.node.id}' maxConcurrency`);
    if (resolved.isErr()) {
      return [start, { type: "frame.failed", payload: { frameKey: nodeKey, error: resolutionErrorPayload(resolved.error), terminalReason: "expression_resolution_failed" } }];
    }
    maxConcurrency = resolved.value;
  }
  const events: SchedulerEvent[] = [
    start,
    { type: "group.started", payload: { runId: input.runId, groupKey: nodeKey, nodeKey, nodeId: input.node.id, kind: "parallel", strategy: input.node.strategy, ...(maxConcurrency === undefined ? {} : { maxConcurrency }) } },
  ];
  let readinessSequence = input.readinessSequence;
  for (const [branchId, branch] of Object.entries(input.node.branches)) {
    const branchPath = appendBranch(input.basePath, input.node.id, branchId);
    const branchFrameKey = deriveInstanceKey(branchPath);
    events.push(
      {
        type: "frame.started",
        payload: {
          runId: input.runId,
          frameKey: branchFrameKey,
          frameKind: "branch",
          instancePath: branchPath,
          parentFrameKey: nodeKey,
          nodeId: input.node.id,
          strategy: input.node.strategy,
          scope: scopeMapForScope(branchPath, branch),
        },
      },
      {
        type: "group.member_ready",
        payload: {
          runId: input.runId,
          groupKey: nodeKey,
          memberKey: branchFrameKey,
          memberKind: "branch",
          branchId,
          childFrameKey: branchFrameKey,
          readinessSequence,
        },
      },
      ...materializeScopeStart(input.runId, branchFrameKey, branch, branchPath, input.scope, readinessSequence, branchFrameKey),
    );
    readinessSequence += 1;
  }
  return events;
}

function materializeFanoutEvents(input: { runId: string; node: FanoutNodeIR; parentFrameKey: string; basePath: InstancePath; scope: EvaluationScope; readinessSequence: number }): SchedulerEvent[] {
  const nodePath = appendNode(input.basePath, input.node.id);
  const nodeKey = deriveInstanceKey(nodePath);
  const start = nodeFrameStarted(input.runId, input.node, nodePath, input.parentFrameKey, "node", input.node.strategy);
  try {
    const items = evaluateExpr(input.node.over, input.scope);
    if (!Array.isArray(items)) {
      return [start, { type: "frame.failed", payload: { frameKey: nodeKey, error: { reason: "fanout_over_not_array" }, terminalReason: "fanout_over_not_array" } }];
    }
    let maxConcurrency: number | undefined;
    if (input.node.maxConcurrency !== undefined) {
      const resolved = tryResolveConcurrencyLimit(input.node.maxConcurrency, input.scope, `Fanout node '${input.node.id}' maxConcurrency`);
      if (resolved.isErr()) {
        return [start, { type: "frame.failed", payload: { frameKey: nodeKey, error: resolutionErrorPayload(resolved.error), terminalReason: "expression_resolution_failed" } }];
      }
      maxConcurrency = resolved.value;
    }
    let quorumCount: number | undefined;
    if (input.node.strategy === "quorum") {
      const resolved = tryResolveInteger(input.node.count, input.scope, `Fanout node '${input.node.id}' quorum count`, 1);
      if (resolved.isErr()) {
        return [start, { type: "frame.failed", payload: { frameKey: nodeKey, error: resolutionErrorPayload(resolved.error), terminalReason: "expression_resolution_failed" } }];
      }
      quorumCount = resolved.value;
    }
    const events: SchedulerEvent[] = [
      start,
      input.node.strategy === "quorum"
        ? { type: "group.started", payload: { runId: input.runId, groupKey: nodeKey, nodeKey, nodeId: input.node.id, kind: "fanout", strategy: "quorum", quorumCount: quorumCount!, ...(maxConcurrency === undefined ? {} : { maxConcurrency }) } }
        : { type: "group.started", payload: { runId: input.runId, groupKey: nodeKey, nodeKey, nodeId: input.node.id, kind: "fanout", strategy: "all", ...(maxConcurrency === undefined ? {} : { maxConcurrency }) } },
    ];
    for (const [itemIndex, item] of items.entries()) {
      const itemPath = appendFanoutItem(input.basePath, input.node.id, itemIndex);
      const itemFrameKey = deriveInstanceKey(itemPath);
      const itemScope = scopeWithFanoutItem(input.scope, input.node.id, item as JsonValue, itemIndex);
      events.push(
        {
          type: "frame.started",
          payload: {
            runId: input.runId,
            frameKey: itemFrameKey,
            frameKind: "fanout_item",
            instancePath: itemPath,
            parentFrameKey: nodeKey,
            nodeId: input.node.id,
            strategy: input.node.strategy,
            scope: scopeMapForScope(itemPath, input.node.do),
          },
        },
        {
          type: "group.member_ready",
          payload: {
            runId: input.runId,
            groupKey: nodeKey,
            memberKey: itemFrameKey,
            memberKind: "fanout_item",
            itemIndex,
            item: item as JsonValue,
            childFrameKey: itemFrameKey,
            readinessSequence: input.readinessSequence + itemIndex,
          },
        },
        ...materializeScopeStart(input.runId, itemFrameKey, input.node.do, itemPath, itemScope, input.readinessSequence + itemIndex, itemFrameKey),
      );
    }
    return events;
  } catch (error) {
    return [start, { type: "frame.failed", payload: { frameKey: nodeKey, error: expressionFailure(error), terminalReason: "expression_failed" } }];
  }
}

function materializeLoopEvents(input: { runId: string; node: LoopNodeIR; parentFrameKey: string; basePath: InstancePath; scope: EvaluationScope; readinessSequence: number }): SchedulerEvent[] {
  const nodePath = appendNode(input.basePath, input.node.id);
  const nodeKey = deriveInstanceKey(nodePath);
  const start = nodeFrameStarted(input.runId, input.node, nodePath, input.parentFrameKey, "loop");
  let state: JsonValue;
  try {
    state = normalizeWorkflowData(evaluateExpr(input.node.state, input.scope), `Loop node '${input.node.id}' initial state`) as JsonValue;
  } catch (error) {
    return [start, { type: "frame.failed", payload: { frameKey: nodeKey, error: expressionFailure(error), terminalReason: "expression_failed" } }];
  }

  const seed = { type: "frame.loop_advanced", payload: { frameKey: nodeKey, iter: 0, state } } satisfies SchedulerEvent;
  return [
    start,
    seed,
    ...materializeLoopIterationEvents({
      runId: input.runId,
      loop: input.node,
      loopFrameKey: nodeKey,
      basePath: input.basePath,
      iter: 0,
      readinessSequence: input.readinessSequence,
      scope: scopeWithLoopIteration(input.scope, input.node.id, 0, state),
    }),
  ];
}

function materializeLoopIterationEvents(input: { runId: string; loop: LoopNodeIR; loopFrameKey: string; basePath: InstancePath; iter: number; readinessSequence: number; scope: EvaluationScope }): SchedulerEvent[] {
  const iterationPath = appendLoopIteration(input.basePath, input.loop.id, input.iter);
  const iterationFrameKey = deriveInstanceKey(iterationPath);
  return [
    {
      type: "frame.started",
      payload: {
        runId: input.runId,
        frameKey: iterationFrameKey,
        frameKind: "loop_iteration",
        instancePath: iterationPath,
        parentFrameKey: input.loopFrameKey,
        nodeId: input.loop.id,
        scope: scopeMapForScope(iterationPath, input.loop.do),
      },
    },
    ...materializeScopeStart(input.runId, iterationFrameKey, input.loop.do, iterationPath, input.scope, input.readinessSequence),
  ];
}

function materializeScopeStart(runId: string, frameKey: string, scopeIR: ScopeIR, basePath: InstancePath, scope: EvaluationScope, readinessSequence: number, memberKey?: string): SchedulerEvent[] {
  const first = scopeIR.nodes[0];
  if (!first) {
    let result: JsonValue;
    try {
      result = evaluateOutput(scopeIR.output, scope);
    } catch (error) {
      return [
        { type: "frame.failed", payload: { frameKey, error: expressionFailure(error), terminalReason: "expression_failed" } },
        ...(memberKey === undefined
          ? []
          : [{ type: "group.member_failed", payload: { memberKey, error: expressionFailure(error), terminalReason: "expression_failed" } } satisfies SchedulerEvent]),
      ];
    }
    return [
      { type: "frame.completed", payload: { frameKey, result, terminalReason: "frame_completed" } },
      ...(memberKey === undefined
        ? []
        : [{ type: "group.member_completed", payload: { memberKey, completionSequence: readinessSequence, output: result } } satisfies SchedulerEvent]),
    ];
  }
  return materializeNodeEvents({ runId, node: first, parentFrameKey: frameKey, basePath, scope, readinessSequence });
}

function schedulerLeafEvents(input: {
  runId: string;
  node: NodeIR;
  nodeKey: string;
  instancePath: InstancePath;
  parentFrameKey: string;
  readinessSequence: number;
  scope: EvaluationScope;
}): SchedulerEvent[] {
  const timeout = (input.node.kind === "agent" || input.node.kind === "task") && input.node.timeout !== undefined
    ? tryResolveDuration(input.node.timeout, input.scope, `${input.node.kind} node '${input.node.id}' timeout`)
    : undefined;
  const events: SchedulerEvent[] = [{
    type: "instance.ready",
    payload: {
      runId: input.runId,
      nodeKey: input.nodeKey,
      nodeId: input.node.id,
      instancePath: input.instancePath,
      parentFrameKey: input.parentFrameKey,
      readinessSequence: input.readinessSequence,
      ...(timeout?.isOk() ? { timeoutMs: timeout.value.milliseconds } : {}),
    },
  }];
  if (timeout?.isErr()) {
    events.push({
      type: "instance.failed",
      payload: {
        nodeKey: input.nodeKey,
        error: resolutionErrorPayload(timeout.error),
        statusReason: "expression_resolution_failed",
      },
    });
  }
  return events;
}

function nodeFrameStarted(runId: string, node: NodeIR, nodePath: InstancePath, parentFrameKey: string, frameKind: Extract<FrameKind, "node" | "loop">, strategy?: "all" | "race" | "quorum"): Extract<SchedulerEvent, { type: "frame.started" }> {
  const nodeKey = deriveInstanceKey(nodePath);
  return {
    type: "frame.started",
    payload: {
      runId,
      frameKey: nodeKey,
      frameKind,
      instancePath: nodePath,
      parentFrameKey,
      nodeKey,
      nodeId: node.id,
      ...(strategy === undefined ? {} : { strategy }),
    },
  };
}

function nodeState(node: NodeIR, nodePath: InstancePath, projection: SchedulerProjection): NodeState {
  const key = deriveInstanceKey(nodePath);
  if (isSchedulerLeaf(node)) {
    const instance = projection.instances[key];
    if (!instance) return { status: "not_started" };
    if (instance.status === "completed") return instance.output === undefined ? { status: "completed" } : { status: "completed", output: instance.output };
    if (instance.status === "failed") return { status: "failed", ...(instance.error === undefined ? {} : { error: instance.error }), ...(instance.statusReason === undefined ? {} : { reason: instance.statusReason }) };
    if (instance.status === "cancelled") return { status: "cancelled", ...(instance.statusReason === undefined ? {} : { reason: instance.statusReason }) };
    return { status: "running" };
  }
  const frame = projection.frames[key];
  if (!frame) return { status: "not_started" };
  if (frame.status === "completed") return frame.result === undefined ? { status: "completed" } : { status: "completed", output: frame.result };
  if (frame.status === "failed") return { status: "failed", ...(frame.error === undefined ? {} : { error: frame.error }), ...(frame.terminalReason === undefined ? {} : { reason: frame.terminalReason }) };
  if (frame.status === "cancelled") return { status: "cancelled", ...(frame.terminalReason === undefined ? {} : { reason: frame.terminalReason }) };
  return { status: "running" };
}

function scopeFrame(ir: WorkflowIR, projection: SchedulerProjection, frame: SchedulerFrame, baseScope: EvaluationScope): ScopeFrame | undefined {
  if (frame.frameKey === "root") {
    return { frame, scopeIR: ir.root, basePath: [], scope: baseScopeForFrame(projection, frame, baseScope) };
  }
  if (!frame.instancePath) return undefined;
  const scopeIR = scopeForPath(ir.root, frame.instancePath);
  if (!scopeIR) return undefined;
  const member = projection.groupMembers[frame.frameKey];
  return {
    frame,
    scopeIR,
    basePath: frame.instancePath,
    scope: baseScopeForFrame(projection, frame, baseScope),
    ...(member === undefined ? {} : { member }),
  };
}

function scopeForNodeFrame(projection: SchedulerProjection, frame: SchedulerFrame, baseScope: EvaluationScope): EvaluationScope {
  return frame.parentFrameKey ? completedScopeForFrame(projection, frame.parentFrameKey, baseScope) : baseScope;
}

function nodeForFrame(ir: WorkflowIR, frame: SchedulerFrame): NodeIR | undefined {
  if (!frame.instancePath) return undefined;
  const segment = lastSegment(frame.instancePath);
  if (segment?.kind !== "node") return undefined;
  return scopeForPath(ir.root, parentPath(frame.instancePath))?.nodes.find(node => node.id === segment.nodeId);
}

function scopeForPath(root: ScopeIR, path: InstancePath): ScopeIR | undefined {
  let scope: ScopeIR | undefined = root;
  for (const segment of path) {
    if (!scope) return undefined;
    if (segment.kind === "node") continue;
    const found: NodeIR | undefined = scope.nodes.find(candidate => candidate.id === segment.nodeId);
    if (!found) return undefined;
    if (segment.kind === "branch") {
      if (found.kind === "parallel") scope = found.branches[segment.branchId];
      else if (found.kind === "if" || found.kind === "switch") scope = conditionalBranchById(found, segment.branchId)?.scope;
      else return undefined;
    } else if (segment.kind === "fanout") {
      if (found.kind !== "fanout") return undefined;
      scope = found.do;
    } else {
      if (found.kind !== "loop") return undefined;
      scope = found.do;
    }
  }
  return scope;
}

function groupResult(node: ParallelNodeIR | FanoutNodeIR, projection: SchedulerProjection, groupKey: string): JsonValue | undefined {
  const members = Object.values(projection.groupMembers).filter(member => member.groupKey === groupKey);
  if (node.kind === "parallel" && node.strategy === "all") {
    return Object.fromEntries(members
      .filter(member => member.memberKind === "branch")
      .map(member => [member.branchId, requireWorkflowOutput(member.output, `Parallel branch '${member.branchId}'`)]));
  }
  if (node.kind === "parallel" && node.strategy === "race") {
    const winner = members
      .filter(member => member.memberKind === "branch")
      .filter(member => member.status === "completed")
      .sort(byCompletionSequence)[0];
    return winner ? { winner: winner.branchId, result: requireWorkflowOutput(winner.output, `Parallel branch '${winner.branchId}'`) } : undefined;
  }
  if (node.kind === "fanout" && node.strategy === "all") {
    return members
      .filter(member => member.memberKind === "fanout_item")
      .sort((left, right) => left.itemIndex - right.itemIndex)
      .map(member => requireWorkflowOutput(member.output, `Fanout item ${member.itemIndex}`));
  }
  if (node.kind === "fanout") {
    const quorumCount = projection.groups[groupKey]?.quorumCount;
    if (quorumCount === undefined) throw new Error(`Fanout quorum group '${groupKey}' has no resolved quorum count.`);
    const completed = members
      .filter(member => member.memberKind === "fanout_item" && member.status === "completed")
      .sort(byCompletionSequence)
      .slice(0, quorumCount);
    return completed.map(member => requireWorkflowOutput(member.output, `Fanout item ${member.itemIndex}`));
  }
  return undefined;
}

function terminalScopeFrameEvents(input: ScopeFrame, status: "failed" | "cancelled", error: JsonObject | undefined, reason: string): SchedulerEvent[] {
  const cancelReason = cancellationReason(reason);
  const events: SchedulerEvent[] = status === "failed"
    ? [{ type: "frame.failed", payload: { frameKey: input.frame.frameKey, error: error ?? { reason }, terminalReason: reason } }]
    : [{ type: "frame.cancelled", payload: { frameKey: input.frame.frameKey, cancelReason } }];
  if (input.member && (input.member.status === "ready" || input.member.status === "running")) {
    events.push(status === "failed"
      ? { type: "group.member_failed", payload: { memberKey: input.member.memberKey, error: error ?? { reason }, terminalReason: reason } }
      : { type: "group.member_cancelled", payload: { memberKey: input.member.memberKey, cancelReason } });
  }
  return events;
}

function runnableFrames(projection: SchedulerProjection): SchedulerFrame[] {
  return Object.values(projection.frames)
    .filter(frame => frame.status === "running")
    .sort((left, right) => frameDepth(right) - frameDepth(left) || framePriority(left) - framePriority(right) || left.frameKey.localeCompare(right.frameKey));
}

function frameDepth(frame: SchedulerFrame): number {
  return frame.instancePath?.length ?? 0;
}

function framePriority(frame: SchedulerFrame): number {
  if (frame.frameKind === "branch" || frame.frameKind === "fanout_item" || frame.frameKind === "loop_iteration") return 0;
  if (frame.frameKind === "node" || frame.frameKind === "loop") return 1;
  return 2;
}

function emptyProjection(runId: string): SchedulerProjection {
  return { run: { runId, status: "pending", paused: false }, frames: {}, instances: {}, attempts: {}, groups: {}, groupMembers: {}, signalWaits: {}, branchDecisions: {} };
}

function isScopeFrame(frame: SchedulerFrame): boolean {
  return frame.frameKind === "root" || frame.frameKind === "branch" || frame.frameKind === "fanout_item" || frame.frameKind === "loop_iteration";
}

function completionReason(input: ScopeFrame, projection: SchedulerProjection): string {
  if (input.frame.frameKey === "root") return "root_completed";
  if (input.frame.frameKind === "branch") {
    const parent = input.frame.parentFrameKey ? projection.frames[input.frame.parentFrameKey] : undefined;
    const parentNode = parent?.nodeId;
    if (parentNode) {
      const segment = lastSegment(input.frame.instancePath);
      if (segment?.kind === "branch" && segment.nodeId === parentNode && !input.member) return "branch_completed";
    }
  }
  return "frame_completed";
}

function nextFrameReadiness(member: GroupMember | undefined, index: number): number {
  return (member?.readinessSequence ?? 0) + index + 1;
}

function nextCompletionSequence(projection: SchedulerProjection): number {
  return Math.max(0, ...Object.values(projection.groupMembers).map(member => member.completionSequence ?? 0)) + 1;
}

function selectConditionalBranch(node: Extract<NodeIR, { kind: "if" | "switch" }>, scope: EvaluationScope): { branchId: string; scope: ScopeIR } {
  if (node.kind === "if") {
    const condition = evaluateExpr(node.condition, scope);
    if (typeof condition !== "boolean") throw new Error(`If node '${node.id}' condition must evaluate to boolean.`);
    return condition ? { branchId: "then", scope: node.then } : { branchId: "else", scope: node.else };
  }
  const selected = node.cases.findIndex(c => {
    const condition = evaluateExpr(c.when, scope);
    if (typeof condition !== "boolean") throw new Error(`Switch node '${node.id}' case condition must evaluate to boolean.`);
    return condition;
  });
  return selected >= 0
    ? { branchId: `case:${selected}`, scope: node.cases[selected]!.then }
    : { branchId: "default", scope: node.default };
}

function conditionalBranchById(node: Extract<NodeIR, { kind: "if" | "switch" }>, branchId: string): { branchId: string; scope: ScopeIR } | undefined {
  if (node.kind === "if") {
    if (branchId === "then") return { branchId, scope: node.then };
    if (branchId === "else") return { branchId, scope: node.else };
    return undefined;
  }
  if (branchId === "default") return { branchId, scope: node.default };
  const match = /^case:(\d+)$/.exec(branchId);
  if (!match) return undefined;
  const index = Number(match[1]);
  const found = node.cases[index];
  return found ? { branchId, scope: found.then } : undefined;
}

function scopeMapForScope(basePath: InstancePath, scope: ScopeIR): Record<string, string> {
  return Object.fromEntries(scope.nodes.map(node => [node.id, deriveInstanceKey(appendNode(basePath, node.id))]));
}

function evaluateOutput(output: ScopeIR["output"], scope: EvaluationScope): JsonValue {
  return normalizeWorkflowData(evaluateExpr(output, scope), "Scope output") as JsonValue;
}

function requireWorkflowOutput(value: JsonValue | undefined, label: string): JsonValue {
  if (value === undefined) throw new Error(`${label} did not produce an output.`);
  return value;
}

function expressionFailure(error: unknown): JsonObject {
  return { reason: "expression_failed", message: error instanceof Error ? error.message : String(error) };
}

function byCompletionSequence(left: GroupMember, right: GroupMember): number {
  return (left.completionSequence ?? Number.MAX_SAFE_INTEGER) - (right.completionSequence ?? Number.MAX_SAFE_INTEGER);
}

function cancellationReason(reason: string): "parent_failed" | "race_lost" | "quorum_reached" | "paused" | "superseded" | "operator_cancelled" {
  return reason === "race_lost" || reason === "quorum_reached" || reason === "paused" || reason === "superseded" || reason === "operator_cancelled"
    ? reason
    : "parent_failed";
}

function parentPath(path: InstancePath): InstancePath {
  return path.slice(0, -1);
}

function lastSegment(path: InstancePath | undefined): InstancePathSegment | undefined {
  return path?.[path.length - 1];
}

function isSchedulerLeaf(node: NodeIR): boolean {
  return node.kind === "task" || node.kind === "agent" || node.kind === "signal";
}
