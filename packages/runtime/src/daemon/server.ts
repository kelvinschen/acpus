import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import type { Result, ResultAsync } from "neverthrow";
import { daemonEndpoint, probeDaemonEndpoint } from "./client.js";
import {
  appliedDaemonResponse,
  daemonFailureMessage,
  failedDaemonResponse,
  parseDaemonRequest,
  type DaemonAdmitRunInput,
  type DaemonControlIntent,
  type DaemonControlResult,
  type DaemonHandlerFailure,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonShutdownResult,
  type DaemonStatus,
} from "./protocol.js";
import { probeProcessLiveness } from "../process-liveness.js";
import { isRuntimeStoreBusyError, openSqliteDatabase } from "../storage/database.js";
import { openExistingRuntimeStore, type RunDetails } from "../store/store.js";

export type DaemonServerHandle = {
  activeConnections(): number;
  close(): Promise<void>;
};

export type DaemonHandlers = {
  status(): Result<DaemonStatus, DaemonHandlerFailure> | ResultAsync<DaemonStatus, DaemonHandlerFailure>;
  admitRun(input: DaemonAdmitRunInput): Result<RunDetails, DaemonHandlerFailure> | ResultAsync<RunDetails, DaemonHandlerFailure>;
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
  socket.setTimeout(5_000, () => socket.destroy());
  socket.on("data", chunk => chunks.push(Buffer.from(chunk)));
  socket.once("end", () => {
    socket.setTimeout(0);
    void (async () => {
      const request = parseDaemonRequest(Buffer.concat(chunks).toString("utf8"));
      const response = request.ok ? await dispatchRequest(request.value, handlers) : request.response;
      socket.end(JSON.stringify(response));
    })();
  });
}

async function dispatchRequest(request: DaemonRequest, handlers: DaemonHandlers): Promise<DaemonResponse> {
  try {
    const result = request.method === "admitRun"
      ? await handlers.admitRun(request)
      : request.method === "control"
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
  const store = await openExistingRuntimeStore(cwd);
  if (!store) return true;
  try {
    const daemon = store.getRuntimeDiagnostics().daemon;
    if (!daemon) return true;
    if (daemon.heartbeatAt && Date.now() - Date.parse(daemon.heartbeatAt) > 5_000) return true;
    return daemon.pid !== undefined && probeProcessLiveness(daemon.pid) === "dead";
  } finally {
    store.close();
  }
}
