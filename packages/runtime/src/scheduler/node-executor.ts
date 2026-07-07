import type { AgentNodeIR, TaskNodeIR, WorkflowIR } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";
import type { AgentTurnRequest, AgentTurnResult } from "@acpus/agent-executor";
import { AgentNodeCancelledError, AgentNodeTimeoutError, executeAgentNode } from "../execution/agent-node.js";
import { executeTaskNode } from "../execution/task-executor.js";
import { assertWorkflowData } from "../evaluation/admissible.js";
import type { EvaluationScope } from "../evaluation/evaluator.js";
import type { RuntimeStore } from "../store/store.js";
import type { NodeAttemptContext, NodeExecutor } from "./advance.js";
import { scopeForNodeAttempt } from "./scope.js";
import { throwSchedulerStoreResult, type AttemptCommitInput, type SchedulerStoreResult } from "./store-port.js";
import type { SchedulerProjection } from "./types.js";
import { indexNodes } from "./ir-walk.js";

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
      if (node.kind === "task") return completedResult(await executeTask(node, scope, context, input));
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
    attemptId: context.attemptId,
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
  return scopeForNodeAttempt(base, projection, nodeKey);
}

function completedResult(output: unknown): AttemptCommitInput["result"] {
  assertWorkflowData(output, "Node output");
  return output === undefined ? { status: "completed" } : { status: "completed", output: output as JsonValue };
}
