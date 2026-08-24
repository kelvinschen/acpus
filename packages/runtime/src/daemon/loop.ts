import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { sameRuntimeAuthority } from "./authority.js";
import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonErrorCode,
  type DaemonHandlerFailure,
  type DaemonRunStreamFrame,
  type DaemonSubmitAndObserveInput,
} from "./protocol.js";
import { startDaemonServer, type DaemonServerHandle } from "./server.js";
import type { RunIncident } from "./sessions.js";
import { tryLoadRuntimeConfiguration } from "../configuration.js";
import {
  openWorkspaceRuntimeInternal,
  type OwnedWorkspaceRuntime,
  type WorkspaceRuntimeOpenFailure,
} from "../workspace-runtime.js";
import type { InspectionError } from "../inspection/types.js";

export type DaemonLoopOptions = {
  heartbeatMs?: number;
  packageVersion: string;
  idleStopMs?: number;
  onShutdown?: () => void;
  onRunIncident?: (incident: RunIncident) => void;
};

export type DaemonLoopHandle = {
  shutdown(): Effect.Effect<void>;
};

type CleanupOwner = {
  cleanup: Effect.Effect<void, unknown>;
  observed: boolean;
};

type DaemonLoopState = {
  readonly options: DaemonLoopOptions;
  readonly idleStopMs: number;
  readonly rootScope: Scope.Closeable;
  readonly ownedScope: Scope.Closeable;
  readonly operations: FiberSet.FiberSet<void>;
  readonly shutdownRequested: Deferred.Deferred<void>;
  runtime: OwnedWorkspaceRuntime | undefined;
  server: DaemonServerHandle | undefined;
  serverOwner: CleanupOwner | undefined;
  runtimeOwner: CleanupOwner | undefined;
  cleanup: Effect.Effect<void>;
  cleanupObserved: boolean;
  lifecycle: Fiber.Fiber<void> | undefined;
  closeEffect: Effect.Effect<void>;
  idleSince: number | undefined;
  stopped: boolean;
  automatic: boolean;
  notified: boolean;
};

export class DaemonRuntimeStoreReadinessError extends Error {
  constructor(readonly failure: WorkspaceRuntimeOpenFailure) {
    super(failure.message);
    this.name = "DaemonRuntimeStoreReadinessError";
  }
}

export function startDaemonLoop(
  cwd: string,
  options: DaemonLoopOptions,
): Effect.Effect<DaemonLoopHandle, unknown> {
  const configuration = tryLoadRuntimeConfiguration(process.env);
  if (Result.isFailure(configuration)) return Effect.fail(new Error(configuration.failure.message));
  return Effect.gen(function*() {
    const rootScope = yield* Scope.make();
    const started = yield* Effect.exit(startDaemonLoopInScope(cwd, options, rootScope));
    if (Exit.isSuccess(started)) return started.value;
    const released = yield* Effect.exit(Scope.close(rootScope, started));
    const failures = [Cause.squash(started.cause), ...exitFailures(released)];
    return yield* Effect.fail(failures.length === 1
      ? failures[0]
      : new AggregateError(failures, "Daemon startup could not release every resource."));
  });
}

function startDaemonLoopInScope(
  cwd: string,
  options: DaemonLoopOptions,
  rootScope: Scope.Closeable,
): Effect.Effect<DaemonLoopHandle, unknown> {
  return Effect.gen(function*() {
    const heartbeatMs = options.heartbeatMs ?? 1_000;
    const ownedScope = yield* Scope.fork(rootScope);
    const operations = yield* Scope.provide(ownedScope)(FiberSet.make<void>());
    const state: DaemonLoopState = {
      options,
      idleStopMs: options.idleStopMs ?? 30_000,
      rootScope,
      ownedScope,
      operations,
      shutdownRequested: Deferred.makeUnsafe(),
      runtime: undefined,
      server: undefined,
      serverOwner: undefined,
      runtimeOwner: undefined,
      cleanup: Effect.void,
      cleanupObserved: false,
      lifecycle: undefined,
      closeEffect: Effect.void,
      idleSince: undefined,
      stopped: false,
      automatic: false,
      notified: false,
    };

    const server = yield* startDaemonServer(cwd, daemonHandlers(state));
    state.server = server;
    state.serverOwner = {
      cleanup: yield* Effect.cached(Effect.suspend(() => server.close())),
      observed: false,
    };
    yield* registerCleanupOwner(ownedScope, state.serverOwner);

    const runtime = yield* openWorkspaceRuntimeInternal(cwd, {
      heartbeatMs,
      idleStopMs: state.idleStopMs,
      packageVersion: options.packageVersion,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      ...(options.onRunIncident === undefined ? {} : { onRunIncident: options.onRunIncident }),
      onAuthorityLost: () => requestShutdown(state, true),
    }).pipe(Effect.mapError(failure => new DaemonRuntimeStoreReadinessError(failure)));
    state.runtime = runtime;
    state.runtimeOwner = {
      cleanup: yield* Effect.cached(Effect.suspend(() => runtime.close())),
      observed: false,
    };
    yield* registerCleanupOwner(ownedScope, state.runtimeOwner);

    state.cleanup = yield* Effect.cached(Effect.uninterruptible(shutdownDaemon(state)));
    yield* Scope.addFinalizer(ownedScope, Effect.suspend(() => state.cleanupObserved
      ? state.cleanup.pipe(Effect.ignoreCause)
      : state.cleanup));
    yield* FiberSet.run(operations, idleLoop(state, heartbeatMs), { startImmediately: true });
    state.lifecycle = yield* Effect.forkIn(lifecycleEffect(state), rootScope, { startImmediately: true });
    state.closeEffect = yield* Effect.cached(Effect.uninterruptible(closeDaemon(state)));

    return {
      shutdown: () => {
        requestShutdown(state, false);
        return state.closeEffect;
      },
    };
  });
}

function daemonHandlers(state: DaemonLoopState): Parameters<typeof startDaemonServer>[1] {
  return {
    status: () => {
      const runtime = state.runtime;
      if (runtime === undefined) {
        return Effect.fail(handlerFailure("EXECUTION_UNAVAILABLE", "Daemon is still initializing."));
      }
      return Effect.succeed({
        status: "ok",
        pid: process.pid,
        leaseGeneration: runtime.authority.leaseGeneration,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        packageVersion: state.options.packageVersion,
        authority: runtime.authority,
      });
    },
    submitAndObserve: (request, signal) => submitAndObserve(state, request, signal),
    inspect: request => {
      const runtime = state.runtime;
      if (runtime === undefined) {
        return Effect.fail(handlerFailure("EXECUTION_UNAVAILABLE", "Daemon is still initializing."));
      }
      return runtime.inspect(request.view).pipe(
        Effect.mapError(inspectionHandlerFailure),
        Effect.flatMap(inspected => inspected.kind === "archived-run"
          ? Effect.fail(handlerFailure("RUN_NOT_FOUND", `Run '${request.view.runId}' was not found.`))
          : Effect.succeed(inspected)),
      );
    },
    control: intent => {
      const runtime = state.runtime;
      if (runtime === undefined) {
        return Effect.fail(handlerFailure("EXECUTION_UNAVAILABLE", "Daemon is still initializing."));
      }
      return runtime.control(intent).pipe(
        Effect.mapError(error => handlerFailure(error.code, error.message, error.ambiguity)),
      );
    },
    shutdownSettled: () => completeShutdown(state),
    shutdown: () => Effect.suspend(() => {
      const runtime = state.runtime;
      const server = state.server;
      if (runtime === undefined || server === undefined) {
        return Effect.fail(handlerFailure("EXECUTION_UNAVAILABLE", "Daemon is still initializing."));
      }
      if (server.activeConnections() > 1) {
        return Effect.fail(handlerFailure("CONTROL_CONFLICT", "Daemon has active client requests."));
      }
      const activity = runtime.activity();
      if (activity.activeMutations) {
        return Effect.fail(handlerFailure("CONTROL_CONFLICT", "Daemon has active runtime mutations."));
      }
      if (activity.activeSessions > 0) {
        return Effect.fail(handlerFailure("CONTROL_CONFLICT", "Daemon has active run sessions."));
      }
      acceptShutdown(state, true);
      return Effect.succeed({ status: "shutdown" as const });
    }),
  };
}

function submitAndObserve(
  state: DaemonLoopState,
  request: DaemonSubmitAndObserveInput,
  signal: AbortSignal,
): Stream.Stream<DaemonRunStreamFrame> {
  const runtime = state.runtime;
  if (runtime === undefined) {
    return Stream.succeed(
      runStreamError("admission", "not-admitted", "EXECUTION_UNAVAILABLE", "Daemon is still initializing."),
    );
  }
  if (!sameRuntimeAuthority(runtime.authority, request.expectedAuthority)) {
    return Stream.succeed(
      runStreamError("authority", "not-admitted", "AUTHORITY_MISMATCH", "Runtime authority changed before run admission."),
    );
  }
  return Stream.unwrap(Effect.result(runtime.submit({
    requestId: request.requestId,
    prepared: request.prepared,
    input: request.input,
    ...(request.agentInjections === undefined ? {} : { agentInjections: request.agentInjections }),
  })).pipe(Effect.map(submitted => {
    if (Result.isFailure(submitted)) {
      return Stream.succeed<DaemonRunStreamFrame>(runStreamError(
        "admission",
        submitted.failure.outcome,
        submitted.failure.code,
        submitted.failure.message,
        submitted.failure.runId,
      ));
    }
    const admitted = Stream.succeed<DaemonRunStreamFrame>({
      kind: "admitted",
      authority: runtime.authority,
      run: submitted.success,
    });
    if (request.until === "admitted" || signal.aborted) return admitted;
    const observations: Stream.Stream<DaemonRunStreamFrame> = runtime.observeInspection({
      view: { kind: "run", runId: submitted.success.id },
      until: request.until,
    }, signal).pipe(
      Stream.map(observation => ({ kind: "observation" as const, observation })),
      Stream.catch(error => Stream.succeed(runStreamError(
        "observation",
        "admitted",
        "STORE_ERROR",
        error.message,
        submitted.success.id,
      ))),
    );
    return admitted.pipe(Stream.concat(observations));
  })));
}

function idleLoop(state: DaemonLoopState, heartbeatMs: number): Effect.Effect<void> {
  return Effect.gen(function*() {
    while (true) {
      yield* Effect.sleep(heartbeatMs);
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.sync(() => checkIdleStop(state, now)).pipe(
        Effect.catchCause(() => Effect.sync(() => requestShutdown(state, true))),
      );
    }
  });
}

function checkIdleStop(state: DaemonLoopState, now: number): void {
  const runtime = state.runtime;
  const server = state.server;
  if (runtime === undefined || server === undefined || state.stopped) return;
  const activity = runtime.activity();
  if (activity.runsStarted > 0
    || activity.idleBlockers > 0
    || activity.activeSessions > 0
    || activity.activeHooks > 0
    || activity.activeMutations
    || activity.tickActive
    || server.activeConnections() > 0) {
    state.idleSince = undefined;
    runtime.setIdleState(undefined, state.idleStopMs);
    return;
  }
  state.idleSince ??= now;
  runtime.setIdleState(new Date(state.idleSince).toISOString(), state.idleStopMs);
  if (now - state.idleSince >= state.idleStopMs) requestShutdown(state, true);
}

function requestShutdown(state: DaemonLoopState, automatic: boolean): void {
  acceptShutdown(state, automatic);
  completeShutdown(state);
}

function acceptShutdown(state: DaemonLoopState, automatic: boolean): void {
  state.automatic ||= automatic;
  state.stopped = true;
  state.runtime?.stopScheduling();
  state.runtime = undefined;
}

function completeShutdown(state: DaemonLoopState): void {
  Deferred.doneUnsafe(state.shutdownRequested, Effect.void);
}

function lifecycleEffect(state: DaemonLoopState): Effect.Effect<void> {
  return Deferred.await(state.shutdownRequested).pipe(
    Effect.andThen(Effect.uninterruptible(closeOwnedScope(state))),
    Effect.onExit(() => Effect.sync(() => notifyShutdown(state))),
  );
}

function closeOwnedScope(state: DaemonLoopState): Effect.Effect<void> {
  return Effect.gen(function*() {
    const semantic = yield* Effect.exit(state.cleanup);
    state.cleanupObserved = true;
    const structural = yield* Effect.exit(Scope.close(state.ownedScope, semantic));
    return yield* failCleanup(
      [...exitFailures(semantic), ...exitFailures(structural)],
      "Daemon shutdown could not release every resource.",
    );
  });
}

function shutdownDaemon(state: DaemonLoopState): Effect.Effect<void> {
  return Effect.gen(function*() {
    const failures: unknown[] = [];
    failures.push(...exitFailures(yield* Effect.exit(
      FiberSet.clear(state.operations).pipe(
        Effect.andThen(FiberSet.awaitEmpty(state.operations)),
      ),
    )));
    for (const owner of [state.serverOwner, state.runtimeOwner]) {
      if (owner === undefined) continue;
      owner.observed = true;
      failures.push(...exitFailures(yield* Effect.exit(owner.cleanup)));
    }
    return yield* failCleanup(failures, "Daemon shutdown could not release every resource.");
  });
}

function closeDaemon(state: DaemonLoopState): Effect.Effect<void> {
  return Effect.gen(function*() {
    requestShutdown(state, false);
    const lifecycle = state.lifecycle;
    if (lifecycle === undefined) return;
    const settled = yield* Fiber.await(lifecycle);
    const released = yield* Effect.exit(Scope.close(state.rootScope, settled));
    return yield* failCleanup(
      [...exitFailures(settled), ...exitFailures(released)],
      "Daemon shutdown could not release every resource.",
    );
  });
}

function registerCleanupOwner(
  scope: Scope.Closeable,
  owner: CleanupOwner,
): Effect.Effect<void> {
  return Scope.addFinalizer(scope, Effect.suspend(() => owner.observed
    ? owner.cleanup.pipe(Effect.ignoreCause)
    : owner.cleanup.pipe(Effect.orDie)));
}

function notifyShutdown(state: DaemonLoopState): void {
  if (!state.automatic || state.notified) return;
  state.notified = true;
  try {
    state.options.onShutdown?.();
  } catch {}
}

function inspectionHandlerFailure(error: InspectionError): DaemonHandlerFailure {
  if (error.type === "invalid-query") return handlerFailure("INVALID_REQUEST", error.message);
  if (error.type === "run-not-found") return handlerFailure("RUN_NOT_FOUND", error.message);
  if (error.type === "runtime-store-unavailable") return handlerFailure("STORE_BUSY", error.message);
  return handlerFailure("STORE_ERROR", error.message);
}

function handlerFailure(code: DaemonErrorCode, message: string, ambiguity?: true): DaemonHandlerFailure {
  return { code, message, ...(ambiguity ? { ambiguity } : {}) };
}

function runStreamError(
  phase: Extract<DaemonRunStreamFrame, { kind: "error" }>["phase"],
  outcome: Extract<DaemonRunStreamFrame, { kind: "error" }>["outcome"],
  code: DaemonErrorCode,
  message: string,
  runId?: string,
): Extract<DaemonRunStreamFrame, { kind: "error" }> {
  return {
    kind: "error",
    phase,
    outcome,
    ...(runId === undefined ? {} : { runId }),
    error: { code, message },
  };
}

function exitFailures(exit: Exit.Exit<unknown, unknown>): unknown[] {
  return Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : [];
}

function failCleanup(failures: readonly unknown[], message: string): Effect.Effect<void> {
  if (failures.length === 0) return Effect.void;
  return Effect.die(failures.length === 1
    ? failures[0]
    : new AggregateError(failures, message));
}
