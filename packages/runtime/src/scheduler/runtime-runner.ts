import { resolve } from "node:path";
import type { NodeIR, WorkflowIR } from "@acpus/core/ir";
import type { AgentTurnRequest, AgentTurnResult } from "@acpus/agent-executor";
import type { EvaluationScope } from "../evaluation/evaluator.js";
import { buildHookContext } from "../hooks/context.js";
import { mapRuntimeEventToHookEvent } from "../hooks/events.js";
import type { HookRunner } from "../hooks/runner.js";
import type { NodeProgressWriter } from "../progress/writer.js";
import type { FrozenRun, RuntimeStore } from "../store/store.js";
import { advanceRun, drainDerivedTransitions, type AdvanceRunInput, type AdvanceRunSummary } from "./advance.js";
import { bootstrapRootEvents, continueRootEvents } from "./materialize.js";
import { createRuntimeNodeExecutor } from "./node-executor.js";
import { indexNodes } from "./ir-walk.js";
import { scopeForNodeAttempt } from "./scope.js";
import { resolutionErrorPayload, tryResolveDuration, tryResolveString } from "../evaluation/resolvable.js";
import type { TaskAttemptRunner } from "../execution/task-process.js";

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
  hookRunner?: HookRunner;
  progressWriter?: NodeProgressWriter;
  taskAttemptRunner?: TaskAttemptRunner;
};

export async function advanceFrozenRun(input: AdvanceFrozenRunInput): Promise<AdvanceRunSummary> {
  const frozen = input.store.getFrozenRun(input.runId);
  if (!frozen) throw new Error(`Run '${input.runId}' has no frozen workflow.`);
  const scope = rootScope(frozen);
  const nodes = indexNodes(frozen.ir.root);
  const eventCursor = input.store.getLastRunEventSequence(input.runId);
  const summary = await advanceRun({
    runId: input.runId,
    ownerId: input.ownerId,
    store: input.store.scheduler,
    ...(input.leaseMs === undefined ? {} : { leaseMs: input.leaseMs }),
    ...(input.maxLeafConcurrency === undefined ? {} : { maxLeafConcurrency: input.maxLeafConcurrency }),
    ...(input.now === undefined ? {} : { now: input.now }),
    localConcurrencyLimitFor: (_groupKey, projection) => projection.groups[_groupKey]?.maxConcurrency,
    maxAttemptsFor: () => undefined,
    awaitableEventsFor: (instance, projection, now) => {
      const node = nodes.get(instance.nodeId);
      const attemptScope = scopeForNodeAttempt(scope, projection, instance.nodeKey);
      const timeout = node?.kind === "signal" && node.timeout !== undefined
        ? tryResolveDuration(node.timeout, attemptScope, `Signal node '${node.id}' timeout`)
        : undefined;
      const deadlineAt = timeout?.isOk()
        ? new Date(now.getTime() + timeout.value.milliseconds).toISOString()
        : undefined;
      const prompt = node?.kind === "signal"
        ? tryResolveString(node.run.prompt, attemptScope, `Signal node '${node.id}' prompt`)
        : undefined;
      const timeoutMessage = node?.kind === "signal" && node.onTimeout?.message !== undefined
        ? tryResolveString(node.onTimeout.message, attemptScope, `Signal node '${node.id}' onTimeout message`)
        : undefined;
      const resolutionError = timeout?.isErr() ? timeout.error : prompt?.isErr() ? prompt.error : timeoutMessage?.isErr() ? timeoutMessage.error : undefined;
      const renderedPrompt = prompt?.isOk() ? prompt.value : undefined;
      const renderedTimeoutMessage = timeoutMessage?.isOk() ? timeoutMessage.value : undefined;
      return node?.kind === "signal"
        ? resolutionError
          ? [{ type: "instance.failed", payload: { nodeKey: instance.nodeKey, error: resolutionErrorPayload(resolutionError), statusReason: "expression_resolution_failed" } }]
          : [
          { type: "instance.awaiting", payload: { nodeKey: instance.nodeKey, statusReason: "signal" } },
          {
            type: "signal.awaiting",
            payload: {
              runId: input.runId,
              nodeKey: instance.nodeKey,
              nodeId: instance.nodeId,
              ...(deadlineAt === undefined ? {} : { deadlineAt }),
              ...(renderedTimeoutMessage === undefined ? {} : { timeoutMessage: renderedTimeoutMessage }),
              ...(renderedPrompt === undefined ? {} : { renderedPrompt }),
            },
          },
        ]
        : [];
    },
    deadlineAtFor: (_instance, _projection, now) => {
      const node = nodes.get(_instance.nodeId);
      if (!node || !isSchedulerRetryLeaf(node) || _instance.timeoutMs === undefined) return undefined;
      return new Date(now.getTime() + _instance.timeoutMs);
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
      ...(input.progressWriter === undefined ? {} : { progressWriter: input.progressWriter }),
      ...(input.executeAgentTurn ? { executeAgentTurn: input.executeAgentTurn } : {}),
      ...(input.agentRepairDelayMs === undefined ? {} : { agentRepairDelayMs: input.agentRepairDelayMs }),
      ...(input.taskAttemptRunner === undefined ? {} : { taskAttemptRunner: input.taskAttemptRunner }),
    }),
  });
  triggerHooksForCommittedRows({ ...input, frozen, afterSequence: eventCursor });
  return summary;
}

export function triggerHooksForCommittedRows(input: {
  cwd: string;
  runId: string;
  store: RuntimeStore;
  hookRunner?: HookRunner;
  frozen: FrozenRun;
  afterSequence: number;
}): void {
  if (!input.hookRunner) return;
  let rows: ReturnType<RuntimeStore["getCommittedRuntimeEventsAfter"]>;
  try {
    rows = input.store.getCommittedRuntimeEventsAfter(input.runId, input.afterSequence);
  } catch {
    return;
  }
  if (rows.length === 0) return;
  let projection: ReturnType<RuntimeStore["scheduler"]["loadRunSnapshot"]>["projection"];
  try {
    projection = input.store.scheduler.loadRunSnapshot(input.runId).projection;
  } catch {
    return;
  }
  let executionMetadata: ReturnType<RuntimeStore["getExecutionMetadata"]> = [];
  try {
    executionMetadata = input.store.getExecutionMetadata(input.runId);
  } catch {
    // Hooks still run without optional effective attempt values.
  }
  for (const row of rows) {
    try {
      const hookEvent = mapRuntimeEventToHookEvent(row);
      if (!hookEvent) continue;
      const context = buildHookContext({
        row,
        hookEvent,
        projection,
        ir: input.frozen.ir,
        workspaceDir: input.frozen.meta.workspaceDir ?? input.cwd,
        workflowPath: resolve(input.cwd, input.frozen.meta.workflowPath ?? ""),
        executionMetadata,
      });
      input.hookRunner.trigger(hookEvent, context);
    } catch {
      // Hooks are non-interfering; context construction failures skip the hook.
    }
  }
}

export function triggerHooksForCommittedRowsForRun(input: {
  cwd: string;
  runId: string;
  store: RuntimeStore;
  hookRunner?: HookRunner;
  afterSequence: number;
}): void {
  if (!input.hookRunner) return;
  const frozen = input.store.getFrozenRun(input.runId);
  if (!frozen) return;
  triggerHooksForCommittedRows({
    ...input,
    frozen,
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

function rootScope(frozen: FrozenRun): EvaluationScope {
  return {
    input: frozen.input,
    nodes: {},
    meta: frozen.meta,
    fanout: {},
    loop: {},
  };
}
