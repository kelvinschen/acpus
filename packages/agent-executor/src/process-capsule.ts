import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AcpError } from "@acpus/acp";
import type { OwnedProcessError, ProcessExit, OwnedProcess, ProcessHostShape } from "@acpus/owned-process";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { finishAcpOwnership, writeAcpOwnershipManifest } from "./ownership.js";
import type { NormalizedRuntimeOwnerIdentity } from "./owner.js";
import {
  PROCESS_TREE_CLEANUP_BUDGET_MS,
  processTreeDeadline,
  remaining,
  stopProcessTreeWithDisposition,
} from "./process-tree.js";
import type {
  AcpAgentLaunch,
  AcpOwnershipManifest,
  AgentSessionCleanupError,
  AgentSessionIntent,
  AgentSessionSupervisorOptions,
  AgentTurnEvent,
  AgentTurnPolicyEvidence,
  AgentTurnSnapshot,
  AttemptContext,
  HardCleanupEvidence,
  ProcessCapsuleError,
  SessionNeutralizationEvidence,
} from "./types.js";
import { createAgentTurnReducer, type AgentTurnReducer } from "./turn-reducer.js";
import {
  ACP_WORKER_PROTOCOL_VERSION,
  isAcpWorkerChildMessage,
  type AcpWorkerChildMessage,
  type AcpWorkerParentMessage,
  type ProcessCapsuleTerminal,
} from "./worker-protocol.js";

const CAPSULE_OPEN_TIMEOUT_MS = 30_000;
const COOPERATIVE_CLOSE_GRACE_MS = 4_000;
const WORKERS_DIRECTORY_MODE = 0o700;
const INHERIT_PROCESS_GROUP_ENV = "ACPUS_INTERNAL_ACP_INHERIT_PROCESS_GROUP";

type CapsuleCloseReason = "lease_settled" | "open_failed" | "neutralize" | "shutdown";

export type ProcessCapsuleOpenInput = Readonly<{
  options: AgentSessionSupervisorOptions;
  owner: NormalizedRuntimeOwnerIdentity;
  attempt: AttemptContext;
  session: AgentSessionIntent;
  sessionLeaseId: string;
  resolvedLaunch: AcpAgentLaunch;
}>;

export type ProcessCapsuleOpenFailure =
  | Readonly<{ type: "cancelled"; message: string }>
  | Readonly<{ type: "session_open_failed"; error: AcpError }>
  | Readonly<{ type: "capsule_open_failed"; error: ProcessCapsuleError }>;

type ProcessCapsuleTurnInput<E> = Readonly<{
  turnId: string;
  prompt: string;
  signal: AbortSignal;
  deadlineAt?: string;
  inactivityFailAfterMs?: number;
  onEvent: (event: AgentTurnEvent) => Result.Result<void, E>;
}>;

export type ProcessCapsuleTurnSettlement<E> = Readonly<{
  snapshot: AgentTurnSnapshot;
  finalResponse: string;
  terminal?: ProcessCapsuleTerminal;
  policy?: AgentTurnPolicyEvidence;
  hardCleanup?: HardCleanupEvidence;
  sinkError?: E;
  capsuleError?: ProcessCapsuleError;
}>;

export type ProcessCapsule = Readonly<{
  hostId: string;
  agentSessionId: string;
  sessionLeaseId: string;
  projectionRef: string;
  reportedVersion?: string;
  runTurn<E>(input: ProcessCapsuleTurnInput<E>): Effect.Effect<ProcessCapsuleTurnSettlement<E>>;
  close(reason: CapsuleCloseReason): Effect.Effect<SessionNeutralizationEvidence, AgentSessionCleanupError>;
}>;

type CapsulePhase = "opening" | "ready" | "running" | "cancelling" | "cleaning" | "closed";

type Silence = {
  readonly startedAt: string;
  readonly startedAtMonotonic: bigint;
  fiber?: Fiber.Fiber<void>;
};

type ActiveTurn = {
  readonly turnId: string;
  readonly startedAt: string;
  readonly startedAtMonotonic: bigint;
  readonly scope: Scope.Scope;
  readonly onEvent: (event: AgentTurnEvent) => Result.Result<void, unknown>;
  readonly settlement: Deferred.Deferred<ProcessCapsuleTurnSettlement<unknown>>;
  readonly reducer: AgentTurnReducer;
  sequence: number;
  sinkError?: unknown;
  policy?: AgentTurnPolicyEvidence;
  silence?: Silence;
  terminal: boolean;
};

type CapsuleState = {
  readonly input: ProcessCapsuleOpenInput;
  readonly processes: ProcessHostShape;
  readonly clock: Clock.Clock;
  readonly scope: Scope.Scope;
  readonly hostId: string;
  readonly child: OwnedProcess;
  readonly manifestPath: string;
  readonly manifestLock: Semaphore.Semaphore;
  readonly ready: Deferred.Deferred<void, ProcessCapsuleOpenFailure>;
  readonly closed: Deferred.Deferred<void>;
  manifest: AcpOwnershipManifest;
  manifestError?: ProcessCapsuleError;
  phase: CapsulePhase;
  projectionRef?: string;
  reportedVersion?: string;
  openFailure?: ProcessCapsuleOpenFailure;
  active?: ActiveTurn;
  capsuleError?: ProcessCapsuleError;
  cleanup: Effect.Effect<SessionNeutralizationEvidence, AgentSessionCleanupError>;
  cleanupObserved: boolean;
  cleanupReason?: CapsuleCloseReason;
  hardCleanup?: HardCleanupEvidence;
};

/** Opens one cold process capsule after the caller already owns the Session guard. */
export function openProcessCapsule(
  input: ProcessCapsuleOpenInput,
  processes: ProcessHostShape,
): Effect.Effect<ProcessCapsule, ProcessCapsuleOpenFailure, Scope.Scope> {
  let state: CapsuleState | undefined;
  const open = Effect.gen(function*() {
    const scope = yield* Scope.Scope;
    const clock = yield* Clock.Clock;
    yield* ensureOpeningAvailable(input, clock);
    yield* prepareDirectories(input);
    yield* ensureOpeningAvailable(input, clock);

    const child = yield* processes.spawn({
      command: globalThis.process.execPath,
      args: workerEntryArgs(),
      detached: globalThis.process.platform !== "win32",
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      ipc: true,
      env: safeWorkerEnvironment(),
    }).pipe(Effect.mapError(error => openCapsuleFailure("bootstrap", "worker_spawn_failed", error.message)));

    const hostId = `host_${randomUUID()}`;
    const workerStartToken = yield* processes.startToken(child.pid);
    const manifest: AcpOwnershipManifest = {
      schemaVersion: 3,
      hostId,
      agentSessionId: input.session.agentSessionId,
      sessionLeaseId: input.sessionLeaseId,
      runId: input.attempt.runId,
      attemptId: input.attempt.attemptId,
      owner: input.owner,
      worker: {
        pid: child.pid,
        ...(workerStartToken === undefined ? {} : { startToken: workerStartToken }),
        ...(child.target.processGroupId === undefined ? {} : { pgid: child.target.processGroupId }),
      },
      state: { phase: "opening" },
      createdAt: nowIso(clock),
    };
    const manifestPath = join(input.options.workersRoot, `acp_capsule_${hostId.slice("host_".length)}.json`);

    state = yield* Effect.uninterruptibleMask(restore => Effect.gen(function*() {
      const created = createState(input, processes, clock, scope, hostId, child, manifest, manifestPath);
      created.cleanup = yield* Effect.cached(Effect.uninterruptible(
        Effect.suspend(() => closeCapsuleValue(
          created,
          created.cleanupReason ?? (created.projectionRef === undefined ? "open_failed" : "lease_settled"),
        )),
      ));
      yield* Effect.forkScoped(restore(observeMessages(created)));
      yield* Effect.forkScoped(restore(observeProcessExit(created)));
      yield* Scope.addFinalizer(scope, capsuleFinalizer(created));
      return created;
    }));

    yield* persistManifest(manifestPath, manifest).pipe(
      Effect.mapError(error => {
        const failure = manifestError(state!, error);
        return { type: "capsule_open_failed" as const, error: failure };
      }),
    );

    const openMessage: AcpWorkerParentMessage = {
      type: "open",
      protocolVersion: ACP_WORKER_PROTOCOL_VERSION,
      input: {
        hostId,
        sessionLeaseId: input.sessionLeaseId,
        runId: input.attempt.runId,
        attemptId: input.attempt.attemptId,
        agentSessionId: input.session.agentSessionId,
        sessionOpenMode: input.session.sessionOpenMode,
        sessionStateDirectory: input.options.sessionStateDirectoryForRun(input.attempt.runId),
        resolvedLaunch: input.resolvedLaunch,
        cwd: input.session.cwd,
        env: definedEnvironment(input.session.env),
        permissionMode: input.session.permissionMode,
        configuration: input.session.configuration,
      },
    };
    yield* sendMessage(state, openMessage).pipe(Effect.mapError(error => {
      state!.capsuleError ??= error;
      return { type: "capsule_open_failed" as const, error };
    }));

    const timeoutFailure = openCapsuleFailure(
      "opening",
      "worker_exception",
      "ACP capsule did not become ready in time.",
    );
    const readyOrAbort = Effect.raceFirst(
      Deferred.await(state.ready),
      awaitAbort(input.attempt.signal).pipe(
        Effect.andThen(Effect.fail(cancelledOpen("Agent Session acquire was cancelled."))),
      ),
    );
    yield* Effect.raceFirst(
      readyOrAbort,
      Effect.sleep(openTimeout(input.attempt.deadlineAt, clock)).pipe(Effect.andThen(Effect.fail(timeoutFailure))),
    );

    if (state.projectionRef === undefined) {
      return yield* Effect.fail(openCapsuleFailure(
        "opening",
        "ipc_protocol",
        "ACP capsule became ready without a projection reference.",
      ));
    }
    return publicCapsule(state);
  });

  return open.pipe(Effect.onExit(exit => {
    const current = state;
    if (Exit.isSuccess(exit) || current === undefined) return Effect.void;
    return Effect.sync(() => {
      current.cleanupObserved = true;
      current.cleanupReason ??= "open_failed";
    }).pipe(Effect.andThen(current.cleanup), Effect.ignore);
  }));
}

function createState(
  input: ProcessCapsuleOpenInput,
  processes: ProcessHostShape,
  clock: Clock.Clock,
  scope: Scope.Scope,
  hostId: string,
  child: OwnedProcess,
  manifest: AcpOwnershipManifest,
  manifestPath: string,
): CapsuleState {
  return {
    input,
    processes,
    clock,
    scope,
    hostId,
    child,
    manifest,
    manifestPath,
    manifestLock: Semaphore.makeUnsafe(1),
    ready: Deferred.makeUnsafe<void, ProcessCapsuleOpenFailure>(),
    closed: Deferred.makeUnsafe<void>(),
    phase: "opening",
    cleanup: Effect.die("Process Capsule cleanup was used before initialization."),
    cleanupObserved: false,
  };
}

function observeMessages(state: CapsuleState): Effect.Effect<void> {
  return Stream.runForEach(state.child.messages, value => onChildMessage(state, value)).pipe(
    Effect.catch(error => faultCapsule(state, processFailure(state, error))),
  );
}

function observeProcessExit(state: CapsuleState): Effect.Effect<void> {
  return state.child.closed.pipe(Effect.matchEffect({
    onFailure: error => faultCapsule(state, processFailure(state, error)),
    onSuccess: exit => processExited(state, exit),
  }));
}

function processExited(state: CapsuleState, exit: ProcessExit): Effect.Effect<void> {
  return Effect.suspend(() => {
    Deferred.doneUnsafe(state.closed, Effect.void);
    const expected = state.phase === "cleaning" || state.phase === "closed";
    if (!expected) {
      state.capsuleError ??= capsuleError(
        phaseForError(state),
        "worker_exit",
        `ACP capsule exited with code '${exit.exitCode ?? "null"}' and signal '${exit.signal ?? "none"}'.`,
      );
    }
    state.phase = "closed";
    if (state.projectionRef === undefined) {
      const failure = state.openFailure ?? openCapsuleFailure(
        "opening",
        "worker_exit",
        "ACP capsule exited before readiness.",
      );
      state.openFailure = failure;
      Deferred.doneUnsafe(state.ready, Effect.fail(failure));
    }
    return state.active === undefined
      ? Effect.void
      : settleActive(state, failedSettlement(state));
  });
}

function onChildMessage(state: CapsuleState, value: unknown): Effect.Effect<void> {
  if (!isAcpWorkerChildMessage(value)
    || value.hostId !== state.hostId
    || value.sessionLeaseId !== state.input.sessionLeaseId) {
    return faultCapsule(state, capsuleError(
      phaseForError(state),
      "ipc_protocol",
      "ACP capsule sent an invalid IPC message.",
    ));
  }
  const message = value as AcpWorkerChildMessage;
  if (message.type === "ready") {
    if (state.phase !== "opening") {
      return faultCapsule(state, capsuleError(
        phaseForError(state),
        "ipc_protocol",
        "ACP capsule reported readiness out of order.",
      ));
    }
    state.phase = "ready";
    state.projectionRef = message.projectionRef;
    if (message.reportedVersion !== undefined) state.reportedVersion = message.reportedVersion;
    return updateManifestPhase(state, { phase: "ready" }).pipe(
      Effect.andThen(Effect.sync(() => {
        Deferred.doneUnsafe(state.ready, Effect.void);
      })),
      Effect.catch(error => faultCapsule(state, error)),
    );
  }
  if (message.type === "open_failed") {
    const failure = { type: "session_open_failed" as const, error: message.error };
    state.openFailure = failure;
    Deferred.doneUnsafe(state.ready, Effect.fail(failure));
    return Effect.void;
  }
  if (message.type === "closed") {
    state.phase = "closed";
    Deferred.doneUnsafe(state.closed, Effect.void);
    return Effect.void;
  }
  if (message.type === "failed") {
    state.capsuleError ??= message.error;
    if (state.projectionRef === undefined) {
      const failure = { type: "capsule_open_failed" as const, error: message.error };
      state.openFailure ??= failure;
      Deferred.doneUnsafe(state.ready, Effect.fail(state.openFailure));
    }
    return state.active === undefined ? Effect.void : settleActive(state, failedSettlement(state));
  }

  const active = state.active;
  if ((message.type === "event" || message.type === "terminal")
    && (active === undefined || active.turnId !== message.turnId || active.terminal)) {
    return faultCapsule(state, capsuleError(
      phaseForError(state),
      "ipc_protocol",
      "ACP capsule sent an event outside the active Turn.",
    ));
  }
  if (active === undefined) return Effect.void;
  if (message.type === "terminal") {
    return settleActive(state, settlementFromTerminal(state, active, message.terminal));
  }
  if (message.type !== "event") return Effect.void;

  const observedAt = nowIso(state.clock);
  const envelope: AgentTurnEvent = {
    sequence: active.sequence++,
    observedAt,
    elapsedMs: elapsedMillis(active.startedAtMonotonic, state.clock.monotonicTimeNanosUnsafe()),
    event: message.event,
  };
  active.reducer.observe(envelope);
  const activity = recordActivity(state, active, observedAt);
  if (active.sinkError !== undefined) return scheduleActivity(state, active, activity);

  let accepted: Result.Result<void, unknown>;
  try {
    accepted = active.onEvent(envelope);
  } catch (error) {
    accepted = Result.fail(error);
  }
  if (Result.isFailure(accepted)) {
    active.sinkError = accepted.failure;
    return requestPolicy(state, active, {
      type: "cancelled",
      reason: "event_sink",
      requestedAt: nowIso(state.clock),
    });
  }
  return scheduleActivity(state, active, activity);
}

function publicCapsule(state: CapsuleState): ProcessCapsule {
  return {
    hostId: state.hostId,
    agentSessionId: state.input.session.agentSessionId,
    sessionLeaseId: state.input.sessionLeaseId,
    projectionRef: state.projectionRef!,
    ...(state.reportedVersion === undefined ? {} : { reportedVersion: state.reportedVersion }),
    runTurn: input => runCapsuleTurn(state, input),
    close: reason => closeCapsule(state, reason),
  };
}

function runCapsuleTurn<E>(
  state: CapsuleState,
  input: ProcessCapsuleTurnInput<E>,
): Effect.Effect<ProcessCapsuleTurnSettlement<E>> {
  return Effect.scoped(Effect.gen(function*() {
    const turnScope = yield* Scope.Scope;
    const active = yield* Effect.sync(() => {
      if (state.phase !== "ready" || state.active !== undefined) return undefined;
      const startedAt = nowIso(state.clock);
      const claimed: ActiveTurn = {
        turnId: input.turnId,
        startedAt,
        startedAtMonotonic: state.clock.monotonicTimeNanosUnsafe(),
        scope: turnScope,
        onEvent: input.onEvent as (event: AgentTurnEvent) => Result.Result<void, unknown>,
        settlement: Deferred.makeUnsafe<ProcessCapsuleTurnSettlement<unknown>>(),
        reducer: createAgentTurnReducer(startedAt),
        sequence: 0,
        terminal: false,
      };
      state.active = claimed;
      state.phase = "running";
      return claimed;
    });
    if (active === undefined) return failedSettlement(state) as ProcessCapsuleTurnSettlement<E>;

    const manifestReady = yield* updateManifestPhase(state, { phase: "running", turnId: input.turnId }).pipe(
      Effect.matchEffect({
        onFailure: error => faultCapsule(state, error).pipe(Effect.as(false)),
        onSuccess: () => Effect.succeed(true),
      }),
    );
    if (!manifestReady || state.active !== active || active.terminal) {
      return yield* Deferred.await(active.settlement) as Effect.Effect<ProcessCapsuleTurnSettlement<E>>;
    }

    yield* scheduleActivity(state, active, recordActivity(
      state,
      active,
      active.startedAt,
      input.inactivityFailAfterMs,
    ));
    if (input.deadlineAt !== undefined) {
      yield* Effect.forkIn(deadlinePolicy(state, active, input.deadlineAt), turnScope);
    }
    yield* Effect.forkIn(abortPolicy(state, active, input.signal), turnScope);

    if (input.signal.aborted) {
      yield* requestPolicy(state, active, cancellationPolicy(state, input.signal));
    } else if (state.active === active && !active.terminal && active.policy === undefined) {
      yield* sendMessage(state, {
        type: "run",
        protocolVersion: ACP_WORKER_PROTOCOL_VERSION,
        hostId: state.hostId,
        sessionLeaseId: state.input.sessionLeaseId,
        turnId: input.turnId,
        prompt: input.prompt,
      }).pipe(Effect.catch(error => faultCapsule(state, error)));
    }
    return yield* Deferred.await(active.settlement) as Effect.Effect<ProcessCapsuleTurnSettlement<E>>;
  }));
}

function recordActivity(
  state: CapsuleState,
  active: ActiveTurn,
  observedAt: string,
  configuredFailAfterMs = state.input.attempt.inactivityFailAfterMs,
): Readonly<{ previous?: Fiber.Fiber<void>; silence?: Silence; failAfterMs?: number }> {
  if (active.terminal || active.policy !== undefined) return {};
  const previous = active.silence?.fiber;
  const silence: Silence = {
    startedAt: observedAt,
    startedAtMonotonic: state.clock.monotonicTimeNanosUnsafe(),
  };
  active.silence = silence;
  return {
    ...(previous === undefined ? {} : { previous }),
    silence,
    ...(configuredFailAfterMs === undefined ? {} : { failAfterMs: configuredFailAfterMs }),
  };
}

function scheduleActivity(
  state: CapsuleState,
  active: ActiveTurn,
  activity: Readonly<{ previous?: Fiber.Fiber<void>; silence?: Silence; failAfterMs?: number }>,
): Effect.Effect<void> {
  return Effect.gen(function*() {
    if (activity.previous !== undefined) yield* Fiber.interrupt(activity.previous);
    const { failAfterMs, silence } = activity;
    if (failAfterMs === undefined || silence === undefined
      || state.active !== active || active.terminal || active.policy !== undefined
      || active.silence !== silence) return;
    silence.fiber = yield* Effect.forkIn(
      Effect.sleep(failAfterMs).pipe(Effect.andThen(Effect.suspend(() => {
        if (state.active !== active || active.terminal || active.policy !== undefined
          || active.silence !== silence) return Effect.void;
        return requestPolicy(state, active, {
          type: "inactivity",
          failAfterMs,
          silentForMs: elapsedMillis(silence.startedAtMonotonic, state.clock.monotonicTimeNanosUnsafe()),
          silenceStartedAt: silence.startedAt,
          requestedAt: nowIso(state.clock),
        });
      }))),
      active.scope,
    );
  });
}

function deadlinePolicy(
  state: CapsuleState,
  active: ActiveTurn,
  deadlineAt: string,
): Effect.Effect<void> {
  return Effect.sleep(millisecondsUntil(deadlineAt, state.clock)).pipe(
    Effect.andThen(Effect.suspend(() => requestPolicy(state, active, {
      type: "deadline",
      deadlineAt,
      requestedAt: nowIso(state.clock),
    }))),
  );
}

function abortPolicy(
  state: CapsuleState,
  active: ActiveTurn,
  signal: AbortSignal,
): Effect.Effect<void> {
  return awaitAbort(signal).pipe(
    Effect.andThen(Effect.suspend(() => requestPolicy(state, active, cancellationPolicy(state, signal)))),
  );
}

function cancellationPolicy(state: CapsuleState, signal: AbortSignal): AgentTurnPolicyEvidence {
  return {
    type: "cancelled",
    reason: signal.reason === "steer" ? "steer" : "operator",
    requestedAt: nowIso(state.clock),
  };
}

function requestPolicy(
  state: CapsuleState,
  active: ActiveTurn,
  policy: AgentTurnPolicyEvidence,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    if (state.active !== active || active.terminal || active.policy !== undefined) return Effect.void;
    active.policy = policy;
    const cleaning = state.phase === "cleaning";
    if (!cleaning) state.phase = "cancelling";
    const persist = cleaning
      ? Effect.void
      : updateManifestPhase(state, { phase: "cancelling", turnId: active.turnId });
    return persist.pipe(
      Effect.matchEffect({
        onFailure: error => faultCapsule(state, error).pipe(Effect.as(false)),
        onSuccess: () => Effect.succeed(true),
      }),
      Effect.flatMap(written => {
        if (!written || state.active !== active || active.terminal) return Effect.void;
        return sendMessage(state, {
          type: "cancel",
          protocolVersion: ACP_WORKER_PROTOCOL_VERSION,
          hostId: state.hostId,
          sessionLeaseId: state.input.sessionLeaseId,
          turnId: active.turnId,
          reason: policy.type === "deadline"
            ? "deadline"
            : policy.type === "inactivity"
              ? "inactivity"
              : policy.reason,
        }).pipe(Effect.catch(error => faultCapsule(state, error)));
      }),
      Effect.flatMap(() => cleaning || state.active !== active || active.terminal
        ? Effect.void
        : Effect.forkIn(
            Effect.sleep(COOPERATIVE_CLOSE_GRACE_MS).pipe(Effect.andThen(Effect.suspend(() => {
              if (state.active !== active || active.terminal) return Effect.void;
              state.cleanupReason ??= "lease_settled";
              return state.cleanup.pipe(Effect.ignore);
            }))),
            active.scope,
          ).pipe(Effect.asVoid)),
    );
  });
}

function settleActive(
  state: CapsuleState,
  settlement: ProcessCapsuleTurnSettlement<unknown>,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    const active = state.active;
    if (active === undefined || active.terminal) return Effect.void;
    active.terminal = true;
    const resolved: ProcessCapsuleTurnSettlement<unknown> = {
      ...settlement,
      ...(active.policy === undefined ? {} : { policy: active.policy }),
      ...(active.sinkError === undefined ? {} : { sinkError: active.sinkError }),
      ...(state.hardCleanup === undefined ? {} : { hardCleanup: state.hardCleanup }),
    };
    delete state.active;
    if (state.phase === "cleaning" || state.phase === "closed") {
      Deferred.doneUnsafe(active.settlement, Effect.succeed(resolved));
      return Effect.void;
    }
    state.phase = "ready";
    return updateManifestPhase(state, { phase: "ready" }).pipe(
      Effect.andThen(Effect.sync(() => {
        Deferred.doneUnsafe(active.settlement, Effect.succeed(resolved));
      })),
      Effect.catch(error => {
        state.capsuleError ??= error;
        Deferred.doneUnsafe(active.settlement, Effect.succeed({ ...resolved, capsuleError: error }));
        state.cleanupReason ??= "lease_settled";
        return state.cleanup.pipe(Effect.ignore);
      }),
    );
  });
}

function closeCapsule(
  state: CapsuleState,
  reason: CapsuleCloseReason,
): Effect.Effect<SessionNeutralizationEvidence, AgentSessionCleanupError> {
  return Effect.uninterruptible(Effect.gen(function*() {
    state.cleanupObserved = true;
    state.cleanupReason ??= reason;
    const result = yield* Effect.result(state.cleanup);
    yield* Scope.close(state.scope, Exit.void);
    return yield* Effect.fromResult(result);
  }));
}

function capsuleFinalizer(state: CapsuleState): Effect.Effect<void> {
  return Effect.suspend(() => {
    state.cleanupReason ??= state.projectionRef === undefined ? "open_failed" : "shutdown";
    return state.cleanupObserved
      ? state.cleanup.pipe(Effect.ignore)
      : state.cleanup.pipe(Effect.orDie, Effect.asVoid);
  });
}

function closeCapsuleValue(
  state: CapsuleState,
  reason: CapsuleCloseReason,
): Effect.Effect<SessionNeutralizationEvidence, AgentSessionCleanupError> {
  return Effect.gen(function*() {
    state.phase = "cleaning";
    yield* updateManifestPhase(state, { phase: "cleaning" }).pipe(Effect.catch(error => {
      state.manifestError ??= error;
      return Effect.void;
    }));
    if (state.active !== undefined && state.active.policy === undefined) {
      yield* requestPolicy(state, state.active, {
        type: "cancelled",
        reason: reason === "neutralize" ? "lease_lost" : "operator",
        requestedAt: nowIso(state.clock),
      });
    }
    yield* sendMessage(state, {
      type: "close",
      protocolVersion: ACP_WORKER_PROTOCOL_VERSION,
      hostId: state.hostId,
      sessionLeaseId: state.input.sessionLeaseId,
      reason,
    }).pipe(Effect.catch(error => {
      state.capsuleError ??= error;
      return Effect.void;
    }));

    const startedAt = nowIso(state.clock);
    const deadline = yield* processTreeDeadline(PROCESS_TREE_CLEANUP_BUDGET_MS);
    const graceMs = Math.min(COOPERATIVE_CLOSE_GRACE_MS, yield* remaining(deadline));
    if (graceMs > 0) {
      yield* Effect.raceFirst(Deferred.await(state.closed), Effect.sleep(graceMs)).pipe(Effect.asVoid);
    }
    const stopped = yield* stopProcessTreeWithDisposition(state.processes, state.child.target, deadline);
    const finishedAt = nowIso(state.clock);
    state.hardCleanup = { disposition: stopped.disposition, startedAt, finishedAt };
    if (state.active !== undefined) yield* settleActive(state, failedSettlement(state));

    const ownership = yield* persistFinishedOwnership(
      state,
      stopped.disposition === "unverified" ? "unverified" : stopped.alive,
    ).pipe(Effect.catch(error =>
      Effect.fail({
        type: "cleanup_unverified" as const,
        agentSessionId: state.input.session.agentSessionId,
        evidence: {
          state: "unverified" as const,
          observedAt: nowIso(state.clock),
          reason: error.message,
        },
        message: "ACP capsule ownership cleanup could not be persisted.",
      })));
    if (stopped.alive) {
      if (ownership.state === "unverified") {
        return yield* Effect.fail({
          type: "cleanup_unverified" as const,
          agentSessionId: state.input.session.agentSessionId,
          evidence: { ...ownership, state: "unverified" as const },
          message: "ACP capsule process-tree death could not be proven.",
        });
      }
      return yield* Effect.fail({
        type: "cleanup_failed" as const,
        agentSessionId: state.input.session.agentSessionId,
        evidence: ownership,
        message: "ACP capsule process-tree death could not be proven.",
      });
    }
    if (state.manifestError !== undefined) {
      return yield* Effect.fail({
        type: "cleanup_failed" as const,
        agentSessionId: state.input.session.agentSessionId,
        evidence: {
          state: "dead" as const,
          observedAt: finishedAt,
          reason: state.manifestError.message,
        },
        message: state.manifestError.message,
      });
    }
    state.phase = "closed";
    return {
      session: { runId: state.input.attempt.runId, agentSessionId: state.input.session.agentSessionId },
      disposition: stopped.disposition === "unverified" ? "kill" : stopped.disposition,
      observedAt: finishedAt,
    };
  });
}

function faultCapsule(state: CapsuleState, error: ProcessCapsuleError): Effect.Effect<void> {
  return Effect.suspend(() => {
    state.capsuleError ??= error;
    if (state.projectionRef === undefined) {
      const failure = state.openFailure ?? { type: "capsule_open_failed" as const, error };
      state.openFailure = failure;
      Deferred.doneUnsafe(state.ready, Effect.fail(failure));
    }
    state.cleanupReason ??= state.projectionRef === undefined ? "open_failed" : "lease_settled";
    const settle = state.active === undefined ? Effect.void : settleActive(state, failedSettlement(state));
    return settle.pipe(Effect.andThen(state.cleanup), Effect.ignore);
  });
}

function failedSettlement(state: CapsuleState): ProcessCapsuleTurnSettlement<never> {
  const active = state.active;
  return {
    snapshot: active === undefined
      ? emptySnapshot(state.clock)
      : active.reducer.snapshot(undefined, turnTiming(state, active)),
    finalResponse: active?.reducer.finalResponse() ?? "",
    ...(state.capsuleError === undefined ? {} : { capsuleError: state.capsuleError }),
    ...(state.hardCleanup === undefined ? {} : { hardCleanup: state.hardCleanup }),
  };
}

function settlementFromTerminal(
  state: CapsuleState,
  active: ActiveTurn,
  terminal: ProcessCapsuleTerminal,
): ProcessCapsuleTurnSettlement<unknown> {
  const protocolResult = terminal.type === "provider_result" ? terminal.result : undefined;
  return {
    terminal,
    snapshot: active.reducer.snapshot(protocolResult, turnTiming(state, active)),
    finalResponse: active.reducer.finalResponse(),
    ...(active.policy === undefined ? {} : { policy: active.policy }),
    ...(active.sinkError === undefined ? {} : { sinkError: active.sinkError }),
    ...(state.hardCleanup === undefined ? {} : { hardCleanup: state.hardCleanup }),
  };
}

function updateManifestPhase(
  state: CapsuleState,
  phase: AcpOwnershipManifest["state"],
): Effect.Effect<void, ProcessCapsuleError> {
  return state.manifestLock.withPermit(Effect.suspend(() => {
    const manifest = { ...state.manifest, state: phase };
    state.manifest = manifest;
    return persistManifest(state.manifestPath, manifest).pipe(
      Effect.mapError(error => manifestError(state, error)),
    );
  }));
}

function persistManifest(path: string, manifest: AcpOwnershipManifest): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: () => writeAcpOwnershipManifest(path, manifest),
    catch: cause => cause,
  });
}

function persistFinishedOwnership(
  state: CapsuleState,
  liveness: boolean | "unverified",
): Effect.Effect<import("./types.js").SessionOwnershipEvidence, ProcessCapsuleError> {
  return Effect.tryPromise({
    try: () => finishAcpOwnership(
      state.manifestPath,
      state.manifest,
      liveness,
      "cleanup_unverified",
    ),
    catch: cause => manifestError(state, cause),
  });
}

function sendMessage(
  state: CapsuleState,
  message: AcpWorkerParentMessage,
): Effect.Effect<void, ProcessCapsuleError> {
  return state.child.send(message).pipe(Effect.mapError(error => processFailure(state, error)));
}

function processFailure(state: CapsuleState, error: OwnedProcessError): ProcessCapsuleError {
  return capsuleError(
    phaseForError(state),
    error.operation === "ipc" ? "ipc_closed" : "worker_exception",
    error.message,
  );
}

function manifestError(state: CapsuleState, error: unknown): ProcessCapsuleError {
  const failure = capsuleError(
    phaseForError(state),
    "worker_exception",
    `ACP ownership manifest write failed: ${errorMessage(error)}`,
  );
  state.manifestError ??= failure;
  return failure;
}

function phaseForError(state: CapsuleState): ProcessCapsuleError["phase"] {
  if (state.phase === "opening") return "opening";
  if (state.phase === "running" || state.phase === "cancelling") return "running";
  if (state.phase === "cleaning" || state.phase === "closed") return "closing";
  return "ready";
}

function capsuleError(
  phase: ProcessCapsuleError["phase"],
  code: ProcessCapsuleError["code"],
  message: string,
): ProcessCapsuleError {
  return { type: "process_capsule", phase, code, message };
}

function openCapsuleFailure(
  phase: ProcessCapsuleError["phase"],
  code: ProcessCapsuleError["code"],
  message: string,
): ProcessCapsuleOpenFailure {
  return { type: "capsule_open_failed", error: capsuleError(phase, code, message) };
}

function cancelledOpen(message: string): ProcessCapsuleOpenFailure {
  return { type: "cancelled", message };
}

function prepareDirectories(input: ProcessCapsuleOpenInput): Effect.Effect<void, ProcessCapsuleOpenFailure> {
  return Effect.all([
    Effect.tryPromise({
      try: () => mkdir(input.options.workersRoot, { recursive: true, mode: WORKERS_DIRECTORY_MODE }),
      catch: cause => cause,
    }),
    Effect.tryPromise({
      try: () => mkdir(input.options.sessionStateDirectoryForRun(input.attempt.runId), {
        recursive: true,
        mode: WORKERS_DIRECTORY_MODE,
      }),
      catch: cause => cause,
    }),
  ], { concurrency: "unbounded" }).pipe(
    Effect.asVoid,
    Effect.mapError(error => openCapsuleFailure("bootstrap", "worker_exception", errorMessage(error))),
  );
}

function ensureOpeningAvailable(
  input: ProcessCapsuleOpenInput,
  clock: Clock.Clock,
): Effect.Effect<void, ProcessCapsuleOpenFailure> {
  if (input.attempt.signal.aborted) {
    return Effect.fail(cancelledOpen("Agent Session acquire was cancelled."));
  }
  if (input.attempt.deadlineAt !== undefined
    && millisecondsUntil(input.attempt.deadlineAt, clock) <= 0) {
    return Effect.fail(cancelledOpen("Agent Session acquire deadline elapsed before capsule open."));
  }
  return Effect.void;
}

function awaitAbort(signal: AbortSignal): Effect.Effect<void> {
  return Effect.callback<void>(resume => {
    const onAbort = () => resume(Effect.void);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
}

function emptySnapshot(clock: Clock.Clock): AgentTurnSnapshot {
  const now = nowIso(clock);
  return {
    responses: [],
    summary: {
      eventCount: 0,
      availability: { context: "unavailable", tokenUsage: "unavailable" },
      tools: { totalToolCallCount: 0, calls: [] },
    },
    timing: { startedAt: now, finishedAt: now, elapsedMs: 0 },
  };
}

function turnTiming(
  state: CapsuleState,
  active: ActiveTurn,
): Readonly<{ finishedAt: string; elapsedMs: number }> {
  return {
    finishedAt: nowIso(state.clock),
    elapsedMs: elapsedMillis(active.startedAtMonotonic, state.clock.monotonicTimeNanosUnsafe()),
  };
}

function elapsedMillis(startedAt: bigint, finishedAt: bigint): number {
  return Math.max(0, Math.round(Number(finishedAt - startedAt) / 1_000_000));
}

function nowIso(clock: Clock.Clock): string {
  return new Date(clock.currentTimeMillisUnsafe()).toISOString();
}

function definedEnvironment(env: Readonly<NodeJS.ProcessEnv>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function workerEntryArgs(): string[] {
  const sourceMode = fileURLToPath(import.meta.url).endsWith(".ts");
  const entry = fileURLToPath(new URL(`./worker-entry.${sourceMode ? "ts" : "js"}`, import.meta.url));
  return sourceMode
    ? ["--conditions=development", "--import", import.meta.resolve("tsx"), entry]
    : [entry];
}

function safeWorkerEnvironment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(globalThis.process.env)
      .filter(([key]) => key !== "NODE_OPTIONS" && key !== "NODE_PATH")),
    [INHERIT_PROCESS_GROUP_ENV]: randomUUID(),
  };
}

function openTimeout(deadlineAt: string | undefined, clock: Clock.Clock): number {
  const remainingMs = deadlineAt === undefined ? undefined : millisecondsUntil(deadlineAt, clock);
  return remainingMs === undefined
    ? CAPSULE_OPEN_TIMEOUT_MS
    : Math.min(CAPSULE_OPEN_TIMEOUT_MS, remainingMs);
}

function millisecondsUntil(deadlineAt: string, clock: Clock.Clock): number {
  return Math.max(0, new Date(deadlineAt).getTime() - clock.currentTimeMillisUnsafe());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
