import type { AgentNodeIR, NodeIR, TaskNodeIR, WorkflowIR } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";
import type { AgentTurnRequest, AgentTurnResult } from "@acpus/agent-executor";
import { AgentNodeCancelledError, AgentNodeTimeoutError, executeAgentNode } from "../execution/agent-node.js";
import { executeTaskNode } from "../execution/task-executor.js";
import type { EvaluationScope } from "../evaluation/evaluator.js";
import { normalizeValue } from "../evaluation/schema.js";
import type { RuntimeStore } from "../store/store.js";
import type { NodeAttemptContext, NodeExecutor } from "./advance.js";
import { throwSchedulerStoreResult, type AttemptCommitInput, type SchedulerStoreResult } from "./store-port.js";
import type { SchedulerProjection } from "./types.js";

export type RuntimeNodeExecutorInput = {
  cwd: string;
  ir: WorkflowIR;
  scope: EvaluationScope;
  store: RuntimeStore;
  executeAgentTurn?: (request: AgentTurnRequest) => Promise<AgentTurnResult>;
  agentRepairDelayMs?: number;
};

export function createRuntimeNodeExecutor(input: RuntimeNodeExecutorInput): NodeExecutor {
  const nodes = indexNodes(input.ir.root);
  return {
    async execute(context: NodeAttemptContext): Promise<AttemptCommitInput["result"]> {
      const node = nodes.get(context.nodeId);
      if (!node) return { status: "failed", reason: `Node '${context.nodeId}' was not found in frozen IR.` };
      const scope = scopeForAttempt(input.scope, unwrapStoreResult(input.store.scheduler.tryLoadRunSnapshot(context.runId)).projection, context.nodeKey);
      if (node.kind === "task") return completedResult(normalizeValue(node.outputSchema, await executeTask(node, scope, context, input) as JsonValue, `Node '${node.id}' output`));
      if (node.kind === "agent") {
        try {
          return completedResult(await executeAgent(node, scope, context, input));
        } catch (error) {
          if (error instanceof AgentNodeCancelledError) return { status: "cancelled", reason: "paused" };
          if (error instanceof AgentNodeTimeoutError) return { status: "timed_out", reason: error.message };
          throw error;
        }
      }
      return { status: "failed", reason: `Node '${context.nodeId}' (${node.kind}) is not a scheduler leaf executor target.` };
    },
  };
}

function unwrapStoreResult<T>(result: SchedulerStoreResult<T>): T {
  return throwSchedulerStoreResult(result);
}

async function executeTask(node: TaskNodeIR, scope: EvaluationScope, context: NodeAttemptContext, input: RuntimeNodeExecutorInput): Promise<unknown> {
  return executeTaskNode(node, scope, {
    cwd: input.cwd,
    runId: context.runId,
    store: input.store,
    nodeKey: context.nodeKey,
    attemptNo: context.attemptNo,
    signal: context.signal,
  });
}

async function executeAgent(node: AgentNodeIR, scope: EvaluationScope, context: NodeAttemptContext, input: RuntimeNodeExecutorInput): Promise<unknown> {
  return executeAgentNode(node, scope, {
    cwd: input.cwd,
    runId: context.runId,
    agents: input.ir.agents,
    nodeKey: context.nodeKey,
    attemptId: context.attemptId,
    attemptNo: context.attemptNo,
    store: input.store,
    initialPromptKind: context.attemptStartReason === "control_retry" || context.attemptStartReason === "pause_resume" ? "plain_continuation" : "task",
    signal: context.signal,
    ...(input.executeAgentTurn ? { executeTurn: input.executeAgentTurn } : {}),
    ...(input.agentRepairDelayMs === undefined ? {} : { repairDelayMs: input.agentRepairDelayMs }),
  });
}

function scopeForAttempt(base: EvaluationScope, projection: SchedulerProjection, nodeKey: string): EvaluationScope {
  const instance = projection.instances[nodeKey];
  const rootScope = completedRootNodeScope(base, projection);
  const scoped = instance?.parentFrameKey && instance.parentFrameKey !== "root"
    ? completedFrameNodeScope(rootScope, projection, instance.parentFrameKey)
    : rootScope;
  const loopSegment = instance?.instancePath.find(segment => segment.kind === "loop");
  if (loopSegment) {
    const loopFrame = Object.values(projection.frames).find(frame => frame.nodeId === loopSegment.nodeId && frame.frameKind === "loop");
    return {
      ...scoped,
      loop: {
        ...scoped.loop,
        [loopSegment.nodeId]: {
          iter: loopSegment.iter,
          ...(loopFrame?.loop?.previous === undefined ? {} : { previous: loopFrame.loop.previous }),
        },
      },
    };
  }
  const member = projection.groupMembers[nodeKey]
    ?? (instance?.parentFrameKey === undefined ? undefined : projection.groupMembers[instance.parentFrameKey]);
  if (!member || member.memberKind !== "fanout_item") return scoped;
  const group = projection.groups[member.groupKey];
  if (!group || group.kind !== "fanout") return scoped;
  return {
    ...scoped,
    fanout: {
      ...scoped.fanout,
      [group.nodeId]: {
        item: member.item,
        itemIndex: member.itemIndex,
      },
    },
  };
}

function completedFrameNodeScope(base: EvaluationScope, projection: SchedulerProjection, parentFrameKey: string): EvaluationScope {
  const nodes: NonNullable<EvaluationScope["nodes"]> = { ...base.nodes };
  for (const instance of Object.values(projection.instances)) {
    if (instance.parentFrameKey === parentFrameKey && instance.status === "completed") {
      nodes[instance.nodeId] = { status: "completed", output: instance.output };
    }
  }
  return { ...base, nodes };
}

function completedRootNodeScope(base: EvaluationScope, projection: SchedulerProjection): EvaluationScope {
  const nodes: NonNullable<EvaluationScope["nodes"]> = { ...base.nodes };
  for (const instance of Object.values(projection.instances)) {
    if (instance.parentFrameKey === "root" && instance.status === "completed") {
      nodes[instance.nodeId] = { status: "completed", output: instance.output };
    }
  }
  for (const frame of Object.values(projection.frames)) {
    if (frame.parentFrameKey === "root" && frame.nodeId && frame.status === "completed") {
      nodes[frame.nodeId] = { status: "completed", output: frame.result };
    }
  }
  return { ...base, nodes };
}

function completedResult(output: unknown): AttemptCommitInput["result"] {
  return output === undefined ? { status: "completed" } : { status: "completed", output: output as JsonValue };
}

function indexNodes(scope: WorkflowIR["root"], nodes = new Map<string, NodeIR>()): Map<string, NodeIR> {
  for (const node of scope.nodes) {
    nodes.set(node.id, node);
    if (node.kind === "if") {
      indexNodes(node.then, nodes);
      if (node.else) indexNodes(node.else, nodes);
    } else if (node.kind === "switch") {
      for (const c of node.cases) indexNodes(c.then, nodes);
      if (node.default) indexNodes(node.default, nodes);
    } else if (node.kind === "parallel") {
      for (const branch of Object.values(node.branches)) indexNodes(branch.scope, nodes);
    } else if (node.kind === "fanout" || node.kind === "loop") {
      indexNodes(node.do, nodes);
    }
  }
  return nodes;
}
