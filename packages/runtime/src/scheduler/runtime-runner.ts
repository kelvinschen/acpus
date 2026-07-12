import { resolve } from "node:path";
import type { NodeIR } from "@acpus/core/ir";
import { ok } from "neverthrow";
import type { EvaluationScope } from "../evaluation/evaluator.js";
import { resolutionErrorPayload, tryCreateDeadline, tryResolveDuration, tryResolveString } from "../evaluation/resolvable.js";
import { buildHookContext } from "../hooks/context.js";
import { mapRuntimeEventToHookEvent } from "../hooks/events.js";
import type { HookRunner } from "../hooks/runner.js";
import type { NodeProgressWriter } from "../progress/writer.js";
import type { FrozenRun, RuntimeStore } from "../store/store.js";
import { advanceRun, type AdvanceRunInput, type AdvanceRunSummary } from "./advance.js";
import { bootstrapRootEvents, continueRootEvents } from "./materialize.js";
import { createRuntimeNodeExecutor } from "./node-executor.js";
import { indexNodes } from "./ir-walk.js";
import { scopeForNodeAttempt } from "./scope.js";
import { throwSchedulerStoreResult } from "./store-port.js";
import type { SchedulerSnapshot } from "./store-port.js";
import { applySchedulerEvents, attemptTimeoutEvents, groupCompletionEvents, signalTimeoutEvents } from "./transitions.js";
import type { SchedulerProjection } from "./types.js";
import { loadAgentHostPolicy, type AgentHostPolicy } from "../configuration.js";

export type AdvanceFrozenRunInput = {
  cwd: string;
  ownerId: string;
  runId: string;
  store: RuntimeStore;
  maxLeafConcurrency?: number;
  agentHostPolicy?: AgentHostPolicy;
  onClaim?: AdvanceRunInput["onClaim"];
  onRelease?: AdvanceRunInput["onRelease"];
  onActiveAttempt?: AdvanceRunInput["onActiveAttempt"];
  hookRunner?: HookRunner;
  hookCursor?: RuntimeHookCursor;
  progressWriter?: NodeProgressWriter;
};

export type RuntimeHookCursor = { sequence: number };

export async function advanceFrozenRun(input: AdvanceFrozenRunInput): Promise<AdvanceRunSummary> {
  const frozen = input.store.getFrozenRun(input.runId);
  if (!frozen) throw new Error(`Run '${input.runId}' has no frozen workflow.`);
  const scope = rootScope(frozen);
  const nodes = indexNodes(frozen.ir.root);
  const hookCursor = input.hookCursor ?? { sequence: input.store.getLastRunEventSequence(input.runId) };
  const agentHostPolicy = input.agentHostPolicy ?? loadAgentHostPolicy(process.env);
  const summary = await advanceRun({
    runId: input.runId,
    ownerId: input.ownerId,
    store: input.store.scheduler,
    ...(input.maxLeafConcurrency === undefined ? {} : { maxLeafConcurrency: input.maxLeafConcurrency }),
    localConcurrencyLimitFor: (_groupKey, projection) => projection.groups[_groupKey]?.maxConcurrency,
    awaitableEventsFor: (instance, projection, now) => {
      const node = nodes.get(instance.nodeId);
      const attemptScope = scopeForNodeAttempt(scope, projection, instance.nodeKey);
      const timeout = node?.kind === "signal" && node.timeout !== undefined
        ? tryResolveDuration(node.timeout, attemptScope, `Signal node '${node.id}' timeout`)
        : undefined;
      const deadline = node?.kind === "signal" && timeout?.isOk()
        ? tryCreateDeadline(now, timeout.value.milliseconds, `Signal node '${node.id}' timeout`)
        : undefined;
      const deadlineAt = deadline?.isOk() ? deadline.value.toISOString() : undefined;
      const prompt = node?.kind === "signal"
        ? tryResolveString(node.run.prompt, attemptScope, `Signal node '${node.id}' prompt`)
        : undefined;
      const timeoutMessage = node?.kind === "signal" && node.onTimeout?.message !== undefined
        ? tryResolveString(node.onTimeout.message, attemptScope, `Signal node '${node.id}' onTimeout message`)
        : undefined;
      const resolutionError = timeout?.isErr() ? timeout.error : deadline?.isErr() ? deadline.error : prompt?.isErr() ? prompt.error : timeoutMessage?.isErr() ? timeoutMessage.error : undefined;
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
      if (!node || !isSchedulerRetryLeaf(node) || _instance.timeoutMs === undefined) return ok(undefined);
      return tryCreateDeadline(now, _instance.timeoutMs, `${node.kind} node '${node.id}' timeout`)
        .mapErr(error => ({
          status: "failed" as const,
          reason: "expression_resolution_failed",
          error: resolutionErrorPayload(error),
        }));
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
      agentHostPolicy,
      ...(input.progressWriter === undefined ? {} : { progressWriter: input.progressWriter }),
    }),
  });
  triggerHooksForCommittedRows({ ...input, frozen, hookCursor });
  return summary;
}

function triggerHooksForCommittedRows(input: {
  cwd: string;
  runId: string;
  store: RuntimeStore;
  hookRunner?: HookRunner;
  frozen: FrozenRun;
  hookCursor: RuntimeHookCursor;
}): void {
  if (!input.hookRunner) return;
  let rows: ReturnType<RuntimeStore["getCommittedRuntimeEventsAfter"]>;
  try {
    rows = input.store.getCommittedRuntimeEventsAfter(input.runId, input.hookCursor.sequence);
  } catch {
    return;
  }
  if (rows.length === 0) return;
  input.hookCursor.sequence = rows.at(-1)!.sequence;
  let projection: SchedulerProjection;
  try {
    projection = throwSchedulerStoreResult(input.store.scheduler.tryLoadRunSnapshot(input.runId)).projection;
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
  hookCursor: RuntimeHookCursor;
}): void {
  if (!input.hookRunner) return;
  const frozen = input.store.getFrozenRun(input.runId);
  if (!frozen) return;
  triggerHooksForCommittedRows({
    ...input,
    frozen,
  });
}

export function settleFrozenRunTransitions(input: {
  store: RuntimeStore;
  runId: string;
  ownerEpoch: number;
  now?: Date;
}): SchedulerSnapshot {
  const frozen = input.store.getFrozenRun(input.runId);
  if (!frozen) throw new Error(`Run '${input.runId}' has no frozen workflow.`);
  const scope = rootScope(frozen);
  const current = throwSchedulerStoreResult(input.store.scheduler.tryLoadRunSnapshot(input.runId));
  let projection = current.projection;
  const events = [];
  for (let batches = 0; batches < 1_000; batches += 1) {
    const derived = Object.keys(projection.groups).flatMap(groupKey => groupCompletionEvents(projection, groupKey));
    if (derived.length === 0) derived.push(...continueRootEvents(frozen.ir, projection, scope));
    if (derived.length === 0) derived.push(...attemptTimeoutEvents(projection, input.now ?? new Date()));
    if (derived.length === 0) derived.push(...signalTimeoutEvents(projection, input.now ?? new Date()));
    if (derived.length === 0) {
      if (events.length === 0) return current;
      return throwSchedulerStoreResult(input.store.scheduler.tryAppendSchedulerEvents({
        runId: input.runId,
        ownerEpoch: input.ownerEpoch,
        expectedVersion: current.version,
        idempotencyKey: `scheduler:settle-control:${input.runId}:${current.version}`,
        events,
      }));
    }
    events.push(...derived);
    projection = applySchedulerEvents(projection, derived);
  }
  throw new Error(`Run '${input.runId}' did not quiesce after 1000 control-settlement transition batches.`);
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
