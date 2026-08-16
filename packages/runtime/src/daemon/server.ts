import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import type { Result, ResultAsync } from "neverthrow";
import { sameRuntimeAuthority } from "./authority.js";
import { daemonEndpoint, probeDaemonEndpoint } from "./client.js";
import {
  appliedDaemonResponse,
  daemonFailureMessage,
  failedDaemonResponse,
  isDaemonRunStreamFrame,
  parseDaemonRequest,
  type DaemonControlIntent,
  type DaemonControlResult,
  type DaemonHandlerFailure,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonRunStreamFrame,
  type DaemonShutdownResult,
  type DaemonStatus,
  type DaemonSubmitAndObserveInput,
} from "./protocol.js";
import { probeProcessIdentity } from "../process-liveness.js";
import { isRuntimeStoreBusyError, openSqliteDatabase } from "../storage/database.js";
import { openExistingWritableRuntimeStore } from "../store/store.js";

export type DaemonServerHandle = {
  activeConnections(): number;
  close(): Promise<void>;
};

export type DaemonHandlers = {
  status(): Result<DaemonStatus, DaemonHandlerFailure> | ResultAsync<DaemonStatus, DaemonHandlerFailure>;
  submitAndObserve(input: DaemonSubmitAndObserveInput, signal: AbortSignal): AsyncIterable<DaemonRunStreamFrame>;
  control(intent: DaemonControlIntent): Result<DaemonControlResult, DaemonHandlerFailure> | ResultAsync<DaemonControlResult, DaemonHandlerFailure>;
  shutdown(): Result<DaemonShutdownResult, DaemonHandlerFailure> | ResultAsync<DaemonShutdownResult, DaemonHandlerFailure>;
};

export async function startDaemonServer(cwd: string, handlers: DaemonHandlers): Promise<DaemonServerHandle> {
  const endpoint = daemonEndpoint(cwd);
  if (isFilesystemSocket(endpoint)) {
    await ensurePrivateSocketParent(endpoint);
    await rejectSocketSymlink(endpoint);
  }

  const sockets = new Set<Socket>();
  let activeConnections = 0;
  const server = createServer({ allowHalfOpen: true }, socket => {
    activeConnections += 1;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => {
      sockets.delete(socket);
      activeConnections -= 1;
    });
    void handleSocket(socket, handlers);
  });

  try {
    try {
      await listen(server, endpoint);
    } catch (error) {
      if (!isFilesystemSocket(endpoint) || !isAddressInUse(error)) throw error;
      await recoverStaleFilesystemSocket(cwd, endpoint, server, error);
    }
    if (isFilesystemSocket(endpoint)) await secureFilesystemSocket(endpoint);
  } catch (error) {
    if (server.listening) {
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
      if (isFilesystemSocket(endpoint)) await rm(endpoint, { force: true });
    }
    throw error;
  }

  return {
    activeConnections: () => activeConnections,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close(error => {
          if (error) rejectClose(error);
          else resolveClose();
        });
      });
      if (isFilesystemSocket(endpoint)) await rm(endpoint, { force: true });
    },
  };
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

async function recoverStaleFilesystemSocket(
  cwd: string,
  endpoint: string,
  server: ReturnType<typeof createServer>,
  originalError: unknown,
): Promise<void> {
  if (await probeDaemonEndpoint(cwd) || !await hasStaleDaemonEvidence(cwd)) throw originalError;
  const recoveryLockPath = `${endpoint}.recovery.sqlite`;
  const recoveryLock = openSqliteDatabase(recoveryLockPath, { timeout: 0 });
  try {
    await chmod(recoveryLockPath, 0o600);
    recoveryLock.exec("BEGIN IMMEDIATE");
  } catch (error) {
    recoveryLock.close();
    if (isRuntimeStoreBusyError(error)) throw originalError;
    throw error;
  }
  try {
    if (await probeDaemonEndpoint(cwd) || !await hasStaleDaemonEvidence(cwd)) throw originalError;
    await rm(endpoint, { force: true });
    try {
      await listen(server, endpoint);
    } catch (retryError) {
      if (isAddressInUse(retryError)) throw originalError;
      throw retryError;
    }
  } finally {
    try {
      recoveryLock.exec("ROLLBACK");
    } finally {
      recoveryLock.close();
    }
  }
}

async function listen(server: ReturnType<typeof createServer>, endpoint: string): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(endpoint, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
}

async function handleSocket(socket: Socket, handlers: DaemonHandlers): Promise<void> {
  const chunks: Buffer[] = [];
  let handled = false;
  socket.setTimeout(5_000, () => socket.destroy());
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
    socket.setTimeout(0);
    if (upload.subarray(newline + 1).length > 0) {
      socket.end(JSON.stringify(failedDaemonResponse("INVALID_REQUEST", "Invalid daemon request.")));
      return;
    }
    void dispatchSocketRequest(socket, handlers, upload.subarray(0, newline).toString("utf8"));
  });
  socket.once("end", () => {
    if (handled) return;
    handled = true;
    socket.setTimeout(0);
    void dispatchSocketRequest(socket, handlers, Buffer.concat(chunks).toString("utf8"));
  });
}

async function dispatchSocketRequest(socket: Socket, handlers: DaemonHandlers, raw: string): Promise<void> {
  const request = parseDaemonRequest(raw);
  if (!request.ok) {
    if (request.stream) {
      await writeRunStreamFrame(socket, {
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
    await dispatchRunStream(socket, request.value, handlers);
    return;
  }
  socket.end(JSON.stringify(await dispatchRequest(request.value, handlers)));
}

async function dispatchRequest(
  request: Exclude<DaemonRequest, { method: "submitAndObserve" }>,
  handlers: DaemonHandlers,
): Promise<DaemonResponse> {
  try {
    const result = request.method === "control"
      ? await handlers.control(request.control)
      : request.method === "shutdown"
        ? await handlers.shutdown()
        : await handlers.status();
    return result.match(
      appliedDaemonResponse,
      failure => failedDaemonResponse(failure.code, failure.message, failure.ambiguity),
    );
  } catch {
    return failedDaemonResponse("INTERNAL_ERROR", daemonFailureMessage(request, "INTERNAL_ERROR"));
  }
}

async function dispatchRunStream(
  socket: Socket,
  request: Extract<DaemonRequest, { method: "submitAndObserve" }>,
  handlers: DaemonHandlers,
): Promise<void> {
  const observer = new AbortController();
  let outcomeResolved = false;
  let admittedRunId: string | undefined;
  const abortObserverAfterOutcome = (): void => {
    if (outcomeResolved) observer.abort();
  };
  socket.once("close", abortObserverAfterOutcome);
  let iterator: AsyncIterator<DaemonRunStreamFrame> | undefined;
  try {
    iterator = handlers.submitAndObserve(request, observer.signal)[Symbol.asyncIterator]();
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        socket.end();
        return;
      }
      const frame = next.value;
      if (!isDaemonRunStreamFrame(frame)
        || admittedRunId === undefined && frame.kind === "observation"
        || admittedRunId !== undefined && frame.kind === "admitted"
        || admittedRunId !== undefined && frame.kind === "error"
          && (frame.outcome !== "admitted" || frame.runId !== undefined && frame.runId !== admittedRunId)
        || frame.kind === "admitted" && !sameRuntimeAuthority(frame.authority, request.expectedAuthority)) {
        await writeRunStreamFrame(socket, {
          kind: "error",
          phase: admittedRunId === undefined ? "admission" : "observation",
          outcome: admittedRunId === undefined ? "unknown" : "admitted",
          ...(admittedRunId === undefined ? {} : { runId: admittedRunId }),
          error: { code: "INTERNAL_ERROR", message: "Run submission failed." },
        });
        socket.end();
        return;
      }
      if (frame.kind === "admitted") admittedRunId = frame.run.id;
      outcomeResolved ||= frame.kind === "admitted" || frame.kind === "error";
      if (socket.destroyed || !socket.writable) {
        abortObserverAfterOutcome();
        return;
      }
      if (!await writeRunStreamFrame(socket, frame)) {
        abortObserverAfterOutcome();
        return;
      }
      if (frame.kind === "error"
        || frame.kind === "observation" && frame.observation.kind === "closed"
        || frame.kind === "admitted" && request.until === "admitted") {
        socket.end();
        return;
      }
    }
  } catch {
    outcomeResolved = true;
    if (!socket.destroyed && socket.writable) {
      await writeRunStreamFrame(socket, {
        kind: "error",
        phase: admittedRunId === undefined ? "admission" : "observation",
        outcome: admittedRunId === undefined ? "unknown" : "admitted",
        ...(admittedRunId === undefined ? {} : { runId: admittedRunId }),
        error: { code: "INTERNAL_ERROR", message: "Run submission failed." },
      });
      socket.end();
    }
  } finally {
    socket.off("close", abortObserverAfterOutcome);
    await iterator?.return?.();
  }
}

async function writeRunStreamFrame(socket: Socket, frame: DaemonRunStreamFrame): Promise<boolean> {
  if (socket.destroyed || !socket.writable) return false;
  const line = `${JSON.stringify(frame)}\n`;
  if (socket.write(line)) return true;
  return await new Promise(resolveWrite => {
    const cleanup = (): void => {
      socket.off("drain", drained);
      socket.off("close", closed);
      socket.off("error", closed);
    };
    const drained = (): void => {
      cleanup();
      resolveWrite(true);
    };
    const closed = (): void => {
      cleanup();
      resolveWrite(false);
    };
    socket.once("drain", drained);
    socket.once("close", closed);
    socket.once("error", closed);
  });
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

async function hasStaleDaemonEvidence(cwd: string): Promise<boolean> {
  const store = await openExistingWritableRuntimeStore(cwd);
  if (!store) return true;
  try {
    const authority = store.getRuntimeDiagnostics().authority;
    if (!authority) return true;
    if (authority.heartbeatAt && Date.now() - Date.parse(authority.heartbeatAt) > 5_000) return true;
    return authority.pid !== undefined && probeProcessIdentity({
      pid: authority.pid,
      ...(authority.processStartToken === undefined ? {} : { startToken: authority.processStartToken }),
    }) === "dead";
  } finally {
    store.close();
  }
}
