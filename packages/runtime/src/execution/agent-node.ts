import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { sha256Digest } from "@acpus/core/content-identity";
import type { AgentDefinitionIR, AgentNodeIR, WorkflowIR } from "@acpus/core/ir";
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
import { err, ok, ResultAsync, type Result } from "neverthrow";
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
import { schedulerStoreError, throwSchedulerStoreResult } from "../scheduler/store-port.js";
import { pruneUndefined } from "../stable-json.js";
import type { RunDirectoryToken } from "../store/path-fence.js";
import type { RuntimeStore } from "../store/store.js";
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
  agents: WorkflowIR["agents"];
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
      store: RuntimeStore;
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

export function executeAgentNode(node: AgentNodeIR, scope: EvaluationScope, options: AgentExecutorOptions): ResultAsync<JsonValue, AgentAttemptFailure> {
  return new ResultAsync(executeAgentNodeResult(node, scope, options));
}

async function executeAgentNodeResult(node: AgentNodeIR, scope: EvaluationScope, options: AgentExecutorOptions): Promise<Result<JsonValue, AgentAttemptFailure>> {
  assertStoredAgentAttemptContext(options);
  const turns: AgentTurnRecord[] = [];
  const artifactRun = agentArtifactRun(options);
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
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }
    : undefined;
  let activeProgress: AgentProgressTurn | undefined;
  const writeTerminalState = async (
    status: AgentProgressTerminalStatus,
    message?: string,
    result?: AgentTurnResult,
  ): Promise<void> => {
    if (result) activeProgress?.publishTerminal(status, result.snapshot, message);
    try {
      await writeAgentAttemptMetadata(node, options, agentSessionIdForMetadata, explicitSessionKey, responseRepairMax, status, turns, message);
    } catch (error) {
      if (!isAttemptFenceError(error)) throw error;
    }
  };
  const finishFailure = async (
    failure: AgentAttemptFailure,
    result?: AgentTurnResult,
  ): Promise<Result<never, AgentAttemptFailure>> => {
    const status = failure.type === "cancelled" ? "cancelled" : failure.type === "timed_out" ? "timed_out" : "failed";
    try {
      await writeTerminalState(status, failure.message, result);
    } catch (metadataError) {
      throw new AggregateError([failure, metadataError], `Agent node '${node.id}' failed and its terminal metadata could not be persisted.`);
    }
    return err(failure);
  };

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
        return finishFailure({ type: "failed", failure, message: failure.message });
      }
      responseRepairMax = options.hostPolicy.responseRepair.max;
    } else {
      responseRepairMax = 0;
    }
    const cwd = node.run.cwd ? tryResolveString(node.run.cwd, scope, "agent cwd") : ok(definition.cwd ?? options.cwd);
    if (cwd.isErr()) return finishFailure(resolutionFailure(cwd.error));
    const dynamic = dynamicEnv(node.run.env, scope);
    if (dynamic.isErr()) return finishFailure(resolutionFailure(dynamic.error));
    const managedEnv = {
      ...staticEnv(definition.env),
      ...dynamic.value,
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
    if (session.isErr()) return finishFailure(resolutionFailure(session.error));
    explicitSessionKey = session.value.explicitSessionKey;
    agentSessionIdForMetadata = session.value.agentSessionId;
    const effectiveModel = definition.config?.model ?? definition.model;
    const permissionMode = node.run.permissionMode ?? definition.permissionMode ?? "approve-all";
    const maxRepairTurns = responseRepairMax;
    const authoredPrompt = renderAgentPrompt(node, scope, options)
      .map(rendered => buildAuthoredAgentPrompt(rendered, node.outputSchema));
    if (authoredPrompt.isErr()) return finishFailure(resolutionFailure(authoredPrompt.error));
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
          scopeDigest: session.value.scopeDigest,
          explicitShared: session.value.explicitShared,
          authored: { promptOrigin: "authored", inputDigest: authoredPrompt.value.inputDigest },
          ...(steeringPrompt === undefined || initialPrompt.kind !== "steer" ? {} : {
            steering: {
              steerId: initialPrompt.steerId,
              instruction: initialPrompt.instruction,
              promptOrigin: "steering" as const,
              inputDigest: steeringPrompt.inputDigest,
            },
          }),
        })
      : ok<AgentAttemptOperationPlan>({
          operation: "start",
          session: { ...session.value, generation: 1 },
          sessionOpenMode: "new_or_empty",
          promptOrigin: "authored",
          inputDigest: authoredPrompt.value.inputDigest,
        });
    if (planResult.isErr()) {
      const failure: AgentNodeFailure = {
        origin: "runtime",
        code: planResult.error.type,
        message: planResult.error.message,
      };
      return finishFailure({ type: "failed", failure, message: failure.message });
    }
    const plan = planResult.value;
    agentSessionIdForMetadata = plan.session.agentSessionId;
    const plannedPrompt = plan.promptOrigin === "authored"
      ? authoredPrompt.value.prompt
      : steeringPrompt?.prompt;
    if (plannedPrompt === undefined) throw new Error(`Agent Attempt '${options.attemptId}' has no prompt for '${plan.promptOrigin}'.`);
    let prompt: string = plannedPrompt;
    const steerEventSequence = "steerEventSequence" in plan ? plan.steerEventSequence : undefined;
    if (options.store) {
      throwSchedulerStoreResult(options.store.scheduler.tryBindAgentAttemptSession({
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
        }));
    }
    let checkpoint: AgentSessionCheckpointValue = {
      checkpoint: "not_dispatched",
      attemptId: options.attemptId ?? `local-${node.id}`,
      promptOrigin: plan.promptOrigin,
      inputDigest: plan.inputDigest,
    };
    const supervisor = options.agentSessionSupervisor ?? unavailableAgentSessionSupervisor();
    const supervised = await supervisor.withSessionLease({
      attempt: {
        runId: options.runId ?? `local-${node.id}`,
        nodeKey: options.nodeKey ?? node.id,
        attemptId: options.attemptId ?? `local-${node.id}`,
        ownerEpoch: options.ownerEpoch ?? 0,
        ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
        signal: options.signal ?? new AbortController().signal,
        ...(options.hostPolicy.inactivityFailAfterMs === undefined ? {} : { inactivityFailAfterMs: options.hostPolicy.inactivityFailAfterMs }),
      },
      session: {
        agentSessionId: plan.session.agentSessionId,
        sessionOpenMode: plan.sessionOpenMode,
        agent: agentSelector(definition),
        cwd: cwd.value,
        env,
        permissionMode,
        configuration: {
          ...(effectiveModel === undefined ? {} : { model: effectiveModel }),
          options: Object.fromEntries(Object.entries(definition.config ?? {}).filter(([key]) => key !== "model")),
        },
      },
    }, lease => new ResultAsync((async () => {
      if (options.store && options.runId && options.attemptId && options.ownerEpoch !== undefined) {
        throwSchedulerStoreResult(options.store.scheduler.tryRecordAgentSessionBinding({
          runId: options.runId,
          attemptId: options.attemptId,
          ownerEpoch: options.ownerEpoch,
          agentSessionId: lease.agentSessionId,
          bindingDigest: lease.bindingFingerprint.digest as import("@acpus/core/content-identity").Sha256Digest,
          ...(lease.reportedVersion === undefined ? {} : { reportedVersion: lease.reportedVersion }),
        }));
      }
      for (let turn = 0; turn <= maxRepairTurns; turn += 1) {
        const remaining = remainingTimeout(deadline, node.id);
        if (remaining.isErr()) return finishFailure(remaining.error);
        if (options.signal?.aborted) {
          return finishFailure(abortedTurnFailure());
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
        const result = await executeObservedAgentTurn(
          node,
          options,
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
              cwd: cwd.value,
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
        if (options.signal?.aborted) {
          turns.push(agentTurnRecord(turn + 1, result));
          return finishFailure(abortedTurnFailure(result));
        }
        let turnRecord: AgentTurnRecord;
        try {
          turnRecord = await writeAgentTurnArtifacts(
            node,
            options,
            turn + 1,
            request,
            result,
            artifactRun,
          );
        } catch (error) {
          if (!isAttemptFenceError(error)) throw error;
          turns.push(agentTurnRecord(turn + 1, result));
          return finishFailure({ type: "cancelled", message: "Agent turn was fenced." });
        }
        turns.push(turnRecord);
        if (options.signal?.aborted) return finishFailure(abortedTurnFailure(result));
        if (result.status === "cancelled") {
          return finishFailure({ type: "cancelled", message: result.message }, result);
        }
        if (result.status === "failed" && result.failure.kind === "timeout") {
          const failure = agentNodeFailure(result.failure);
          return finishFailure({ type: "timed_out", failure, message: failure.message }, result);
        }
        if (result.status === "failed") {
          const failure = agentNodeFailure(result.failure);
          return finishFailure({ type: "failed", failure, message: failure.message }, result);
        }
        if (!node.outputSchema) {
          await writeTerminalState("completed", undefined, result);
          return ok(result.finalResponse);
        }
        const conformed = conformAgentOutput(node.outputSchema, result.finalResponse, node.id);
        const outputProcessing = conformed.isOk() ? conformed.value.outputProcessing : conformed.error.outputProcessing;
        turns[turn] = { ...turns[turn]!, outputProcessing };
        if (conformed.isOk()) {
          await writeTerminalState("completed", undefined, result);
          return ok(conformed.value.output);
        }
        const rejected = conformed.error;
        turns[turn] = { ...turns[turn]!, failure: { kind: rejected.kind, message: rejected.message } };
        if (turn === maxRepairTurns) {
          const failure: AgentNodeFailure = { origin: "provider", code: rejected.kind, message: rejected.message };
          return finishFailure({ type: "failed", failure, message: failure.message }, result);
        }
        const delayed = await delay(DEFAULT_REPAIR_DELAY_MS, options.signal, deadline);
        if (delayed.isErr()) return finishFailure(delayed.error);
        const repair = buildRepairAgentPrompt(node.outputSchema, rejected.phase);
        prompt = repair.prompt;
        if (options.store) {
          checkpoint = throwSchedulerStoreResult(options.store.scheduler.tryAdvanceAgentSessionCheckpoint({
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
          }));
        }
      }
      throw new Error(`Agent node '${node.id}' exhausted response repair.`);
    })()));
    if (supervised.isOk()) return ok(supervised.value);
    if (supervised.error.type === "use") return err(supervised.error.error);
    if (supervised.error.type === "use_and_cleanup") return err(supervised.error.use);
    if (supervised.error.type === "acquire"
      && supervised.error.error.type === "session_open_failed") {
      const failure = agentNodeFailure(backendFailureFromAcp(supervised.error.error.error));
      return finishFailure({ type: "failed", failure, message: failure.message });
    }
    const message = supervised.error.type === "acquire"
      ? supervised.error.error.message
      : supervised.error.error.message;
    const failure: AgentNodeFailure = { origin: "runtime", code: "agent_session_acquire_failed", message };
    return finishFailure({ type: "failed", failure, message });
}

async function executeObservedAgentTurn(
  node: AgentNodeIR,
  options: AgentExecutorOptions,
  turn: number,
  promptKind: "task" | "steer" | "repair",
  request: AgentTurnRequestRecord,
  runTurn: (request: AgentTurnRequestRecord) => Promise<AgentTurnResult>,
): Promise<AgentTurnResult> {
  if (!options.store
    || !options.runId
    || !options.nodeKey
    || !options.attemptId
    || options.attemptNo === undefined) {
    return runTurn(request);
  }
  return options.store.observationLog.captureTurn({
    runId: options.runId,
    nodeId: node.id,
    nodeKey: options.nodeKey,
    attemptId: options.attemptId,
    attemptNo: options.attemptNo,
    turn,
    promptKind,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }, request, runTurn, () => cancelledAgentTurn("Agent Turn was fenced before Provider dispatch."));
}

async function runLeasedAgentTurn(input: {
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
}): Promise<AgentTurnResult> {
  let checkpoint = input.checkpoint;
  if (input.options.store) {
    if (checkpoint.checkpoint !== "not_dispatched") {
      throw new Error(`Agent Turn '${input.request.turnId}' does not start from not_dispatched.`);
    }
    checkpoint = throwSchedulerStoreResult(input.options.store.scheduler.tryCommitAgentTurnDispatch({
      runId: input.options.runId,
      ownerEpoch: input.options.ownerEpoch,
      agentSessionId: input.lease.agentSessionId,
      attemptId: input.options.attemptId,
      turnId: input.request.turnId,
      sessionLeaseId: input.lease.sessionLeaseId,
      expected: checkpoint,
      invocationMetadata: agentInvocationMetadata(input.node, input.options, input.invocation),
    }));
    input.onCheckpoint(checkpoint);
    if (checkpoint.checkpoint === "not_dispatched") throw new Error("Dispatch commit returned not_dispatched.");
    checkpoint = throwSchedulerStoreResult(input.options.store.scheduler.tryAdvanceAgentSessionCheckpoint({
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
    }));
    input.onCheckpoint(checkpoint);
  }
  let settled: Awaited<ReturnType<AgentSessionLease["runTurn"]>>;
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
  }) : undefined;
  try {
    settled = await input.lease.runTurn({
      turnId: input.request.turnId,
      prompt: input.request.prompt,
      onEvent: event => {
        try {
          if (input.options.store
            && (checkpoint.checkpoint === "dispatch_intent" || checkpoint.checkpoint === "owned_in_flight")) {
            checkpoint = advanceAgentCheckpoint(input.options, input.lease, checkpoint as Exclude<AgentSessionCheckpointValue, { checkpoint: "not_dispatched" }>, "provider_observed", "provider_activity");
            input.onCheckpoint(checkpoint);
          }
          input.request.onEvent(event);
          return ok(undefined);
        } catch (error) {
          return err(error);
        }
      },
    });
  } finally {
    unregister?.();
  }
  if (input.options.store) {
    if (settled.isOk() || settled.error.evidence.protocolTerminal !== undefined) {
      checkpoint = advanceAgentCheckpoint(input.options, input.lease, checkpoint as Exclude<AgentSessionCheckpointValue, { checkpoint: "not_dispatched" }>, "terminal_observed", "provider_terminal");
    } else if (settled.error.evidence.localFailure?.error.providerEvidence === "inbound_activity") {
      checkpoint = advanceAgentCheckpoint(input.options, input.lease, checkpoint as Exclude<AgentSessionCheckpointValue, { checkpoint: "not_dispatched" }>, "terminal_unknown", "inbound_local_failure");
    } else if (checkpoint.checkpoint !== "acceptance_unknown" && checkpoint.checkpoint !== "terminal_unknown") {
      const next = checkpoint.checkpoint === "provider_observed" ? "terminal_unknown" : "acceptance_unknown";
      checkpoint = advanceAgentCheckpoint(input.options, input.lease, checkpoint as Exclude<AgentSessionCheckpointValue, { checkpoint: "not_dispatched" }>, next, "loss_without_new_provider_evidence");
    }
    input.onCheckpoint(checkpoint);
  }
  return settled.match(
    outcome => ({
      status: "completed" as const,
      finalResponse: outcome.finalResponse,
      ...outcome.snapshot,
      snapshot: outcome.snapshot,
    }),
    failure => turnResultFromSupervisorFailure(failure),
  );
}

function advanceAgentCheckpoint(
  options: Extract<AgentExecutorOptions, { store: RuntimeStore }>,
  lease: AgentSessionLease,
  expected: Exclude<AgentSessionCheckpointValue, { checkpoint: "not_dispatched" }>,
  next: "provider_observed" | "terminal_observed" | "acceptance_unknown" | "terminal_unknown",
  cause: "provider_activity" | "provider_terminal" | "loss_without_new_provider_evidence" | "inbound_local_failure",
): AgentSessionCheckpointValue {
  const ordinary = options.store.scheduler.tryAdvanceAgentSessionCheckpoint({
    runId: options.runId,
    ownerEpoch: options.ownerEpoch,
    agentSessionId: lease.agentSessionId,
    attemptId: options.attemptId,
    expected,
    next: { ...expected, checkpoint: next },
    cause,
  });
  if (ordinary.isOk()) return ordinary.value;
  if (ordinary.error.type !== "terminal-attempt" && ordinary.error.type !== "owner-epoch-stale" && ordinary.error.type !== "owner-epoch-inactive") {
    return throwSchedulerStoreResult(ordinary);
  }
  return throwSchedulerStoreResult(options.store.scheduler.trySettleFencedAgentSessionCheckpoint({
    runId: options.runId,
    runtimeOwnerEpoch: options.runtimeOwnerEpoch,
    agentSessionId: lease.agentSessionId,
    attemptId: options.attemptId,
    turnId: expected.turnId,
    sessionLeaseId: expected.sessionLeaseId,
    expected: expected.checkpoint,
    next,
    cause,
    observedAt: new Date(),
  }));
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
    withSessionLease: input => new ResultAsync(Promise.resolve(err({
      type: "acquire" as const,
      error: {
        type: "supervisor_closed" as const,
        agentSessionId: input.session.agentSessionId,
        message: "Agent execution requires an Agent Session supervisor.",
      },
    }))),
    withSessionsNeutralized: () => new ResultAsync(Promise.resolve(err({
      type: "acquire" as const,
      error: { type: "supervisor_closed" as const, message: "Agent Session supervisor is unavailable." },
    }))),
    shutdown: () => new ResultAsync(Promise.resolve(ok(undefined))),
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

function cancelledAgentTurn(message: string): AgentTurnResult {
  const now = new Date().toISOString();
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

function renderAgentPrompt(node: AgentNodeIR, scope: EvaluationScope, options: AgentExecutorOptions): Result<string, ResolutionError> {
  const field = `Agent node '${node.id}' prompt`;
  try {
    return tryResolveString(node.run.prompt, scope, field, {
      formatTemplateValue: value => {
        if (!isArtifactRefCandidate(value)) return undefined;
        if (!options.store || !options.runId) throw new Error("Agent ArtifactRef interpolation requires runtime store and run id.");
        const resolved = tryBindArtifactRef(value, { runId: options.runId, store: options.store });
        if (resolved.isErr()) throw resolved.error;
        return resolved.value.path;
      },
    });
  } catch (error) {
    if (!isArtifactPathError(error)) throw error;
    return err({ type: "evaluation", field, message: error.message });
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

function dynamicEnv(env: AgentNodeIR["run"]["env"], scope: EvaluationScope): Result<Record<string, string>, ResolutionError> {
  if (!env) return ok({});
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const item = tryResolveString(value, scope, `Agent env '${key}'`);
    if (item.isErr()) return err(item.error);
    resolved[key] = item.value;
  }
  return ok(resolved);
}

function staticEnv(env: AgentDefinitionIR["env"]): Record<string, string> {
  return env ? { ...env } : {};
}

function agentSelector(definition: AgentDefinitionIR): AgentSelector {
  return definition.kind === "agent_command"
    ? { kind: "command", command: definition.command }
    : { kind: "named", name: definition.use };
}

async function writeAgentTurnArtifacts(
  node: AgentNodeIR,
  options: AgentExecutorOptions,
  turn: number,
  request: AgentTurnRequestRecord,
  result: AgentTurnResult,
  artifactRun?: RunDirectoryToken,
): Promise<AgentTurnRecord> {
  const base = agentTurnRecord(turn, result);
  if (!options.store || !options.runId) return base;
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
  const record: AgentTurnRecord = {
    ...base,
    turnArtifact: await writeAgentArtifact(options, artifactRun, turn, "json", `${JSON.stringify(turnArtifact, null, 2)}\n`, "application/json"),
  };
  return record;
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

async function writeAgentArtifact(
  options: AgentExecutorOptions,
  run: RunDirectoryToken | undefined,
  turn: number,
  name: string,
  content: string,
  mediaType: string,
): Promise<AgentArtifactRef> {
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
  const file = await writeRunFile({ run, relativePath, bytes, label });
  try {
    verifyRunFile(run, file, label);
    throwSchedulerStoreResult(options.store.registerArtifact({
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
    }));
  } catch (error) {
    try {
      await removeRunFile(run, file, label);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Agent artifact '${id}' registration failed and its unregistered file could not be removed.`);
    }
    throw error;
  }
  verifyRunFile(run, file, label);
  return { artifactId: id, mediaType };
}

function agentArtifactRun(options: AgentExecutorOptions): RunDirectoryToken | undefined {
  if (!options.store || !options.runId) return undefined;
  const run = options.store.getRunDirectoryToken(options.runId);
  if (!run) throw new Error(`Run '${options.runId}' has no run directory.`);
  return run;
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

async function writeAgentAttemptMetadata(
  node: AgentNodeIR,
  options: AgentExecutorOptions,
  agentSessionId: string | undefined,
  explicitSessionKey: string | undefined,
  responseRepairMax: number | null | undefined,
  status: "completed" | "failed" | "cancelled" | "timed_out",
  turns: AgentTurnRecord[],
  message?: string,
): Promise<void> {
  if (!options.store) return;
  throwSchedulerStoreResult(options.store.writeExecutionMetadata({
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
  }));
}

function delay(ms: number, signal: AbortSignal | undefined, deadline: number | undefined): Promise<Result<void, AgentAttemptFailure>> {
  if (ms <= 0) return Promise.resolve(ok(undefined));
  const remaining = remainingTimeout(deadline, "response repair");
  if (remaining.isErr()) return Promise.resolve(err(remaining.error));
  const delayMs = remaining.value === undefined ? ms : Math.min(ms, remaining.value);
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve(err({ type: "cancelled", message: "Agent response repair was aborted." }));
      return;
    }
    const abort = () => {
      clearTimeout(timeout);
      resolve(err({ type: "cancelled", message: "Agent response repair was aborted." }));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      if (remaining.value !== undefined && remaining.value <= ms) {
        resolve(err(timeoutFailure("Agent response repair timed out.")));
      } else {
        resolve(ok(undefined));
      }
    }, delayMs);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function remainingTimeout(deadline: number | undefined, nodeId: string): Result<number | undefined, AgentAttemptFailure> {
  if (deadline === undefined) return ok(undefined);
  const remaining = deadline - Date.now();
  return remaining <= 0
    ? err(timeoutFailure(`Agent node '${nodeId}' timed out.`))
    : ok(remaining);
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
  if (deadline.isErr()) throw new Error(`Agent node '${nodeId}' has invalid persisted deadline ${JSON.stringify(value)}.`);
  return deadline.value.getTime();
}
