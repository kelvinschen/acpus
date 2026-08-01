import { chmod, lstat, mkdir, open, rm } from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import { dirname } from "node:path";
import { isJsonValue, type JsonValue } from "@acpus/expression/ir";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import { probeProcessLiveness } from "../process-liveness.js";
import { ensureRuntimeLayout, resolveRuntimeLayout } from "../runtime-layout.js";
import {
  isPreparedRunWorkflow,
  openExistingRuntimeStore,
  type AgentOverrideMap,
  type PreparedRunWorkflow,
  type RunDetails,
} from "../store/store.js";

export const DAEMON_PROTOCOL_VERSION = 3;

export type DaemonStatus = {
  status: "ok";
  pid: number;
  generation: number;
  protocolVersion: number;
  packageVersion: string;
};

export type DaemonAdmitRunInput = {
  prepared: PreparedRunWorkflow;
  input: JsonValue;
  agentOverrides?: AgentOverrideMap;
};

type DaemonAdmitRunRequest = { method: "admitRun" } & DaemonAdmitRunInput;

type DaemonRequest = {
  method: "status";
} | {
  method: "shutdown";
} | {
  method: "control";
  control: DaemonControlIntent;
} | DaemonAdmitRunRequest;

export type DaemonControlResult =
  | { type: "pause"; state: "applied"; run: RunDetails }
  | { type: "resume"; state: "applied"; run: RunDetails }
  | { type: "retry"; state: "applied"; run: RunDetails; target?: string }
  | { type: "cancel"; state: "applied"; run: RunDetails; target?: string }
  | {
    type: "steer";
    state: "applied";
    run: RunDetails;
    steerId: string;
    requestedTarget: string;
    target: string;
    fencedAttemptId: string;
    continuation: "queued";
  }
  | { type: "fork"; state: "applied"; sourceRunId: string; run: RunDetails }
  | {
    type: "signal";
    state: "consumed";
    requestedTarget: string;
    target: string;
    validation: { kind: "schema"; schemaSummary: string } | { kind: "raw-string" };
    run: RunDetails;
  };

export type DaemonControlIntent =
  | { requestId: string; type: "pause" | "resume"; runId: string }
  | { requestId: string; type: "retry" | "cancel"; runId: string; target?: string }
  | { requestId: string; type: "steer"; runId: string; target: string; instruction: string }
  | { requestId: string; type: "fork"; runId: string; target?: string; prepared?: PreparedRunWorkflow; input?: JsonValue; agentOverrides?: AgentOverrideMap }
  | { requestId: string; type: "signal"; runId: string; nodeId: string; payload: JsonValue };

type DaemonResponse =
  | { ok: true; result: DaemonStatus | DaemonShutdownResult | RunDetails | DaemonControlResult }
  | { ok: false; error: { code: DaemonErrorCode; message: string; ambiguity?: true } };

const DAEMON_ERROR_CODES = ["INVALID_REQUEST", "RUN_NOT_FOUND", "RUN_NOT_CONTROLLABLE", "CONTROL_CONFLICT", "EXECUTION_UNAVAILABLE", "STORE_BUSY", "STORE_ERROR", "INTERNAL_ERROR"] as const;

export type DaemonErrorCode = (typeof DAEMON_ERROR_CODES)[number];

export type DaemonShutdownResult = {
  status: "shutdown";
};

export type DaemonHandlerFailure = { code: DaemonErrorCode; message: string; ambiguity?: true };

export type DaemonClientFailure =
  | { type: "rejected"; code: DaemonErrorCode; message: string; ambiguity?: true }
  | { type: "transport"; reason: "not-found" | "refused" | "timeout" | "io"; method: DaemonRequest["method"]; errno?: string; message: string }
  | { type: "protocol"; stage: "envelope" | "result"; method: DaemonRequest["method"]; message: string };

export type DaemonServerHandle = {
  activeConnections(): number;
  close(): Promise<void>;
};

export function daemonEndpoint(cwd: string): string {
  return resolveRuntimeLayout(cwd).daemonEndpoint;
}

export async function startDaemonServer(cwd: string, handlers: DaemonHandlers): Promise<DaemonServerHandle> {
  const layout = await ensureRuntimeLayout(cwd);
  if (layout.isErr()) throw new Error(layout.error.message);
  const endpoint = layout.value.daemonEndpoint;
  if (isFilesystemSocket(endpoint)) {
    await ensurePrivateSocketParent(endpoint);
    await rejectSocketSymlink(endpoint);
  }

  const sockets = new Set<Socket>();
  let activeConnections = 0;
  const server = createServer({ allowHalfOpen: true }, socket => {
    activeConnections += 1;
    sockets.add(socket);
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

async function recoverStaleFilesystemSocket(cwd: string, endpoint: string, server: ReturnType<typeof createServer>, originalError: unknown): Promise<void> {
  const lock = await acquireStaleSocketLock(endpoint);
  if (!lock) throw originalError;
  try {
    if (await hasLiveDaemon(cwd)) throw originalError;
    if (!await hasStaleDaemonEvidence(cwd)) throw originalError;
    await rm(endpoint, { force: true });
    try {
      await listen(server, endpoint);
    } catch (retryError) {
      if (isAddressInUse(retryError)) throw originalError;
      throw retryError;
    }
  } finally {
    await lock.release();
  }
}

async function acquireStaleSocketLock(endpoint: string): Promise<{ release(): Promise<void> } | undefined> {
  const lockPath = `${endpoint}.lock`;
  try {
    const file = await open(lockPath, "wx");
    return {
      release: async () => {
        await file.close();
        await rm(lockPath, { force: true });
      },
    };
  } catch (error) {
    if (isFileExists(error)) return undefined;
    throw error;
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

export function requestDaemonStatus(cwd: string): ResultAsync<DaemonStatus, DaemonClientFailure> {
  const request = { method: "status" } as const;
  return requestDaemon(cwd, request).andThen(response => daemonResult(request, response, isDaemonStatus));
}

export function requestDaemonControl(cwd: string, control: DaemonControlIntent): ResultAsync<DaemonControlResult, DaemonClientFailure> {
  const request = { method: "control", control } as const;
  return requestDaemon(cwd, request).andThen(response => daemonResult(
    request,
    response,
    value => isDaemonControlResult(value, control.type),
  ));
}

export function requestDaemonAdmitRun(cwd: string, input: DaemonAdmitRunInput): ResultAsync<RunDetails, DaemonClientFailure> {
  const request = { ...input, method: "admitRun" } as const;
  return requestDaemon(cwd, request).andThen(response => daemonResult(request, response, isRunDetails));
}

export function requestDaemonShutdown(cwd: string): ResultAsync<DaemonShutdownResult, DaemonClientFailure> {
  const request = { method: "shutdown" } as const;
  return requestDaemon(cwd, request).andThen(response => daemonResult(request, response, isDaemonShutdownResult));
}

function requestDaemon(cwd: string, request: DaemonRequest): ResultAsync<DaemonResponse, Extract<DaemonClientFailure, { type: "transport" | "protocol" }>> {
  const endpoint = daemonEndpoint(cwd);
  return new ResultAsync(new Promise(resolveRequest => {
    const socket = connect(endpoint);
    const chunks: Buffer[] = [];
    const timeoutMs = request.method === "admitRun"
      ? undefined
      : request.method === "control"
        ? 30_000
        : 1_000;
    const timeout = timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          socket.destroy();
          resolveRequest(err({
            type: "transport",
            reason: "timeout",
            method: request.method,
            message: `Timed out waiting for daemon ${describeRequest(request)} response.`,
          }));
        }, timeoutMs);
    socket.once("error", error => {
      if (timeout) clearTimeout(timeout);
      resolveRequest(err(daemonTransportFailure(request, error)));
    });
    socket.on("data", chunk => chunks.push(Buffer.from(chunk)));
    socket.once("end", () => {
      if (timeout) clearTimeout(timeout);
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        if (!isDaemonResponse(response)) {
          resolveRequest(err({ type: "protocol", stage: "envelope", method: request.method, message: "Daemon returned an invalid response." }));
          return;
        }
        resolveRequest(ok(response));
      } catch {
        resolveRequest(err({ type: "protocol", stage: "envelope", method: request.method, message: "Daemon returned invalid response JSON." }));
      }
    });
    socket.once("connect", () => {
      socket.end(JSON.stringify(request));
    });
  }));
}

type DaemonHandlers = {
  status(): Result<DaemonStatus, DaemonHandlerFailure> | ResultAsync<DaemonStatus, DaemonHandlerFailure>;
  admitRun(input: DaemonAdmitRunInput): Result<RunDetails, DaemonHandlerFailure> | ResultAsync<RunDetails, DaemonHandlerFailure>;
  control(intent: DaemonControlIntent): Result<DaemonControlResult, DaemonHandlerFailure> | ResultAsync<DaemonControlResult, DaemonHandlerFailure>;
  shutdown(): Result<DaemonShutdownResult, DaemonHandlerFailure> | ResultAsync<DaemonShutdownResult, DaemonHandlerFailure>;
};

async function handleSocket(socket: Socket, handlers: DaemonHandlers): Promise<void> {
  const chunks: Buffer[] = [];
  socket.setTimeout(5_000, () => socket.destroy());
  socket.on("data", chunk => chunks.push(Buffer.from(chunk)));
  socket.once("end", () => {
    socket.setTimeout(0);
    void (async () => {
      const request = parseRequest(Buffer.concat(chunks).toString("utf8"));
      const response = request.ok ? await dispatchRequest(request.value, handlers) : request.response;
      socket.end(JSON.stringify(response));
    })();
  });
}

function parseRequest(raw: string): { ok: true; value: DaemonRequest } | { ok: false; response: DaemonResponse } {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isPlainRecord(value) || typeof value.method !== "string") return { ok: false, response: failedResponse("INVALID_REQUEST", "Invalid daemon request.") };
    if (value.method === "status" || value.method === "shutdown") {
      return hasExactKeys(value, ["method"])
        ? { ok: true, value: { method: value.method } }
        : { ok: false, response: failedResponse("INVALID_REQUEST", "Invalid daemon request.") };
    }
    if (value.method === "admitRun") {
      if (!isAdmitRunRequest(value)) return { ok: false, response: failedResponse("INVALID_REQUEST", "Invalid daemon admission request.") };
      return { ok: true, value };
    }
    if (value.method !== "control" || !hasExactKeys(value, ["method", "control"]) || !isControlIntent(value.control)) {
      return { ok: false, response: failedResponse("INVALID_REQUEST", "Unsupported daemon method.") };
    }
    return { ok: true, value: { method: "control", control: value.control } };
  } catch {
    return { ok: false, response: failedResponse("INVALID_REQUEST", "Invalid daemon request JSON.") };
  }
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
    return result.match(appliedResponse, failure => failedResponse(failure.code, failure.message, failure.ambiguity));
  } catch {
    return failedResponse("INTERNAL_ERROR", daemonFailureMessage(request, "INTERNAL_ERROR"));
  }
}

function appliedResponse(result: Exclude<DaemonResponse, { ok: false }>["result"]): DaemonResponse {
  return { ok: true, result };
}

function failedResponse(code: DaemonErrorCode, message: string, ambiguity?: true): DaemonResponse {
  return { ok: false, error: { code, message, ...(ambiguity ? { ambiguity } : {}) } };
}

function describeRequest(request: DaemonRequest): string {
  if (request.method === "admitRun") return "run admission";
  if (request.method === "control") return `${request.control.type} control for run '${request.control.runId}'`;
  return request.method;
}

function daemonFailureMessage(request: DaemonRequest, code: DaemonErrorCode): string {
  if (code === "STORE_BUSY") return "Runtime store is busy. Retry the request.";
  if (request.method === "status") return "Daemon status is unavailable.";
  if (request.method === "admitRun") return "Run admission failed.";
  if (request.method === "control") return `Control '${request.control.type}' could not be applied to run '${request.control.runId}'.`;
  return "Daemon shutdown failed.";
}

function daemonResult<T>(request: DaemonRequest, response: DaemonResponse, validate: (value: unknown) => value is T): Result<T, DaemonClientFailure> {
  if (!response.ok) return err({
    type: "rejected",
    code: response.error.code,
    message: response.error.message,
    ...(response.error.ambiguity ? { ambiguity: true } : {}),
  });
  return validate(response.result)
    ? ok(response.result)
    : err({ type: "protocol", stage: "result", method: request.method, message: `Daemon returned an invalid ${describeRequest(request)} result.` });
}

function daemonTransportFailure(request: DaemonRequest, error: NodeJS.ErrnoException): Extract<DaemonClientFailure, { type: "transport" }> {
  const reason = error.code === "ENOENT" || error.code === "ENOTDIR" ? "not-found" : error.code === "ECONNREFUSED" ? "refused" : "io";
  return {
    type: "transport",
    reason,
    method: request.method,
    ...(error.code === undefined ? {} : { errno: error.code }),
    message: error.message,
  };
}

function isFilesystemSocket(endpoint: string): boolean {
  return process.platform !== "win32" && !endpoint.startsWith("\0");
}

function isDaemonStatus(value: unknown): value is DaemonStatus {
  return isPlainRecord(value)
    && hasExactKeys(value, ["status", "pid", "generation", "protocolVersion", "packageVersion"])
    && value.status === "ok"
    && Number.isInteger(value.pid) && Number(value.pid) > 0
    && Number.isInteger(value.generation) && Number(value.generation) > 0
    && Number.isInteger(value.protocolVersion) && Number(value.protocolVersion) > 0
    && typeof value.packageVersion === "string";
}

function isDaemonShutdownResult(value: unknown): value is DaemonShutdownResult {
  return isPlainRecord(value) && hasExactKeys(value, ["status"]) && value.status === "shutdown";
}

function isRunDetails(value: unknown): value is RunDetails {
  if (!isPlainRecord(value)
    || !hasExactKeys(
      value,
      [
        "id",
        "name",
        "status",
        "workflowEntry",
        "sourceGraphDigest",
        "createdAt",
        "updatedAt",
        "progressVersion",
        "input",
        "hooks",
        "eventCount",
        "nodeCount",
        "execution",
      ],
      ["progressUpdatedAt", "output", "agentOverrides", "fork", "dynamic"],
    )
    || typeof value.id !== "string"
    || typeof value.name !== "string"
    || !isRunStatus(value.status)
    || typeof value.workflowEntry !== "string"
    || typeof value.sourceGraphDigest !== "string"
    || typeof value.createdAt !== "string"
    || typeof value.updatedAt !== "string"
    || !isNonNegativeInteger(value.progressVersion)
    || (value.progressUpdatedAt !== undefined && typeof value.progressUpdatedAt !== "string")
    || !isJsonValue(value.input)
    || (value.output !== undefined && !isJsonValue(value.output))
    || (value.agentOverrides !== undefined && (!isPlainRecord(value.agentOverrides) || !isJsonValue(value.agentOverrides)))
    || (value.fork !== undefined && !isRunForkInfo(value.fork))
    || !Array.isArray(value.hooks)
    || !isJsonValue(value.hooks)
    || !isNonNegativeInteger(value.eventCount)
    || !isNonNegativeInteger(value.nodeCount)
    || !isRunExecutionState(value.execution)
    || (value.dynamic !== undefined && (!isPlainRecord(value.dynamic) || !isJsonValue(value.dynamic)))) {
    return false;
  }
  return true;
}

function isDaemonControlResult(value: unknown, expectedType: DaemonControlIntent["type"]): value is DaemonControlResult {
  if (!isPlainRecord(value) || value.type !== expectedType || !isRunDetails(value.run)) return false;
  if (value.type === "pause" || value.type === "resume") {
    return hasExactKeys(value, ["type", "state", "run"]) && value.state === "applied";
  }
  if (value.type === "retry" || value.type === "cancel") {
    return hasExactKeys(value, ["type", "state", "run"], ["target"])
      && value.state === "applied"
      && (value.target === undefined || typeof value.target === "string" && value.target.length > 0);
  }
  if (value.type === "steer") {
    return hasExactKeys(value, ["type", "state", "run", "steerId", "requestedTarget", "target", "fencedAttemptId", "continuation"])
      && value.state === "applied"
      && value.continuation === "queued"
      && typeof value.steerId === "string" && value.steerId.length > 0
      && typeof value.requestedTarget === "string" && value.requestedTarget.length > 0
      && typeof value.target === "string" && value.target.length > 0
      && typeof value.fencedAttemptId === "string" && value.fencedAttemptId.length > 0;
  }
  if (value.type === "fork") {
    return hasExactKeys(value, ["type", "state", "sourceRunId", "run"])
      && value.state === "applied"
      && typeof value.sourceRunId === "string";
  }
  return value.type === "signal"
    && hasExactKeys(value, ["type", "state", "requestedTarget", "target", "validation", "run"])
    && value.state === "consumed"
    && typeof value.requestedTarget === "string"
    && typeof value.target === "string"
    && isSignalValidation(value.validation);
}

function isRunStatus(value: unknown): value is RunDetails["status"] {
  return value === "pending"
    || value === "running"
    || value === "paused"
    || value === "awaiting"
    || value === "failed"
    || value === "completed"
    || value === "canceled";
}

function isRunExecutionState(value: unknown): boolean {
  if (!isPlainRecord(value)
    || !hasExactKeys(
      value,
      ["state", "lastStatus"],
      ["reason", "daemonHeartbeatAt", "ownerId", "leaseExpiresAt"],
    )
    || typeof value.state !== "string"
    || !["active", "inactive", "stale", "terminal", "unknown"].includes(value.state)
    || !isRunStatus(value.lastStatus)
    || (value.reason !== undefined && (typeof value.reason !== "string" || ![
        "terminal",
        "daemon_heartbeat_expired",
        "daemon_pid_dead",
        "run_lease_expired",
        "run_lease_active",
        "daemon_alive",
        "no_liveness_evidence",
      ].includes(value.reason)))) {
    return false;
  }
  return [value.daemonHeartbeatAt, value.ownerId, value.leaseExpiresAt]
    .every(field => field === undefined || typeof field === "string");
}

function isRunForkInfo(value: unknown): boolean {
  return isPlainRecord(value)
    && hasExactKeys(value, ["sourceRunId"], ["target"])
    && typeof value.sourceRunId === "string"
    && (value.target === undefined || typeof value.target === "string");
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isSignalValidation(value: unknown): value is Extract<DaemonControlResult, { type: "signal" }>["validation"] {
  if (!isPlainRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "raw-string") return hasExactKeys(value, ["kind"]);
  return value.kind === "schema"
    && hasExactKeys(value, ["kind", "schemaSummary"])
    && typeof value.schemaSummary === "string";
}

function isDaemonResponse(value: unknown): value is DaemonResponse {
  if (!isPlainRecord(value)) return false;
  if (value.ok === true) return hasExactKeys(value, ["ok", "result"]);
  if (value.ok !== false || !hasExactKeys(value, ["ok", "error"]) || !isPlainRecord(value.error)) return false;
  return hasExactKeys(value.error, ["code", "message"], ["ambiguity"])
    && DAEMON_ERROR_CODES.includes(value.error.code as DaemonErrorCode)
    && typeof value.error.message === "string"
    && (value.error.ambiguity === undefined || value.error.ambiguity === true);
}

function isControlIntent(value: unknown): value is DaemonControlIntent {
  if (!isPlainRecord(value) || typeof value.requestId !== "string" || typeof value.type !== "string" || typeof value.runId !== "string") return false;
  if (value.type === "pause" || value.type === "resume") return hasExactKeys(value, ["requestId", "type", "runId"]);
  if (value.type === "retry" || value.type === "cancel") {
    return hasExactKeys(value, ["requestId", "type", "runId"], ["target"])
      && (value.target === undefined || typeof value.target === "string" && value.target.length > 0);
  }
  if (value.type === "steer") {
    return hasExactKeys(value, ["requestId", "type", "runId", "target", "instruction"])
      && value.requestId.length > 0
      && typeof value.target === "string"
      && value.target.trim().length > 0
      && typeof value.instruction === "string"
      && value.instruction.trim().length > 0;
  }
  if (value.type === "signal") {
    return hasExactKeys(value, ["requestId", "type", "runId", "nodeId", "payload"])
      && typeof value.nodeId === "string"
      && isJsonValue(value.payload);
  }
  if (value.type !== "fork"
    || !hasExactKeys(value, ["requestId", "type", "runId"], ["target", "prepared", "input", "agentOverrides"])) return false;
  return (value.target === undefined || typeof value.target === "string" && value.target.length > 0)
    && (value.prepared === undefined || isPreparedRunWorkflow(value.prepared))
    && (value.input === undefined || isJsonValue(value.input))
    && (value.agentOverrides === undefined || isPlainRecord(value.agentOverrides));
}

function isAdmitRunRequest(value: Record<string, unknown>): value is DaemonAdmitRunRequest {
  return value.method === "admitRun"
    && hasExactKeys(value, ["method", "prepared", "input"], ["agentOverrides"])
    && isPreparedRunWorkflow(value.prepared)
    && hasOwn(value, "input")
    && isJsonValue(value.input)
    && (value.agentOverrides === undefined || isPlainRecord(value.agentOverrides));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key));
}

async function hasLiveDaemon(cwd: string): Promise<boolean> {
  return (await requestDaemon(cwd, { method: "status" })).isOk();
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EADDRINUSE";
}

function isFileExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST";
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
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
