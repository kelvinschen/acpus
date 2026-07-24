import { resolve } from "node:path";
import type { NodeIR } from "@acpus/core/ir";
import { err, ok, type Result } from "neverthrow";
import { resolutionErrorPayload, tryCreateDeadline, tryResolveDuration, tryResolveString } from "../evaluation/resolvable.js";
import { buildHookContext } from "../hooks/context.js";
import { mapRuntimeEventToHookEvent } from "../hooks/events.js";
import type { HookRunner } from "../hooks/runner.js";
import type { NodeProgressWriter } from "../progress/writer.js";
import { isRuntimeStoreBusyError, type FrozenRun, type RuntimeStore } from "../store/store.js";
import { advanceRun, type AdvanceRunInput, type AdvanceRunSummary } from "./advance.js";
import { bootstrapRootEvents, continueRootEvents } from "./materialize.js";
import { createRuntimeNodeExecutor } from "./node-executor.js";
import { indexNodes } from "./ir-walk.js";
import { scopeForNodeAttempt } from "./scope.js";
import { frozenRunScope, settleFrozenProjection } from "./settle.js";
import { throwSchedulerStoreResult } from "./store-port.js";
import type { SchedulerSnapshot } from "./store-port.js";
import { loadAgentHostPolicy, type AgentHostPolicy } from "../configuration.js";
import { readVerifiedArtifactBytes } from "../artifacts/path.js";
import { createVersionedWakeup } from "./wakeup.js";

export type AdvanceFrozenRunInput = {
  cwd: string;
  ownerId: string;
  runId: string;
  store: RuntimeStore;
  maxLeafConcurrency?: number;
  agentHostPolicy?: AgentHostPolicy;
  onClaim?: AdvanceRunInput["onClaim"];
  onRelease?: AdvanceRunInput["onRelease"];
  wakeup?: AdvanceRunInput["wakeup"];
  shouldStop?: AdvanceRunInput["shouldStop"];
  hookRunner?: HookRunner;
  shouldDispatchHooks?: (runId: string) => boolean;
  onHookIncident?: (runId: string, error: unknown) => void;
  progressWriter?: NodeProgressWriter;
};

type RunExecutionExitStatus = "completed" | "failed" | "canceled" | "paused" | "awaiting" | "lease_lost";

export type RunExecutionExit = Omit<AdvanceRunSummary, "status"> & {
  status: RunExecutionExitStatus;
};

export type RunExecutionFailure = {
  type: "store-busy";
  runId: string;
  message: string;
};

export type RunExecution = {
  ownerEpoch: Promise<number | undefined>;
  result: Promise<Result<RunExecutionExit, RunExecutionFailure>>;
  wake(): void;
  stop(): void;
};

export type RuntimeRunScheduler = {
  start(input: { runId: string; ownerId: string }): RunExecution;
};

export function createRuntimeRunScheduler(input: {
  cwd: string;
  store: RuntimeStore;
  maxLeafConcurrency: number;
  agentHostPolicy: AgentHostPolicy;
  hookRunner?: HookRunner;
  shouldDispatchHooks?: (runId: string) => boolean;
  onHookIncident?: (runId: string, error: unknown) => void;
  progressWriter?: NodeProgressWriter;
}): RuntimeRunScheduler {
  return {
    start: identity => {
      const wakeup = createVersionedWakeup();
      const ownerEpoch = deferred<number | undefined>();
      let ownerResolved = false;
      let stopped = false;
      const settleOwner = (value: number | undefined) => {
        if (ownerResolved) return;
        ownerResolved = true;
        ownerEpoch.resolve(value);
      };
      const result = (async (): Promise<Result<RunExecutionExit, RunExecutionFailure>> => {
        try {
          const advanced = await advanceFrozenRun({
            cwd: input.cwd,
            store: input.store,
            runId: identity.runId,
            ownerId: identity.ownerId,
            maxLeafConcurrency: input.maxLeafConcurrency,
            agentHostPolicy: input.agentHostPolicy,
            wakeup,
            shouldStop: () => stopped,
            onClaim: claim => settleOwner(claim.ownerEpoch),
            ...(input.hookRunner === undefined ? {} : { hookRunner: input.hookRunner }),
            ...(input.shouldDispatchHooks === undefined ? {} : { shouldDispatchHooks: input.shouldDispatchHooks }),
            ...(input.onHookIncident === undefined ? {} : { onHookIncident: input.onHookIncident }),
            ...(input.progressWriter === undefined ? {} : { progressWriter: input.progressWriter }),
          });
          return ok(runExecutionExit(identity.runId, advanced));
        } catch (error) {
          if (isRuntimeStoreBusyError(error)) {
            return err({ type: "store-busy", runId: identity.runId, message: "Runtime store is busy. Retry the run on a later daemon tick." });
          }
          throw error;
        } finally {
          settleOwner(undefined);
        }
      })();
      return {
        ownerEpoch: ownerEpoch.promise,
        result,
        wake: () => wakeup.wake(),
        stop: () => {
          stopped = true;
          wakeup.wake();
        },
      };
    },
  };
}

function runExecutionExit(runId: string, summary: AdvanceRunSummary): RunExecutionExit {
  switch (summary.status) {
    case "completed":
    case "failed":
    case "canceled":
    case "paused":
    case "awaiting":
    case "lease_lost":
      return { ...summary, status: summary.status };
    case "idle":
      throw new Error(`Run '${runId}' became non-terminal without active work or a durable wake source.`);
  }
}

export async function advanceFrozenRun(input: AdvanceFrozenRunInput): Promise<AdvanceRunSummary> {
  const frozen = input.store.getFrozenRun(input.runId);
  if (!frozen) throw new Error(`Run '${input.runId}' has no frozen workflow.`);
  const scope = frozenRunScope(frozen);
  const nodes = indexNodes(frozen.ir.root);
  const signalNodeIds = new Set([...nodes.values()].filter(node => node.kind === "signal").map(node => node.id));
  const agentHostPolicy = input.agentHostPolicy ?? loadAgentHostPolicy(process.env);
  const summary = await advanceRun({
    runId: input.runId,
    ownerId: input.ownerId,
    store: input.store.scheduler,
    ...(input.maxLeafConcurrency === undefined ? {} : { maxLeafConcurrency: input.maxLeafConcurrency }),
    signalNodeIds,
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
    ...(input.wakeup === undefined ? {} : { wakeup: input.wakeup }),
    ...(input.shouldStop === undefined ? {} : { shouldStop: input.shouldStop }),
    onCheckpoint: () => dispatchHooksAtCheckpoint({ ...input, frozen }),
    executor: createRuntimeNodeExecutor({
      cwd: input.cwd,
      ir: frozen.ir,
      scope,
      store: input.store,
      sourceRoot: frozen.sourceRoot ?? input.cwd,
      agentHostPolicy,
      ...(input.progressWriter === undefined ? {} : { progressWriter: input.progressWriter }),
    }),
  });
  dispatchHooksAtCheckpoint({ ...input, frozen });
  return summary;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

export type HookDispatchRetry = {
  type: "hook-dispatch-retry";
  runId: string;
  stage: "read-cursor" | "read-events" | "load-projection" | "load-metadata" | "advance-cursor";
  message: string;
};

export type HookDispatchProgress = {
  runId: string;
  eventSequence: number;
  dispatched: number;
};

function dispatchCommittedHooks(input: {
  cwd: string;
  runId: string;
  store: RuntimeStore;
  hookRunner?: HookRunner;
  frozen: FrozenRun;
}): Result<HookDispatchProgress, HookDispatchRetry> {
  let dispatched = 0;
  for (;;) {
    const cursor = hookDispatchStage(input.runId, "read-cursor", () => input.store.getHookDispatchCursor(input.runId));
    if (cursor.isErr()) return err(cursor.error);
    const read = hookDispatchStage(input.runId, "read-events", () => input.store.readHookDispatchEvents(input.runId, cursor.value));
    if (read.isErr()) return err(read.error);
    if (cursor.value > read.value.lastSequence) {
      throw new Error(`Run '${input.runId}' hook dispatch cursor ${cursor.value} exceeds committed event sequence ${read.value.lastSequence}.`);
    }
    const row = read.value.events[0];
    if (!row) {
      if (cursor.value !== read.value.lastSequence) {
        throw new Error(`Run '${input.runId}' hook dispatch cursor ${cursor.value} has no next committed event before sequence ${read.value.lastSequence}.`);
      }
      return ok({ runId: input.runId, eventSequence: cursor.value, dispatched });
    }
    if (row.sequence !== cursor.value + 1) {
      throw new Error(`Run '${input.runId}' hook dispatch event sequence jumps from ${cursor.value} to ${row.sequence}.`);
    }

    const hookEvent = mapRuntimeEventToHookEvent(row);
    let prepared: { event: NonNullable<typeof hookEvent>; context: ReturnType<typeof buildHookContext> } | undefined;
    if (hookEvent && input.hookRunner) {
      const projection = hookDispatchStage(input.runId, "load-projection", () => throwSchedulerStoreResult(input.store.scheduler.tryLoadRunSnapshot(input.runId)).projection);
      if (projection.isErr()) return err(projection.error);
      const context = hookDispatchStage(input.runId, "load-metadata", () => {
        const metadata = input.store.getExecutionMetadata(input.runId);
        const payload = objectValue(row.payload);
        const attemptId = typeof payload?.attemptId === "string" ? payload.attemptId : undefined;
        const agentPrompts = loadAgentPrompts(input.cwd, input.store, input.runId, metadata, attemptId);
        return buildHookContext({
          row,
          hookEvent,
          projection: projection.value,
          ir: input.frozen.ir,
          workspaceDir: input.frozen.meta.workspaceDir ?? input.cwd,
          workflowPath: resolve(input.cwd, input.frozen.meta.workflowPath ?? ""),
          executionMetadata: metadata,
          agentPrompts,
        });
      });
      if (context.isErr()) return err(context.error);
      prepared = {
        event: hookEvent,
        context: context.value,
      };
    }

    const advanced = hookDispatchStage(input.runId, "advance-cursor", () => input.store.compareAndSetHookDispatchCursor(input.runId, cursor.value, row.sequence));
    if (advanced.isErr()) return err(advanced.error);
    if (!advanced.value) continue;
    if (prepared) {
      try {
        input.hookRunner!.trigger(prepared.event, prepared.context);
      } catch {
        // Hook observers are terminal side effects; their failure never rolls back the durable cursor.
      }
      dispatched += 1;
    }
  }
}

function loadAgentPrompts(
  cwd: string,
  store: RuntimeStore,
  runId: string,
  rows: ReturnType<RuntimeStore["getExecutionMetadata"]>,
  attemptId: string | undefined,
): Map<string, string> {
  const prompts = new Map<string, string>();
  if (!attemptId) return prompts;
  for (const row of rows) {
    if (row.kind !== "agent_attempt" || row.attemptId !== attemptId) continue;
    const metadata = objectValue(row.metadata);
    const firstTurn = Array.isArray(metadata?.turns) ? objectValue(metadata.turns[0]) : undefined;
    const turnArtifact = objectValue(firstTurn?.turnArtifact);
    const artifactId = typeof turnArtifact?.artifactId === "string" ? turnArtifact.artifactId : undefined;
    if (!artifactId) continue;
    const artifact = objectValue(JSON.parse(readVerifiedArtifactBytes({ cwd, runId, store }, artifactId).toString("utf8")));
    if (!artifact || typeof artifact.prompt !== "string") throw new Error(`Agent turn artifact '${artifactId}' has an invalid prompt.`);
    prompts.set(attemptId, artifact.prompt);
    break;
  }
  return prompts;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function dispatchCommittedHooksForRun(input: {
  cwd: string;
  runId: string;
  store: RuntimeStore;
  hookRunner?: HookRunner;
}): Result<HookDispatchProgress, HookDispatchRetry> {
  const frozen = hookDispatchStage(input.runId, "load-projection", () => input.store.getFrozenRun(input.runId));
  if (frozen.isErr()) return err(frozen.error);
  if (!frozen.value) throw new Error(`Run '${input.runId}' has no frozen workflow.`);
  return dispatchCommittedHooks({
    ...input,
    frozen: frozen.value,
  });
}

function hookDispatchStage<T>(runId: string, stage: HookDispatchRetry["stage"], read: () => T): Result<T, HookDispatchRetry> {
  try {
    return ok(read());
  } catch (error) {
    if (isRuntimeStoreBusyError(error)) {
      return err({ type: "hook-dispatch-retry", runId, stage, message: "Runtime store is busy. Retry hook dispatch on a later daemon tick." });
    }
    throw error;
  }
}

function dispatchHooksAtCheckpoint(input: Parameters<typeof dispatchCommittedHooks>[0] & Pick<AdvanceFrozenRunInput, "shouldDispatchHooks" | "onHookIncident">): void {
  if (input.shouldDispatchHooks?.(input.runId) === false) return;
  try {
    dispatchCommittedHooks(input);
  } catch (error) {
    if (!input.onHookIncident) throw error;
    input.onHookIncident(input.runId, error);
  }
}

export function settleFrozenRunTransitions(input: {
  store: RuntimeStore;
  runId: string;
  ownerEpoch: number;
  now?: Date;
}): SchedulerSnapshot {
  const frozen = input.store.getFrozenRun(input.runId);
  if (!frozen) throw new Error(`Run '${input.runId}' has no frozen workflow.`);
  const current = throwSchedulerStoreResult(input.store.scheduler.tryLoadRunSnapshot(input.runId));
  const settled = settleFrozenProjection({
    frozen,
    projection: current.projection,
    now: input.now ?? new Date(),
  });
  if (settled.events.length === 0) return current;
  return throwSchedulerStoreResult(input.store.scheduler.tryAppendSchedulerEvents({
    runId: input.runId,
    ownerEpoch: input.ownerEpoch,
    expectedVersion: current.version,
    idempotencyKey: `scheduler:settle-control:${input.runId}:${current.version}`,
    events: settled.events,
  }));
}

function isSchedulerRetryLeaf(node: NodeIR): node is Extract<NodeIR, { kind: "task" | "agent" }> {
  return node.kind === "task" || node.kind === "agent";
}
