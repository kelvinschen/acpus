import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { err, ok, type Result } from "neverthrow";
import {
  AcpxAgentResolutionSystemError,
  resolveAcpxAgentLaunch,
  type AcpxAgentLaunch,
  type AcpxAgentResolutionFailure,
} from "./acpx-agent-resolution.js";
import {
  finishAcpOwnership,
  writeAcpOwnershipManifest,
} from "./ownership.js";
import {
  processStartToken,
  PROCESS_TREE_CLEANUP_BUDGET_MS,
  stopProcessTree,
} from "./process-tree.js";
import type {
  AcpOwnershipManifest,
  AgentBackendFailure,
  AgentTurnProgress,
  AgentTurnRequest,
  AgentTurnResult,
  ManagedAcpAttempt,
  ManagedAcpAttemptInput,
  ManagedAcpExecutor,
  ManagedAcpExecutorOptions,
} from "./types.js";
import {
  ACP_WORKER_PROTOCOL_VERSION,
  isAcpWorkerChildMessage,
  type AcpWorkerChildMessage,
  type AcpWorkerParentMessage,
} from "./worker-protocol.js";

const WORKER_READY_TIMEOUT_MS = 5_000;
const COOPERATIVE_CLOSE_GRACE_MS = 1_000;
const WORKERS_DIRECTORY_MODE = 0o700;

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
  readonly starting: Set<Promise<Result<WorkerState, AcpxAgentResolutionFailure>>>;
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
      if (state.shuttingDown) return use(unavailableAttempt(workerLostFailure("ACP executor is shutting down.")));
      let worker: WorkerState | undefined;
      let handedToCaller = false;
      try {
        const starting = startWorker(state, input);
        state.starting.add(starting);
        try {
          const started = await starting;
          if (started.isErr()) {
            handedToCaller = true;
            return use(unavailableAttempt(configFailure(started.error)));
          }
          worker = started.value;
        } finally {
          state.starting.delete(starting);
        }
        if (state.shuttingDown) return use(unavailableAttempt(workerLostFailure("ACP executor is shutting down.")));
        handedToCaller = true;
        return await use({ runTurn: request => runWorkerTurn(worker!, request) });
      } catch (error) {
        if (handedToCaller || error instanceof AcpxAgentResolutionSystemError) throw error;
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

async function startWorker(
  state: ManagedAcpExecutorState,
  input: ManagedAcpAttemptInput,
): Promise<Result<WorkerState, AcpxAgentResolutionFailure>> {
  const resolved = await resolveAcpxAgentLaunch({ agent: input.agent, cwd: input.cwd, env: input.env });
  if (resolved.isErr()) return err(resolved.error);
  return ok(await startResolvedWorker(state, input, resolved.value));
}

async function startResolvedWorker(
  state: ManagedAcpExecutorState,
  input: ManagedAcpAttemptInput,
  resolvedLaunch: AcpxAgentLaunch,
): Promise<WorkerState> {
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
    await writeAcpOwnershipManifest(manifestPath, manifest);
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
      resolvedLaunch,
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
  const alive = await stopProcessTree(
    child.pid,
    performance.now() + PROCESS_TREE_CLEANUP_BUDGET_MS,
  );
  if (!manifestPath || !manifest) return;
  await finishAcpOwnership(options, manifestPath, manifest, alive, reason);
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
    active.lastProgress = {
      ...message.observation.progress,
      responses: [...message.observation.progress.responses],
    };
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
    await finishAcpOwnership(state.options, worker.manifestPath, worker.manifest, alive, reason);
  } finally {
    state.workers.delete(worker.workerId);
  }
}

function unavailableAttempt(failure: AgentBackendFailure | string): ManagedAcpAttempt {
  const normalized = typeof failure === "string" ? workerLostFailure(failure) : failure;
  return { runTurn: async () => failedWithoutWorker(normalized) };
}

function workerLostResult(worker: WorkerState, message: string): AgentTurnResult {
  return failedWithoutWorker(workerLostFailure(message), worker.active);
}

function failedWithoutWorker(failure: AgentBackendFailure, active?: ActiveTurn): AgentTurnResult {
  const timing = resultTiming(active);
  return {
    status: "failed",
    failure,
    responses: partialResponses(active),
    stderr: "",
    summary: active?.lastProgress?.summary ?? emptySummary(),
    timing,
  };
}

function workerLostFailure(message: string): AgentBackendFailure {
  return { kind: "worker_lost", origin: "runtime", retryable: true, message };
}

function configFailure(failure: AcpxAgentResolutionFailure): AgentBackendFailure {
  return { kind: "config", origin: "runtime", retryable: false, message: failure.message };
}

function cancelledResult(active: ActiveTurn): AgentTurnResult {
  return {
    status: "cancelled",
    message: "Agent turn was aborted.",
    responses: partialResponses(active),
    stderr: "",
    summary: active.lastProgress?.summary ?? emptySummary(),
    timing: resultTiming(active),
  };
}

function timeoutResult(active: ActiveTurn): AgentTurnResult {
  return {
    status: "failed",
    failure: { kind: "timeout", origin: "runtime", message: "Agent turn exceeded its authored timeout." },
    responses: partialResponses(active),
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
    responses: partialResponses(active),
    stderr: "",
    summary: active.lastProgress?.summary ?? emptySummary(),
    timing: resultTiming(active),
  };
}

function partialResponses(active: ActiveTurn | undefined): readonly string[] {
  return [...(active?.lastProgress?.responses ?? [])];
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
  const deadline = performance.now() + PROCESS_TREE_CLEANUP_BUDGET_MS;
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
  return stopProcessTree(worker.manifest.worker.pid, deadline);
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

function remaining(deadline: number): number {
  return Math.max(0, Math.floor(deadline - performance.now()));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
