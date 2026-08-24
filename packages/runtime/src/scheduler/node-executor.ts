import type { AdmittedWorkflowIR, AgentNodeIR, TaskNodeIR } from "@acpus/core/ir";
import type { JsonObject, JsonValue } from "@acpus/expression/ir";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { executeAgentNode, type AgentAttemptFailure, type AgentNodeFailure } from "../execution/agent-node.js";
import { executeTaskNode, type TaskNodeFailure } from "../execution/task-executor.js";
import type { EvaluationScope } from "../evaluation/evaluator.js";
import { resolutionErrorPayload, type ResolutionError } from "../evaluation/resolvable.js";
import type { RuntimeStoreAdapter } from "../store/store.js";
import { makeRuntimeStoreService, type RuntimeStoreBusy } from "../store/service.js";
import type { NodeProgressWriter } from "../progress/writer.js";
import type { NodeAttemptContext, NodeExecutor } from "./advance.js";
import { scopeForNodeAttempt } from "./scope.js";
import type { AttemptCommitInput, SchedulerStoreError } from "./store-port.js";
import { indexNodes } from "./ir-walk.js";
import type { AgentHostPolicy } from "../configuration.js";
import type { AgentSessionSupervisor } from "@acpus/agent-executor";
import type { ProcessHostShape } from "@acpus/owned-process";
import type { AgentTurnExecutionRegistry } from "../execution/agent-turn-registry.js";

export type RuntimeNodeExecutorInput = {
  cwd: string;
  sourceRoot?: string;
  ir: AdmittedWorkflowIR;
  scope: EvaluationScope;
  store: RuntimeStoreAdapter;
  agentHostPolicy: AgentHostPolicy;
  processes: ProcessHostShape;
  runtimeOwnerEpoch?: number;
  agentSessionSupervisor?: AgentSessionSupervisor;
  agentTurnRegistry?: AgentTurnExecutionRegistry;
  progressWriter?: NodeProgressWriter;
};

export function createRuntimeNodeExecutor(input: RuntimeNodeExecutorInput): NodeExecutor {
  const nodes = indexNodes(input.ir.root);
  const store = makeRuntimeStoreService(input.store);
  return {
    execute(context: NodeAttemptContext): Effect.Effect<AttemptCommitInput["result"]> {
      return Effect.gen(function* () {
      const node = nodes.get(context.nodeId);
      if (!node) throw new Error(`Node '${context.nodeId}' was not found in frozen IR.`);
      const scope = scopeForNodeAttempt(input.scope, input.store.scheduler.tryLoadRunSnapshot(context.runId).projection, context.nodeKey);
      if (node.kind === "task") {
        const executed = yield* executeTask(node, scope, context, input, store).pipe(Effect.catch(storeFailureDefect));
        return Result.match(executed, {
          onSuccess: output => output === undefined ? { status: "completed" } : { status: "completed", output },
          onFailure: taskFailure,
        });
      }
      if (node.kind === "agent") {
        const executed = yield* executeAgent(node, scope, context, input, input.agentHostPolicy);
        return Result.match(executed, {
          onSuccess: output => ({ status: "completed", output }),
          onFailure: agentFailure,
        });
      }
      throw new Error(`Node '${context.nodeId}' (${node.kind}) is not a scheduler leaf executor target.`);
      });
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

function executeTask(
  node: TaskNodeIR,
  scope: EvaluationScope,
  context: NodeAttemptContext,
  input: RuntimeNodeExecutorInput,
  store: ReturnType<typeof makeRuntimeStoreService>,
): Effect.Effect<Result.Result<JsonValue | undefined, TaskNodeFailure>, RuntimeStoreBusy | SchedulerStoreError> {
  return executeTaskNode(node, scope, {
    cwd: input.cwd,
    sourceRoot: input.sourceRoot ?? input.cwd,
    runId: context.runId,
    attemptId: context.attemptId,
    store,
    processes: input.processes,
    nodeKey: context.nodeKey,
    attemptNo: context.attemptNo,
    ownerEpoch: context.ownerEpoch,
    ...(context.deadlineAt === undefined ? {} : { deadlineAt: context.deadlineAt }),
  });
}

function executeAgent(
  node: AgentNodeIR,
  scope: EvaluationScope,
  context: NodeAttemptContext,
  input: RuntimeNodeExecutorInput,
  agentHostPolicy: AgentHostPolicy,
): Effect.Effect<Result.Result<JsonValue, AgentAttemptFailure>> {
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
    ...(context.interrupt === undefined ? {} : { abortAttempt: context.interrupt }),
    ...(input.agentTurnRegistry === undefined ? {} : { agentTurnRegistry: input.agentTurnRegistry }),
  });
}

function storeFailureDefect(error: RuntimeStoreBusy | SchedulerStoreError): Effect.Effect<never> {
  return Effect.die(error.type === "runtime-store-busy" ? error.cause : error);
}
