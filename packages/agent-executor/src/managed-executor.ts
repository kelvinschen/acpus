import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type {
  AcpOwnershipHealth,
  AcpOwnershipManifest,
  AgentBackendFailure,
  AgentTurnProgress,
  AgentTurnRequest,
  AgentTurnResult,
  ManagedAcpAttempt,
  ManagedAcpAttemptInput,
  ManagedAcpExecutor,
} from "./types.js";
import {
  ACP_WORKER_PROTOCOL_VERSION,
  isAcpWorkerChildMessage,
  type AcpWorkerChildMessage,
  type AcpWorkerParentMessage,
} from "./worker-protocol.js";

const WORKER_READY_TIMEOUT_MS = 5_000;
const CLEANUP_BUDGET_MS = 5_000;
const COOPERATIVE_CLOSE_GRACE_MS = 1_000;
const TERM_GRACE_MS = 1_000;
const MANIFEST_MODE = 0o600;
const WORKERS_DIRECTORY_MODE = 0o700;

export type ManagedAcpExecutorOptions = {
  workersRoot: string;
  sessionStateDirectoryForRun(runId: string): string;
  daemon: { generation: string | number; pid?: number };
  onDegraded?: (manifest: AcpOwnershipManifest) => void;
};

export type AcpOwnershipInspectionInput = {
  workersRoot: string;
  daemon?: { generation: string | number; pid?: number };
};

type WorkerState = {
  workerId: string;
  input: ManagedAcpAttemptInput;
  child: ChildProcess;
  manifest: AcpOwnershipManifest;
  manifestPath: string;
  ready: Promise<void>;
  settleReady: (error?: Error) => void;
  closed: Promise<void>;
  settleClosed: () => void;
  active?: ActiveTurn;
  cleaning?: Promise<void>;
};

type ActiveTurn = {
  turnId: string;
  startedAt: string;
  startedAtMonotonic: number;
  resolve(result: AgentTurnResult): void;
  request: AgentTurnRequest;
  lastProgress?: AgentTurnProgress;
  silence?: {
    startedAt: string;
    startedAtMonotonic: number;
    timer?: ReturnType<typeof setTimeout>;
  };
  timeout?: ReturnType<typeof setTimeout>;
  abort: () => void;
  settled: boolean;
};

type ManagedAcpExecutorState = {
  readonly options: ManagedAcpExecutorOptions;
  readonly daemon: { pid: number; startToken?: string; generation: string };
  readonly workers: Map<string, WorkerState>;
  readonly starting: Set<Promise<WorkerState>>;
  shuttingDown: boolean;
};

/** Creates the daemon-owned executor. Each call to withAttempt owns one worker tree. */
export async function createManagedAcpExecutor(options: ManagedAcpExecutorOptions): Promise<ManagedAcpExecutor> {
  const pid = options.daemon.pid ?? process.pid;
  const startToken = await processStartToken(pid);
  const daemon = {
    pid,
    ...(startToken === undefined ? {} : { startToken }),
    generation: String(options.daemon.generation),
  };
  const state: ManagedAcpExecutorState = { options, daemon, workers: new Map(), starting: new Set(), shuttingDown: false };
  return {
    withAttempt: async <T>(input: ManagedAcpAttemptInput, use: (attempt: ManagedAcpAttempt) => Promise<T>): Promise<T> => {
      if (state.shuttingDown) return use(unavailableAttempt("ACP executor is shutting down."));
      let worker: WorkerState | undefined;
      try {
        const starting = startWorker(state, input);
        state.starting.add(starting);
        try {
          worker = await starting;
        } finally {
          state.starting.delete(starting);
        }
        if (state.shuttingDown) return use(unavailableAttempt("ACP executor is shutting down."));
        return await use({ runTurn: request => runWorkerTurn(worker!, request) });
      } catch (error) {
        if (!worker) return use(unavailableAttempt(errorMessage(error)));
        throw error;
      } finally {
        if (worker) await cleanupWorker(state, worker, "attempt settled");
      }
    },
    shutdown: async (): Promise<void> => {
      state.shuttingDown = true;
      await Promise.allSettled([...state.starting]);
      await Promise.all([...state.workers.values()].map(worker => cleanupWorker(state, worker, "daemon shutdown")));
    },
  };
}

/** Reads residual ownership evidence without creating, changing, or signalling anything. */
export async function inspectAcpOwnership(input: AcpOwnershipInspectionInput): Promise<AcpOwnershipHealth> {
  const manifests = await readOwnershipManifests(input.workersRoot);
  const current = input.daemon && {
    pid: input.daemon.pid ?? process.pid,
    generation: String(input.daemon.generation),
  };
  let degraded = 0;
  let orphaned = 0;
  const records: AcpOwnershipHealth["manifests"] = [];
  for (const manifest of manifests) {
    if (manifest.state === "degraded") {
      degraded += 1;
      records.push(manifestReference(manifest));
      continue;
    }
    const belongsToCurrentDaemon = current !== undefined
      && manifest.daemon.pid === current.pid
      && manifest.daemon.generation === current.generation;
    const workerLiveness = await matchesProcessStartToken(manifest.worker.pid, manifest.worker.startToken);
    if (!belongsToCurrentDaemon || workerLiveness === false) {
      orphaned += 1;
      records.push(manifestReference(manifest));
    }
  }
  return { degraded, orphaned, manifests: records.slice(0, 12) };
}

/** Performs the single bounded daemon-startup sweep for the current workspace. */
export async function recoverAcpOwnership(input: ManagedAcpExecutorOptions): Promise<void> {
  const manifests = await readOwnershipManifestFiles(input.workersRoot);
  const deadline = performance.now() + CLEANUP_BUDGET_MS;
  for (const entry of manifests) {
    await recoverManifest(input, entry, deadline).catch(() => {});
  }
}

async function recoverManifest(
  input: ManagedAcpExecutorOptions,
  entry: { path: string; manifest: AcpOwnershipManifest },
  deadline: number,
): Promise<void> {
  const { manifest, path } = entry;
  const liveness = await matchesProcessStartToken(manifest.worker.pid, manifest.worker.startToken);
  if (liveness === false) {
    await removeManifest(path);
    return;
  }
  if (liveness !== true || performance.now() >= deadline) return;
  const alive = await stopKnownTree(manifest.worker.pid, deadline);
  if (alive) await markDegraded(input, path, manifest, "startup recovery");
  else await removeManifest(path);
}

async function startWorker(state: ManagedAcpExecutorState, input: ManagedAcpAttemptInput): Promise<WorkerState> {
  await Promise.all([
    mkdir(state.options.workersRoot, { recursive: true, mode: WORKERS_DIRECTORY_MODE }),
    mkdir(state.options.sessionStateDirectoryForRun(input.runId), { recursive: true, mode: WORKERS_DIRECTORY_MODE }),
  ]);
  const workerId = `acp_worker_${randomUUID()}`;
  const child = spawn(process.execPath, workerEntryArgs(), {
    detached: process.platform !== "win32",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: safeWorkerEnvironment(),
  });
  let earlyError: Error | undefined;
  let closedEarly = false;
  let onChildError = (error: Error): void => { earlyError = error; };
  let onChildClose = (): void => { closedEarly = true; };
  child.on("error", error => onChildError(error));
  child.on("close", () => onChildClose());
  let manifest: AcpOwnershipManifest | undefined;
  let manifestPath: string | undefined;
  let worker: WorkerState | undefined;
  try {
    if (child.pid === undefined) throw new Error("ACP worker process did not provide a pid.");
    const workerStartToken = await processStartToken(child.pid);
    if (earlyError) throw earlyError;
    if (closedEarly) throw new Error("ACP worker exited before initialization.");
    manifest = {
      schemaVersion: 1,
      workerId,
      runId: input.runId,
      attemptId: input.attemptId,
      sessionName: input.sessionName,
      daemon: state.daemon,
      worker: {
        pid: child.pid,
        ...(workerStartToken === undefined ? {} : { startToken: workerStartToken }),
        ...(process.platform === "win32" ? {} : { pgid: child.pid }),
      },
      state: "active",
      createdAt: new Date().toISOString(),
    };
    manifestPath = join(state.options.workersRoot, `${workerId}.json`);
    await writeManifest(manifestPath, manifest);
    if (earlyError) throw earlyError;
    if (closedEarly) throw new Error("ACP worker exited before initialization.");
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    let closedResolve!: () => void;
    const closed = new Promise<void>(resolve => {
      closedResolve = resolve;
    });
    worker = {
      workerId,
      input,
      child,
      manifest,
      manifestPath,
      ready,
      settleReady: error => error ? readyReject(error) : readyResolve(),
      closed,
      settleClosed: closedResolve,
    };
    const ownedWorker = worker;
    onChildError = error => {
      ownedWorker.settleReady(error);
      settleActive(ownedWorker, workerLostResult(ownedWorker, error.message));
    };
    onChildClose = () => {
      ownedWorker.settleClosed();
      ownedWorker.settleReady(new Error("ACP worker exited before becoming ready."));
      settleActive(ownedWorker, workerLostResult(ownedWorker, "ACP worker exited before returning a turn result."));
    };
    state.workers.set(workerId, worker);
    child.on("message", value => onWorkerMessage(ownedWorker, value));
    send(ownedWorker, {
      type: "initialize",
      protocolVersion: ACP_WORKER_PROTOCOL_VERSION,
      workerId,
      attemptId: input.attemptId,
      sessionStateDirectory: state.options.sessionStateDirectoryForRun(input.runId),
      cwd: input.cwd,
      env: input.env,
      agent: input.agent,
      permissionMode: input.permissionMode,
      ...(input.model === undefined ? {} : { model: input.model }),
    });
    await withTimeout(worker.ready, WORKER_READY_TIMEOUT_MS, "ACP worker did not initialize in time.");
    return worker;
  } catch (error) {
    if (worker) await cleanupWorker(state, worker, "worker initialization failed");
    else await cleanupUnmanagedWorker(child, manifestPath, manifest, state.options, "worker initialization failed").catch(() => {});
    throw error;
  }
}

async function cleanupUnmanagedWorker(
  child: ChildProcess,
  manifestPath: string | undefined,
  manifest: AcpOwnershipManifest | undefined,
  options: ManagedAcpExecutorOptions,
  reason: string,
): Promise<void> {
  if (child.pid === undefined) return;
  const alive = await stopKnownTree(child.pid, performance.now() + CLEANUP_BUDGET_MS);
  if (!manifestPath || !manifest) return;
  if (alive) await markDegraded(options, manifestPath, manifest, reason);
  else await removeManifest(manifestPath);
}

function onWorkerMessage(worker: WorkerState, value: unknown): void {
  if (!isAcpWorkerChildMessage(value) || value.workerId !== worker.workerId || value.attemptId !== worker.input.attemptId) {
    worker.settleReady(new Error("ACP worker sent an invalid IPC message."));
    settleActive(worker, workerLostResult(worker, "ACP worker sent an invalid IPC message."));
    return;
  }
  const message = value as AcpWorkerChildMessage;
  if (message.type === "ready") {
    worker.settleReady();
    return;
  }
  if (message.type === "closed") {
    worker.settleClosed();
    return;
  }
  if (message.type === "worker-failure") {
    worker.settleReady(new Error(message.message));
    settleActive(worker, workerLostResult(worker, message.message));
    return;
  }
  const active = worker.active;
  if (!active || active.turnId !== message.turnId || active.settled) return;
  if (message.type === "acp-activity") {
    noteActivity(worker, active, message.observedAt);
    return;
  }
  if (message.type === "turn-observation") {
    active.lastProgress = message.observation.progress;
    notify(active.request.onProgress, message.observation.progress);
    notify(active.request.onObservation, message.observation);
    return;
  }
  settleActive(worker, message.result);
}

function runWorkerTurn(worker: WorkerState, request: AgentTurnRequest): Promise<AgentTurnResult> {
  if (worker.active) return Promise.resolve(workerLostResult(worker, "ACP worker already has an active turn."));
  if (!worker.child.connected) return Promise.resolve(workerLostResult(worker, "ACP worker IPC is closed."));
  return new Promise(resolve => {
    const turnId = `turn_${randomUUID()}`;
    const active: ActiveTurn = {
      turnId,
      startedAt: new Date().toISOString(),
      startedAtMonotonic: performance.now(),
      request,
      resolve,
      abort: () => {
        if (active.settled) return;
        send(worker, {
          type: "abort-turn",
          protocolVersion: ACP_WORKER_PROTOCOL_VERSION,
          workerId: worker.workerId,
          attemptId: worker.input.attemptId,
          turnId,
          reason: "aborted",
        });
        settleActive(worker, cancelledResult(active));
      },
      settled: false,
    };
    worker.active = active;
    noteActivity(worker, active, active.startedAt);
    if (request.timeoutMs !== undefined) {
      active.timeout = setTimeout(() => {
        if (active.settled) return;
        sendAbort(worker, active, "timeout");
        settleActive(worker, timeoutResult(active));
      }, request.timeoutMs);
    }
    request.signal?.addEventListener("abort", active.abort, { once: true });
    if (request.signal?.aborted) {
      active.abort();
      return;
    }
    const { signal: _signal, onProgress: _onProgress, onObservation: _onObservation, ...workerRequest } = request;
    send(worker, {
      type: "run-turn",
      protocolVersion: ACP_WORKER_PROTOCOL_VERSION,
      workerId: worker.workerId,
      attemptId: worker.input.attemptId,
      turnId,
      request: workerRequest,
    });
  });
}

function noteActivity(worker: WorkerState, active: ActiveTurn, observedAt: string): void {
  const startedAtMonotonic = performance.now();
  if (active.silence?.timer) clearTimeout(active.silence.timer);
  const silence: NonNullable<ActiveTurn["silence"]> = { startedAt: observedAt, startedAtMonotonic };
  active.silence = silence;
  notify(worker.input.onAcpActivity, observedAt);
  const failAfterMs = worker.input.inactivityFailAfterMs;
  if (failAfterMs === undefined) return;
  silence.timer = setTimeout(() => {
    if (active.settled || active.silence !== silence) return;
    sendAbort(worker, active, "inactivity");
    settleActive(worker, staleResult(active, failAfterMs));
  }, failAfterMs);
}

function sendAbort(worker: WorkerState, active: ActiveTurn, reason: "timeout" | "inactivity"): void {
  send(worker, {
    type: "abort-turn",
    protocolVersion: ACP_WORKER_PROTOCOL_VERSION,
    workerId: worker.workerId,
    attemptId: worker.input.attemptId,
    turnId: active.turnId,
    reason,
  });
}

function settleActive(worker: WorkerState, result: AgentTurnResult): void {
  const active = worker.active;
  if (!active || active.settled) return;
  active.settled = true;
  if (active.timeout) clearTimeout(active.timeout);
  if (active.silence?.timer) clearTimeout(active.silence.timer);
  active.request.signal?.removeEventListener("abort", active.abort);
  delete worker.active;
  active.resolve(result);
}

async function cleanupWorker(state: ManagedAcpExecutorState, worker: WorkerState, reason: string): Promise<void> {
  if (worker.cleaning) return worker.cleaning;
  worker.cleaning = cleanupWorkerValue(state, worker, reason).catch(() => {});
  return worker.cleaning;
}

async function cleanupWorkerValue(state: ManagedAcpExecutorState, worker: WorkerState, reason: string): Promise<void> {
  try {
    const alive = await stopWorkerTree(worker, reason);
    if (alive) await markDegraded(state.options, worker.manifestPath, worker.manifest, reason);
    else await removeManifest(worker.manifestPath);
  } finally {
    state.workers.delete(worker.workerId);
  }
}

function unavailableAttempt(message: string): ManagedAcpAttempt {
  return { runTurn: async () => failedWithoutWorker("worker_lost", message) };
}

function workerLostResult(worker: WorkerState, message: string): AgentTurnResult {
  return failedWithoutWorker("worker_lost", message, worker.active);
}

function failedWithoutWorker(kind: AgentBackendFailure["kind"], message: string, active?: ActiveTurn): AgentTurnResult {
  const timing = resultTiming(active);
  return {
    status: "failed",
    failure: { kind, origin: "runtime", retryable: true, message },
    responseText: active?.lastProgress?.responseText ?? "",
    stderr: "",
    summary: active?.lastProgress?.summary ?? emptySummary(),
    timing,
  };
}

function cancelledResult(active: ActiveTurn): AgentTurnResult {
  return {
    status: "cancelled",
    message: "Agent turn was aborted.",
    responseText: active.lastProgress?.responseText ?? "",
    stderr: "",
    summary: active.lastProgress?.summary ?? emptySummary(),
    timing: resultTiming(active),
  };
}

function timeoutResult(active: ActiveTurn): AgentTurnResult {
  return {
    status: "failed",
    failure: { kind: "timeout", origin: "runtime", message: "Agent turn exceeded its authored timeout." },
    responseText: active.lastProgress?.responseText ?? "",
    stderr: "",
    summary: active.lastProgress?.summary ?? emptySummary(),
    timing: resultTiming(active),
  };
}

function staleResult(active: ActiveTurn, failAfterMs: number): AgentTurnResult {
  const silence = active.silence;
  const silentForMs = silence ? Math.max(0, Math.round(performance.now() - silence.startedAtMonotonic)) : failAfterMs;
  return {
    status: "failed",
    failure: {
      kind: "inactivity_stale",
      origin: "runtime",
      retryable: true,
      message: "ACP agent was silent for the configured inactivity limit.",
      evidence: {
        failAfterMs,
        silentForMs,
        silenceStartedAt: silence?.startedAt ?? active.startedAt,
      },
    },
    responseText: active.lastProgress?.responseText ?? "",
    stderr: "",
    summary: active.lastProgress?.summary ?? emptySummary(),
    timing: resultTiming(active),
  };
}

function emptySummary() {
  return {
    eventCount: 0,
    availability: { context: "unavailable" as const, tokenUsage: "unavailable" as const },
    tools: { totalToolCallCount: 0, calls: [] },
  };
}

function resultTiming(active: ActiveTurn | undefined) {
  const startedAt = active?.startedAt ?? new Date().toISOString();
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs: active === undefined ? 0 : Math.max(0, Math.round(performance.now() - active.startedAtMonotonic)),
  };
}

function send(worker: WorkerState, message: AcpWorkerParentMessage): void {
  if (!worker.child.connected) return;
  worker.child.send(message, error => {
    if (!error) return;
    settleActive(worker, workerLostResult(worker, `ACP worker IPC failed: ${error.message}`));
  });
}

function notify<T>(callback: ((value: T) => unknown) | undefined, value: T): void {
  try {
    callback?.(value);
  } catch {
    // Observability callbacks must not control process ownership or turn settlement.
  }
}

function workerEntryArgs(): string[] {
  const sourceMode = fileURLToPath(import.meta.url).endsWith(".ts");
  const entry = fileURLToPath(new URL(`./worker-entry.${sourceMode ? "ts" : "js"}`, import.meta.url));
  return sourceMode ? ["--import", import.meta.resolve("tsx"), entry] : [entry];
}

function safeWorkerEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_OPTIONS" && key !== "NODE_PATH"));
}

async function stopWorkerTree(worker: WorkerState, reason: string): Promise<boolean> {
  const deadline = performance.now() + CLEANUP_BUDGET_MS;
  if (worker.active) {
    send(worker, {
      type: "abort-turn",
      protocolVersion: ACP_WORKER_PROTOCOL_VERSION,
      workerId: worker.workerId,
      attemptId: worker.input.attemptId,
      turnId: worker.active.turnId,
      reason: "aborted",
    });
    settleActive(worker, cancelledResult(worker.active));
  }
  send(worker, {
    type: "close-attempt",
    protocolVersion: ACP_WORKER_PROTOCOL_VERSION,
    workerId: worker.workerId,
    attemptId: worker.input.attemptId,
    reason,
  });
  await settleWithin(worker.closed, Math.min(COOPERATIVE_CLOSE_GRACE_MS, remaining(deadline)));
  return stopKnownTree(worker.manifest.worker.pid, deadline);
}

async function stopKnownTree(pid: number, deadline: number): Promise<boolean> {
  if (!await treeAlive(pid)) return false;
  terminateKnownTree(pid, "SIGTERM");
  await waitForTreeDeath(pid, Math.min(TERM_GRACE_MS, remaining(deadline)));
  if (!await treeAlive(pid)) return false;
  terminateKnownTree(pid, "SIGKILL");
  await waitForTreeDeath(pid, remaining(deadline));
  return await treeAlive(pid);
}

async function markDegraded(
  options: ManagedAcpExecutorOptions,
  path: string,
  manifest: AcpOwnershipManifest,
  reason: string,
): Promise<void> {
  const degraded = withCleanup(manifest, reason);
  await writeManifest(path, degraded).catch(() => {});
  notify(options.onDegraded, degraded);
}

function terminateKnownTree(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], { stdio: "ignore" }).unref();
      return;
    }
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

async function processAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
    return code === "EPERM";
  }
}

async function treeAlive(pid: number): Promise<boolean> {
  if (process.platform === "win32") return processAlive(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
    return code === "EPERM";
  }
}

async function matchesProcessStartToken(pid: number, expected: string | undefined): Promise<boolean | undefined> {
  if (expected === undefined) return await processAlive(pid) ? undefined : false;
  const actual = await processStartToken(pid);
  if (actual === undefined) return await processAlive(pid) ? undefined : false;
  return actual === expected;
}

async function processStartToken(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).trim().split(/\s+/u);
    const startTime = fields[19];
    return startTime ? `linux:${startTime}` : undefined;
  } catch {
    return undefined;
  }
}

async function readOwnershipManifests(workersRoot: string): Promise<AcpOwnershipManifest[]> {
  return (await readOwnershipManifestFiles(workersRoot)).map(entry => entry.manifest);
}

async function readOwnershipManifestFiles(workersRoot: string): Promise<Array<{ path: string; manifest: AcpOwnershipManifest }>> {
  let names: string[];
  try {
    names = await readdir(workersRoot);
  } catch (error) {
    if (isMissing(error)) return [];
    return [];
  }
  const files = names.filter(name => /^acp_worker_[0-9a-f-]+\.json$/u.test(name)).sort();
  const parsed = await Promise.all(files.map(async name => {
    const path = join(workersRoot, name);
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as unknown;
      return validManifest(value) ? { path, manifest: value } : undefined;
    } catch {
      return undefined;
    }
  }));
  return parsed.filter((entry): entry is { path: string; manifest: AcpOwnershipManifest } => entry !== undefined);
}

async function writeManifest(path: string, manifest: AcpOwnershipManifest): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", mode: MANIFEST_MODE });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function removeManifest(path: string): Promise<void> {
  await unlink(path).catch(error => {
    if (!isMissing(error)) throw error;
  });
}

function validManifest(value: unknown): value is AcpOwnershipManifest {
  if (!record(value)) return false;
  const manifest = value as Record<string, unknown>;
  return manifest.schemaVersion === 1
    && typeof manifest.workerId === "string"
    && typeof manifest.runId === "string"
    && typeof manifest.attemptId === "string"
    && typeof manifest.sessionName === "string"
    && daemonIdentity(manifest.daemon)
    && workerIdentity(manifest.worker)
    && (manifest.state === "active" || manifest.state === "degraded");
}

function daemonIdentity(value: unknown): value is { pid: number; startToken?: string; generation: string } {
  if (!record(value) || !positiveProcessId(value.pid)) return false;
  return typeof value.generation === "string"
    && (value.startToken === undefined || typeof value.startToken === "string");
}

function workerIdentity(value: unknown): value is { pid: number; startToken?: string; pgid?: number } {
  if (!record(value) || !positiveProcessId(value.pid)) return false;
  return (value.startToken === undefined || typeof value.startToken === "string")
    && (value.pgid === undefined || positiveProcessId(value.pgid));
}

function positiveProcessId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function withCleanup(manifest: AcpOwnershipManifest, reason: string): AcpOwnershipManifest {
  return {
    ...manifest,
    state: "degraded",
    cleanup: { attemptedAt: new Date().toISOString(), reason },
  };
}

function manifestReference(manifest: AcpOwnershipManifest) {
  return { workerId: manifest.workerId, runId: manifest.runId, attemptId: manifest.attemptId, state: manifest.state };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function settleWithin(promise: Promise<void>, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) return;
  await withTimeout(promise, timeoutMs, "cleanup wait elapsed").catch(() => {});
}

async function waitForTreeDeath(pid: number, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline && await treeAlive(pid)) {
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - performance.now()))));
  }
}

function remaining(deadline: number): number {
  return Math.max(0, Math.floor(deadline - performance.now()));
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
