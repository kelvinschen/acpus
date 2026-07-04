import type { NodeIR, WorkflowIR } from "@acpus/core/ir";
import type { AgentTurnRequest, AgentTurnResult } from "@acpus/agent-executor";
import type { EvaluationScope } from "../evaluation/evaluator.js";
import type { FrozenRun, RuntimeStore } from "../store/store.js";
import { advanceRun, drainDerivedTransitions, type AdvanceRunInput, type AdvanceRunSummary } from "./advance.js";
import { bootstrapRootEvents, continueRootEvents } from "./materialize.js";
import { createRuntimeNodeExecutor } from "./node-executor.js";
import { parseDurationMs } from "../execution/duration.js";
import { indexNodes } from "./ir-walk.js";
import { renderTemplate } from "../evaluation/evaluator.js";
import { scopeForNodeAttempt } from "./scope.js";

export type AdvanceFrozenRunInput = {
  cwd: string;
  ownerId: string;
  runId: string;
  store: RuntimeStore;
  leaseMs?: number;
  maxLeafConcurrency?: number;
  now?: () => Date;
  executeAgentTurn?: (request: AgentTurnRequest) => Promise<AgentTurnResult>;
  agentRepairDelayMs?: number;
  onClaim?: AdvanceRunInput["onClaim"];
  onRelease?: AdvanceRunInput["onRelease"];
  onActiveAttempt?: AdvanceRunInput["onActiveAttempt"];
};

export async function advanceFrozenRun(input: AdvanceFrozenRunInput): Promise<AdvanceRunSummary> {
  const frozen = input.store.getFrozenRun(input.runId);
  if (!frozen) throw new Error(`Run '${input.runId}' has no frozen workflow.`);
  const scope = rootScope(frozen);
  const nodes = indexNodes(frozen.ir.root);
  return advanceRun({
    runId: input.runId,
    ownerId: input.ownerId,
    store: input.store.scheduler,
    ...(input.leaseMs === undefined ? {} : { leaseMs: input.leaseMs }),
    ...(input.maxLeafConcurrency === undefined ? {} : { maxLeafConcurrency: input.maxLeafConcurrency }),
    ...(input.now === undefined ? {} : { now: input.now }),
    localConcurrencyLimitFor: localConcurrencyLimitForRoot(frozen.ir),
    maxAttemptsFor: () => undefined,
    awaitableEventsFor: (instance, projection, now) => {
      const node = nodes.get(instance.nodeId);
      const deadlineAt = node?.kind === "signal" && node.timeout !== undefined
        ? new Date(now.getTime() + parseDurationMs(node.timeout)).toISOString()
        : undefined;
      return node?.kind === "signal"
        ? [
          { type: "instance.awaiting", payload: { nodeKey: instance.nodeKey, statusReason: "signal" } },
          {
            type: "signal.awaiting",
            payload: {
              runId: input.runId,
              nodeKey: instance.nodeKey,
              nodeId: instance.nodeId,
              ...(deadlineAt === undefined ? {} : { deadlineAt }),
              ...(node.onTimeout?.message === undefined ? {} : { timeoutMessage: node.onTimeout.message }),
              renderedPrompt: renderTemplate(node.run.prompt, scopeForNodeAttempt(scope, projection, instance.nodeKey)),
            },
          },
        ]
        : [];
    },
    deadlineAtFor: (_instance, _projection, now) => {
      const node = nodes.get(_instance.nodeId);
      if (!node || !isSchedulerRetryLeaf(node) || node.timeout === undefined) return undefined;
      return new Date(now.getTime() + parseDurationMs(node.timeout));
    },
    bootstrap: snapshot => snapshot.projection.frames.root ? [] : bootstrapRootEvents(input.runId, frozen.ir, scope),
    materialize: snapshot => continueRootEvents(frozen.ir, snapshot.projection, scope),
    ...(input.onClaim === undefined ? {} : { onClaim: input.onClaim }),
    ...(input.onRelease === undefined ? {} : { onRelease: input.onRelease }),
    ...(input.onActiveAttempt === undefined ? {} : { onActiveAttempt: input.onActiveAttempt }),
    executor: createRuntimeNodeExecutor({
      cwd: input.cwd,
      ir: frozen.ir,
      scope,
      store: input.store,
      ...(input.executeAgentTurn ? { executeAgentTurn: input.executeAgentTurn } : {}),
      ...(input.agentRepairDelayMs === undefined ? {} : { agentRepairDelayMs: input.agentRepairDelayMs }),
    }),
  });
}

export function drainFrozenRunTransitions(input: {
  store: RuntimeStore;
  runId: string;
  ownerEpoch: number;
  now?: () => Date;
}) {
  const frozen = input.store.getFrozenRun(input.runId);
  if (!frozen) throw new Error(`Run '${input.runId}' has no frozen workflow.`);
  const scope = rootScope(frozen);
  return drainDerivedTransitions(
    input.store.scheduler,
    input.runId,
    { runId: input.runId, ownerEpoch: input.ownerEpoch },
    input.now ?? (() => new Date()),
    snapshot => continueRootEvents(frozen.ir, snapshot.projection, scope),
    () => undefined,
  );
}

function isSchedulerRetryLeaf(node: NodeIR): node is Extract<NodeIR, { kind: "task" | "agent" }> {
  return node.kind === "task" || node.kind === "agent";
}

function localConcurrencyLimitForRoot(ir: WorkflowIR): NonNullable<AdvanceRunInput["localConcurrencyLimitFor"]> {
  const limits = new Map<string, number>();
  for (const node of indexNodes(ir.root).values()) {
    if ((node.kind === "parallel" || node.kind === "fanout") && node.maxConcurrency !== undefined) {
      limits.set(node.id, node.maxConcurrency);
    }
  }
  return (groupKey, projection) => {
    const group = projection.groups[groupKey];
    return group ? limits.get(group.nodeId) : undefined;
  };
}

function rootScope(frozen: FrozenRun): EvaluationScope {
  return {
    input: frozen.input,
    nodes: {},
    meta: frozen.meta,
    fanout: {},
    loop: {},
  };
}
