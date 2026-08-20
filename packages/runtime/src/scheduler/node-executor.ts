import type { AdmittedWorkflowIR, AgentNodeIR, TaskNodeIR } from "@acpus/core/ir";
import type { JsonObject, JsonValue } from "@acpus/expression/ir";
import type { Result } from "neverthrow";
import { executeAgentNode, type AgentAttemptFailure, type AgentNodeFailure } from "../execution/agent-node.js";
import { executeTaskNode, type TaskNodeFailure } from "../execution/task-executor.js";
import type { EvaluationScope } from "../evaluation/evaluator.js";
import { resolutionErrorPayload, type ResolutionError } from "../evaluation/resolvable.js";
import type { RuntimeStore } from "../store/store.js";
import type { NodeProgressWriter } from "../progress/writer.js";
import type { NodeAttemptContext, NodeExecutor } from "./advance.js";
import { scopeForNodeAttempt } from "./scope.js";
import { throwSchedulerStoreResult, type AttemptCommitInput } from "./store-port.js";
import { indexNodes } from "./ir-walk.js";
import type { AgentHostPolicy } from "../configuration.js";
import type { AgentSessionSupervisor } from "@acpus/agent-executor";
import type { AgentTurnExecutionRegistry } from "../execution/agent-turn-registry.js";

export type RuntimeNodeExecutorInput = {
  cwd: string;
  sourceRoot?: string;
  ir: AdmittedWorkflowIR;
  scope: EvaluationScope;
  store: RuntimeStore;
  agentHostPolicy: AgentHostPolicy;
  runtimeOwnerEpoch?: number;
  agentSessionSupervisor?: AgentSessionSupervisor;
  agentTurnRegistry?: AgentTurnExecutionRegistry;
  progressWriter?: NodeProgressWriter;
};

export function createRuntimeNodeExecutor(input: RuntimeNodeExecutorInput): NodeExecutor {
  const nodes = indexNodes(input.ir.root);
  return {
    async execute(context: NodeAttemptContext): Promise<AttemptCommitInput["result"]> {
      const node = nodes.get(context.nodeId);
      if (!node) throw new Error(`Node '${context.nodeId}' was not found in frozen IR.`);
      const scope = scopeForNodeAttempt(input.scope, throwSchedulerStoreResult(input.store.scheduler.tryLoadRunSnapshot(context.runId)).projection, context.nodeKey);
      if (node.kind === "task") {
        const executed = await executeTask(node, scope, context, input);
        return executed.match(
          output => output === undefined ? { status: "completed" } : { status: "completed", output },
          taskFailure,
        );
      }
      if (node.kind === "agent") {
        const executed = await executeAgent(node, scope, context, input, input.agentHostPolicy);
        return executed.match(
          output => ({ status: "completed", output }),
          agentFailure,
        );
      }
      throw new Error(`Node '${context.nodeId}' (${node.kind}) is not a scheduler leaf executor target.`);
    },
  };
}

function resolutionFailure(error: ResolutionError): AttemptCommitInput["result"] {
  return {
    status: "failed",
    reason: "expression_resolution_failed",
    error: resolutionErrorPayload(error),
  };
}

function taskFailure(failure: TaskNodeFailure): AttemptCommitInput["result"] {
  if (failure.type === "resolution") return resolutionFailure(failure.error);
  if (failure.type === "cancelled") return { status: "cancelled", reason: "paused" };
  if (failure.type === "timed_out") return { status: "timed_out", reason: failure.message };
  return { status: "failed", reason: failure.message };
}

function agentFailure(failure: AgentAttemptFailure): AttemptCommitInput["result"] {
  if (failure.type === "resolution") return resolutionFailure(failure.error);
  if (failure.type === "cancelled") return { status: "cancelled", reason: "paused" };
  const payload = agentFailurePayload(failure.failure);
  return failure.type === "timed_out"
    ? { status: "timed_out", reason: failure.failure.code, error: payload }
    : { status: "failed", reason: failure.failure.code, error: payload };
}

function agentFailurePayload(failure: AgentNodeFailure): JsonObject {
  return {
    origin: failure.origin,
    code: failure.code,
    message: failure.message,
    ...(failure.origin === "runtime" && failure.retryable !== undefined ? { retryable: failure.retryable } : {}),
    ...(failure.origin === "runtime" && failure.evidence !== undefined ? { evidence: failure.evidence as JsonValue } : {}),
    ...(failure.origin === "provider" && failure.upstream !== undefined
      ? { upstream: failure.upstream as JsonValue }
      : {}),
  };
}

async function executeTask(
  node: TaskNodeIR,
  scope: EvaluationScope,
  context: NodeAttemptContext,
  input: RuntimeNodeExecutorInput,
): Promise<Result<JsonValue | undefined, TaskNodeFailure>> {
  return executeTaskNode(node, scope, {
    cwd: input.cwd,
    sourceRoot: input.sourceRoot ?? input.cwd,
    runId: context.runId,
    attemptId: context.attemptId,
    store: input.store,
    nodeKey: context.nodeKey,
    attemptNo: context.attemptNo,
    ownerEpoch: context.ownerEpoch,
    ...(context.deadlineAt === undefined ? {} : { deadlineAt: context.deadlineAt }),
    signal: context.signal,
  });
}

async function executeAgent(node: AgentNodeIR, scope: EvaluationScope, context: NodeAttemptContext, input: RuntimeNodeExecutorInput, agentHostPolicy: AgentHostPolicy) {
  const initialPrompt = context.steer
    ? { kind: "steer" as const, steerId: context.steer.steerId, instruction: context.steer.instruction }
    : { kind: "task" as const };
  return executeAgentNode(node, scope, {
    cwd: input.cwd,
    runId: context.runId,
    agents: input.ir.agents,
    hostPolicy: agentHostPolicy,
    nodeKey: context.nodeKey,
    attemptId: context.attemptId,
    attemptNo: context.attemptNo,
    ownerEpoch: context.ownerEpoch,
    runtimeOwnerEpoch: input.runtimeOwnerEpoch ?? 0,
    ...(context.deadlineAt === undefined ? {} : { deadlineAt: context.deadlineAt }),
    store: input.store,
    ...(input.progressWriter === undefined ? {} : { progressWriter: input.progressWriter }),
    ...(input.agentSessionSupervisor === undefined ? {} : { agentSessionSupervisor: input.agentSessionSupervisor }),
    initialPrompt,
    signal: context.signal,
    ...(context.abort === undefined ? {} : { abortAttempt: context.abort }),
    ...(input.agentTurnRegistry === undefined ? {} : { agentTurnRegistry: input.agentTurnRegistry }),
  });
}
