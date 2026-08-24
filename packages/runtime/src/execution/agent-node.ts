import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { sha256Digest } from "@acpus/core/content-identity";
import type { AgentDefinitionIR, AgentNodeIR } from "@acpus/core/ir";
import {
  type AgentSelector,
  type AgentSessionLease,
  type AgentSessionSupervisor,
  type AgentTurnEvent,
  type AgentTurnFailure,
  type AgentTurnSnapshot,
  type AgentTurnSummary,
  type AgentTurnTiming,
  type AcpError,
} from "@acpus/agent-executor";
import type { JsonValue } from "@acpus/expression/ir";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import {
  removeRunFile,
  verifyRunFile,
  writeRunFile,
} from "../store/run-file.js";
import { isArtifactRefCandidate, tryBindArtifactRef, type ArtifactPathError } from "../artifacts/access.js";
import type { AgentHostPolicy } from "../configuration.js";
import { tryParsePersistedDeadline } from "../deadline.js";
import { type EvaluationScope } from "../evaluation/evaluator.js";
import { tryResolveString, type ResolutionError } from "../evaluation/resolvable.js";
import { createAgentProgressTurn, type AgentProgressTerminalStatus, type AgentProgressTurn } from "../progress/agent.js";
import type { NodeProgressWriter } from "../progress/writer.js";
import { schedulerStoreError } from "../scheduler/store-port.js";
import { pruneUndefined } from "../stable-json.js";
import type { RunDirectoryToken } from "../store/path-fence.js";
import type { RuntimeStoreAdapter } from "../store/store.js";
import {
  conformAgentOutput,
  type AgentOutputProcessing,
} from "./agent-output.js";
import {
  buildAuthoredAgentPrompt,
  buildRepairAgentPrompt,
  buildSteeringAgentPrompt,
} from "./agent-prompt.js";
import { resolveAgentSessionIdentity } from "./agent-session.js";
import type { AgentAttemptOperationPlan, AgentSessionCheckpointValue } from "./agent-operation-plan.js";
import type { AgentTurnExecutionRegistry } from "./agent-turn-registry.js";

const DEFAULT_REPAIR_DELAY_MS = 5_000;

type AgentBackendFailure = {
  kind: "config" | "session_binding_mismatch" | "spawn" | "provider_exit" | "timeout" | "worker_lost" | "inactivity_stale";
  origin?: "provider" | "runtime";
  retryable?: boolean;
  message: string;
  evidence?: { failAfterMs: number; silentForMs: number; silenceStartedAt: string };
  upstream?: { source: "acp"; operation: "open_session" | "configure_session" | "run_turn"; code?: string | number; origin?: string; data?: JsonValue };
};

type AgentTurnResult = AgentTurnSnapshot & Readonly<{ snapshot: AgentTurnSnapshot }> & (
  | Readonly<{ status: "completed"; finalResponse: string }>
  | Readonly<{ status: "failed"; failure: AgentBackendFailure }>
  | Readonly<{ status: "cancelled"; message: string }>
);

export type AgentNodeFailure =
  | {
      origin: "provider";
      code: string;
      message: string;
      upstream?: AgentBackendFailure["upstream"];
    }
  | {
      origin: "runtime";
      code: "invalid_agent_response_repair_max" | "agent_config_resolution_failed" | "session_binding_mismatch" | "agent_acp_inactivity_stale" | "agent_acp_worker_lost" | "agent_session_acquire_failed" | "session_checkpoint_unknown" | "safe_retry_input_mismatch" | "invalid_agent_operation_target" | "shared_session_restart_requires_run";
      message: string;
      retryable?: boolean;
      evidence?: AgentBackendFailure["evidence"];
      upstream?: AgentBackendFailure["upstream"];
    };

export type AgentAttemptFailure =
  | { type: "resolution"; error: ResolutionError; message: string }
  | { type: "cancelled"; message: string }
  | { type: "timed_out"; failure: AgentNodeFailure; message: string }
  | { type: "failed"; failure: AgentNodeFailure; message: string };

type AgentExecutorOptionsBase = {
  cwd: string;
  agents: Record<string, AgentDefinitionIR>;
  hostPolicy: AgentHostPolicy;
  deadlineAt?: string;
  progressWriter?: NodeProgressWriter;
  agentSessionSupervisor?: AgentSessionSupervisor;
  initialPrompt?: AgentInitialPrompt;
  signal?: AbortSignal;
  abortAttempt?: (reason: "steer") => void;
  agentTurnRegistry?: AgentTurnExecutionRegistry;
};

export type AgentExecutorOptions = AgentExecutorOptionsBase & (
  | {
      store: RuntimeStoreAdapter;
      runId: string;
      nodeKey: string;
      attemptId: string;
      attemptNo: number;
      ownerEpoch: number;
      runtimeOwnerEpoch: number;
    }
  | {
      store?: undefined;
      runId?: string;
      nodeKey?: string;
      attemptId?: string;
      attemptNo?: number;
      ownerEpoch?: number;
    }
);

type AgentInitialPrompt =
  | { kind: "task" }
  | { kind: "steer"; steerId: string; instruction: string };

type AgentTurnRequestRecord = {
  turnId: string;
  prompt: string;
  agentSessionId: string;
  onEvent: (event: AgentTurnEvent) => void;
};

type AgentTurnRecord = {
  turn: number;
  status: AgentTurnResult["status"];
  summary?: AgentTurnSummaryProjection;
  turnArtifact?: AgentArtifactRef;
  outputProcessing?: AgentOutputProcessing;
  failure?: { kind: string; message: string; upstream?: AgentBackendFailure["upstream"] };
  message?: string;
};

type AgentTurnArtifactBase = {
  schemaVersion: 2;
  runId: string;
  nodeId: string;
  nodeKey: string;
  attemptNo: number;
  turn: number;
  agentKey: string;
  agentSessionId: string;
  timing: AgentTurnTiming;
  prompt: string;
  responses: string[];
  summary: AgentTurnSummary;
};

export type AgentTurnArtifact = AgentTurnArtifactBase & (
  | { status: "completed"; finalResponse: string }
  | { status: "failed"; failure: AgentBackendFailure }
  | { status: "cancelled"; message: string }
);

type AgentTurnSummaryProjection = Pick<AgentTurnSummary, "eventCount" | "availability" | "stopReason" | "context" | "tokenUsage"> & {
  tools: { totalToolCallCount: number };
};

type AgentArtifactRef = {
  artifactId: string;
  mediaType: string;
};

export function executeAgentNode(
  node: AgentNodeIR,
  scope: EvaluationScope,
  options: AgentExecutorOptions,
): Effect.Effect<Result.Result<JsonValue, AgentAttemptFailure>> {
  const execution = withAttemptSignal((signal, interruptSignal) =>
    executeAgentNodeResult(node, scope, options, options.signal ?? signal, interruptSignal));
  return options.signal === undefined
    ? execution
    : Effect.raceFirst(execution, externalAgentCancellation(options.signal));
}

function withAttemptSignal<Success>(
  use: (signal: AbortSignal, interruptSignal: Effect.Effect<void>) => Effect.Effect<Success, never, Scope.Scope>,
): Effect.Effect<Success> {
  return Effect.scoped(Effect.gen(function* () {
    const ready = Deferred.makeUnsafe<AbortSignal>();
    const signalFiber = yield* Effect.forkScoped(Effect.callback<never>((_resume, signal) => {
      Deferred.doneUnsafe(ready, Effect.succeed(signal));
    }));
    const signal = yield* Deferred.await(ready);
    const interruptSignal = Fiber.interrupt(signalFiber);
    return yield* use(signal, interruptSignal).pipe(
      Effect.onInterrupt(() => interruptSignal),
    );
  }));
}

function executeAgentNodeResult(
  node: AgentNodeIR,
  scope: EvaluationScope,
  options: AgentExecutorOptions,
  signal: AbortSignal,
  interruptSignal: Effect.Effect<void>,
): Effect.Effect<Result.Result<JsonValue, AgentAttemptFailure>, never, Scope.Scope> {
  return Effect.gen(function* () {
  assertStoredAgentAttemptContext(options);
  const turns: AgentTurnRecord[] = [];
  const artifactRun = yield* agentArtifactRun(options);
  let agentSessionIdForMetadata: string | undefined;
  let explicitSessionKey: string | undefined;
  let responseRepairMax: number | null | undefined;
  const progressWriter = options.progressWriter ?? options.store;
  const progressContext = progressWriter
    && options.runId
    && options.nodeKey
    && options.attemptId
    && options.ownerEpoch !== undefined
    ? {
        writer: progressWriter,
        runId: options.runId,
        nodeKey: options.nodeKey,
        nodeId: node.id,
        attemptId: options.attemptId,
        attemptNo: options.attemptNo ?? 1,
        ownerEpoch: options.ownerEpoch,
        signal,
      }
    : undefined;
  let activeProgress: AgentProgressTurn | undefined;
  const writeTerminalState = (
    status: AgentProgressTerminalStatus,
    message?: string,
    result?: AgentTurnResult,
  ): Effect.Effect<void> => Effect.sync(() => {
    if (result) activeProgress?.publishTerminal(status, result.snapshot, message);
  }).pipe(
    Effect.andThen(writeAgentAttemptMetadata(node, options, agentSessionIdForMetadata, explicitSessionKey, responseRepairMax, status, turns, message)),
      Effect.catchCause(cause => isAttemptFenceError(Cause.squash(cause)) ? Effect.void : Effect.failCause(cause)),
  );
  const finishFailure = (
    failure: AgentAttemptFailure,
    result?: AgentTurnResult,
  ): Effect.Effect<Result.Result<never, AgentAttemptFailure>> => Effect.gen(function* () {
    const status = failure.type === "cancelled" ? "cancelled" : failure.type === "timed_out" ? "timed_out" : "failed";
    const written = yield* Effect.exit(writeTerminalState(status, failure.message, result));
    if (Exit.isFailure(written)) {
      return yield* Effect.die(new AggregateError(
        [failure, Cause.squash(written.cause)],
        `Agent node '${node.id}' failed and its terminal metadata could not be persisted.`,
      ));
    }
    return Result.fail(failure);
  });

    const definition = options.agents[node.run.agent];
    if (!definition) throw new Error(`Agent '${node.run.agent}' is not declared.`);
    if (node.outputSchema) {
      if (options.hostPolicy.responseRepair.type === "invalid") {
        const failure: AgentNodeFailure = {
          origin: "runtime",
          code: "invalid_agent_response_repair_max",
          message: options.hostPolicy.responseRepair.failure.message,
        };
        responseRepairMax = null;
        return yield* finishFailure({ type: "failed", failure, message: failure.message });
      }
      responseRepairMax = options.hostPolicy.responseRepair.max;
    } else {
      responseRepairMax = 0;
    }
    const cwd = node.run.cwd ? tryResolveString(node.run.cwd, scope, "agent cwd") : Result.succeed(definition.cwd ?? options.cwd);
    if (Result.isFailure(cwd)) return yield* finishFailure(resolutionFailure(cwd.failure));
    const dynamic = dynamicEnv(node.run.env, scope);
    if (Result.isFailure(dynamic)) return yield* finishFailure(resolutionFailure(dynamic.failure));
    const managedEnv = {
      ...staticEnv(definition.env),
      ...dynamic.success,
    };
    const invocationEnv = { ...managedEnv };
    delete invocationEnv.ACPUS_RUNTIME_NODE_ID;
    delete invocationEnv.ACPUS_RUNTIME_RUN_ID;
    delete invocationEnv.ACPUS_RUNTIME_NODE_KEY;
    delete invocationEnv.ACPUS_RUNTIME_ATTEMPT;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...managedEnv,
    };
    applyRuntimeAgentEnv(env, node.id, options);
    const deadline = options.deadlineAt === undefined ? undefined : persistedDeadline(options.deadlineAt, node.id);
    const session = resolveAgentSessionIdentity(node, scope, options.runId, options.nodeKey ?? node.id);
    if (Result.isFailure(session)) return yield* finishFailure(resolutionFailure(session.failure));
    explicitSessionKey = session.success.explicitSessionKey;
    agentSessionIdForMetadata = session.success.agentSessionId;
    const effectiveModel = definition.config?.model ?? definition.model;
    const permissionMode = node.run.permissionMode ?? definition.permissionMode ?? "approve-all";
    const maxRepairTurns = responseRepairMax;
    const authoredPrompt = Result.map(renderAgentPrompt(node, scope, options), rendered => buildAuthoredAgentPrompt(rendered, node.outputSchema));
    if (Result.isFailure(authoredPrompt)) return yield* finishFailure(resolutionFailure(authoredPrompt.failure));
    const initialPrompt = options.initialPrompt ?? { kind: "task" };
    if (!options.store && initialPrompt.kind === "steer") {
      throw new Error("Agent Steer requires a durable Scheduler directive.");
    }
    const steeringPrompt = initialPrompt.kind === "steer"
      ? buildSteeringAgentPrompt(initialPrompt.instruction, node.outputSchema)
      : undefined;
    const planResult = options.store
      ? options.store.scheduler.planAgentAttemptAdmission({
          runId: options.runId,
          attemptId: options.attemptId,
          ownerEpoch: options.ownerEpoch,
          target: options.nodeKey,
          scopeDigest: session.success.scopeDigest,
          explicitShared: session.success.explicitShared,
          authored: { promptOrigin: "authored", inputDigest: authoredPrompt.success.inputDigest },
          ...(steeringPrompt === undefined || initialPrompt.kind !== "steer" ? {} : {
            steering: {
              steerId: initialPrompt.steerId,
              instruction: initialPrompt.instruction,
              promptOrigin: "steering" as const,
              inputDigest: steeringPrompt.inputDigest,
            },
          }),
        })
      : Result.succeed<AgentAttemptOperationPlan>({
        operation: "start",
        session: { ...session.success, generation: 1 },
          sessionOpenMode: "new_or_empty",
          promptOrigin: "authored",
        inputDigest: authoredPrompt.success.inputDigest,
      });
    if (Result.isFailure(planResult)) {
      const failure: AgentNodeFailure = {
        origin: "runtime",
        code: planResult.failure.type,
        message: planResult.failure.message,
      };
      return yield* finishFailure({ type: "failed", failure, message: failure.message });
    }
    const plan = planResult.success;
    agentSessionIdForMetadata = plan.session.agentSessionId;
    const plannedPrompt = plan.promptOrigin === "authored"
      ? authoredPrompt.success.prompt
      : steeringPrompt?.prompt;
    if (plannedPrompt === undefined) throw new Error(`Agent Attempt '${options.attemptId}' has no prompt for '${plan.promptOrigin}'.`);
    let prompt: string = plannedPrompt;
    const steerEventSequence = "steerEventSequence" in plan ? plan.steerEventSequence : undefined;
    if (options.store) {
      options.store.scheduler.tryBindAgentAttemptSession({
          runId: options.runId,
          attemptId: options.attemptId,
          ownerEpoch: options.ownerEpoch,
          agentSessionId: plan.session.agentSessionId,
          scopeDigest: plan.session.scopeDigest,
          generation: plan.session.generation,
          explicitShared: plan.session.explicitShared,
          operation: plan.operation,
          sessionOpenMode: plan.sessionOpenMode,
          ...(plan.predecessorAttemptId === undefined ? {} : { predecessorAttemptId: plan.predecessorAttemptId }),
          ...(steerEventSequence === undefined ? {} : { steerEventSequence }),
          promptOrigin: plan.promptOrigin,
          inputDigest: plan.inputDigest,
          ...(plan.admittedFromCheckpoint === undefined ? {} : { admittedFromCheckpoint: plan.admittedFromCheckpoint }),
        });
    }
    let checkpoint: AgentSessionCheckpointValue = {
      checkpoint: "not_dispatched",
      attemptId: options.attemptId ?? `local-${node.id}`,
      promptOrigin: plan.promptOrigin,
      inputDigest: plan.inputDigest,
    };
    const supervisor = options.agentSessionSupervisor ?? unavailableAgentSessionSupervisor();
    const supervisedFiber = yield* Effect.forkScoped(Effect.result(supervisor.withSessionLease({
      attempt: {
        runId: options.runId ?? `local-${node.id}`,
        nodeKey: options.nodeKey ?? node.id,
        attemptId: options.attemptId ?? `local-${node.id}`,
        ownerEpoch: options.ownerEpoch ?? 0,
        ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
        signal,
        ...(options.hostPolicy.inactivityFailAfterMs === undefined ? {} : { inactivityFailAfterMs: options.hostPolicy.inactivityFailAfterMs }),
      },
      session: {
        agentSessionId: plan.session.agentSessionId,
        sessionOpenMode: plan.sessionOpenMode,
        agent: agentSelector(definition),
        cwd: cwd.success,
        env,
        permissionMode,
        configuration: {
          ...(effectiveModel === undefined ? {} : { model: effectiveModel }),
          options: Object.fromEntries(Object.entries(definition.config ?? {}).filter(([key]) => key !== "model")),
        },
      },
    }, lease => Effect.gen(function* () {
      if (options.store && options.runId && options.attemptId && options.ownerEpoch !== undefined) {
        options.store.scheduler.tryRecordAgentSessionReady({
          runId: options.runId,
          attemptId: options.attemptId,
          ownerEpoch: options.ownerEpoch,
          agentSessionId: lease.agentSessionId,
          ...(lease.reportedVersion === undefined ? {} : { reportedVersion: lease.reportedVersion }),
        });
      }
      for (let turn = 0; turn <= maxRepairTurns; turn += 1) {
        const remaining = remainingTimeout(deadline, node.id, yield* Clock.currentTimeMillis);
        if (Result.isFailure(remaining)) return yield* finishFailure(remaining.failure);
        if (signal.aborted) {
          return yield* finishFailure(abortedTurnFailure());
        }
        activeProgress = progressContext
          ? createAgentProgressTurn({ ...progressContext, turn: turn + 1 })
          : undefined;
        const request: AgentTurnRequestRecord = {
          turnId: `turn_${randomUUID()}`,
          prompt,
          agentSessionId: plan.session.agentSessionId,
          onEvent: event => activeProgress?.callbacks.onEvent(event),
        };
        const result = yield* executeObservedAgentTurn(
          node,
          options,
          signal,
          turn + 1,
          turn === 0 ? promptKindForOrigin(plan.promptOrigin) : "repair",
          request,
          turnRequest => runLeasedAgentTurn({
            node,
            options,
            lease,
            request: turnRequest,
            checkpoint,
            invocation: {
              prompt: turnRequest.prompt,
              promptOrigin: turn === 0 ? plan.promptOrigin : "repair",
              cwd: cwd.success,
              env: invocationEnv,
              permissionMode,
              ...(effectiveModel === undefined ? {} : { model: effectiveModel }),
              ...(explicitSessionKey === undefined ? {} : { sessionKey: explicitSessionKey }),
              ...(turn === 0 && definition.config !== undefined ? { config: definition.config } : {}),
              ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
            },
            onCheckpoint: value => { checkpoint = value; },
          }),
        );
        activeProgress?.clearAcpActivity();
        if (signal.aborted) {
          turns.push(agentTurnRecord(turn + 1, result));
          return yield* finishFailure(abortedTurnFailure(result));
        }
        const artifact = yield* Effect.exit(writeAgentTurnArtifacts(
          node,
          options,
          turn + 1,
          request,
          result,
          artifactRun,
        ));
        if (Exit.isFailure(artifact)) {
          const error = Cause.squash(artifact.cause);
          if (!isAttemptFenceError(error)) return yield* Effect.failCause(artifact.cause);
          turns.push(agentTurnRecord(turn + 1, result));
          return yield* finishFailure({ type: "cancelled", message: "Agent turn was fenced." });
        }
        turns.push(artifact.value);
        if (signal.aborted) return yield* finishFailure(abortedTurnFailure(result));
        if (result.status === "cancelled") {
          return yield* finishFailure({ type: "cancelled", message: result.message }, result);
        }
        if (result.status === "failed" && result.failure.kind === "timeout") {
          const failure = agentNodeFailure(result.failure);
          return yield* finishFailure({ type: "timed_out", failure, message: failure.message }, result);
        }
        if (result.status === "failed") {
          const failure = agentNodeFailure(result.failure);
          return yield* finishFailure({ type: "failed", failure, message: failure.message }, result);
        }
        if (!node.outputSchema) {
          yield* writeTerminalState("completed", undefined, result);
          return Result.succeed(result.finalResponse);
        }
        const conformed = conformAgentOutput(node.outputSchema, result.finalResponse, node.id);
        const outputProcessing = Result.isSuccess(conformed) ? conformed.success.outputProcessing : conformed.failure.outputProcessing;
        turns[turn] = { ...turns[turn]!, outputProcessing };
        if (Result.isSuccess(conformed)) {
          yield* writeTerminalState("completed", undefined, result);
          return Result.succeed(conformed.success.output);
        }
        const rejected = conformed.failure;
        turns[turn] = { ...turns[turn]!, failure: { kind: rejected.kind, message: rejected.message } };
        if (turn === maxRepairTurns) {
          const failure: AgentNodeFailure = { origin: "provider", code: rejected.kind, message: rejected.message };
          return yield* finishFailure({ type: "failed", failure, message: failure.message }, result);
        }
        const delayed = yield* delay(DEFAULT_REPAIR_DELAY_MS, deadline);
        if (Result.isFailure(delayed)) return yield* finishFailure(delayed.failure);
        const repair = buildRepairAgentPrompt(node.outputSchema, rejected.phase);
        prompt = repair.prompt;
        if (options.store) {
          checkpoint = options.store.scheduler.tryAdvanceAgentSessionCheckpoint({
            runId: options.runId,
            ownerEpoch: options.ownerEpoch,
            agentSessionId: plan.session.agentSessionId,
            attemptId: options.attemptId,
            expected: checkpoint,
            next: {
              checkpoint: "not_dispatched",
              attemptId: options.attemptId,
              promptOrigin: "repair",
              inputDigest: repair.inputDigest,
            },
            cause: "begin_repair",
          });
        }
      }
      throw new Error(`Agent node '${node.id}' exhausted response repair.`);
    }).pipe(Effect.flatMap(Effect.fromResult)))));
    const supervised = yield* Fiber.join(supervisedFiber).pipe(
      Effect.onInterrupt(() => interruptSignal.pipe(
        Effect.andThen(Fiber.await(supervisedFiber)),
        Effect.asVoid,
      )),
    );
    if (Result.isSuccess(supervised)) return Result.succeed(supervised.success);
    if (supervised.failure.type === "use") return Result.fail(supervised.failure.error);
    if (supervised.failure.type === "use_and_cleanup") return Result.fail(supervised.failure.use);
    if (supervised.failure.type === "acquire"
      && supervised.failure.error.type === "session_open_failed") {
      const failure = agentNodeFailure(backendFailureFromAcp(supervised.failure.error.error));
      return yield* finishFailure({ type: "failed", failure, message: failure.message });
    }
    const message = supervised.failure.type === "acquire"
      ? supervised.failure.error.message
      : supervised.failure.error.message;
    const failure: AgentNodeFailure = { origin: "runtime", code: "agent_session_acquire_failed", message };
    return yield* finishFailure({ type: "failed", failure, message });
  });
}

function executeObservedAgentTurn(
  node: AgentNodeIR,
  options: AgentExecutorOptions,
  signal: AbortSignal,
  turn: number,
  promptKind: "task" | "steer" | "repair",
  request: AgentTurnRequestRecord,
  runTurn: (request: AgentTurnRequestRecord) => Effect.Effect<AgentTurnResult>,
): Effect.Effect<AgentTurnResult> {
  if (!options.store
    || !options.runId
    || !options.nodeKey
    || !options.attemptId
    || options.attemptNo === undefined) {
    return runTurn(request);
  }
  const store = options.store;
  const runId = options.runId;
  const nodeKey = options.nodeKey;
  const attemptId = options.attemptId;
  const attemptNo = options.attemptNo;
  return Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    return yield* store.observationLog.captureTurn({
      runId,
      nodeId: node.id,
      nodeKey,
      attemptId,
      attemptNo,
      turn,
      promptKind,
      signal,
    }, request, runTurn, () => cancelledAgentTurn(
      "Agent Turn was fenced before Provider dispatch.",
      clock.currentTimeMillisUnsafe(),
    ));
  });
}

function runLeasedAgentTurn(input: {
  node: AgentNodeIR;
  options: AgentExecutorOptions;
  lease: AgentSessionLease;
  request: AgentTurnRequestRecord;
  checkpoint: AgentSessionCheckpointValue;
  invocation: {
    prompt: string;
    promptOrigin: "authored" | "steering" | "repair";
    cwd: string;
    env: Record<string, string>;
    permissionMode: "approve-reads" | "approve-all" | "deny-all";
    model?: string;
    sessionKey?: string;
    config?: Record<string, string>;
    deadlineAt?: string;
  };
  onCheckpoint(checkpoint: AgentSessionCheckpointValue): void;
}): Effect.Effect<AgentTurnResult> {
  return Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    let checkpoint = input.checkpoint;
  if (input.options.store) {
    if (checkpoint.checkpoint !== "not_dispatched") {
      throw new Error(`Agent Turn '${input.request.turnId}' does not start from not_dispatched.`);
    }
    checkpoint = input.options.store.scheduler.tryCommitAgentTurnDispatch({
      runId: input.options.runId,
      ownerEpoch: input.options.ownerEpoch,
      agentSessionId: input.lease.agentSessionId,
      attemptId: input.options.attemptId,
      turnId: input.request.turnId,
      sessionLeaseId: input.lease.sessionLeaseId,
      expected: checkpoint,
      invocationMetadata: agentInvocationMetadata(input.node, input.options, input.invocation),
    });
    input.onCheckpoint(checkpoint);
    if (checkpoint.checkpoint === "not_dispatched") throw new Error("Dispatch commit returned not_dispatched.");
    checkpoint = input.options.store.scheduler.tryAdvanceAgentSessionCheckpoint({
      runId: input.options.runId,
      ownerEpoch: input.options.ownerEpoch,
      agentSessionId: input.lease.agentSessionId,
      attemptId: input.options.attemptId,
      expected: checkpoint,
      next: {
        checkpoint: "owned_in_flight",
        attemptId: checkpoint.attemptId,
        turnId: checkpoint.turnId,
        sessionLeaseId: checkpoint.sessionLeaseId,
        promptOrigin: checkpoint.promptOrigin,
        inputDigest: checkpoint.inputDigest,
      },
      cause: "local_call_pending",
    });
    input.onCheckpoint(checkpoint);
  }
    const unregister = input.options.agentTurnRegistry
      && input.options.runId
      && input.options.nodeKey
      && input.options.attemptId
      ? input.options.agentTurnRegistry.register({
          runId: input.options.runId,
          nodeKey: input.options.nodeKey,
          nodeId: input.node.id,
          agentSessionId: input.lease.agentSessionId,
          attemptId: input.options.attemptId,
          turnId: input.request.turnId,
          sessionLeaseId: input.lease.sessionLeaseId,
          abort: reason => input.options.abortAttempt?.(reason),
        })
      : undefined;
    const settled = yield* Effect.result(input.lease.runTurn({
      turnId: input.request.turnId,
      prompt: input.request.prompt,
      onEvent: event => {
        try {
          if (input.options.store
            && (checkpoint.checkpoint === "dispatch_intent" || checkpoint.checkpoint === "owned_in_flight")) {
            checkpoint = advanceAgentCheckpoint(input.options, input.lease, checkpoint as Exclude<AgentSessionCheckpointValue, { checkpoint: "not_dispatched" }>, "provider_observed", "provider_activity", clock.currentTimeMillisUnsafe());
            input.onCheckpoint(checkpoint);
          }
          input.request.onEvent(event);
          return Result.succeed(undefined);
        } catch (error) {
          return Result.fail(error);
        }
      },
    }).pipe(Effect.ensuring(Effect.sync(() => unregister?.()))));
    if (input.options.store) {
    if (Result.isSuccess(settled) || settled.failure.evidence.protocolTerminal !== undefined) {
      checkpoint = advanceAgentCheckpoint(input.options, input.lease, checkpoint as Exclude<AgentSessionCheckpointValue, { checkpoint: "not_dispatched" }>, "terminal_observed", "provider_terminal", clock.currentTimeMillisUnsafe());
    } else if (settled.failure.evidence.localFailure?.error.providerEvidence === "inbound_activity") {
      checkpoint = advanceAgentCheckpoint(input.options, input.lease, checkpoint as Exclude<AgentSessionCheckpointValue, { checkpoint: "not_dispatched" }>, "terminal_unknown", "inbound_local_failure", clock.currentTimeMillisUnsafe());
    } else if (checkpoint.checkpoint !== "acceptance_unknown" && checkpoint.checkpoint !== "terminal_unknown") {
      const next = checkpoint.checkpoint === "provider_observed" ? "terminal_unknown" : "acceptance_unknown";
      checkpoint = advanceAgentCheckpoint(input.options, input.lease, checkpoint as Exclude<AgentSessionCheckpointValue, { checkpoint: "not_dispatched" }>, next, "loss_without_new_provider_evidence", clock.currentTimeMillisUnsafe());
    }
    input.onCheckpoint(checkpoint);
  }
    return Result.match(settled, {
      onSuccess: outcome => ({
        status: "completed" as const,
        finalResponse: outcome.finalResponse,
        ...outcome.snapshot,
        snapshot: outcome.snapshot,
      }),
      onFailure: failure => turnResultFromSupervisorFailure(failure),
    });
  });
}

function advanceAgentCheckpoint(
  options: Extract<AgentExecutorOptions, { store: RuntimeStoreAdapter }>,
  lease: AgentSessionLease,
  expected: Exclude<AgentSessionCheckpointValue, { checkpoint: "not_dispatched" }>,
  next: "provider_observed" | "terminal_observed" | "acceptance_unknown" | "terminal_unknown",
  cause: "provider_activity" | "provider_terminal" | "loss_without_new_provider_evidence" | "inbound_local_failure",
  observedAt: number,
): AgentSessionCheckpointValue {
  try {
    return options.store.scheduler.tryAdvanceAgentSessionCheckpoint({
      runId: options.runId,
      ownerEpoch: options.ownerEpoch,
      agentSessionId: lease.agentSessionId,
      attemptId: options.attemptId,
      expected,
      next: { ...expected, checkpoint: next },
      cause,
    });
  } catch (error) {
    const failure = schedulerStoreError(error);
    if (!failure || failure.type !== "terminal-attempt" && failure.type !== "owner-epoch-stale" && failure.type !== "owner-epoch-inactive") {
      throw error;
    }
  }
  return options.store.scheduler.trySettleFencedAgentSessionCheckpoint({
    runId: options.runId,
    runtimeOwnerEpoch: options.runtimeOwnerEpoch,
    agentSessionId: lease.agentSessionId,
    attemptId: options.attemptId,
    turnId: expected.turnId,
    sessionLeaseId: expected.sessionLeaseId,
    expected: expected.checkpoint,
    next,
    cause,
    observedAt: new Date(observedAt),
  });
}

function turnResultFromSupervisorFailure(failure: AgentTurnFailure<unknown>): AgentTurnResult {
  const common = {
    ...failure.snapshot,
    snapshot: failure.snapshot,
  };
  if (failure.type === "cancelled") return { status: "cancelled", message: `Agent Turn was cancelled (${failure.reason}).`, ...common };
  if (failure.type === "acp") return { status: "failed", failure: backendFailureFromAcp(failure.error), ...common };
  if (failure.type === "policy_timeout") {
    return { status: "failed", failure: { kind: "timeout", origin: "runtime", message: "Agent turn exceeded its authored deadline." }, ...common };
  }
  if (failure.type === "inactivity_stale") {
    return {
      status: "failed",
      failure: {
        kind: "inactivity_stale",
        origin: "runtime",
        retryable: true,
        message: "ACP agent was silent for the configured inactivity limit.",
        evidence: {
          failAfterMs: failure.failAfterMs,
          silentForMs: failure.silentForMs,
          silenceStartedAt: failure.silenceStartedAt,
        },
      },
      ...common,
    };
  }
  return {
    status: "failed",
    failure: {
      kind: "worker_lost",
      origin: "runtime",
      retryable: failure.type !== "event_sink",
      message: failure.type === "capsule_lost" ? failure.error.message : "Agent observation sink rejected an event.",
    },
    ...common,
  };
}

function backendFailureFromAcp(error: AcpError): AgentBackendFailure {
  const operation = error.operation === "configure_session"
    ? "configure_session" as const
    : ["open_session", "initialize", "new_session", "resume_session", "load_session"].includes(error.operation)
      ? "open_session" as const
      : "run_turn" as const;
  const config = error.type === "invalid_input" || error.type === "persistence" || error.type === "configuration" || error.type === "capability";
  return {
    kind: error.type === "session_binding" ? "session_binding_mismatch" : config ? "config" : error.type === "spawn" ? "spawn" : "provider_exit",
    origin: error.origin === "input" || error.origin === "persistence" || error.origin === "client" ? "runtime" : "provider",
    retryable: error.retryable,
    message: error.message,
    upstream: {
      source: "acp",
      operation,
      ...(error.code === undefined ? {} : { code: error.code }),
      origin: error.type,
      ...(error.type === "session_binding" ? { data: { categories: [...error.categories] } } : {}),
    },
  };
}

function promptKindForOrigin(origin: AgentAttemptOperationPlan["promptOrigin"]): "task" | "steer" | "repair" {
  return origin === "authored" ? "task" : origin === "steering" ? "steer" : "repair";
}

function agentNodeFailure(failure: AgentBackendFailure): AgentNodeFailure {
  if (failure.kind === "session_binding_mismatch") {
    return {
      origin: "runtime",
      code: "session_binding_mismatch",
      message: failure.message,
      ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
      ...(failure.upstream === undefined ? {} : { upstream: failure.upstream }),
    };
  }
  if (failure.kind === "config" && failure.origin === "runtime") {
    return {
      origin: "runtime",
      code: "agent_config_resolution_failed",
      message: failure.message,
      ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
    };
  }
  if (failure.kind === "inactivity_stale") {
    return {
      origin: "runtime",
      code: "agent_acp_inactivity_stale",
      message: failure.message,
      ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
      ...(failure.evidence === undefined ? {} : { evidence: failure.evidence }),
    };
  }
  if (failure.kind === "worker_lost") {
    return {
      origin: "runtime",
      code: "agent_acp_worker_lost",
      message: failure.message,
      ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
    };
  }
  return {
    origin: "provider",
    code: failure.kind,
    message: failure.message,
    ...(failure.upstream ? { upstream: failure.upstream } : {}),
  };
}

function unavailableAgentSessionSupervisor(): AgentSessionSupervisor {
  return {
    withSessionLease: input => Effect.fail({
      type: "acquire" as const,
      error: {
        type: "supervisor_closed" as const,
        agentSessionId: input.session.agentSessionId,
        message: "Agent execution requires an Agent Session supervisor.",
      },
    }),
    withSessionsNeutralized: () => Effect.fail({
      type: "acquire" as const,
      error: { type: "supervisor_closed" as const, message: "Agent Session supervisor is unavailable." },
    }),
    shutdown: () => Effect.void,
  };
}

function resolutionFailure(error: ResolutionError): AgentAttemptFailure {
  return { type: "resolution", error, message: error.message };
}

function abortedTurnFailure(result?: AgentTurnResult): AgentAttemptFailure {
  return {
    type: "cancelled",
    message: result?.status === "cancelled" ? result.message : "Agent turn was aborted.",
  };
}

function cancelledAgentTurn(message: string, nowMillis: number): AgentTurnResult {
  const now = new Date(nowMillis).toISOString();
  const snapshot: AgentTurnSnapshot = {
    responses: [],
    summary: {
      eventCount: 0,
      availability: { context: "unavailable", tokenUsage: "unavailable" },
      tools: { totalToolCallCount: 0, calls: [] },
    },
    timing: { startedAt: now, finishedAt: now, elapsedMs: 0 },
  };
  return { status: "cancelled", message, ...snapshot, snapshot };
}

function isAttemptFenceError(error: unknown): boolean {
  const failure = schedulerStoreError(error);
  return failure?.type === "terminal-attempt"
    || failure?.type === "owner-epoch-stale"
    || failure?.type === "owner-epoch-inactive";
}

function assertStoredAgentAttemptContext(options: AgentExecutorOptions): void {
  if (!options.store) return;
  if (!options.runId || !options.nodeKey || !options.attemptId || options.attemptNo === undefined || options.ownerEpoch === undefined || options.runtimeOwnerEpoch === undefined) {
    throw new Error("Store-backed Agent execution requires runId, nodeKey, attemptId, attemptNo, ownerEpoch, and runtimeOwnerEpoch.");
  }
}

function renderAgentPrompt(node: AgentNodeIR, scope: EvaluationScope, options: AgentExecutorOptions): Result.Result<string, ResolutionError> {
  const field = `Agent node '${node.id}' prompt`;
  try {
    return tryResolveString(node.run.prompt, scope, field, {
      formatTemplateValue: value => {
        if (!isArtifactRefCandidate(value)) return undefined;
        if (!options.store || !options.runId) throw new Error("Agent ArtifactRef interpolation requires runtime store and run id.");
        const resolved = tryBindArtifactRef(value, { runId: options.runId, store: options.store });
        if (Result.isFailure(resolved)) throw resolved.failure;
        return resolved.success.path;
      },
    });
  } catch (error) {
    if (!isArtifactPathError(error)) throw error;
    return Result.fail({ type: "evaluation", field, message: error.message });
  }
}

function isArtifactPathError(error: unknown): error is ArtifactPathError {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { type?: unknown; message?: unknown };
  return typeof candidate.message === "string"
    && (candidate.type === "invalid-artifact-ref"
      || candidate.type === "artifact-run-mismatch"
      || candidate.type === "artifact-not-found"
      || candidate.type === "artifact-path-invalid");
}

function applyRuntimeAgentEnv(env: NodeJS.ProcessEnv, nodeId: string, options: AgentExecutorOptions): void {
  env.ACPUS_RUNTIME_NODE_ID = nodeId;
  setOptionalEnv(env, "ACPUS_RUNTIME_RUN_ID", options.runId);
  setOptionalEnv(env, "ACPUS_RUNTIME_NODE_KEY", options.nodeKey);
  setOptionalEnv(env, "ACPUS_RUNTIME_ATTEMPT", options.attemptNo === undefined ? undefined : String(options.attemptNo));
}

function setOptionalEnv(env: NodeJS.ProcessEnv, key: string, value: string | undefined): void {
  if (value === undefined) delete env[key];
  else env[key] = value;
}

function dynamicEnv(env: AgentNodeIR["run"]["env"], scope: EvaluationScope): Result.Result<Record<string, string>, ResolutionError> {
  if (!env) return Result.succeed({});
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const item = tryResolveString(value, scope, `Agent env '${key}'`);
    if (Result.isFailure(item)) return Result.fail(item.failure);
    resolved[key] = item.success;
  }
  return Result.succeed(resolved);
}

function staticEnv(env: AgentDefinitionIR["env"]): Record<string, string> {
  return env ? { ...env } : {};
}

function agentSelector(definition: AgentDefinitionIR): AgentSelector {
  return definition.kind === "agent_command"
    ? { kind: "command", command: definition.command }
    : { kind: "named", name: definition.use };
}

function writeAgentTurnArtifacts(
  node: AgentNodeIR,
  options: AgentExecutorOptions,
  turn: number,
  request: AgentTurnRequestRecord,
  result: AgentTurnResult,
  artifactRun?: RunDirectoryToken,
): Effect.Effect<AgentTurnRecord> {
  const base = agentTurnRecord(turn, result);
  if (!options.store || !options.runId) return Effect.succeed(base);
  const turnArtifact: AgentTurnArtifact = {
    schemaVersion: 2,
    runId: options.runId,
    nodeId: node.id,
    nodeKey: options.nodeKey ?? node.id,
    attemptNo: options.attemptNo ?? 1,
    turn,
    agentKey: node.run.agent,
    agentSessionId: request.agentSessionId,
    timing: result.timing,
    prompt: request.prompt,
    responses: [...result.responses],
    summary: result.summary,
    ...(result.status === "completed"
      ? { status: result.status, finalResponse: result.finalResponse }
      : result.status === "failed"
        ? { status: result.status, failure: result.failure }
        : { status: result.status, message: result.message }),
  };
  return writeAgentArtifact(options, artifactRun, turn, "json", `${JSON.stringify(turnArtifact, null, 2)}\n`, "application/json").pipe(
    Effect.map(turnArtifact => ({ ...base, turnArtifact })),
  );
}

function agentTurnRecord(turn: number, result: AgentTurnResult): AgentTurnRecord {
  return {
    turn,
    status: result.status,
    summary: summaryProjection(result.summary),
    ...(result.status === "failed" ? { failure: result.failure } : {}),
    ...(result.status === "cancelled" ? { message: result.message } : {}),
  };
}

function summaryProjection(summary: AgentTurnSummary): AgentTurnSummaryProjection {
  return pruneUndefined({
    eventCount: summary.eventCount,
    availability: summary.availability,
    stopReason: summary.stopReason,
    context: summary.context,
    tokenUsage: summary.tokenUsage,
    tools: { totalToolCallCount: summary.tools.totalToolCallCount },
  }) as AgentTurnSummaryProjection;
}

function writeAgentArtifact(
  options: AgentExecutorOptions,
  run: RunDirectoryToken | undefined,
  turn: number,
  name: string,
  content: string,
  mediaType: string,
): Effect.Effect<AgentArtifactRef> {
  if (!options.store || !options.runId) throw new Error("Agent artifact storage requires runtime store and run id.");
  if (!options.attemptId || options.ownerEpoch === undefined) throw new Error("Agent artifact storage requires scheduler attempt ownership.");
  if (!run) throw new Error("Agent artifact storage requires an opened run directory.");
  const nodeKey = options.nodeKey ?? "agent";
  const attempt = options.attemptNo ?? 1;
  const attemptDirectory = agentAttemptDirectory(attempt, options.attemptId);
  const id = `artifact_${randomUUID()}`;
  const relativePath = join("artifacts", nodeKey, attemptDirectory, "agent", `turn-${String(turn).padStart(3, "0")}.${name}`);
  const bytes = Buffer.from(content, "utf8");
  const label = `Agent artifact '${id}'`;
  return Effect.gen(function* () {
    const file = yield* Effect.promise(() => writeRunFile({ run, relativePath, bytes, label }));
    const registered = yield* Effect.exit(Effect.sync(() => {
      verifyRunFile(run, file, label);
      options.store.registerArtifact({
        id,
        runId: options.runId,
        nodeKey,
        attemptId: options.attemptId,
        attempt,
        ownerEpoch: options.ownerEpoch,
        mediaType,
        digest: sha256Digest(bytes),
        size: bytes.byteLength,
        relativePath,
        file,
      });
    }));
    if (Exit.isFailure(registered)) {
      const cleanup = yield* Effect.exit(Effect.promise(() => removeRunFile(run, file, label)));
      if (Exit.isFailure(cleanup)) {
        return yield* Effect.die(new AggregateError(
          [Cause.squash(registered.cause), Cause.squash(cleanup.cause)],
          `Agent artifact '${id}' registration failed and its unregistered file could not be removed.`,
        ));
      }
      return yield* Effect.failCause(registered.cause);
    }
    verifyRunFile(run, file, label);
    return { artifactId: id, mediaType };
  });
}

function agentArtifactRun(options: AgentExecutorOptions): Effect.Effect<RunDirectoryToken | undefined> {
  return Effect.sync(() => {
    if (!options.store || !options.runId) return undefined;
    const run = options.store.getRunDirectoryToken(options.runId);
    if (!run) throw new Error(`Run '${options.runId}' has no run directory.`);
    return run;
  });
}

function agentAttemptDirectory(attempt: number, attemptId: string): string {
  if (!/^attempt_[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(attemptId)) {
    throw new Error(`Agent artifact storage requires a scheduler-issued attempt id, received '${attemptId}'.`);
  }
  return join(`attempt-${attempt}`, attemptId);
}

function agentInvocationMetadata(
  node: AgentNodeIR,
  options: AgentExecutorOptions,
  invocation: {
    prompt: string;
    promptOrigin: "authored" | "steering" | "repair";
    cwd: string;
    env: Record<string, string>;
    permissionMode: "approve-reads" | "approve-all" | "deny-all";
    model?: string;
    sessionKey?: string;
    config?: Record<string, string>;
    deadlineAt?: string;
  },
): JsonValue {
  return pruneUndefined({
    nodeId: node.id,
    nodeKey: options.nodeKey ?? node.id,
    attemptNo: options.attemptNo ?? 1,
    ...invocation,
  }) as JsonValue;
}

function writeAgentAttemptMetadata(
  node: AgentNodeIR,
  options: AgentExecutorOptions,
  agentSessionId: string | undefined,
  explicitSessionKey: string | undefined,
  responseRepairMax: number | null | undefined,
  status: "completed" | "failed" | "cancelled" | "timed_out",
  turns: AgentTurnRecord[],
  message?: string,
): Effect.Effect<void> {
  return Effect.sync(() => {
    if (!options.store) return;
    options.store.writeExecutionMetadata({
      runId: options.runId,
      attemptId: options.attemptId,
      ownerEpoch: options.ownerEpoch,
      kind: "agent_attempt",
      metadata: pruneUndefined({
        nodeId: node.id,
        nodeKey: options.nodeKey ?? node.id,
        attemptNo: options.attemptNo ?? 1,
        status,
        ...(agentSessionId ? { agentSessionId } : {}),
        ...(explicitSessionKey ? { sessionKey: explicitSessionKey } : {}),
        ...(options.deadlineAt ? { deadlineAt: options.deadlineAt } : {}),
        ...(responseRepairMax === undefined ? {} : { responseRepairMax }),
        turnCount: turns.length,
        turns: turns.map(turn => pruneUndefined(turn) as JsonValue),
        ...(message ? { message } : {}),
      }) as JsonValue,
    });
  });
}

function delay(ms: number, deadline: number | undefined): Effect.Effect<Result.Result<void, AgentAttemptFailure>> {
  if (ms <= 0) return Effect.succeed(Result.succeed(undefined));
  return Effect.gen(function* () {
    const remaining = remainingTimeout(deadline, "response repair", yield* Clock.currentTimeMillis);
    if (Result.isFailure(remaining)) return Result.fail(remaining.failure);
    const delayMs = remaining.success === undefined ? ms : Math.min(ms, remaining.success);
    yield* Effect.sleep(delayMs);
    return remaining.success !== undefined && remaining.success <= ms
      ? Result.fail(timeoutFailure("Agent response repair timed out."))
      : Result.succeed(undefined);
  });
}

function externalAgentCancellation(signal: AbortSignal): Effect.Effect<Result.Result<never, AgentAttemptFailure>> {
  return Effect.callback(resume => {
    const cancel = () => resume(Effect.succeed(Result.fail({
      type: "cancelled",
      message: "Agent turn was aborted.",
    })));
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", cancel));
  });
}

function remainingTimeout(deadline: number | undefined, nodeId: string, now: number): Result.Result<number | undefined, AgentAttemptFailure> {
  if (deadline === undefined) return Result.succeed(undefined);
  const remaining = deadline - now;
  return remaining <= 0
    ? Result.fail(timeoutFailure(`Agent node '${nodeId}' timed out.`))
    : Result.succeed(remaining);
}

function timeoutFailure(message: string): AgentAttemptFailure {
  return {
    type: "timed_out",
    failure: { origin: "provider", code: "timeout", message },
    message,
  };
}

function persistedDeadline(value: string, nodeId: string): number {
  const deadline = tryParsePersistedDeadline(value);
  if (Result.isFailure(deadline)) throw new Error(`Agent node '${nodeId}' has invalid persisted deadline ${JSON.stringify(value)}.`);
  return deadline.success.getTime();
}
