import { createHash } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { JsonValue } from "@acpus/expression/ir";
import { isRuntimeStoreBusyError, openExistingRuntimeStore, type AgentOverrideMap, type PreparedRunWorkflow, type RunDetails } from "../store/store.js";

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

export type DaemonControlResult = {
  run: RunDetails;
  forkRunId?: string;
};

export type DaemonControlIntent =
  | { requestId: string; type: "pause" | "resume"; runId: string }
  | { requestId: string; type: "retry" | "cancel"; runId: string; target?: string }
  | { requestId: string; type: "fork"; runId: string; target?: string; prepared?: PreparedRunWorkflow; input?: JsonValue; agentOverrides?: AgentOverrideMap; unsafeReuse?: boolean }
  | { requestId: string; type: "signal"; runId: string; nodeId: string; payload: JsonValue };

type DaemonResponse =
  | { ok: true; result: DaemonStatus | DaemonShutdownResult | RunDetails | DaemonControlResult }
  | { ok: false; error: { code: DaemonErrorCode; message: string } };

const DAEMON_ERROR_CODES = ["INVALID_REQUEST", "RUN_NOT_FOUND", "RUN_NOT_CONTROLLABLE", "CONTROL_CONFLICT", "EXECUTION_UNAVAILABLE", "STORE_BUSY", "STORE_ERROR", "INTERNAL_ERROR"] as const;

export type DaemonErrorCode = (typeof DAEMON_ERROR_CODES)[number];

export type DaemonShutdownResult = {
  status: "shutdown";
};

export class DaemonRequestError extends Error {
  constructor(readonly code: DaemonErrorCode, message: string) {
    super(message);
  }
}

export type DaemonServerHandle = {
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

export async function startDaemonServer(cwd: string, handlers: DaemonHandlers): Promise<DaemonServerHandle> {
  const endpoint = daemonEndpoint(cwd);
  if (isFilesystemSocket(endpoint)) {
    await mkdir(dirname(endpoint), { recursive: true });
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
    await listen(server, endpoint);
  } catch (error) {
    if (!isFilesystemSocket(endpoint) || !isAddressInUse(error)) throw error;
    await recoverStaleFilesystemSocket(cwd, endpoint, server, error);
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

export async function requestDaemonControl(cwd: string, control: DaemonControlIntent): Promise<DaemonControlResult> {
  const response = await requestDaemon(cwd, { method: "control", control });
  if (!response.ok) throw new DaemonRequestError(response.error.code, response.error.message);
  if (!isDaemonControlResult(response.result)) throw new Error("Daemon returned an invalid control response.");
  return response.result;
}

export async function requestDaemonAdmitRun(cwd: string, input: DaemonAdmitRunInput): Promise<RunDetails> {
  const response = await requestDaemon(cwd, { ...input, method: "admitRun" });
  if (!response.ok) throw new DaemonRequestError(response.error.code, response.error.message);
  if (!isRunDetails(response.result)) throw new Error("Daemon returned an invalid admitRun response.");
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
    const timeoutMs = request.method === "admitRun" ? undefined : request.method === "control" ? 30_000 : 1_000;
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
        const response = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        if (!isDaemonResponse(response)) throw new Error("Daemon returned an invalid response.");
        resolveRequest(response);
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
  control(intent: DaemonControlIntent): Promise<DaemonControlResult>;
  shutdown(): Promise<DaemonShutdownResult> | DaemonShutdownResult;
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
    if (request.method === "admitRun") return appliedResponse(await handlers.admitRun(request));
    if (request.method === "control") return appliedResponse(await handlers.control(request.control));
    if (request.method === "shutdown") return appliedResponse(await handlers.shutdown());
    return appliedResponse(handlers.status());
  } catch (error) {
    const code = daemonRequestErrorCode(request, error);
    return failedResponse(code, error instanceof DaemonRequestError ? error.message : daemonFailureMessage(request, code));
  }
}

function appliedResponse(result: Exclude<DaemonResponse, { ok: false }>["result"]): DaemonResponse {
  return { ok: true, result };
}

function failedResponse(code: DaemonErrorCode, message: string): DaemonResponse {
  return { ok: false, error: { code, message } };
}

function describeRequest(request: DaemonRequest): string {
  if (request.method === "admitRun") return "run admission";
  if (request.method === "control") return `${request.control.type} control for run '${request.control.runId}'`;
  return request.method;
}

function daemonControlErrorCode(error: unknown): DaemonErrorCode {
  if (error instanceof DaemonRequestError) return error.code;
  if (isRuntimeStoreBusyError(error)) return "STORE_BUSY";
  return "RUN_NOT_CONTROLLABLE";
}

function daemonRequestErrorCode(request: DaemonRequest, error: unknown): DaemonErrorCode {
  if (error instanceof DaemonRequestError) return error.code;
  if (request.method === "status") return "INTERNAL_ERROR";
  if (request.method === "admitRun") return isRuntimeStoreBusyError(error) ? "STORE_BUSY" : "STORE_ERROR";
  return daemonControlErrorCode(error);
}

function daemonFailureMessage(request: DaemonRequest, code: DaemonErrorCode): string {
  if (code === "STORE_BUSY") return "Runtime store is busy. Retry the request.";
  if (request.method === "status") return "Daemon status is unavailable.";
  if (request.method === "admitRun") return "Run admission failed.";
  if (request.method === "control") return `Control '${request.control.type}' could not be applied to run '${request.control.runId}'.`;
  return "Daemon shutdown failed.";
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
  return typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string" && typeof (value as { status?: unknown }).status === "string";
}

function isDaemonControlResult(value: unknown): value is DaemonControlResult {
  return isPlainRecord(value)
    && hasExactKeys(value, ["run"], ["forkRunId"])
    && isRunDetails(value.run)
    && (value.forkRunId === undefined || typeof value.forkRunId === "string");
}

function isDaemonResponse(value: unknown): value is DaemonResponse {
  if (!isPlainRecord(value)) return false;
  if (value.ok === true) return hasExactKeys(value, ["ok", "result"]);
  if (value.ok !== false || !hasExactKeys(value, ["ok", "error"]) || !isPlainRecord(value.error)) return false;
  return hasExactKeys(value.error, ["code", "message"])
    && DAEMON_ERROR_CODES.includes(value.error.code as DaemonErrorCode)
    && typeof value.error.message === "string";
}

function isControlIntent(value: unknown): value is DaemonControlIntent {
  if (!isPlainRecord(value) || typeof value.requestId !== "string" || typeof value.type !== "string" || typeof value.runId !== "string") return false;
  if (value.type === "pause" || value.type === "resume") return hasExactKeys(value, ["requestId", "type", "runId"]);
  if (value.type === "retry" || value.type === "cancel") {
    return hasExactKeys(value, ["requestId", "type", "runId"], ["target"])
      && (value.target === undefined || typeof value.target === "string" && value.target.length > 0);
  }
  if (value.type === "signal") {
    return hasExactKeys(value, ["requestId", "type", "runId", "nodeId", "payload"])
      && typeof value.nodeId === "string"
      && isJsonValue(value.payload);
  }
  if (value.type !== "fork"
    || !hasExactKeys(value, ["requestId", "type", "runId"], ["target", "prepared", "input", "agentOverrides", "unsafeReuse"])) return false;
  return (value.target === undefined || typeof value.target === "string" && value.target.length > 0)
    && (value.prepared === undefined || isPreparedRunWorkflow(value.prepared))
    && (value.input === undefined || isJsonValue(value.input))
    && (value.agentOverrides === undefined || isPlainRecord(value.agentOverrides))
    && (value.unsafeReuse === undefined || typeof value.unsafeReuse === "boolean");
}

function isAdmitRunRequest(value: Record<string, unknown>): value is DaemonAdmitRunRequest {
  return value.method === "admitRun"
    && hasExactKeys(value, ["method", "prepared", "input"], ["agentOverrides"])
    && isPreparedRunWorkflow(value.prepared)
    && hasOwn(value, "input")
    && isJsonValue(value.input)
    && (value.agentOverrides === undefined || isPlainRecord(value.agentOverrides));
}

function isPreparedRunWorkflow(value: unknown): value is PreparedRunWorkflow {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ["workflowPath", "ir", "irJson", "sourceGraphDigest", "lock"], ["packageLockDigest"])) return false;
  const ir = value.ir;
  return typeof value.workflowPath === "string"
    && isPlainRecord(ir)
    && typeof ir.name === "string"
    && isPlainRecord(ir.root)
    && typeof value.irJson === "string"
    && typeof value.sourceGraphDigest === "string"
    && (value.packageLockDigest === undefined || typeof value.packageLockDigest === "string")
    && isRunWorkflowLockArtifact(value.lock);
}

function isRunWorkflowLockArtifact(value: unknown): boolean {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ["kind", "version", "workflow", "ir", "sourceGraphDigest"], ["packageLockDigest"])
    || value.kind !== "acpus_workflow_preparation_lock"
    || value.version !== 1
    || typeof value.sourceGraphDigest !== "string"
    || (value.packageLockDigest !== undefined && typeof value.packageLockDigest !== "string")
    || !isPlainRecord(value.workflow)
    || !hasExactKeys(value.workflow, ["entry", "sourceDigest"])
    || typeof value.workflow.entry !== "string"
    || typeof value.workflow.sourceDigest !== "string"
    || !isPlainRecord(value.ir)
    || !hasExactKeys(value.ir, ["path", "digest"])
    || value.ir.path !== "workflow.ir.json"
    || typeof value.ir.digest !== "string") return false;
  return true;
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

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key));
}

async function hasLiveDaemon(cwd: string): Promise<boolean> {
  try {
    await requestDaemon(cwd, { method: "status" });
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
