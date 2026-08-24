import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { sameRuntimeAuthority } from "./authority.js";
import { daemonEndpoint, probeDaemonEndpointValue } from "./client.js";
import {
  appliedDaemonResponse,
  daemonFailureMessage,
  failedDaemonResponse,
  isDaemonRunStreamFrame,
  parseDaemonRequest,
  type DaemonControlIntent,
  type DaemonControlResult,
  type DaemonHandlerFailure,
  type DaemonInspectInput,
  type DaemonInspectionResult,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonRunStreamFrame,
  type DaemonShutdownResult,
  type DaemonStatus,
  type DaemonSubmitAndObserveInput,
} from "./protocol.js";
import { probeProcessIdentity } from "../process-liveness.js";
import { isRuntimeStoreBusyError, openSqliteDatabase } from "../storage/database.js";
import { acquireExistingWritableRuntimeStore } from "../store/service.js";

export type DaemonServerHandle = {
  activeConnections(): number;
  close(): Effect.Effect<void>;
};

export type DaemonHandlers = {
  status(): Effect.Effect<DaemonStatus, DaemonHandlerFailure>;
  submitAndObserve(
    input: DaemonSubmitAndObserveInput,
    signal: AbortSignal,
  ): Stream.Stream<DaemonRunStreamFrame>;
  inspect(input: DaemonInspectInput): Effect.Effect<DaemonInspectionResult, DaemonHandlerFailure>;
  control(intent: DaemonControlIntent): Effect.Effect<DaemonControlResult, DaemonHandlerFailure>;
  shutdown(): Effect.Effect<DaemonShutdownResult, DaemonHandlerFailure>;
  shutdownSettled(): void;
};

type ServerState = {
  readonly endpoint: string;
  readonly sockets: Set<Socket>;
  readonly requests: FiberSet.FiberSet<void, unknown>;
  readonly server: ReturnType<typeof createServer>;
  activeConnections: number;
  bound: boolean;
  closed: boolean;
  cleanup: Effect.Effect<void>;
  cleanupObserved: boolean;
};

type RunRequest = (effect: Effect.Effect<void, unknown>) => Fiber.Fiber<void, unknown>;

export function startDaemonServer(
  cwd: string,
  handlers: DaemonHandlers,
): Effect.Effect<DaemonServerHandle, unknown> {
  return Effect.gen(function*() {
    const rootScope = yield* Scope.make();
    const started = yield* Effect.exit(startDaemonServerInScope(cwd, handlers, rootScope));
    if (Exit.isSuccess(started)) return started.value;
    const released = yield* Effect.exit(Scope.close(rootScope, started));
    const failures = [Cause.squash(started.cause), ...exitFailures(released)];
    return yield* Effect.fail(failures.length === 1
      ? failures[0]
      : new AggregateError(failures, "Daemon server startup could not release every resource."));
  });
}

function startDaemonServerInScope(
  cwd: string,
  handlers: DaemonHandlers,
  rootScope: Scope.Closeable,
): Effect.Effect<DaemonServerHandle, unknown> {
  return Effect.gen(function*() {
    const endpoint = daemonEndpoint(cwd);
    if (isFilesystemSocket(endpoint)) {
      yield* tryPromise(() => ensurePrivateSocketParent(endpoint));
      yield* tryPromise(() => rejectSocketSymlink(endpoint));
    }

    const sockets = new Set<Socket>();
    const requests = yield* Scope.provide(rootScope)(FiberSet.make<void, unknown>());
    const runRequest = yield* FiberSet.runtime(requests)<never>();
    const state = {} as ServerState;
    const server = createServer({ allowHalfOpen: true }, socket => {
      state.activeConnections += 1;
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => {
        sockets.delete(socket);
        state.activeConnections -= 1;
      });
      handleSocket(socket, handlers, runRequest);
    });
    Object.assign(state, {
      endpoint,
      sockets,
      requests,
      server,
      activeConnections: 0,
      bound: false,
      closed: false,
      cleanup: Effect.void,
      cleanupObserved: false,
    });
    state.cleanup = yield* Effect.cached(Effect.uninterruptible(closeServerResources(state)));
    yield* Scope.addFinalizer(rootScope, Effect.suspend(() => state.cleanupObserved
      ? state.cleanup.pipe(Effect.ignoreCause)
      : state.cleanup));

    const listened = yield* Effect.exit(listen(server, endpoint));
    if (Exit.isFailure(listened)) {
      const original = Cause.squash(listened.cause);
      if (!isFilesystemSocket(endpoint) || !isAddressInUse(original)) {
        return yield* Effect.fail(original);
      }
      yield* Effect.scoped(recoverStaleFilesystemSocket(cwd, endpoint, server, original));
    }
    state.bound = true;
    if (isFilesystemSocket(endpoint)) yield* tryPromise(() => secureFilesystemSocket(endpoint));

    const close = yield* Effect.cached(Effect.uninterruptible(Effect.gen(function*() {
      const semantic = yield* Effect.exit(state.cleanup);
      state.cleanupObserved = true;
      const structural = yield* Effect.exit(Scope.close(rootScope, semantic));
      return yield* failCleanup(
        [...exitFailures(semantic), ...exitFailures(structural)],
        "Daemon server shutdown could not release every resource.",
      );
    })));
    return {
      activeConnections: () => state.activeConnections,
      close: () => close,
    };
  });
}

function handleSocket(socket: Socket, handlers: DaemonHandlers, runRequest: RunRequest): void {
  const chunks: Buffer[] = [];
  let handled = false;
  let requestFiber: Fiber.Fiber<void, unknown> | undefined;
  const uploadTimeout = runRequest(Effect.sleep(5_000).pipe(
    Effect.andThen(Effect.sync(() => socket.destroy())),
  ));
  const stopUploadTimeout = (): void => uploadTimeout.interruptUnsafe();
  socket.once("close", stopUploadTimeout);
  uploadTimeout.addObserver(() => socket.off("close", stopUploadTimeout));
  const dispatch = (raw: string): void => {
    stopUploadTimeout();
    requestFiber = runRequest(Effect.scoped(dispatchSocketRequest(socket, handlers, raw)));
    const interrupt = (): void => requestFiber?.interruptUnsafe();
    socket.once("close", interrupt);
    requestFiber.addObserver(() => socket.off("close", interrupt));
  };
  socket.on("data", chunk => {
    if (handled) {
      socket.destroy();
      return;
    }
    chunks.push(Buffer.from(chunk));
    const upload = Buffer.concat(chunks);
    const newline = upload.indexOf(0x0a);
    if (newline < 0) return;
    handled = true;
    stopUploadTimeout();
    if (upload.subarray(newline + 1).length > 0) {
      socket.end(JSON.stringify(failedDaemonResponse("INVALID_REQUEST", "Invalid daemon request.")));
      return;
    }
    dispatch(upload.subarray(0, newline).toString("utf8"));
  });
  socket.once("end", () => {
    if (handled) return;
    handled = true;
    dispatch(Buffer.concat(chunks).toString("utf8"));
  });
}

function dispatchSocketRequest(
  socket: Socket,
  handlers: DaemonHandlers,
  raw: string,
): Effect.Effect<void, unknown, Scope.Scope> {
  return Effect.gen(function*() {
    const request = parseDaemonRequest(raw);
    if (!request.ok) {
      if (request.stream) {
        yield* writeRunStreamFrame(socket, {
          kind: "error",
          phase: "admission",
          outcome: "not-admitted",
          error: request.response.ok
            ? { code: "INTERNAL_ERROR", message: "Run submission failed." }
            : { code: request.response.error.code, message: request.response.error.message },
        });
        socket.end();
      } else {
        socket.end(JSON.stringify(request.response));
      }
      return;
    }
    if (request.value.method === "submitAndObserve") {
      yield* dispatchRunStream(socket, request.value, handlers);
      return;
    }
    const response = yield* dispatchRequest(request.value, handlers);
    if (request.value.method !== "shutdown" || !response.ok) {
      socket.end(JSON.stringify(response));
      return;
    }
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      socket.off("close", settle);
      handlers.shutdownSettled();
    };
    socket.once("close", settle);
    socket.end(JSON.stringify(response), settle);
  });
}

function dispatchRequest(
  request: Exclude<DaemonRequest, { method: "submitAndObserve" }>,
  handlers: DaemonHandlers,
): Effect.Effect<DaemonResponse> {
  if (request.method === "control") {
    return dispatchOperation(request, Effect.suspend(() => handlers.control(request.control)));
  }
  if (request.method === "inspect") {
    return dispatchOperation(request, Effect.suspend(() => handlers.inspect({ view: request.view })));
  }
  if (request.method === "shutdown") {
    return dispatchOperation(request, Effect.suspend(() => handlers.shutdown()));
  }
  return dispatchOperation(request, Effect.suspend(() => handlers.status()));
}

function dispatchOperation<A extends Extract<DaemonResponse, { ok: true }>["result"]>(
  request: Exclude<DaemonRequest, { method: "submitAndObserve" }>,
  operation: Effect.Effect<A, DaemonHandlerFailure>,
): Effect.Effect<DaemonResponse> {
  return Effect.result(operation).pipe(
    Effect.map(result => Result.match(result, {
      onSuccess: appliedDaemonResponse,
      onFailure: failure => failedDaemonResponse(failure.code, failure.message, failure.ambiguity),
    })),
    Effect.catchCause(() => Effect.succeed(
      failedDaemonResponse("INTERNAL_ERROR", daemonFailureMessage(request, "INTERNAL_ERROR")),
    )),
  );
}

function dispatchRunStream(
  socket: Socket,
  request: Extract<DaemonRequest, { method: "submitAndObserve" }>,
  handlers: DaemonHandlers,
): Effect.Effect<void, never, Scope.Scope> {
  let admittedRunId: string | undefined;
  return Effect.gen(function*() {
    const signal = yield* Effect.abortSignal;
    yield* Stream.runForEachWhile(handlers.submitAndObserve(request, signal), frame => Effect.gen(function*() {
      if (!isDaemonRunStreamFrame(frame)
        || admittedRunId === undefined && frame.kind === "observation"
        || admittedRunId !== undefined && frame.kind === "admitted"
        || admittedRunId !== undefined && frame.kind === "error"
          && (frame.outcome !== "admitted" || frame.runId !== undefined && frame.runId !== admittedRunId)
        || frame.kind === "admitted" && !sameRuntimeAuthority(frame.authority, request.expectedAuthority)) {
        yield* writeRunStreamFrame(socket, {
          kind: "error",
          phase: admittedRunId === undefined ? "admission" : "observation",
          outcome: admittedRunId === undefined ? "unknown" : "admitted",
          ...(admittedRunId === undefined ? {} : { runId: admittedRunId }),
          error: { code: "INTERNAL_ERROR", message: "Run submission failed." },
        });
        socket.end();
        return false;
      }
      if (frame.kind === "admitted") admittedRunId = frame.run.id;
      if (socket.destroyed || !socket.writable) return false;
      if (!(yield* writeRunStreamFrame(socket, frame))) return false;
      if (frame.kind === "error"
        || frame.kind === "observation" && frame.observation.kind === "closed"
        || frame.kind === "admitted" && request.until === "admitted") {
        socket.end();
        return false;
      }
      return true;
    }));
    if (!socket.destroyed && socket.writable) socket.end();
  }).pipe(Effect.catchCause(cause => {
    if (Cause.hasInterruptsOnly(cause) || socket.destroyed || !socket.writable) return Effect.void;
    return writeRunStreamFrame(socket, {
      kind: "error",
      phase: admittedRunId === undefined ? "admission" : "observation",
      outcome: admittedRunId === undefined ? "unknown" : "admitted",
      ...(admittedRunId === undefined ? {} : { runId: admittedRunId }),
      error: { code: "INTERNAL_ERROR", message: "Run submission failed." },
    }).pipe(Effect.andThen(Effect.sync(() => socket.end())));
  }));
}

function writeRunStreamFrame(
  socket: Socket,
  frame: DaemonRunStreamFrame,
): Effect.Effect<boolean> {
  return Effect.callback<boolean>(resume => {
    if (socket.destroyed || !socket.writable) {
      resume(Effect.succeed(false));
      return;
    }
    if (socket.write(`${JSON.stringify(frame)}\n`)) {
      resume(Effect.succeed(true));
      return;
    }
    const cleanup = (): void => {
      socket.off("drain", drained);
      socket.off("close", closed);
      socket.off("error", closed);
    };
    const drained = (): void => {
      cleanup();
      resume(Effect.succeed(true));
    };
    const closed = (): void => {
      cleanup();
      resume(Effect.succeed(false));
    };
    socket.once("drain", drained);
    socket.once("close", closed);
    socket.once("error", closed);
    return Effect.sync(cleanup);
  });
}

function closeServerResources(state: ServerState): Effect.Effect<void> {
  return Effect.gen(function*() {
    if (state.closed) return;
    state.closed = true;
    const failures: unknown[] = [];
    for (const socket of state.sockets) socket.destroy();
    failures.push(...exitFailures(yield* Effect.exit(
      FiberSet.clear(state.requests).pipe(Effect.andThen(FiberSet.awaitEmpty(state.requests))),
    )));
    if (state.bound && state.server.listening) {
      failures.push(...exitFailures(yield* Effect.exit(closeNodeServer(state.server))));
    }
    if (state.bound && isFilesystemSocket(state.endpoint)) {
      failures.push(...exitFailures(yield* Effect.exit(tryPromise(() => rm(state.endpoint, { force: true })))));
    }
    return yield* failCleanup(failures, "Daemon server shutdown could not release every resource.");
  });
}

async function ensurePrivateSocketParent(endpoint: string): Promise<void> {
  const parent = dirname(endpoint);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const info = await lstat(parent);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Daemon socket parent '${parent}' must be a private directory.`);
  }
  await chmod(parent, 0o700);
}

async function rejectSocketSymlink(endpoint: string): Promise<void> {
  try {
    if ((await lstat(endpoint)).isSymbolicLink()) {
      throw new Error(`Daemon socket '${endpoint}' must not be a symbolic link.`);
    }
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
}

async function secureFilesystemSocket(endpoint: string): Promise<void> {
  const before = await lstat(endpoint);
  if (before.isSymbolicLink() || !before.isSocket()) {
    throw new Error(`Daemon socket '${endpoint}' is not a Unix socket.`);
  }
  await chmod(endpoint, 0o600);
  const after = await lstat(endpoint);
  if (after.isSymbolicLink() || !after.isSocket()) {
    throw new Error(`Daemon socket '${endpoint}' was replaced while securing it.`);
  }
}

function recoverStaleFilesystemSocket(
  cwd: string,
  endpoint: string,
  server: ReturnType<typeof createServer>,
  originalError: unknown,
): Effect.Effect<void, unknown, Scope.Scope> {
  return Effect.gen(function*() {
    if (yield* daemonEvidenceIsLive(cwd)) return yield* Effect.fail(originalError);
    const recoveryLockPath = `${endpoint}.recovery.sqlite`;
    const recoveryLock = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const database = openSqliteDatabase(recoveryLockPath, { timeout: 0 });
          try {
            await chmod(recoveryLockPath, 0o600);
            database.exec("BEGIN IMMEDIATE");
            return database;
          } catch (error) {
            database.close();
            if (isRuntimeStoreBusyError(error)) throw originalError;
            throw error;
          }
        },
        catch: error => error,
      }),
      database => Effect.sync(() => {
        try {
          database.exec("ROLLBACK");
        } finally {
          database.close();
        }
      }),
    );
    if (yield* daemonEvidenceIsLive(cwd)) return yield* Effect.fail(originalError);
    yield* tryPromise(() => rm(endpoint, { force: true }));
    const retried = yield* Effect.exit(listen(server, endpoint));
    if (Exit.isFailure(retried)) {
      const failure = Cause.squash(retried.cause);
      return yield* Effect.fail(isAddressInUse(failure) ? originalError : failure);
    }
    void recoveryLock;
  });
}

function daemonEvidenceIsLive(cwd: string): Effect.Effect<boolean, unknown> {
  return Effect.gen(function*() {
    if (yield* probeDaemonEndpointValue(cwd)) return true;
    return !(yield* hasStaleDaemonEvidence(cwd));
  });
}

function hasStaleDaemonEvidence(cwd: string): Effect.Effect<boolean, unknown> {
  return Effect.scoped(Effect.gen(function*() {
    const store = yield* acquireExistingWritableRuntimeStore(cwd);
    if (!store) return true;
    const authority = (yield* store.getRuntimeDiagnostics()).authority;
    if (!authority) return true;
    const now = yield* Clock.currentTimeMillis;
    if (authority.heartbeatAt && now - Date.parse(authority.heartbeatAt) > 5_000) return true;
    return authority.pid !== undefined && probeProcessIdentity({
      pid: authority.pid,
      ...(authority.processStartToken === undefined ? {} : { startToken: authority.processStartToken }),
    }) === "dead";
  }));
}

function listen(
  server: ReturnType<typeof createServer>,
  endpoint: string,
): Effect.Effect<void, unknown> {
  return Effect.callback<void, unknown>(resume => {
    const onError = (error: unknown): void => resume(Effect.fail(error));
    server.once("error", onError);
    server.listen(endpoint, () => {
      server.off("error", onError);
      resume(Effect.void);
    });
    return Effect.sync(() => server.off("error", onError));
  });
}

function closeNodeServer(server: ReturnType<typeof createServer>): Effect.Effect<void, unknown> {
  return Effect.callback<void, unknown>(resume => {
    server.close(error => resume(error === undefined ? Effect.void : Effect.fail(error)));
  });
}

function tryPromise<A>(operation: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: operation, catch: error => error });
}

function isFilesystemSocket(endpoint: string): boolean {
  return process.platform !== "win32" && !endpoint.startsWith("\0");
}

function isAddressInUse(error: unknown): boolean {
  return hasErrorCode(error, "EADDRINUSE");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
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
