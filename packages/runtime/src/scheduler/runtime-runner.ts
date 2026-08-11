import type { NodeIR } from "@acpus/core/ir";
import { err, ok, type Result } from "neverthrow";
import { resolutionErrorPayload, tryCreateDeadline, tryResolveDuration, tryResolveString } from "../evaluation/resolvable.js";
import { dispatchHooksAtCheckpoint } from "../hooks/dispatch.js";
import type { HookRunner } from "../hooks/runner.js";
import type { NodeProgressWriter } from "../progress/writer.js";
import type { RuntimeStore } from "../store/store.js";
import { isRuntimeStoreBusyError } from "../storage/database.js";
import { advanceRun, type AdvanceRunInput, type AdvanceRunSummary } from "./advance.js";
import { bootstrapRootEvents, continueRootEvents } from "./materialize.js";
import { createRuntimeNodeExecutor } from "./node-executor.js";
import { indexNodes } from "./ir-walk.js";
import { scopeForNodeAttempt } from "./scope.js";
import { frozenRunScope, settleFrozenSnapshot } from "./settle.js";
import { throwSchedulerStoreResult } from "./store-port.js";
import type { SchedulerSnapshot } from "./store-port.js";
import { loadAgentHostPolicy, type AgentHostPolicy } from "../configuration.js";
import { parseArtifactUri } from "../artifacts/reference.js";
import { resolveAgentSessionIdentity } from "../execution/agent-session.js";
import { createVersionedWakeup } from "./wakeup.js";
import { isReplayLeaf, replayEvaluation } from "./fork-replay.js";
import type { ManagedAcpExecutor } from "@acpus/agent-executor";

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
  managedAcpExecutor?: ManagedAcpExecutor;
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
  managedAcpExecutor?: ManagedAcpExecutor;
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
            ...(input.managedAcpExecutor === undefined ? {} : { managedAcpExecutor: input.managedAcpExecutor }),
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
  const schedulerStore = input.store.scheduler;
  const summary = await advanceRun({
    runId: input.runId,
    ownerId: input.ownerId,
    store: schedulerStore,
    replayCandidates: schedulerStore.listReplayCandidates(input.runId),
    tryCommitReplay: replay => schedulerStore.tryCommitReplay(replay),
    ...(input.maxLeafConcurrency === undefined ? {} : { maxLeafConcurrency: input.maxLeafConcurrency }),
    signalNodeIds,
    executorResourceFor: (instance, projection) => {
      const node = nodes.get(instance.nodeId);
      if (!node || node.kind !== "agent") return undefined;
      const attemptScope = scopeForNodeAttempt(scope, projection, instance.nodeKey);
      return resolveAgentSessionIdentity(node, attemptScope, input.runId, instance.nodeKey)
        .map(identity => identity.sessionName)
        .unwrapOr(undefined);
    },
    replayEvaluationFor: (instance, projection) => {
      const node = nodes.get(instance.nodeId);
      if (!node || !isReplayLeaf(node)) return {};
      return replayEvaluation(
        node,
        scopeForNodeAttempt(scope, projection, instance.nodeKey),
        node.kind === "agent" ? frozen.ir.agents[node.run.agent] : undefined,
        uri => {
          const parsed = parseArtifactUri(uri);
          if (parsed.isErr() || parsed.value.runId !== input.runId) return undefined;
          return input.store.getArtifact(input.runId, parsed.value.artifactId)?.digest;
        },
      );
    },
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
    afterOwnershipRecovery: async () => {
      const recovered = await input.store.observationLog.reconcileInterruptedTurns(input.runId);
      if (recovered.isErr()) throw recovered.error;
    },
    onCheckpoint: () => dispatchHooksAtCheckpoint({ ...input, frozen }),
    executor: createRuntimeNodeExecutor({
      cwd: input.cwd,
      ir: frozen.ir,
      scope,
      store: input.store,
      sourceRoot: frozen.sourceRoot ?? input.cwd,
      agentHostPolicy,
      ...(input.progressWriter === undefined ? {} : { progressWriter: input.progressWriter }),
      ...(input.managedAcpExecutor === undefined ? {} : { managedAcpExecutor: input.managedAcpExecutor }),
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

export function settleFrozenRunTransitions(input: {
  store: RuntimeStore;
  runId: string;
  ownerEpoch: number;
  now?: Date;
}): SchedulerSnapshot {
  const frozen = input.store.getFrozenRun(input.runId);
  if (!frozen) throw new Error(`Run '${input.runId}' has no frozen workflow.`);
  const current = throwSchedulerStoreResult(input.store.scheduler.tryLoadRunSnapshot(input.runId));
  const settled = settleFrozenSnapshot({
    frozen,
    snapshot: current,
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
