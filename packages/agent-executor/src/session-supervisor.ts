import { randomUUID } from "node:crypto";
import { interruptOnAbort } from "@acpus/acp/cancellation";
import type { ProcessHostShape } from "@acpus/owned-process";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { resolveAcpAgentLaunch } from "./agent-resolution.js";
import {
  findOwnershipManifest,
  recoverProcessCapsules,
  revalidateOwnership,
  type QuarantinedOwnership,
} from "./ownership.js";
import { normalizeRuntimeOwner, type NormalizedRuntimeOwnerIdentity } from "./owner.js";
import {
  openProcessCapsule,
  type ProcessCapsule,
  type ProcessCapsuleOpenFailure,
  type ProcessCapsuleTurnSettlement,
} from "./process-capsule.js";
import type {
  AgentSessionAcquireError,
  AgentSessionCleanupError,
  AgentSessionLease,
  AgentSessionNeutralizationError,
  AgentSessionRef,
  AgentSessionShutdownError,
  AgentSessionSupervisor,
  AgentSessionSupervisorOptions,
  AgentSessionSupervisorStartError,
  AgentSessionUseError,
  AgentTurnFailure,
  AgentTurnOutcome,
  SessionNeutralizationEvidence,
  SessionOwnershipEvidence,
  TurnInput,
} from "./types.js";

type LeaseCloseReason = "neutralize" | "shutdown";

type LeaseRecord = {
  readonly session: AgentSessionRef;
  readonly scope: Scope.Closeable;
  readonly operationSettled: Deferred.Deferred<void>;
  readonly cleanup: Deferred.Deferred<SessionNeutralizationEvidence, AgentSessionCleanupError>;
  capsuleScope?: Scope.Closeable;
  capsule?: ProcessCapsule;
  closeReason?: LeaseCloseReason;
};

type SupervisorState = {
  readonly options: AgentSessionSupervisorOptions;
  readonly processes: ProcessHostShape;
  readonly owner: NormalizedRuntimeOwnerIdentity;
  readonly scope: Scope.Closeable;
  readonly admission: Semaphore.Semaphore;
  readonly operations: FiberSet.FiberSet<unknown, unknown>;
  readonly leases: Map<string, LeaseRecord>;
  readonly neutralizing: Set<string>;
  readonly quarantined: Map<string, QuarantinedOwnership>;
  cleanup: Effect.Effect<void, AgentSessionShutdownError>;
  cleanupObserved: boolean;
  closed: boolean;
};

/** Creates the workspace-local authority for AgentSession leases and capsule cleanup. */
export function createAgentSessionSupervisor(
  options: AgentSessionSupervisorOptions,
  processes: ProcessHostShape,
): Effect.Effect<AgentSessionSupervisor, AgentSessionSupervisorStartError, Scope.Scope> {
  return Effect.gen(function*() {
    const parentScope = yield* Scope.Scope;
    const owner = yield* normalizeRuntimeOwner(options.owner, processes);
    const recovered = yield* recoverProcessCapsules(options, processes);
    const scope = yield* Scope.fork(parentScope);
    const operations = yield* Scope.provide(scope)(FiberSet.make<unknown, unknown>());
    const state: SupervisorState = {
      options,
      processes,
      owner,
      scope,
      admission: Semaphore.makeUnsafe(1),
      operations,
      leases: new Map(),
      neutralizing: new Set(),
      quarantined: new Map(recovered),
      cleanup: Effect.void,
      cleanupObserved: false,
      closed: false,
    };
    state.cleanup = yield* Effect.cached(Effect.uninterruptible(shutdownSupervisor(state)));
    yield* Scope.addFinalizer(scope, supervisorFinalizer(state));
    return {
      withSessionLease: (input, use) => withSessionLease(state, input, use),
      withSessionsNeutralized: (input, commit) => withSessionsNeutralized(state, input, commit),
      shutdown: () => closeSupervisor(state),
    };
  });
}

function withSessionLease<T, E>(
  state: SupervisorState,
  input: Parameters<AgentSessionSupervisor["withSessionLease"]>[0],
  use: (lease: AgentSessionLease) => Effect.Effect<T, E>,
): Effect.Effect<T, AgentSessionUseError<E>> {
  const agentSessionId = input.session.agentSessionId;
  return state.admission.withPermit(Effect.gen(function*() {
    if (state.closed) {
      return yield* Effect.fail({
        type: "acquire" as const,
        error: supervisorClosed(agentSessionId),
      });
    }
    if (state.neutralizing.has(agentSessionId) || state.leases.has(agentSessionId)) {
      return yield* Effect.fail({
        type: "acquire" as const,
        error: sessionBusy(agentSessionId),
      });
    }
    const record: LeaseRecord = {
      session: { runId: input.attempt.runId, agentSessionId },
      scope: yield* Scope.fork(state.scope),
      operationSettled: Deferred.makeUnsafe(),
      cleanup: Deferred.makeUnsafe(),
    };
    state.leases.set(agentSessionId, record);
    const sessionFiber = yield* Effect.forkIn(
      useSessionLease(state, record, input, use),
      record.scope,
      { startImmediately: true },
    );
    yield* FiberSet.add(state.operations, sessionFiber);
    return sessionFiber;
  })).pipe(Effect.flatMap(joinOwned));
}

function useSessionLease<T, E>(
  state: SupervisorState,
  record: LeaseRecord,
  input: Parameters<AgentSessionSupervisor["withSessionLease"]>[0],
  use: (lease: AgentSessionLease) => Effect.Effect<T, E>,
): Effect.Effect<T, AgentSessionUseError<E>> {
  const operation: Effect.Effect<T, AgentSessionUseError<E>> = Effect.gen(function*() {
    const agentSessionId = input.session.agentSessionId;
    const quarantine = yield* revalidateQuarantine(state, agentSessionId);
    if (quarantine !== undefined) {
      return yield* Effect.fail({
        type: "acquire" as const,
        error: {
          type: "session_quarantined" as const,
          agentSessionId,
          evidence: quarantine,
          message: "Agent Session has residual process ownership.",
        },
      });
    }
    const unavailable = attemptUnavailable(
      input.attempt,
      agentSessionId,
      "acquire",
      yield* Clock.currentTimeMillis,
    );
    if (unavailable !== undefined) {
      return yield* Effect.fail({ type: "acquire" as const, error: unavailable });
    }
    const resolved = yield* resolveAcpAgentLaunch({
      agent: input.session.agent,
      ...(input.session.configuration.model === undefined
        ? {}
        : { model: input.session.configuration.model }),
      ...(state.options.namedAgentLaunches === undefined
        ? {}
        : { namedAgentLaunches: state.options.namedAgentLaunches }),
      ...(state.options.configuredAgentCommand === undefined
        ? {}
        : { configuredAgentCommand: state.options.configuredAgentCommand }),
    }).pipe(Effect.mapError(error => ({
      type: "acquire" as const,
      error: {
        type: "agent_resolution_failed" as const,
        agentSessionId,
        error,
        message: error.message,
      },
    })));
    const beforeOpen = attemptUnavailable(
      input.attempt,
      agentSessionId,
      "open",
      yield* Clock.currentTimeMillis,
    );
    if (beforeOpen !== undefined) {
      return yield* Effect.fail({ type: "acquire" as const, error: beforeOpen });
    }
    const capsuleScope = yield* Scope.fork(record.scope);
    record.capsuleScope = capsuleScope;
    const capsule = yield* Scope.provide(capsuleScope)(openProcessCapsule({
      options: state.options,
      owner: state.owner,
      attempt: input.attempt,
      session: input.session,
      sessionLeaseId: `lease_${randomUUID()}`,
      resolvedLaunch: resolved,
    }, state.processes)).pipe(Effect.mapError(error => ({
      type: "acquire" as const,
      error: openFailure(agentSessionId, error),
    })));
    record.capsule = capsule;
    return yield* use(leaseFor(capsule, input.attempt)).pipe(
      Effect.mapError(error => ({ type: "use" as const, error })),
    );
  });

  return Effect.uninterruptibleMask(restore => Effect.gen(function*() {
    const outcome = yield* Effect.exit(restore(operation));
    Deferred.doneUnsafe(record.operationSettled, Effect.void);
    const cleanup = yield* settleLeaseCleanup(state, record);
    const settled = yield* Effect.exit(combineLeaseSettlement(outcome, cleanup));
    yield* Scope.close(record.scope, settled);
    return yield* settled;
  }));
}

function settleLeaseCleanup(
  state: SupervisorState,
  record: LeaseRecord,
): Effect.Effect<Exit.Exit<SessionNeutralizationEvidence, AgentSessionCleanupError>> {
  return Effect.uninterruptible(Effect.gen(function*() {
    const cleanup = yield* Effect.exit(record.capsule === undefined
      ? settleMissingCapsuleCleanup(state, record)
      : record.capsule.close(record.closeReason ?? "lease_settled"));
    if (Exit.isFailure(cleanup)) {
      const error = onlyError(cleanup.cause);
      if (error !== undefined && error.evidence.state !== "dead") {
        state.quarantined.set(record.session.agentSessionId, { evidence: error.evidence });
      }
    }
    if (state.leases.get(record.session.agentSessionId) === record) {
      state.leases.delete(record.session.agentSessionId);
    }
    Deferred.doneUnsafe(record.cleanup, cleanup);
    return cleanup;
  }));
}

function settleMissingCapsuleCleanup(
  state: SupervisorState,
  record: LeaseRecord,
): Effect.Effect<SessionNeutralizationEvidence, AgentSessionCleanupError> {
  return Effect.gen(function*() {
    if (record.capsuleScope !== undefined) {
      yield* Effect.exit(Scope.close(record.capsuleScope, Exit.void));
    }
    const found = yield* Effect.result(findOwnershipManifest(
      state.options.workersRoot,
      record.session.agentSessionId,
    ));
    if (Result.isFailure(found)) {
      const evidence = yield* unverifiedOwnership(found.failure.message);
      return yield* Effect.fail({
        type: "cleanup_unverified" as const,
        agentSessionId: record.session.agentSessionId,
        evidence: { ...evidence, state: "unverified" as const },
        message: "ACP capsule ownership cleanup could not be verified after open failed.",
      });
    }
    if (found.success === undefined) {
      return {
        session: record.session,
        disposition: "already_absent",
        observedAt: yield* nowIso,
      };
    }
    const evidence = yield* revalidateOwnership(found.success, state.processes).pipe(
      Effect.catch(error => unverifiedOwnership(errorMessage(error))),
    );
    if (evidence.state === "dead") {
      return {
        session: record.session,
        disposition: "already_absent",
        observedAt: evidence.observedAt,
      };
    }
    if (evidence.state === "unverified") {
      return yield* Effect.fail({
        type: "cleanup_unverified" as const,
        agentSessionId: record.session.agentSessionId,
        evidence: { ...evidence, state: "unverified" as const },
        message: "ACP capsule process-tree death could not be verified after open failed.",
      });
    }
    return yield* Effect.fail({
      type: "cleanup_failed" as const,
      agentSessionId: record.session.agentSessionId,
      evidence,
      message: "ACP capsule process tree remains after open failed.",
    });
  });
}

function combineLeaseSettlement<T, E>(
  outcome: Exit.Exit<T, AgentSessionUseError<E>>,
  cleanup: Exit.Exit<SessionNeutralizationEvidence, AgentSessionCleanupError>,
): Effect.Effect<T, AgentSessionUseError<E>> {
  if (Exit.isSuccess(cleanup)) return outcome;
  const cleanupCause = Cause.map(cleanup.cause, error => ({
    type: "cleanup" as const,
    error,
  } satisfies AgentSessionUseError<E>));
  if (Exit.isSuccess(outcome)) return Effect.failCause(cleanupCause);
  const useError = onlyError(outcome.cause);
  const cleanupError = onlyError(cleanup.cause);
  if (useError?.type === "use" && cleanupError !== undefined) {
    return Effect.fail({
      type: "use_and_cleanup",
      use: useError.error,
      cleanup: cleanupError,
    });
  }
  return Effect.failCause(Cause.combine(outcome.cause, cleanupCause));
}

function leaseFor(
  capsule: ProcessCapsule,
  attempt: Parameters<AgentSessionSupervisor["withSessionLease"]>[0]["attempt"],
): AgentSessionLease {
  return {
    agentSessionId: capsule.agentSessionId,
    sessionLeaseId: capsule.sessionLeaseId,
    projectionRef: capsule.projectionRef,
    ...(capsule.reportedVersion === undefined ? {} : { reportedVersion: capsule.reportedVersion }),
    runTurn: input => runTurn(capsule, attempt, input),
  };
}

function runTurn<E>(
  capsule: ProcessCapsule,
  attempt: Parameters<AgentSessionSupervisor["withSessionLease"]>[0]["attempt"],
  input: TurnInput<E>,
): Effect.Effect<AgentTurnOutcome, AgentTurnFailure<E>> {
  return Effect.gen(function*() {
    const settlement = yield* capsule.runTurn({
      turnId: input.turnId,
      prompt: input.prompt,
      signal: attempt.signal,
      ...(attempt.deadlineAt === undefined ? {} : { deadlineAt: attempt.deadlineAt }),
      ...(attempt.inactivityFailAfterMs === undefined
        ? {}
        : { inactivityFailAfterMs: attempt.inactivityFailAfterMs }),
      onEvent: input.onEvent,
    });
    return yield* Effect.fromResult(mapTurnSettlement(
      settlement,
      attempt.deadlineAt,
      yield* Clock.currentTimeMillis,
    ));
  });
}

function mapTurnSettlement<E>(
  settlement: ProcessCapsuleTurnSettlement<E>,
  deadlineAt: string | undefined,
  now: number,
): Result.Result<AgentTurnOutcome, AgentTurnFailure<E>> {
  const snapshot = settlement.snapshot;
  const evidence = {
    ...(settlement.policy === undefined ? {} : { policy: settlement.policy }),
    ...(settlement.terminal?.type === "provider_result" ? { protocolTerminal: settlement.terminal } : {}),
    ...(settlement.terminal?.type === "provider_error_response" ? { protocolTerminal: settlement.terminal } : {}),
    ...(settlement.terminal?.type === "local_error" ? { localFailure: settlement.terminal } : {}),
    ...(settlement.hardCleanup === undefined ? {} : { hardCleanup: settlement.hardCleanup }),
  };
  if (settlement.sinkError !== undefined) {
    return Result.fail({ type: "event_sink", error: settlement.sinkError, snapshot, evidence });
  }
  if (settlement.policy?.type === "deadline") {
    return Result.fail({ type: "policy_timeout", deadlineAt: settlement.policy.deadlineAt, snapshot, evidence });
  }
  if (settlement.policy?.type === "inactivity") {
    return Result.fail({
      type: "inactivity_stale",
      failAfterMs: settlement.policy.failAfterMs,
      silentForMs: settlement.policy.silentForMs,
      silenceStartedAt: settlement.policy.silenceStartedAt,
      snapshot,
      evidence,
    });
  }
  if (settlement.policy?.type === "cancelled") {
    return Result.fail({
      type: "cancelled",
      reason: settlement.policy.reason === "event_sink" ? "operator" : settlement.policy.reason,
      snapshot,
      evidence,
    });
  }
  if (settlement.capsuleError !== undefined) {
    return Result.fail({ type: "capsule_lost", error: settlement.capsuleError, snapshot, evidence });
  }
  if (settlement.terminal?.type === "provider_error_response" || settlement.terminal?.type === "local_error") {
    return Result.fail({ type: "acp", error: settlement.terminal.error, snapshot, evidence });
  }
  if (settlement.terminal?.type === "provider_result" && settlement.terminal.result.status === "cancelled") {
    return Result.fail({ type: "cancelled", reason: "provider", snapshot, evidence });
  }
  if (deadlineAt !== undefined && now > new Date(deadlineAt).getTime()) {
    return Result.fail({ type: "policy_timeout", deadlineAt, snapshot, evidence });
  }
  if (settlement.terminal?.type !== "provider_result" || settlement.terminal.result.status !== "completed") {
    const error = settlement.capsuleError ?? {
      type: "process_capsule" as const,
      phase: "running" as const,
      code: "worker_exit" as const,
      message: "ACP capsule lost its Turn terminal.",
    };
    return Result.fail({ type: "capsule_lost", error, snapshot, evidence });
  }
  const terminal = settlement.terminal.result as import("@acpus/acp").AcpTurnResult
    & Readonly<{ status: "completed" }>;
  return Result.succeed({ terminal, finalResponse: settlement.finalResponse, snapshot });
}

function withSessionsNeutralized<T, E>(
  state: SupervisorState,
  input: Parameters<AgentSessionSupervisor["withSessionsNeutralized"]>[0],
  commit: (evidence: readonly SessionNeutralizationEvidence[]) => Result.Result<T, E>,
): Effect.Effect<T, AgentSessionNeutralizationError<E>> {
  const sessions = normalizeSessions(input.sessions);
  return state.admission.withPermit(Effect.gen(function*() {
    if (input.signal.aborted) {
      return yield* Effect.fail(cancelledNeutralization("acquire"));
    }
    if (state.closed) {
      return yield* Effect.fail({ type: "acquire" as const, error: supervisorClosed() });
    }
    const conflicted = sessions.find(session => state.neutralizing.has(session.agentSessionId));
    if (conflicted !== undefined) {
      return yield* Effect.fail({
        type: "acquire" as const,
        error: {
          type: "session_busy" as const,
          agentSessionId: conflicted.agentSessionId,
          message: "Agent Session is already being neutralized.",
        },
      });
    }
    for (const session of sessions) state.neutralizing.add(session.agentSessionId);
    const fiber = yield* FiberSet.run(
      state.operations,
      neutralizeSessions(state, input.signal, sessions, commit).pipe(
        Effect.ensuring(Effect.sync(() => {
          for (const session of sessions) state.neutralizing.delete(session.agentSessionId);
        })),
      ),
    );
    return fiber;
  })).pipe(Effect.flatMap(joinOwned));
}

function neutralizeSessions<T, E>(
  state: SupervisorState,
  signal: AbortSignal,
  sessions: readonly AgentSessionRef[],
  commit: (evidence: readonly SessionNeutralizationEvidence[]) => Result.Result<T, E>,
): Effect.Effect<T, AgentSessionNeutralizationError<E>> {
  const preflight = Effect.forEach(sessions, session =>
    revalidateQuarantine(state, session.agentSessionId).pipe(Effect.flatMap(quarantine =>
      quarantine === undefined
        ? Effect.void
        : Effect.fail({
            type: "acquire" as const,
            error: {
              type: "session_quarantined" as const,
              agentSessionId: session.agentSessionId,
              evidence: quarantine,
              message: "Agent Session has residual process ownership.",
            },
          })))).pipe(
    Effect.asVoid,
    effect => interruptOnAbort(effect, signal),
    Effect.catchCause(cause => signal.aborted && Cause.hasInterrupts(cause)
      ? Effect.fail(cancelledNeutralization("acquire"))
      : Effect.failCause(cause)),
  );
  return Effect.gen(function*() {
    yield* preflight;
    const settled = yield* Effect.uninterruptible(Effect.forEach(
      sessions,
      session => Effect.result(drainSessionLease(state, session)),
      { concurrency: "unbounded" },
    ));
    const evidence = settled.filter(Result.isSuccess).map(result => result.success);
    const errors = settled.filter(Result.isFailure).map(result => result.failure);
    if (errors.length > 0) {
      return yield* Effect.fail({ type: "neutralize" as const, errors });
    }
    if (signal.aborted) {
      return yield* Effect.fail(cancelledNeutralization("neutralize"));
    }
    return yield* Effect.fromResult(Result.mapError(
      commit(evidence),
      error => ({ type: "commit" as const, error }),
    ));
  });
}

function drainSessionLease(
  state: SupervisorState,
  session: AgentSessionRef,
): Effect.Effect<SessionNeutralizationEvidence, AgentSessionCleanupError> {
  return Effect.suspend(() => {
    const record = state.leases.get(session.agentSessionId);
    if (record === undefined) {
      return nowIso.pipe(Effect.map(observedAt => ({
        session,
        disposition: "already_absent" as const,
        observedAt,
      })));
    }
    record.closeReason ??= "neutralize";
    return closeLeaseRecord(record, "neutralize");
  });
}

function closeLeaseRecord(
  record: LeaseRecord,
  reason: LeaseCloseReason,
): Effect.Effect<SessionNeutralizationEvidence, AgentSessionCleanupError> {
  record.closeReason ??= reason;
  return Effect.gen(function*() {
    if (record.capsule === undefined) {
      yield* Effect.exit(Scope.close(record.scope, Exit.void));
    } else {
      yield* Effect.result(record.capsule.close(reason));
      yield* Effect.yieldNow;
      if (!Deferred.isDoneUnsafe(record.operationSettled)) {
        yield* Effect.exit(Scope.close(record.scope, Exit.void));
      }
    }
    return yield* Deferred.await(record.cleanup);
  });
}

function revalidateQuarantine(
  state: SupervisorState,
  agentSessionId: string,
): Effect.Effect<SessionOwnershipEvidence | undefined> {
  const quarantined = state.quarantined.get(agentSessionId);
  return quarantined === undefined
    ? Effect.succeed(undefined)
    : performQuarantineRevalidation(state, agentSessionId, quarantined);
}

function performQuarantineRevalidation(
  state: SupervisorState,
  agentSessionId: string,
  quarantined: QuarantinedOwnership,
): Effect.Effect<SessionOwnershipEvidence | undefined> {
  return Effect.gen(function*() {
    const found = yield* Effect.result(findOwnershipManifest(
      state.options.workersRoot,
      agentSessionId,
    ));
    if (Result.isFailure(found)) {
      const evidence = yield* unverifiedOwnership(found.failure.message);
      state.quarantined.set(agentSessionId, { ...quarantined, evidence });
      return evidence;
    }
    const manifest = found.success ?? quarantined.manifest;
    if (manifest === undefined) return quarantined.evidence;
    const current = yield* revalidateOwnership(manifest, state.processes).pipe(
      Effect.catch(error => unverifiedOwnership(errorMessage(error))),
    );
    if (current.state === "dead") {
      state.quarantined.delete(agentSessionId);
      return undefined;
    }
    state.quarantined.set(agentSessionId, { evidence: current, manifest });
    return current;
  });
}

function shutdownSupervisor(
  state: SupervisorState,
): Effect.Effect<void, AgentSessionShutdownError> {
  return Effect.gen(function*() {
    const leases = yield* state.admission.withPermit(Effect.sync(() => {
      state.closed = true;
      const records = [...state.leases.values()];
      for (const record of records) record.closeReason ??= "shutdown";
      return records;
    }));
    const settled = yield* Effect.forEach(
      leases,
      record => Effect.result(closeLeaseRecord(record, "shutdown")),
      { concurrency: "unbounded" },
    );
    yield* FiberSet.clear(state.operations);
    yield* FiberSet.awaitEmpty(state.operations);
    const errors = settled.filter(Result.isFailure).map(result => result.failure);
    if (errors.length > 0) {
      return yield* Effect.fail({
        type: "shutdown_failed" as const,
        errors,
        message: "One or more Agent Session capsules could not be cleaned up.",
      });
    }
  });
}

function closeSupervisor(state: SupervisorState): Effect.Effect<void, AgentSessionShutdownError> {
  return Effect.uninterruptible(Effect.gen(function*() {
    state.cleanupObserved = true;
    const result = yield* Effect.result(state.cleanup);
    yield* Scope.close(state.scope, Exit.void);
    return yield* Effect.fromResult(result);
  }));
}

function supervisorFinalizer(state: SupervisorState): Effect.Effect<void> {
  return Effect.suspend(() => state.cleanupObserved
    ? state.cleanup.pipe(Effect.ignore)
    : state.cleanup.pipe(Effect.orDie, Effect.asVoid));
}

function joinOwned<A, E>(fiber: Fiber.Fiber<A, E>): Effect.Effect<A, E> {
  return Fiber.join(fiber).pipe(
    Effect.onInterrupt(() => Fiber.interrupt(fiber).pipe(Effect.asVoid)),
  );
}

function openFailure(
  agentSessionId: string,
  failure: ProcessCapsuleOpenFailure,
): AgentSessionAcquireError {
  if (failure.type === "cancelled") {
    return { type: "cancelled", agentSessionId, phase: "open", message: failure.message };
  }
  if (failure.type === "session_open_failed") {
    return {
      type: "session_open_failed",
      agentSessionId,
      error: failure.error,
      message: failure.error.message,
    };
  }
  return {
    type: "capsule_open_failed",
    agentSessionId,
    error: failure.error,
    message: failure.error.message,
  };
}

function attemptUnavailable(
  attempt: Parameters<AgentSessionSupervisor["withSessionLease"]>[0]["attempt"],
  agentSessionId: string,
  phase: "acquire" | "resolve" | "open",
  now: number,
): AgentSessionAcquireError | undefined {
  if (attempt.signal.aborted) {
    return {
      type: "cancelled",
      agentSessionId,
      phase,
      message: "Agent Session acquire was cancelled.",
    };
  }
  if (attempt.deadlineAt !== undefined && now >= new Date(attempt.deadlineAt).getTime()) {
    return {
      type: "policy_timeout",
      agentSessionId,
      phase,
      deadlineAt: attempt.deadlineAt,
      message: "Agent Session acquire deadline elapsed.",
    };
  }
  return undefined;
}

function supervisorClosed(agentSessionId?: string): AgentSessionAcquireError {
  return {
    type: "supervisor_closed",
    ...(agentSessionId === undefined ? {} : { agentSessionId }),
    message: "Agent Session supervisor is closed.",
  };
}

function sessionBusy(agentSessionId: string): AgentSessionAcquireError {
  return {
    type: "session_busy",
    agentSessionId,
    message: "Agent Session is already leased.",
  };
}

function cancelledNeutralization(
  phase: "acquire" | "neutralize",
): AgentSessionNeutralizationError<never> {
  return {
    type: "cancelled",
    phase,
    message: "Session neutralization was cancelled.",
  };
}

function unverifiedOwnership(reason: string): Effect.Effect<SessionOwnershipEvidence> {
  return nowIso.pipe(Effect.map(observedAt => ({ state: "unverified", observedAt, reason })));
}

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map(milliseconds => new Date(milliseconds).toISOString()),
);

function onlyError<E>(cause: Cause.Cause<E>): E | undefined {
  const reason = cause.reasons[0];
  if (cause.reasons.length !== 1 || reason === undefined || !Cause.isFailReason(reason)) return undefined;
  return reason.error;
}

function normalizeSessions(sessions: readonly AgentSessionRef[]): AgentSessionRef[] {
  const byId = new Map<string, AgentSessionRef>();
  for (const session of sessions) byId.set(session.agentSessionId, session);
  return [...byId.values()].sort((left, right) =>
    left.agentSessionId.localeCompare(right.agentSessionId));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
