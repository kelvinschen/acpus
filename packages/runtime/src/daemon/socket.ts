import { createHash } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { JsonValue } from "@acpus/expression/ir";
import { isRuntimeStoreBusyError, openExistingRuntimeStore, type AgentOverrideMap, type PreparedRunWorkflow } from "../store/store.js";
import { type RuntimeAdvanceResult } from "../runs/advance-runtime.js";
import { RuntimeUseCaseException, type RuntimeMutationAction, type RuntimeMutationInput, type RuntimeMutationResult } from "../runs/use-cases.js";
import type { RunDetails } from "../store/store.js";

export type DaemonStatus = {
  status: "ok";
  pid: number;
  generation?: number;
  protocolVersion: number;
  packageVersion: string;
};

export type DaemonRequest = {
  id?: string;
  method: "status";
} | {
  id?: string;
  method: "shutdown";
} | {
  id?: string;
  method: "control";
  control: DaemonControlIntent;
} | {
  id?: string;
  method: "admitRun";
  prepared: PreparedRunWorkflow;
  input: JsonValue;
  agentOverrides?: AgentOverrideMap;
  start: boolean;
} | {
  id?: string;
  method: "startRun" | "observeRun";
  runId: string;
};

export type DaemonControlIntent =
  | { requestId: string; type: Exclude<RuntimeMutationAction, "fork">; runId: string; input?: RuntimeMutationInput }
  | { requestId: string; type: "fork"; runId: string; input?: RuntimeMutationInput }
  | { requestId: string; type: "signal"; runId: string; nodeId: string; payload: unknown };

export type DaemonResponse =
  | { id?: string; ok: true; outcome: "applied"; result: DaemonStatus | DaemonShutdownResult | RunDetails | RuntimeAdvanceResult | RuntimeMutationResult }
  | { id?: string; ok: false; outcome: "failed"; error: { code: DaemonErrorCode; message: string } };

export type DaemonErrorCode = "INVALID_REQUEST" | "INVALID_CONTROL" | "RUN_NOT_FOUND" | "RUN_TERMINAL" | "RUN_NOT_CONTROLLABLE" | "CONTROL_CONFLICT" | "EXECUTION_UNAVAILABLE" | "STORE_BUSY" | "STORE_ERROR" | "INTERNAL_ERROR";

export type DaemonShutdownResult = {
  status: "shutdown";
};

export class DaemonRequestError extends Error {
  constructor(readonly code: DaemonErrorCode, message: string) {
    super(message);
  }
}

export type DaemonServerHandle = {
  endpoint: string;
  activeConnections(): number;
  close(): Promise<void>;
};

export function daemonEndpoint(cwd: string): string {
  const workspace = resolve(cwd);
  const digest = createHash("sha256").update(workspace).digest("hex").slice(0, 24);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\acpus-daemon-${digest}`;
  }
  const workspaceEndpoint = join(workspace, ".acpus", ".local", "daemon.sock");
  if (Buffer.byteLength(workspaceEndpoint) < 100) return workspaceEndpoint;
  if (process.platform === "linux") return `\0acpus-daemon-${digest}`;
  return join(tmpdir(), `acpus-daemon-${digest}.sock`);
}

export type DaemonAdmitRunInput = Extract<DaemonRequest, { method: "admitRun" }>;

export async function startDaemonServer(cwd: string, handlers: DaemonHandlers): Promise<DaemonServerHandle> {
  const endpoint = daemonEndpoint(cwd);
  if (isFilesystemSocket(endpoint)) {
    await mkdir(dirname(endpoint), { recursive: true });
  }

  const sockets = new Set<Socket>();
  let activeConnections = 0;
  const requestTracker = {
    begin: () => {
      activeConnections += 1;
    },
    end: () => {
      activeConnections -= 1;
    },
  };
  const server = createServer({ allowHalfOpen: true }, socket => {
    requestTracker.begin();
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      requestTracker.end();
    });
    void handleSocket(socket, handlers, requestTracker);
  });

  try {
    await listen(server, endpoint);
  } catch (error) {
    if (!isFilesystemSocket(endpoint) || !isAddressInUse(error)) throw error;
    await recoverStaleFilesystemSocket(cwd, endpoint, server, error);
  }

  return {
    endpoint,
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

export async function requestDaemonStatus(cwd: string): Promise<DaemonStatus> {
  const response = await requestDaemon(cwd, { method: "status" });
  if (!response.ok) throw new DaemonRequestError(response.error.code, response.error.message);
  if (!isDaemonStatus(response.result)) throw new Error("Daemon returned an invalid status response.");
  return response.result;
}

export async function requestDaemonControl(cwd: string, control: DaemonControlIntent): Promise<RuntimeMutationResult> {
  const response = await requestDaemon(cwd, { method: "control", control });
  if (!response.ok) throw new DaemonRequestError(response.error.code, response.error.message);
  if (isDaemonStatus(response.result) || isDaemonShutdownResult(response.result) || isRunDetails(response.result) || isRuntimeAdvanceResult(response.result)) throw new Error("Daemon returned an invalid control response.");
  return response.result;
}

export async function requestDaemonAdmitRun(cwd: string, input: Omit<DaemonAdmitRunInput, "method">): Promise<RunDetails> {
  const response = await requestDaemon(cwd, { ...input, method: "admitRun" });
  if (!response.ok) throw new DaemonRequestError(response.error.code, response.error.message);
  if (isDaemonStatus(response.result) || isRuntimeAdvanceResult(response.result) || !isRunDetails(response.result)) throw new Error("Daemon returned an invalid admitRun response.");
  return response.result;
}

export async function requestDaemonStartRun(cwd: string, runId: string): Promise<RunDetails> {
  const response = await requestDaemon(cwd, { method: "startRun", runId });
  if (!response.ok) throw new DaemonRequestError(response.error.code, response.error.message);
  if (isDaemonStatus(response.result) || isRuntimeAdvanceResult(response.result) || !isRunDetails(response.result)) throw new Error("Daemon returned an invalid startRun response.");
  return response.result;
}

export async function requestDaemonObserveRun(cwd: string, runId: string): Promise<RuntimeAdvanceResult> {
  const response = await requestDaemon(cwd, { method: "observeRun", runId });
  if (!response.ok) throw new DaemonRequestError(response.error.code, response.error.message);
  if (!isRuntimeAdvanceResult(response.result)) throw new Error("Daemon returned an invalid observeRun response.");
  return response.result;
}

export async function requestDaemonShutdown(cwd: string): Promise<DaemonShutdownResult> {
  const response = await requestDaemon(cwd, { method: "shutdown" });
  if (!response.ok) throw new DaemonRequestError(response.error.code, response.error.message);
  if (!isDaemonShutdownResult(response.result)) throw new Error("Daemon returned an invalid shutdown response.");
  return response.result;
}

async function requestDaemon(cwd: string, request: DaemonRequest): Promise<DaemonResponse> {
  const endpoint = daemonEndpoint(cwd);
  return new Promise<DaemonResponse>((resolveRequest, rejectRequest) => {
    const socket = connect(endpoint);
    const chunks: Buffer[] = [];
    const timeoutMs = request.method === "observeRun" || request.method === "admitRun" ? undefined : request.method === "control" ? 30_000 : 1_000;
    const timeout = timeoutMs === undefined ? undefined : setTimeout(() => {
      socket.destroy();
      rejectRequest(new DaemonRequestError("EXECUTION_UNAVAILABLE", `Timed out waiting for daemon ${describeRequest(request)} response.`));
    }, timeoutMs);
    socket.once("error", error => {
      if (timeout) clearTimeout(timeout);
      rejectRequest(error);
    });
    socket.on("data", chunk => chunks.push(Buffer.from(chunk)));
    socket.once("end", () => {
      if (timeout) clearTimeout(timeout);
      try {
        resolveRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")) as DaemonResponse);
      } catch (error) {
        rejectRequest(error);
      }
    });
    socket.once("connect", () => {
      socket.end(JSON.stringify(request));
    });
  });
}

type DaemonHandlers = {
  status(): DaemonStatus;
  admitRun(input: DaemonAdmitRunInput): Promise<RunDetails> | RunDetails;
  control(intent: DaemonControlIntent): Promise<RuntimeMutationResult>;
  startRun(runId: string): Promise<RunDetails> | RunDetails;
  observeRun(runId: string): Promise<RuntimeAdvanceResult>;
  shutdown(): Promise<DaemonShutdownResult> | DaemonShutdownResult;
};

async function handleSocket(socket: Socket, handlers: DaemonHandlers, requestTracker: { begin(): void; end(): void }): Promise<void> {
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
    const value = JSON.parse(raw) as Partial<DaemonRequest>;
    if (value.method !== "status") {
      if (value.method === "shutdown") return { ok: true, value: { ...(value.id === undefined ? {} : { id: value.id }), method: value.method } };
      if (value.method === "startRun" || value.method === "observeRun") {
        if (typeof value.runId !== "string") return { ok: false, response: failedResponse(value.id, "INVALID_REQUEST", "Invalid daemon run request.") };
        return { ok: true, value: { ...(value.id === undefined ? {} : { id: value.id }), method: value.method, runId: value.runId } };
      }
      if (value.method === "admitRun") {
        if (!isAdmitRunRequest(value)) return { ok: false, response: failedResponse(value.id, "INVALID_REQUEST", "Invalid daemon admission request.") };
        return { ok: true, value };
      }
      if (value.method !== "control" || !isControlIntent(value.control)) {
        return { ok: false, response: failedResponse(value.id, "INVALID_REQUEST", "Unsupported daemon method.") };
      }
      return { ok: true, value: { ...(value.id === undefined ? {} : { id: value.id }), method: "control", control: value.control } };
    }
    return { ok: true, value: { ...(value.id === undefined ? {} : { id: value.id }), method: value.method } };
  } catch {
    return { ok: false, response: failedResponse(undefined, "INVALID_REQUEST", "Invalid daemon request JSON.") };
  }
}

async function dispatchRequest(request: DaemonRequest, handlers: DaemonHandlers): Promise<DaemonResponse> {
  try {
    if (request.method === "admitRun") return appliedResponse(request.id, await handlers.admitRun(request));
    if (request.method === "control") return appliedResponse(request.id, await handlers.control(request.control));
    if (request.method === "startRun") return appliedResponse(request.id, await handlers.startRun(request.runId));
    if (request.method === "observeRun") return appliedResponse(request.id, await handlers.observeRun(request.runId));
    if (request.method === "shutdown") return appliedResponse(request.id, await handlers.shutdown());
    return appliedResponse(request.id, handlers.status());
  } catch (error) {
    return failedResponse(request.id, daemonRequestErrorCode(request, error), error instanceof Error ? error.message : String(error));
  }
}

function responseId(id: string | undefined): { id?: string } {
  return id === undefined ? {} : { id };
}

function appliedResponse(id: string | undefined, result: Exclude<DaemonResponse, { ok: false }>["result"]): DaemonResponse {
  return { ...responseId(id), ok: true, outcome: "applied", result };
}

function failedResponse(id: string | undefined, code: DaemonErrorCode, message: string): DaemonResponse {
  return { ...responseId(id), ok: false, outcome: "failed", error: { code, message } };
}

function describeRequest(request: DaemonRequest): string {
  if (request.method === "admitRun") return "run admission";
  if (request.method === "control") return `${request.control.type} control for run '${request.control.runId}'`;
  if (request.method === "startRun" || request.method === "observeRun") return `${request.method} for run '${request.runId}'`;
  return request.method;
}

function daemonControlErrorCode(error: unknown): DaemonErrorCode {
  if (error instanceof DaemonRequestError) return error.code;
  if (isRuntimeStoreBusyError(error)) return "STORE_BUSY";
  const failure = runtimeFailure(error);
  if (failure) {
    if (failure.type === "run-not-found" || failure.type === "runtime-store-not-found") return "RUN_NOT_FOUND";
    if (failure.type === "scheduler-store-failed") return "STORE_ERROR";
    if (failure.type === "run-control-failed" && error instanceof Error && error.message.includes("currently controlled by another owner")) return "CONTROL_CONFLICT";
    return "RUN_NOT_CONTROLLABLE";
  }
  return "RUN_NOT_CONTROLLABLE";
}

function daemonRequestErrorCode(request: DaemonRequest, error: unknown): DaemonErrorCode {
  if (request.method === "status") return "INTERNAL_ERROR";
  if (error instanceof DaemonRequestError) return error.code;
  if (request.method === "admitRun") return isRuntimeStoreBusyError(error) ? "STORE_BUSY" : "STORE_ERROR";
  return daemonControlErrorCode(error);
}

function runtimeFailure(error: unknown): RuntimeUseCaseException["failure"] | undefined {
  if (error instanceof RuntimeUseCaseException) return error.failure;
  if (typeof error !== "object" || error === null || !("failure" in error)) return undefined;
  const failure = (error as { failure?: unknown }).failure;
  if (typeof failure !== "object" || failure === null || !("type" in failure)) return undefined;
  return failure as RuntimeUseCaseException["failure"];
}

function isFilesystemSocket(endpoint: string): boolean {
  return process.platform !== "win32" && !endpoint.startsWith("\0");
}

function isDaemonStatus(value: unknown): value is DaemonStatus {
  return typeof value === "object" && value !== null && (value as { status?: unknown }).status === "ok";
}

function isDaemonShutdownResult(value: unknown): value is DaemonShutdownResult {
  return typeof value === "object" && value !== null && (value as { status?: unknown }).status === "shutdown";
}

function isRunDetails(value: unknown): value is RunDetails {
  return typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string" && typeof (value as { status?: unknown }).status === "string";
}

function isRuntimeAdvanceResult(value: unknown): value is RuntimeAdvanceResult {
  return typeof value === "object" && value !== null && "summary" in value && "run" in value;
}

function isControlIntent(value: unknown): value is DaemonControlIntent {
  if (typeof value !== "object" || value === null) return false;
  const intent = value as { requestId?: unknown; type?: unknown; runId?: unknown; nodeId?: unknown };
  if (typeof intent.requestId !== "string" || typeof intent.type !== "string" || typeof intent.runId !== "string") return false;
  return intent.type === "signal" ? typeof intent.nodeId === "string" : ["pause", "resume", "retry", "cancel", "fork"].includes(intent.type);
}

function isAdmitRunRequest(value: Partial<DaemonRequest>): value is DaemonAdmitRunInput {
  return value.method === "admitRun"
    && isPreparedRunWorkflow(value.prepared)
    && hasOwn(value, "input")
    && isJsonValue(value.input)
    && (value.agentOverrides === undefined || isPlainRecord(value.agentOverrides))
    && typeof value.start === "boolean";
}

function isPreparedRunWorkflow(value: unknown): value is PreparedRunWorkflow {
  if (!isPlainRecord(value)) return false;
  const ir = value.ir;
  return typeof value.workflowPath === "string"
    && isPlainRecord(ir)
    && typeof ir.name === "string"
    && isPlainRecord(ir.root)
    && typeof value.irJson === "string"
    && typeof value.sourceGraphDigest === "string"
    && (value.packageLockDigest === undefined || typeof value.packageLockDigest === "string")
    && isPlainRecord(value.lock);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => isJsonValue(item));
  if (!isPlainRecord(value)) return false;
  return Object.values(value).every(item => isJsonValue(item));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

async function hasLiveDaemon(cwd: string): Promise<boolean> {
  try {
    await requestDaemonStatus(cwd);
    return true;
  } catch {
    return false;
  }
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EADDRINUSE";
}

function isFileExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST";
}

async function hasStaleDaemonEvidence(cwd: string): Promise<boolean> {
  const store = await openExistingRuntimeStore(cwd);
  if (!store) return true;
  try {
    const daemon = store.getRuntimeDiagnostics().daemon;
    if (!daemon) return true;
    if (daemon.heartbeatAt && Date.now() - Date.parse(daemon.heartbeatAt) > 5_000) return true;
    return daemon.pid !== undefined && !isProcessAlive(daemon.pid);
  } finally {
    store.close();
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EPERM";
  }
}
