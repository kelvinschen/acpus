import type { NodeIR, WorkflowIR } from "@acpus/core/ir";
import type { AgentTurnRequest, AgentTurnResult } from "@acpus/agent-executor";
import type { EvaluationScope } from "../evaluation/evaluator.js";
import type { FrozenRun, RuntimeStore } from "../store/store.js";
import { advanceRun, type AdvanceRunSummary } from "./advance.js";
import { appendNode, deriveInstanceKey } from "./identity.js";
import { bootstrapRootEvents, continueRootEvents } from "./materialize.js";
import { createRuntimeNodeExecutor } from "./node-executor.js";
import { parseDurationMs } from "../execution/duration.js";

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
    deadlineAtFor: (_instance, _projection, now) => {
      const node = nodes.get(_instance.nodeId);
      if (!node || !isSchedulerRetryLeaf(node) || node.timeout === undefined) return undefined;
      return new Date(now.getTime() + parseDurationMs(node.timeout));
    },
    bootstrap: snapshot => snapshot.projection.frames.root ? [] : bootstrapRootEvents(input.runId, frozen.ir, scope),
    materialize: snapshot => continueRootEvents(frozen.ir, snapshot.projection, scope),
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

function isSchedulerRetryLeaf(node: NodeIR): node is Extract<NodeIR, { kind: "task" | "agent" }> {
  return node.kind === "task" || node.kind === "agent";
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

function localConcurrencyLimitForRoot(ir: WorkflowIR): (groupKey: string) => number | undefined {
  const limits = new Map<string, number>();
  for (const node of ir.root.nodes) {
    if ((node.kind === "parallel" || node.kind === "fanout") && node.maxConcurrency !== undefined) {
      limits.set(deriveInstanceKey(appendNode([], node.id)), node.maxConcurrency);
    }
  }
  return groupKey => limits.get(groupKey);
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
