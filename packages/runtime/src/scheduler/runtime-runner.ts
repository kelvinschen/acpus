import type { NodeIR } from "@acpus/core/ir";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { resolutionErrorPayload, tryCreateDeadline, tryResolveDuration, tryResolveString } from "../evaluation/resolvable.js";
import { dispatchHooksAtCheckpoint } from "../hooks/dispatch.js";
import type { HookRunner } from "../hooks/runner.js";
import type { NodeProgressWriter } from "../progress/writer.js";
import type { RuntimeStoreAdapter } from "../store/store.js";
import type { RuntimeStoreBusy, RuntimeStoreShape } from "../store/service.js";
import { isRuntimeStoreBusyError } from "../storage/database.js";
import { advanceRun, type AdvanceRunInput, type AdvanceRunSummary } from "./advance.js";
import { bootstrapRootEvents, continueRootEvents } from "./materialize.js";
import { createRuntimeNodeExecutor } from "./node-executor.js";
import { indexNodes } from "./ir-walk.js";
import { scopeForNodeAttempt } from "./scope.js";
import { frozenRunScope, settleFrozenSnapshot } from "./settle.js";
import type { SchedulerSnapshot, SchedulerStoreError } from "./store-port.js";
import { loadAgentHostPolicy, type AgentHostPolicy } from "../configuration.js";
import { parseArtifactUri } from "../artifacts/reference.js";
import { resolveAgentSessionIdentity } from "../execution/agent-session.js";
import { createVersionedWakeup } from "./wakeup.js";
import { isReplayLeaf, replayEvaluation } from "./fork-replay.js";
import type { AgentSessionSupervisor } from "@acpus/agent-executor";
import type { ProcessHostShape } from "@acpus/owned-process";
import type { AgentTurnExecutionRegistry } from "../execution/agent-turn-registry.js";

export type AdvanceFrozenRunInput = {
  cwd: string;
  ownerId: string;
  runId: string;
  store: RuntimeStoreAdapter;
  maxLeafConcurrency?: number;
  agentHostPolicy?: AgentHostPolicy;
  processes: ProcessHostShape;
  runtimeOwnerEpoch?: number;
  onClaim?: AdvanceRunInput["onClaim"];
  onRelease?: AdvanceRunInput["onRelease"];
  onCheckpoint?: AdvanceRunInput["onCheckpoint"];
  wakeup?: AdvanceRunInput["wakeup"];
  hookRunner?: HookRunner;
  shouldDispatchHooks?: (runId: string) => boolean;
  onHookIncident?: (runId: string, error: unknown) => void;
  progressWriter?: NodeProgressWriter;
  agentSessionSupervisor?: AgentSessionSupervisor;
  agentTurnRegistry?: AgentTurnExecutionRegistry;
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
  ownerEpoch: Effect.Effect<number | undefined>;
  result: Effect.Effect<Result.Result<RunExecutionExit, RunExecutionFailure>>;
  wake(): void;
};

export type RuntimeRunScheduler = {
  start(input: { runId: string; ownerId: string }): RunExecution;
};

export function createRuntimeRunScheduler(input: {
  cwd: string;
  store: RuntimeStoreAdapter;
  maxLeafConcurrency: number;
  agentHostPolicy: AgentHostPolicy;
  processes: ProcessHostShape;
  runtimeOwnerEpoch?: number;
  hookRunner?: HookRunner;
  shouldDispatchHooks?: (runId: string) => boolean;
  onHookIncident?: (runId: string, error: unknown) => void;
  progressWriter?: NodeProgressWriter;
  agentSessionSupervisor?: AgentSessionSupervisor;
  agentTurnRegistry?: AgentTurnExecutionRegistry;
}): RuntimeRunScheduler {
  return {
    start: identity => {
      const wakeup = createVersionedWakeup();
      const ownerEpoch = Deferred.makeUnsafe<number | undefined>();
      const settleOwner = (value: number | undefined) =>
        Deferred.doneUnsafe(ownerEpoch, Effect.succeed(value));
      const result = advanceFrozenRun({
            cwd: input.cwd,
            store: input.store,
            runId: identity.runId,
            ownerId: identity.ownerId,
            maxLeafConcurrency: input.maxLeafConcurrency,
            agentHostPolicy: input.agentHostPolicy,
            processes: input.processes,
            ...(input.runtimeOwnerEpoch === undefined ? {} : { runtimeOwnerEpoch: input.runtimeOwnerEpoch }),
            wakeup,
            onClaim: claim => settleOwner(claim.ownerEpoch),
            ...(input.hookRunner === undefined ? {} : { hookRunner: input.hookRunner }),
            ...(input.shouldDispatchHooks === undefined ? {} : { shouldDispatchHooks: input.shouldDispatchHooks }),
            ...(input.onHookIncident === undefined ? {} : { onHookIncident: input.onHookIncident }),
            ...(input.progressWriter === undefined ? {} : { progressWriter: input.progressWriter }),
            ...(input.agentSessionSupervisor === undefined ? {} : { agentSessionSupervisor: input.agentSessionSupervisor }),
            ...(input.agentTurnRegistry === undefined ? {} : { agentTurnRegistry: input.agentTurnRegistry }),
          }).pipe(
            Effect.map(advanced => Result.succeed(runExecutionExit(identity.runId, advanced))),
            Effect.catchCause(cause => {
              const error = Cause.squash(cause);
              return isRuntimeStoreBusyError(error)
                ? Effect.succeed(Result.fail({
                  type: "store-busy" as const,
                  runId: identity.runId,
                  message: "Runtime store is busy. Retry the run on a later daemon tick.",
                }))
                : Effect.failCause(cause);
            }),
            Effect.ensuring(Effect.sync(() => {
              settleOwner(undefined);
            })),
          );
      return {
        ownerEpoch: Deferred.await(ownerEpoch),
        result,
        wake: () => wakeup.wake(),
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

export function advanceFrozenRun(input: AdvanceFrozenRunInput): Effect.Effect<AdvanceRunSummary> {
  return Effect.gen(function* () {
    const frozen = input.store.getFrozenRun(input.runId);
    if (!frozen) throw new Error(`Run '${input.runId}' has no frozen workflow.`);
    const scope = frozenRunScope(frozen);
    const nodes = indexNodes(frozen.ir.root);
    const signalNodeIds = new Set([...nodes.values()].filter(node => node.kind === "signal").map(node => node.id));
    const agentHostPolicy = input.agentHostPolicy ?? loadAgentHostPolicy(process.env);
    const schedulerStore = input.store.scheduler;
    const summary = yield* advanceRun({
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
      return Result.getOrElse(
        Result.map(resolveAgentSessionIdentity(node, attemptScope, input.runId, instance.nodeKey), identity => identity.agentSessionId),
        () => undefined,
      );
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
          if (Result.isFailure(parsed) || parsed.success.runId !== input.runId) return undefined;
          return input.store.getArtifact(input.runId, parsed.success.artifactId)?.digest;
        },
      );
    },
    awaitableEventsFor: (instance, projection, now) => {
      const node = nodes.get(instance.nodeId);
      const attemptScope = scopeForNodeAttempt(scope, projection, instance.nodeKey);
      const timeout = node?.kind === "signal" && node.timeout !== undefined
        ? tryResolveDuration(node.timeout, attemptScope, `Signal node '${node.id}' timeout`)
        : undefined;
      const deadline = node?.kind === "signal" && timeout !== undefined && Result.isSuccess(timeout)
        ? tryCreateDeadline(now, timeout.success.milliseconds, `Signal node '${node.id}' timeout`)
        : undefined;
      const deadlineAt = deadline !== undefined && Result.isSuccess(deadline) ? deadline.success.toISOString() : undefined;
      const prompt = node?.kind === "signal"
        ? tryResolveString(node.run.prompt, attemptScope, `Signal node '${node.id}' prompt`)
        : undefined;
      const timeoutMessage = node?.kind === "signal" && node.onTimeout?.message !== undefined
        ? tryResolveString(node.onTimeout.message, attemptScope, `Signal node '${node.id}' onTimeout message`)
        : undefined;
      const resolutionError = timeout !== undefined && Result.isFailure(timeout) ? timeout.failure
        : deadline !== undefined && Result.isFailure(deadline) ? deadline.failure
        : prompt !== undefined && Result.isFailure(prompt) ? prompt.failure
        : timeoutMessage !== undefined && Result.isFailure(timeoutMessage) ? timeoutMessage.failure
        : undefined;
      const renderedPrompt = prompt !== undefined && Result.isSuccess(prompt) ? prompt.success : undefined;
      const renderedTimeoutMessage = timeoutMessage !== undefined && Result.isSuccess(timeoutMessage) ? timeoutMessage.success : undefined;
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
      if (!node || !isSchedulerRetryLeaf(node) || _instance.timeoutMs === undefined) return Result.succeed(undefined);
      return Result.mapError(tryCreateDeadline(now, _instance.timeoutMs, `${node.kind} node '${node.id}' timeout`), error => ({
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
    afterOwnershipRecovery: () => Effect.gen(function* () {
      yield* input.store.observationLog.reconcileInterruptedTurns(input.runId).pipe(Effect.orDie);
      if (input.runtimeOwnerEpoch !== undefined) {
        input.store.scheduler.tryReconcileAgentSteers({
          runId: input.runId,
          runtimeOwnerEpoch: input.runtimeOwnerEpoch,
        });
      }
    }),
    onCheckpoint: snapshot => dispatchHooksAtCheckpoint({ ...input, frozen }).pipe(
      Effect.andThen(input.onCheckpoint?.(snapshot) ?? Effect.void),
    ),
    executor: createRuntimeNodeExecutor({
      cwd: input.cwd,
      ir: frozen.ir,
      scope,
      store: input.store,
      sourceRoot: frozen.sourceRoot ?? input.cwd,
      agentHostPolicy,
      processes: input.processes,
      ...(input.runtimeOwnerEpoch === undefined ? {} : { runtimeOwnerEpoch: input.runtimeOwnerEpoch }),
      ...(input.progressWriter === undefined ? {} : { progressWriter: input.progressWriter }),
      ...(input.agentSessionSupervisor === undefined ? {} : { agentSessionSupervisor: input.agentSessionSupervisor }),
      ...(input.agentTurnRegistry === undefined ? {} : { agentTurnRegistry: input.agentTurnRegistry }),
    }),
    });
    yield* dispatchHooksAtCheckpoint({ ...input, frozen });
    return summary;
  });
}

export function settleFrozenRunTransitions(input: {
  store: RuntimeStoreShape;
  runId: string;
  ownerEpoch: number;
}): Effect.Effect<SchedulerSnapshot, SchedulerStoreError | RuntimeStoreBusy> {
  return Effect.gen(function* () {
    const frozen = yield* input.store.getFrozenRun(input.runId);
    if (!frozen) throw new Error(`Run '${input.runId}' has no frozen workflow.`);
    const current = yield* input.store.scheduler.tryLoadRunSnapshot(input.runId);
    const settled = settleFrozenSnapshot({
      frozen,
      snapshot: current,
      now: new Date(yield* Clock.currentTimeMillis),
    });
    if (settled.events.length === 0) return current;
    return yield* input.store.scheduler.tryAppendSchedulerEvents({
      runId: input.runId,
      ownerEpoch: input.ownerEpoch,
      expectedVersion: current.version,
      idempotencyKey: `scheduler:settle-control:${input.runId}:${current.version}`,
      events: settled.events,
    });
  });
}

function isSchedulerRetryLeaf(node: NodeIR): node is Extract<NodeIR, { kind: "task" | "agent" }> {
  return node.kind === "task" || node.kind === "agent";
}
