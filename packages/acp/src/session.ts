import { isAbsolute } from "node:path";
import type {
  InitializeResponse,
  SessionConfigOption,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import { ProcessHost, type ProcessHostShape } from "@acpus/owned-process";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  PersistenceIssue,
  SessionBindingMismatchIssue,
  acpSessionProjectionPath,
  boundConversation,
  loadAcpSessionProjection,
  saveAcpSessionProjection,
  type AcpProjectedConversationEntry,
  type AcpSessionProjection,
} from "./persistence.js";
import {
  ClientOperationIssue,
  createReverseRpcHandlers,
  type ReverseRpcHandlers,
} from "./reverse-rpc.js";
import { resolveAgentSessionBinding } from "./session-binding.js";
import {
  AcpTransport,
  type AcpTransportConnection,
  type AcpTransportUpdate,
} from "./transport.js";
import type {
  AcpError,
  AcpEvent,
  AcpJsonValue,
  AcpOperation,
  AcpSession,
  AcpSessionConfiguration,
  AcpTokenUsage,
  AcpTurnInput,
  AcpTurnResult,
  OpenAcpSessionInput,
} from "./types.js";

type ProjectionHolder = {
  value: AcpSessionProjection | undefined;
};

type OpenControl = {
  readonly signal: AbortSignal | undefined;
  operation: AcpOperation;
  committed: boolean;
};

type ActiveTurn = {
  readonly scope: Scope.Closeable;
  readonly completion: Deferred.Deferred<void>;
  readonly updatesSettled: Deferred.Deferred<void>;
  readonly onEvent: ((event: AcpEvent) => unknown) | undefined;
  cancel: Effect.Effect<void, AcpError>;
  cancelled: boolean;
  projectUpdates: boolean;
  promptEpoch?: number;
  processedSequence: number;
  updateFence?: number;
  clientIssue?: ClientOperationIssue;
};

type SessionState = {
  readonly input: OpenAcpSessionInput;
  readonly scope: Scope.Closeable;
  readonly resourceScope: Scope.Closeable;
  readonly processes: ProcessHostShape;
  readonly reverse: ReverseRpcHandlers;
  readonly connection: AcpTransportConnection;
  readonly projection: ProjectionHolder;
  readonly turnGate: Semaphore.Semaphore;
  sessionId?: string;
  initialized?: InitializeResponse;
  transportError?: AcpError;
  active?: ActiveTurn;
  projectUpdates: boolean;
  closed: boolean;
  cleanupObserved: boolean;
  closeReason?: string;
  cleanup: Effect.Effect<void, AcpError>;
};

const COOPERATIVE_CLOSE_GRACE_MS = 500;

export function openAcpSession(
  input: OpenAcpSessionInput,
): Effect.Effect<AcpSession, AcpError, AcpTransport | ProcessHost | Scope.Scope> {
  return Effect.suspend(() => {
    const invalid = validateOpenInput(input);
    if (invalid !== undefined) return Effect.fail(invalid);
    if (input.signal?.aborted) return Effect.fail(cancelledFailure("open_session"));
    return openValidatedSession(input);
  });
}

function openValidatedSession(
  input: OpenAcpSessionInput,
): Effect.Effect<AcpSession, AcpError, AcpTransport | ProcessHost | Scope.Scope> {
  return Effect.gen(function*() {
    const parentScope = yield* Scope.Scope;
    const sessionScope = yield* Scope.fork(parentScope);
    const resourceScope = yield* Scope.fork(sessionScope);
    const control: OpenControl = {
      signal: input.signal,
      operation: "open_session",
      committed: false,
    };
    let state: SessionState | undefined;
    const acquisition = Scope.provide(resourceScope)(openInResourceScope(
      input,
      control,
      sessionScope,
      resourceScope,
      opened => { state = opened; },
    ));
    const cancellable = input.signal === undefined
      ? acquisition
      : Effect.raceFirst(acquisition, failWhenOpenAborted(control));
    const opened = yield* Effect.result(cancellable);
    if (Result.isSuccess(opened)) return opened.success;

    const primary = opened.failure;
    let cleanupError: AcpError | undefined;
    if (state !== undefined) {
      state.cleanupObserved = true;
      const cleaned = yield* Effect.result(state.cleanup);
      if (Result.isFailure(cleaned)) cleanupError = cleaned.failure;
    }
    yield* Scope.close(sessionScope, Exit.fail(primary));
    return yield* cleanupError === undefined
      ? Effect.fail(primary)
      : Effect.fail(cleanupFailure(primary, control.operation, [cleanupError]));
  });
}

function openInResourceScope(
  input: OpenAcpSessionInput,
  control: OpenControl,
  sessionScope: Scope.Closeable,
  resourceScope: Scope.Closeable,
  onState: (state: SessionState) => void,
): Effect.Effect<AcpSession, AcpError, AcpTransport | ProcessHost | Scope.Scope> {
  return Effect.gen(function*() {
    const transport = yield* AcpTransport;
    const processes = yield* ProcessHost;
    const binding = yield* Effect.tryPromise({
      try: () => resolveAgentSessionBinding({
        launch: input.launch,
        cwd: input.cwd,
        configuration: input.configuration,
      }),
      catch: () => failure(
        "invalid_input",
        "open_session",
        "Agent Session cwd could not be resolved.",
        false,
        { code: "cwd" },
      ),
    });
    const saved = yield* Effect.tryPromise({
      try: () => loadAcpSessionProjection({
        stateDirectory: input.stateDirectory,
        agentSessionId: input.agentSessionId,
        binding,
      }),
      catch: toAcpError("open_session"),
    });
    yield* Effect.try({
      try: () => validateSessionOpenMode(input, saved),
      catch: toAcpError("open_session"),
    });
    yield* checkOpenCancellation(control);

    let currentState: SessionState | undefined;
    const reverse = yield* createReverseRpcHandlers({
      getSessionId: () => currentState?.sessionId,
      cwd: input.cwd,
      ...(input.env === undefined ? {} : { env: input.env }),
      permissionMode: input.permissionMode,
      onActivity: operation => {
        if (currentState !== undefined) emit(currentState, { type: "activity", operation });
      },
    }, processes);
    const rememberClientIssue = <Success>(
      effect: Effect.Effect<Success, ClientOperationIssue>,
    ): Effect.Effect<Success, ClientOperationIssue> => effect.pipe(Effect.tapError(error =>
      Effect.sync(() => {
        const active = currentState?.active;
        if (active !== undefined && error.reason !== "permission") active.clientIssue = error;
      })));
    const connection = yield* transport.connect({
      launch: input.launch,
      cwd: input.cwd,
      ...(input.env === undefined ? {} : { env: input.env }),
      handlers: {
        requestPermission: params => rememberClientIssue(reverse.requestPermission(params)),
        readTextFile: params => rememberClientIssue(reverse.readTextFile(params)),
        writeTextFile: params => rememberClientIssue(reverse.writeTextFile(params)),
        createTerminal: params => rememberClientIssue(reverse.createTerminal(params)),
        terminalOutput: params => rememberClientIssue(reverse.terminalOutput(params)),
        waitForTerminalExit: params => rememberClientIssue(reverse.waitForTerminalExit(params)),
        killTerminal: params => rememberClientIssue(reverse.killTerminal(params)),
        releaseTerminal: params => rememberClientIssue(reverse.releaseTerminal(params)),
      },
    });
    const state: SessionState = {
      input,
      scope: sessionScope,
      resourceScope,
      processes,
      reverse,
      connection,
      projection: { value: saved },
      turnGate: Semaphore.makeUnsafe(1),
      projectUpdates: false,
      closed: false,
      cleanupObserved: false,
      cleanup: Effect.void,
    };
    currentState = state;
    onState(state);
    yield* Effect.forkScoped(Stream.runForEach(connection.updates, update =>
      handleTransportUpdate(state, update)).pipe(Effect.catch(error => Effect.sync(() => {
        state.transportError = error;
      }))));
    state.cleanup = yield* Effect.cached(Effect.uninterruptible(closeSessionValue(state)));
    yield* Scope.addFinalizer(sessionScope, sessionFinalizer(state));

    const initialized = yield* openingRequest(control, "initialize", connection.initialize());
    yield* validateInitialize(initialized);
    state.initialized = initialized;
    const capabilities = capabilitiesFrom(initialized);
    const reportedVersion = reportedAgentVersion(initialized);
    let configuration: SessionConfigOption[] | null | undefined;

    if (saved !== undefined && (capabilities.resume || capabilities.load)) {
      state.sessionId = saved.backend.sessionId;
      const recovered = capabilities.resume
        ? yield* openingRequest(
            control,
            "resume_session",
            connection.resumeSession(state.sessionId, input.cwd),
          )
        : yield* openingRequest(
            control,
            "load_session",
            connection.loadSession(state.sessionId, input.cwd),
          );
      configuration = recovered?.configOptions;
    } else if (saved !== undefined && input.sessionOpenMode === "existing_required") {
      return yield* Effect.fail(failure(
        "capability",
        "resume_session",
        "The ACP Agent cannot resume or load the recorded session.",
        false,
        { capability: "resume" },
      ));
    } else {
      const created = yield* openingRequest(control, "new_session", connection.newSession(input.cwd));
      if (!created || typeof created.sessionId !== "string" || created.sessionId.length === 0) {
        return yield* Effect.fail(failure(
          "protocol",
          "new_session",
          "The ACP Agent returned an invalid session id.",
          false,
        ));
      }
      state.sessionId = created.sessionId;
      configuration = created.configOptions;
    }

    const sessionId = requireSessionId(state);
    const now = yield* currentIso;
    state.projection.value = {
      ...(saved ?? {
        schema: "acpus.acp-session.v3",
        agentSessionId: input.agentSessionId,
        binding,
        backend: { sessionId, capabilities },
        conversation: [],
        createdAt: now,
        updatedAt: now,
      }),
      backend: { sessionId, capabilities },
      updatedAt: now,
    };
    yield* applyConfiguration(
      connection,
      sessionId,
      effectiveTurnConfiguration(input.configuration),
      configuration,
      control,
    );
    control.operation = "open_session";
    yield* saveProjection(input, requireProjection(state.projection), "open_session", {
      beforeRename: () => {
        if (!control.committed && control.signal?.aborted) throw cancelledFailure(control.operation);
      },
      afterRename: () => { control.committed = true; },
    });
    state.projectUpdates = true;

    return {
      agentSessionId: input.agentSessionId,
      sessionId,
      projectionPath: acpSessionProjectionPath(input.agentSessionId),
      ...(reportedVersion === undefined ? {} : { reportedVersion }),
      runTurn: turnInput => runTurn(state, turnInput),
      close: reason => closeSession(state, reason),
    };
  });
}

function runTurn(
  state: SessionState,
  input: AcpTurnInput,
): Effect.Effect<AcpTurnResult, AcpError> {
  return Effect.suspend(() => {
    if (state.closed) {
      return Effect.fail(failure("session", "run_turn", "The ACP session is closed.", false));
    }
    if (state.active !== undefined) {
      return Effect.fail(failure(
        "session",
        "run_turn",
        "The ACP session already has an active turn.",
        false,
      ));
    }
    const invalid = validateTurnInput(input);
    if (invalid !== undefined) return Effect.fail(invalid);
    return state.turnGate.withPermitsIfAvailable(1)(runOwnedTurn(state, input)).pipe(
      Effect.flatMap(Option.match({
        onNone: () => Effect.fail(failure(
          "session",
          "run_turn",
          "The ACP session already has an active turn.",
          false,
        )),
        onSome: Effect.succeed,
      })),
    );
  });
}

function runOwnedTurn(
  state: SessionState,
  input: AcpTurnInput,
): Effect.Effect<AcpTurnResult, AcpError> {
  return Effect.uninterruptibleMask(restore => Effect.gen(function*() {
    const turnScope = yield* Scope.fork(state.resourceScope);
    const active: ActiveTurn = {
      scope: turnScope,
      completion: Deferred.makeUnsafe<void>(),
      updatesSettled: Deferred.makeUnsafe<void>(),
      onEvent: input.onEvent,
      cancel: Effect.void,
      cancelled: false,
      projectUpdates: false,
      processedSequence: 0,
    };
    active.cancel = yield* Effect.cached(Effect.uninterruptible(Effect.suspend(() => {
      active.cancelled = true;
      return state.reverse.cancelPendingPermissions().pipe(
        Effect.andThen(state.connection.cancel(requireSessionId(state))),
      );
    })));
    state.active = active;
    if (input.signal !== undefined) {
      yield* Scope.provide(turnScope)(Effect.forkScoped(
        awaitAbort(input.signal).pipe(Effect.andThen(active.cancel), Effect.ignore),
      ));
    }
    const task = runTurnTask(state, active, input).pipe(
      Effect.catchCause(cause => Cause.hasInterrupts(cause) && active.cancelled
        ? Effect.uninterruptible(persistCancelledTurn(state))
        : Effect.failCause(cause)),
      Effect.onExit(() => Effect.sync(() => {
        Deferred.doneUnsafe(active.completion, Effect.void);
      })),
    );
    const fiber = yield* Scope.provide(turnScope)(Effect.forkScoped(task));
    const settled = yield* Effect.exit(restore(Fiber.join(fiber)).pipe(
      Effect.onInterrupt(() => active.cancel.pipe(Effect.ignore)),
    ));
    yield* Scope.close(turnScope, settled);
    if (state.active === active) delete state.active;
    if (Exit.isSuccess(settled)) return settled.value;
    if (Cause.hasInterrupts(settled.cause) && active.cancelled) {
      return yield* persistCancelledTurn(state);
    }
    return yield* Effect.failCause(settled.cause);
  }));
}

function runTurnTask(
  state: SessionState,
  active: ActiveTurn,
  input: AcpTurnInput,
): Effect.Effect<AcpTurnResult, AcpError> {
  const body = Effect.gen(function*() {
    if (input.configuration !== undefined
      && !sameEffectiveConfiguration(state.input.configuration, input.configuration)) {
      return yield* Effect.fail(failure(
        "configuration",
        "configure_session",
        "Agent Session configuration is immutable after open.",
        false,
      ));
    }
    const now = yield* currentIso;
    state.projection.value = appendConversation(requireProjection(state.projection), {
      type: "message",
      role: "user",
      content: input.prompt,
    }, now);
    yield* saveProjection(state.input, requireProjection(state.projection), "run_turn");

    if (input.signal?.aborted) yield* active.cancel.pipe(Effect.ignore);
    if (active.cancelled) return yield* persistCancelledTurn(state);
    if (state.transportError !== undefined) return yield* Effect.fail(state.transportError);

    active.projectUpdates = true;
    const prompted = yield* state.connection.prompt(requireSessionId(state), input.prompt);
    if (active.cancelled) yield* active.cancel.pipe(Effect.ignore);
    yield* waitForUpdateFence(active, prompted.promptEpoch, prompted.updateFence);
    active.projectUpdates = false;
    if (active.clientIssue !== undefined) {
      return yield* Effect.fail(toAcpError("run_turn")(active.clientIssue));
    }
    const response = prompted.response;
    if (!response || typeof response.stopReason !== "string" || response.stopReason.length === 0) {
      return yield* Effect.fail(failure(
        "protocol",
        "run_turn",
        "The ACP Agent returned an invalid prompt response.",
        false,
        { origin: "provider", providerEvidence: "inbound_activity" },
      ));
    }
    const usage = tokenUsage(response.usage);
    const status: AcpTurnResult["status"] = active.cancelled || response.stopReason === "cancelled"
      ? "cancelled"
      : "completed";
    state.projection.value = withStop(
      requireProjection(state.projection),
      response.stopReason,
      yield* currentIso,
      usage,
    );
    yield* saveProjection(state.input, requireProjection(state.projection), "run_turn");
    return {
      status,
      stopReason: response.stopReason,
      ...(usage === undefined ? {} : { usage }),
    };
  });

  return body.pipe(Effect.catch(error => Effect.gen(function*() {
    active.projectUpdates = false;
    if (active.cancelled) return yield* persistCancelledTurn(state);
    if (state.projection.value !== undefined) {
      yield* saveProjection(state.input, state.projection.value, "run_turn");
    }
    return yield* Effect.fail(error);
  })));
}

function persistCancelledTurn(state: SessionState): Effect.Effect<AcpTurnResult, AcpError> {
  return Effect.gen(function*() {
    if (state.projection.value !== undefined) {
      state.projection.value = withStop(state.projection.value, "cancelled", yield* currentIso);
      yield* saveProjection(state.input, state.projection.value, "run_turn");
    }
    return { status: "cancelled", stopReason: "cancelled" };
  });
}

function waitForUpdateFence(
  active: ActiveTurn,
  epoch: number,
  fence: number,
): Effect.Effect<void, AcpError> {
  return Effect.suspend(() => {
    if (active.promptEpoch !== undefined && active.promptEpoch !== epoch) {
      return Effect.fail(failure(
        "protocol",
        "run_turn",
        "The ACP Agent returned a prompt response for an unexpected update epoch.",
        false,
      ));
    }
    active.promptEpoch = epoch;
    active.updateFence = fence;
    if (active.processedSequence >= fence) {
      Deferred.doneUnsafe(active.updatesSettled, Effect.void);
    }
    return Deferred.await(active.updatesSettled);
  });
}

function handleTransportUpdate(
  state: SessionState,
  envelope: AcpTransportUpdate,
): Effect.Effect<void> {
  return Effect.gen(function*() {
    const active = state.active;
    if (active === undefined
      || envelope.promptEpoch === undefined
      || envelope.promptSequence === undefined) return;
    if (active.promptEpoch !== undefined && active.promptEpoch !== envelope.promptEpoch) return;
    active.promptEpoch ??= envelope.promptEpoch;
    if (active.projectUpdates) emit(state, eventFromUpdate(envelope.update), yield* currentIso);
    active.processedSequence = Math.max(active.processedSequence, envelope.promptSequence);
    if (active.updateFence !== undefined && active.processedSequence >= active.updateFence) {
      Deferred.doneUnsafe(active.updatesSettled, Effect.void);
    }
    return;
  });
}

function emit(state: SessionState, event: AcpEvent, updatedAt?: string): void {
  const active = state.active;
  if (state.projectUpdates
    && active?.projectUpdates
    && state.projection.value !== undefined
    && updatedAt !== undefined) {
    state.projection.value = projectEvent(state.projection.value, event, updatedAt);
  }
  const handler = active?.onEvent;
  if (handler === undefined) return;
  try {
    const observed = handler(event);
    if (isThenable(observed)) void observed.then(undefined, () => undefined);
  } catch {
    // Event observers never participate in protocol settlement.
  }
}

function closeSession(state: SessionState, reason?: string): Effect.Effect<void, AcpError> {
  return Effect.uninterruptible(Effect.gen(function*() {
    state.cleanupObserved = true;
    if (state.closeReason === undefined && reason !== undefined) state.closeReason = reason;
    const result = yield* Effect.result(state.cleanup);
    yield* Scope.close(state.scope, Exit.void);
    return yield* Effect.fromResult(result);
  }));
}

function closeSessionValue(state: SessionState): Effect.Effect<void, AcpError> {
  return Effect.gen(function*() {
    state.closed = true;
    let primary: AcpError | undefined;
    const cleanupErrors: AcpError[] = [];
    yield* state.reverse.cancelPendingPermissions();
    const active = state.active;
    if (active !== undefined) {
      yield* active.cancel.pipe(Effect.ignore);
      const cooperative = yield* Effect.timeoutOption(
        Deferred.await(active.completion),
        COOPERATIVE_CLOSE_GRACE_MS,
      );
      if (Option.isNone(cooperative)) yield* Scope.close(active.scope, Exit.void);
      yield* Deferred.await(active.completion);
    }

    if (state.sessionId !== undefined
      && state.initialized?.agentCapabilities?.sessionCapabilities?.close) {
      const closeRequest = yield* Effect.timeoutOption(
        Effect.result(state.connection.closeSession(state.sessionId)),
        COOPERATIVE_CLOSE_GRACE_MS,
      );
      if (Option.isSome(closeRequest) && Result.isFailure(closeRequest.value)) {
        primary = closeRequest.value.failure;
      }
    }

    const reverseClosed = yield* Effect.result(state.reverse.closeAll());
    if (Result.isFailure(reverseClosed)) {
      cleanupErrors.push(toAcpError("close_session")(reverseClosed.failure));
    }
    const connectionClosed = yield* Effect.result(state.connection.close(state.closeReason));
    if (Result.isFailure(connectionClosed)) cleanupErrors.push(connectionClosed.failure);
    const providerClosed = yield* Effect.result(terminateProvider(state.connection));
    if (Result.isFailure(providerClosed)) cleanupErrors.push(providerClosed.failure);

    if (cleanupErrors.length > 0) {
      return yield* Effect.fail(cleanupFailure(
        primary ?? failure(
          "cleanup",
          "close_session",
          "ACP session close cleanup failed.",
          false,
        ),
        "close_session",
        cleanupErrors,
      ));
    }
    if (primary !== undefined) return yield* Effect.fail(primary);
  });
}

function terminateProvider(
  connection: AcpTransportConnection,
): Effect.Effect<void, AcpError> {
  return Effect.gen(function*() {
    if ((yield* connection.liveness()) === "dead") return;
    yield* signalProvider(connection, "SIGTERM");
    yield* waitForProviderDeath(connection, COOPERATIVE_CLOSE_GRACE_MS);
    if ((yield* connection.liveness()) === "dead") return;
    yield* signalProvider(connection, "SIGKILL");
    yield* waitForProviderDeath(connection, COOPERATIVE_CLOSE_GRACE_MS);
    const final = yield* connection.liveness();
    if (final !== "dead") {
      return yield* Effect.fail(failure(
        "cleanup",
        "close_session",
        `ACP Agent process death could not be verified after SIGKILL (${final}).`,
        false,
        { origin: "process" },
      ));
    }
  });
}

function signalProvider(
  connection: AcpTransportConnection,
  signal: NodeJS.Signals,
): Effect.Effect<void, AcpError> {
  return connection.signal(signal).pipe(Effect.catch(error =>
    connection.liveness().pipe(Effect.flatMap(liveness =>
      liveness === "dead" ? Effect.void : Effect.fail(error)))));
}

function waitForProviderDeath(
  connection: AcpTransportConnection,
  milliseconds: number,
): Effect.Effect<void> {
  return Effect.gen(function*() {
    const checks = Math.max(1, Math.ceil(milliseconds / 25));
    for (let attempt = 0; attempt < checks; attempt += 1) {
      if ((yield* connection.liveness()) === "dead") return;
      yield* Effect.sleep(25);
    }
  });
}

function sessionFinalizer(state: SessionState): Effect.Effect<void> {
  return Effect.suspend(() => state.cleanupObserved
    ? state.cleanup.pipe(Effect.ignore)
    : state.cleanup.pipe(Effect.orDie, Effect.asVoid));
}

function openingRequest<Success>(
  control: OpenControl,
  operation: AcpOperation,
  effect: Effect.Effect<Success, AcpError>,
): Effect.Effect<Success, AcpError> {
  return Effect.suspend(() => {
    control.operation = operation;
    if (!control.committed && control.signal?.aborted) {
      return Effect.fail(cancelledFailure(operation));
    }
    return effect.pipe(Effect.tap(() => checkOpenCancellation(control)));
  });
}

function checkOpenCancellation(control: OpenControl): Effect.Effect<void, AcpError> {
  return !control.committed && control.signal?.aborted
    ? Effect.fail(cancelledFailure(control.operation))
    : Effect.void;
}

function failWhenOpenAborted(control: OpenControl): Effect.Effect<never, AcpError> {
  const signal = control.signal!;
  return Effect.callback<never, AcpError>(resume => {
    const onAbort = (): void => {
      if (!control.committed) resume(Effect.fail(cancelledFailure(control.operation)));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
}

function awaitAbort(signal: AbortSignal): Effect.Effect<void> {
  return Effect.callback<void>(resume => {
    const onAbort = (): void => resume(Effect.void);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
}

function validateSessionOpenMode(
  input: OpenAcpSessionInput,
  saved: AcpSessionProjection | undefined,
): void {
  const path = acpSessionProjectionPath(input.agentSessionId);
  if (input.sessionOpenMode === "existing_required" && saved === undefined) {
    throw new PersistenceIssue(
      "validate",
      path,
      "existing_required requires an existing ACP Session projection.",
    );
  }
  if (input.sessionOpenMode === "new_or_empty"
    && saved !== undefined
    && (saved.conversation.length > 0 || saved.lastStop !== undefined)) {
    throw new PersistenceIssue(
      "validate",
      path,
      "new_or_empty requires an absent or empty ACP Session projection.",
    );
  }
}

function validateInitialize(value: InitializeResponse): Effect.Effect<void, AcpError> {
  return !value || value.protocolVersion !== 1
    ? Effect.fail(failure(
        "initialize",
        "initialize",
        `The ACP Agent selected unsupported protocol version ${String(value?.protocolVersion)}.`,
        false,
      ))
    : Effect.void;
}

function capabilitiesFrom(value: InitializeResponse): { resume: boolean; load: boolean } {
  return {
    resume: value.agentCapabilities?.sessionCapabilities?.resume != null,
    load: value.agentCapabilities?.loadSession === true,
  };
}

function reportedAgentVersion(value: InitializeResponse): string | undefined {
  const version = value.agentInfo?.version;
  return typeof version === "string" && version.length > 0 && version.length <= 256
    ? version
    : undefined;
}

function effectiveTurnConfiguration(
  value: OpenAcpSessionInput["configuration"],
): AcpSessionConfiguration {
  return {
    ...(value.model === null ? {} : { model: value.model }),
    ...(Object.keys(value.options).length === 0 ? {} : { options: value.options }),
  };
}

function sameEffectiveConfiguration(
  expected: OpenAcpSessionInput["configuration"],
  supplied: AcpSessionConfiguration,
): boolean {
  const model = supplied.model ?? null;
  const options = supplied.options ?? expected.options;
  return model === expected.model
    && JSON.stringify(Object.entries(options).sort()) === JSON.stringify(Object.entries(expected.options).sort());
}

function applyConfiguration(
  connection: AcpTransportConnection,
  sessionId: string,
  desired: AcpSessionConfiguration,
  advertised: SessionConfigOption[] | null | undefined,
  control: OpenControl,
): Effect.Effect<SessionConfigOption[] | null | undefined, AcpError> {
  return Effect.gen(function*() {
    let current = advertised;
    if (desired.model !== undefined) {
      const model = current?.find(option => option.category === "model" || option.id === "model");
      if (model === undefined) {
        return yield* Effect.fail(failure(
          "capability",
          "configure_session",
          "The ACP session did not advertise a model configuration option.",
          false,
          { capability: "configuration" },
        ));
      }
      const response = yield* openingRequest(
        control,
        "configure_session",
        connection.setConfigOption(sessionId, model.id, desired.model),
      );
      current = response?.configOptions;
    }
    const entries = Object.entries(desired.options ?? {}).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0);
    for (const [configId, value] of entries) {
      const response = yield* openingRequest(
        control,
        "configure_session",
        connection.setConfigOption(sessionId, configId, value),
      );
      current = response?.configOptions;
    }
    return current;
  });
}

function saveProjection(
  input: OpenAcpSessionInput,
  projection: AcpSessionProjection,
  operation: AcpOperation,
  options?: Parameters<typeof saveAcpSessionProjection>[2],
): Effect.Effect<void, AcpError> {
  return Effect.tryPromise({
    try: () => saveAcpSessionProjection(input.stateDirectory, projection, options),
    catch: toAcpError(operation),
  });
}

const currentIso = Clock.currentTimeMillis.pipe(Effect.map(milliseconds =>
  new Date(milliseconds).toISOString()));

function requireSessionId(state: SessionState): string {
  if (state.sessionId === undefined) throw new Error("ACP backend session id is unavailable.");
  return state.sessionId;
}

function eventFromUpdate(update: SessionUpdate): AcpEvent {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
      return {
        type: "message",
        channel: update.sessionUpdate === "agent_message_chunk" ? "assistant" : "thought",
        content: jsonValue(update.content),
        ...(update.messageId ? { messageId: update.messageId } : {}),
      };
    case "tool_call":
    case "tool_call_update":
      return {
        type: "tool",
        action: update.sessionUpdate === "tool_call" ? "call" : "update",
        toolCallId: update.toolCallId,
        ...(update.title ? { title: update.title } : {}),
        ...(update.name ? { name: update.name } : {}),
        ...(update.kind ? { kind: update.kind } : {}),
        ...(update.status ? { status: update.status } : {}),
        ...(update.rawInput !== undefined ? { input: jsonValue(update.rawInput) } : {}),
        ...(update.rawOutput !== undefined ? { output: jsonValue(update.rawOutput) } : {}),
        ...(update.content != null ? { content: jsonValue(update.content) } : {}),
        ...(update.locations != null ? { locations: jsonValue(update.locations) } : {}),
      };
    case "usage_update": {
      const tokens = tokenUsage(metaUsage(update._meta));
      return {
        type: "usage",
        context: { used: update.used, size: update.size },
        ...(tokens ? { tokens } : {}),
        ...(update.cost ? { cost: { amount: update.cost.amount, currency: update.cost.currency } } : {}),
      };
    }
    case "plan":
      return { type: "plan", value: jsonValue(update.entries) };
    case "available_commands_update":
      return { type: "session", update: "available_commands", value: jsonValue(update.availableCommands) };
    case "current_mode_update":
      return { type: "session", update: "current_mode", value: update.currentModeId };
    case "config_option_update":
      return { type: "session", update: "configuration", value: jsonValue(update.configOptions) };
    case "session_info_update":
      return { type: "session", update: "info", value: jsonValue(update) };
    default:
      return { type: "unknown", name: update.sessionUpdate, value: jsonValue(update) };
  }
}

function projectEvent(
  projection: AcpSessionProjection,
  event: AcpEvent,
  updatedAt: string,
): AcpSessionProjection {
  if (event.type === "message") {
    const text = textContent(event.content);
    if (text === undefined) return projection;
    return appendOrMergeText(projection, event.channel, text, updatedAt);
  }
  if (event.type !== "tool") return projection;
  const conversation = [...projection.conversation];
  const callIndex = findToolCall(conversation, event.toolCallId);
  const previous = callIndex < 0 ? undefined : conversation[callIndex];
  const call: AcpProjectedConversationEntry = {
    type: "tool-call",
    toolCallId: event.toolCallId,
    ...(event.title ?? (previous?.type === "tool-call" ? previous.title : undefined)
      ? { title: event.title ?? (previous?.type === "tool-call" ? previous.title : undefined)! }
      : {}),
    ...(event.name ?? (previous?.type === "tool-call" ? previous.name : undefined)
      ? { name: event.name ?? (previous?.type === "tool-call" ? previous.name : undefined)! }
      : {}),
    ...(event.kind ?? (previous?.type === "tool-call" ? previous.kind : undefined)
      ? { kind: event.kind ?? (previous?.type === "tool-call" ? previous.kind : undefined)! }
      : {}),
    ...(event.status ?? (previous?.type === "tool-call" ? previous.status : undefined)
      ? { status: event.status ?? (previous?.type === "tool-call" ? previous.status : undefined)! }
      : {}),
    ...(event.input ?? (previous?.type === "tool-call" ? previous.input : undefined)
      ? { input: event.input ?? (previous?.type === "tool-call" ? previous.input : undefined)! }
      : {}),
  };
  if (callIndex < 0) conversation.push(call);
  else conversation[callIndex] = call;
  if (event.content !== undefined) {
    conversation.push({ type: "tool-result", toolCallId: event.toolCallId, content: event.content });
  }
  return withConversation(projection, conversation, updatedAt);
}

function appendOrMergeText(
  projection: AcpSessionProjection,
  channel: "assistant" | "thought",
  text: string,
  updatedAt: string,
): AcpSessionProjection {
  const conversation = [...projection.conversation];
  const last = conversation.at(-1);
  if (channel === "thought" && last?.type === "thought") {
    conversation[conversation.length - 1] = { ...last, content: last.content + text };
  } else if (channel === "assistant" && last?.type === "message" && last.role === "assistant") {
    conversation[conversation.length - 1] = { ...last, content: last.content + text };
  } else {
    conversation.push(channel === "thought"
      ? { type: "thought", content: text }
      : { type: "message", role: "assistant", content: text });
  }
  return withConversation(projection, conversation, updatedAt);
}

function appendConversation(
  projection: AcpSessionProjection,
  entry: AcpProjectedConversationEntry,
  updatedAt: string,
): AcpSessionProjection {
  return withConversation(projection, [...projection.conversation, entry], updatedAt);
}

function withConversation(
  projection: AcpSessionProjection,
  conversation: readonly AcpProjectedConversationEntry[],
  updatedAt: string,
): AcpSessionProjection {
  return {
    ...projection,
    conversation: boundConversation(conversation),
    updatedAt,
  };
}

function withStop(
  projection: AcpSessionProjection,
  stopReason: string,
  updatedAt: string,
  usage?: AcpTokenUsage,
): AcpSessionProjection {
  return {
    ...projection,
    lastStop: { stopReason, ...(usage === undefined ? {} : { usage }) },
    updatedAt,
  };
}

function requireProjection(holder: ProjectionHolder): AcpSessionProjection {
  if (holder.value === undefined) throw new Error("ACP session projection is unavailable.");
  return holder.value;
}

function findToolCall(conversation: readonly AcpProjectedConversationEntry[], toolCallId: string): number {
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const entry = conversation[index]!;
    if (entry.type === "tool-call" && entry.toolCallId === toolCallId) return index;
  }
  return -1;
}

function textContent(value: AcpJsonValue): string | undefined {
  if (!value || Array.isArray(value) || typeof value !== "object") return undefined;
  return value.type === "text" && typeof value.text === "string" ? value.text : undefined;
}

function metaUsage(meta: unknown): unknown {
  if (!meta || typeof meta !== "object") return undefined;
  return (meta as Record<string, unknown>).usage;
}

function tokenUsage(value: unknown): AcpTokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const result: Record<string, number> = {};
  for (const key of [
    "inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens",
    "thoughtTokens", "totalTokens",
  ] as const) {
    if (typeof source[key] === "number" && Number.isInteger(source[key]) && source[key] >= 0) {
      result[key] = source[key];
    }
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function jsonValue(value: unknown, depth = 0): AcpJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (depth >= 20) return null;
  if (Array.isArray(value)) return value.slice(0, 1_000).map(item => jsonValue(item, depth + 1));
  if (!value || typeof value !== "object") return null;
  return Object.fromEntries(Object.entries(value).slice(0, 1_000).flatMap(([key, entry]) =>
    entry === undefined ? [] : [[key, jsonValue(entry, depth + 1)]],
  ));
}

function validateOpenInput(input: OpenAcpSessionInput): AcpError | undefined {
  if (!record(input)) return failure("invalid_input", "open_session", "open input must be an object.", false);
  if (typeof input.agentSessionId !== "string") return failure("invalid_input", "open_session", "agentSessionId must be a string.", false);
  if (!input.agentSessionId.trim()) return failure("invalid_input", "open_session", "agentSessionId must be non-empty.", false);
  if (input.sessionOpenMode !== "new_or_empty" && input.sessionOpenMode !== "existing_required") {
    return failure("invalid_input", "open_session", "sessionOpenMode is invalid.", false);
  }
  if (!effectiveConfiguration(input.configuration)) return failure("invalid_input", "open_session", "configuration is invalid.", false);
  if (typeof input.stateDirectory !== "string") return failure("invalid_input", "open_session", "stateDirectory must be a string.", false);
  if (!input.stateDirectory.trim()) return failure("invalid_input", "open_session", "stateDirectory must be non-empty.", false);
  if (typeof input.cwd !== "string") return failure("invalid_input", "open_session", "cwd must be a string.", false);
  if (!isAbsolute(input.cwd)) return failure("invalid_input", "open_session", "cwd must be absolute.", false);
  if (!record(input.launch)) return failure("invalid_input", "open_session", "launch must be an object.", false);
  if (input.launch.kind === "command" && (typeof input.launch.command !== "string" || !input.launch.command.trim())) {
    return failure("invalid_input", "open_session", "launch command must be non-empty.", false);
  }
  if (input.launch.kind === "argv" && (!Array.isArray(input.launch.argv)
    || input.launch.argv.length === 0
    || !input.launch.argv.every(argument => typeof argument === "string")
    || !input.launch.argv[0]?.trim())) {
    return failure("invalid_input", "open_session", "launch argv executable must be non-empty.", false);
  }
  if (input.launch.kind !== "command" && input.launch.kind !== "argv") {
    return failure("invalid_input", "open_session", "launch kind must be command or argv.", false);
  }
  if (input.launch.name !== undefined && typeof input.launch.name !== "string") {
    return failure("invalid_input", "open_session", "launch name must be a string.", false);
  }
  if (input.permissionMode !== "approve-reads" && input.permissionMode !== "approve-all" && input.permissionMode !== "deny-all") {
    return failure("invalid_input", "open_session", "permissionMode is invalid.", false);
  }
  if (input.env !== undefined && (!record(input.env)
    || !Object.values(input.env).every(value => value === undefined || typeof value === "string"))) {
    return failure("invalid_input", "open_session", "env must contain only string or undefined values.", false);
  }
  if (input.signal !== undefined && !abortSignal(input.signal)) {
    return failure("invalid_input", "open_session", "signal must be an AbortSignal.", false);
  }
  return undefined;
}

function validateTurnInput(input: AcpTurnInput): AcpError | undefined {
  if (!record(input)) return failure("invalid_input", "run_turn", "turn input must be an object.", false);
  if (typeof input.prompt !== "string") {
    return failure("invalid_input", "run_turn", "prompt must be a string.", false);
  }
  if (input.configuration !== undefined && !record(input.configuration)) {
    return failure("invalid_input", "run_turn", "configuration must be an object.", false);
  }
  if (input.configuration?.model !== undefined && typeof input.configuration.model !== "string") {
    return failure("invalid_input", "run_turn", "configuration.model must be a string.", false);
  }
  if (input.configuration?.model !== undefined && !input.configuration.model.trim()) {
    return failure("invalid_input", "run_turn", "configuration.model must be non-empty.", false);
  }
  if (input.configuration?.options !== undefined && (!record(input.configuration.options)
    || !Object.values(input.configuration.options).every(value => typeof value === "string"))) {
    return failure("invalid_input", "run_turn", "configuration.options must contain only string values.", false);
  }
  if (input.signal !== undefined && !abortSignal(input.signal)) {
    return failure("invalid_input", "run_turn", "signal must be an AbortSignal.", false);
  }
  if (input.onEvent !== undefined && typeof input.onEvent !== "function") {
    return failure("invalid_input", "run_turn", "onEvent must be a function.", false);
  }
  return undefined;
}

function effectiveConfiguration(value: unknown): value is OpenAcpSessionInput["configuration"] {
  return record(value)
    && exactKeys(value, ["model", "options"])
    && (value.model === null || typeof value.model === "string")
    && record(value.options)
    && Object.values(value.options).every(item => typeof item === "string");
}

function exactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return Object.keys(value).length === required.length
    && required.every(key => Object.hasOwn(value, key));
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function abortSignal(value: unknown): value is AbortSignal {
  return record(value)
    && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function"
    && typeof value.removeEventListener === "function";
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null
    && (typeof value === "object" || typeof value === "function")
    && "then" in value
    && typeof value.then === "function";
}

function toAcpError(operation: AcpOperation): (error: unknown) => AcpError {
  return error => {
    if (isAcpError(error)) return error;
    if (error instanceof PersistenceIssue) {
      return failure("persistence", operation, error.message, false, {
        path: error.path,
        code: error.operation,
      });
    }
    if (error instanceof SessionBindingMismatchIssue) {
      return failure("session_binding", operation, error.message, false, {
        categories: error.categories,
        origin: "persistence",
        providerEvidence: "none",
      });
    }
    if (error instanceof ClientOperationIssue) {
      return failure("client_operation", error.operation, error.message, false, {
        code: error.reason,
        origin: "client",
        providerEvidence: "inbound_activity",
      });
    }
    return failure("protocol", operation, error instanceof Error ? error.message : String(error), true);
  };
}

function isAcpError(value: unknown): value is AcpError {
  return !!value && typeof value === "object"
    && typeof (value as Partial<AcpError>).type === "string"
    && typeof (value as Partial<AcpError>).operation === "string";
}

function failure<T extends AcpError["type"]>(
  type: T,
  operation: AcpOperation,
  message: string,
  retryable: boolean,
  extra: Record<string, unknown> = {},
): Extract<AcpError, { type: T }> {
  return {
    type,
    operation,
    ...defaultErrorEvidence(type),
    message,
    retryable,
    ...extra,
  } as Extract<AcpError, { type: T }>;
}

function defaultErrorEvidence(type: AcpError["type"]): Pick<AcpError, "origin" | "providerEvidence"> {
  const origin = type === "invalid_input"
    ? "input" as const
    : type === "persistence"
      ? "persistence" as const
      : type === "spawn" || type === "provider_exit"
        ? "process" as const
        : type === "protocol" || type === "initialize"
          ? "transport" as const
          : "client" as const;
  return { origin, providerEvidence: "none" };
}

function cancelledFailure(operation: AcpOperation): Extract<AcpError, { type: "cancelled" }> {
  return failure("cancelled", operation, "Opening the ACP session was cancelled.", false);
}

function cleanupFailure(
  primary: unknown,
  operation: AcpOperation,
  cleanupErrors: readonly unknown[],
): Extract<AcpError, { type: "cleanup" }> {
  const primaryMessage = isAcpError(primary)
    ? primary.message
    : primary instanceof Error ? primary.message : String(primary);
  const cleanupMessage = cleanupErrors
    .map(error => isAcpError(error)
      ? error.message
      : error instanceof Error ? error.message : String(error))
    .join("; ");
  return failure(
    "cleanup",
    operation,
    `${primaryMessage} Cleanup failed: ${cleanupMessage}`,
    false,
  );
}
