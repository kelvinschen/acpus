import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { err, ok, type Result } from "neverthrow";
import {
  AcpAgentResolutionSystemError,
  resolveAcpAgentLaunch,
  type AcpAgentResolutionFailure,
} from "./agent-resolution.js";
import {
  finishAcpOwnership,
  writeAcpOwnershipManifest,
} from "./ownership.js";
import { normalizeAcpExecutorOwner, type AcpExecutorOwnerIdentity } from "./owner.js";
import {
  processStartToken,
  PROCESS_TREE_CLEANUP_BUDGET_MS,
  stopProcessTree,
} from "./process-tree.js";
import type {
  AcpOwnershipManifest,
  AgentBackendFailure,
  AcpAgentLaunch,
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

const WORKER_BOOTSTRAP_TIMEOUT_MS = 5_000;
const COOPERATIVE_CLOSE_GRACE_MS = 4_000;
const WORKERS_DIRECTORY_MODE = 0o700;
const INHERIT_PROCESS_GROUP_ENV = "ACPUS_INTERNAL_ACP_INHERIT_PROCESS_GROUP";

class WorkerReportedFailure extends Error {
  constructor(readonly failure: AgentBackendFailure) {
    super(failure.message);
    this.name = "WorkerReportedFailure";
  }
}

type WorkerState = {
  workerId: string;
  input: ManagedAcpAttemptInput;
  child: ChildProcess;
  manifest: AcpOwnershipManifest;
  manifestPath: string;
  phase: "bootstrapping" | "opening" | "ready" | "stopping" | "closed";
  openStarted: Promise<void>;
  settleOpenStarted: (error?: Error) => void;
  ready: Promise<void>;
  settleReady: (error?: Error) => void;
  closed: Promise<void>;
  settleClosed: () => void;
  cancelled?: string;
  terminalFailure?: AgentBackendFailure;
  active?: ActiveTurn;
  cleaning?: Promise<void>;
};

type WorkerStartUnavailable =
  | { status: "failed"; failure: AgentBackendFailure }
  | { status: "cancelled"; message: string };

type StartupSlot = {
  input: ManagedAcpAttemptInput;
  started?: Promise<Result<WorkerState, WorkerStartUnavailable>>;
  worker?: WorkerState;
  stopped?: string;
  stopPromise?: Promise<void>;
};

type ActiveTurn = {
  turnId: string;
  startedAt: string;
  startedAtMonotonic: number;
  resolve(result: AgentTurnResult): void;
  request: AgentTurnRequest;
  signal?: AbortSignal;
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
  readonly owner: AcpExecutorOwnerIdentity;
  readonly workers: Map<string, WorkerState>;
  readonly attempts: Set<StartupSlot>;
  shuttingDown: boolean;
};

/** Creates the managed executor. Each call to withAttempt owns one worker tree. */
export async function createManagedAcpExecutor(options: ManagedAcpExecutorOptions): Promise<ManagedAcpExecutor> {
  const owner = await normalizeAcpExecutorOwner(options.owner);
  const state: ManagedAcpExecutorState = { options, owner, workers: new Map(), attempts: new Set(), shuttingDown: false };
  return {
    withAttempt: async <T>(input: ManagedAcpAttemptInput, use: (attempt: ManagedAcpAttempt) => Promise<T>): Promise<T> => {
      if (state.shuttingDown) return use(unavailableAttempt(workerLostFailure("ACP executor is shutting down.")));
      const slot: StartupSlot = { input };
      state.attempts.add(slot);
      const onAbort = (): void => requestStop(state, slot, "attempt cancelled");
      input.signal?.addEventListener("abort", onAbort, { once: true });
      if (input.signal?.aborted) onAbort();
      let worker: WorkerState | undefined;
      let handedToCaller = false;
      try {
        slot.started = startWorker(state, slot);
        const started = await slot.started;
        if (started.isErr()) {
          handedToCaller = true;
          return use(unavailableAttempt(started.error));
        }
        worker = started.value;
        if (slot.stopped || state.shuttingDown || input.signal?.aborted) {
          handedToCaller = true;
          return use(unavailableAttempt(cancelledStart(slot.stopped ?? "attempt cancelled")));
        }
        handedToCaller = true;
        return await use({ runTurn: request => runWorkerTurn(worker!, request) });
      } catch (error) {
        if (handedToCaller || error instanceof AcpAgentResolutionSystemError) throw error;
        if (!worker) return use(unavailableAttempt(errorMessage(error)));
        throw error;
      } finally {
        input.signal?.removeEventListener("abort", onAbort);
        if (worker) await cleanupWorker(state, worker, "attempt settled");
        state.attempts.delete(slot);
      }
    },
    shutdown: async (): Promise<void> => {
      state.shuttingDown = true;
      const attempts = [...state.attempts];
      for (const slot of attempts) requestStop(state, slot, "executor shutdown");
      await Promise.allSettled(attempts.flatMap(slot => slot.started ? [slot.started] : []));
      await Promise.all([...state.workers.values()].map(worker => cleanupWorker(state, worker, "executor shutdown")));
    },
  };
}

async function startWorker(
  state: ManagedAcpExecutorState,
  slot: StartupSlot,
): Promise<Result<WorkerState, WorkerStartUnavailable>> {
  const { input } = slot;
  if (slot.stopped || input.signal?.aborted || state.shuttingDown) {
    return err(cancelledStart(slot.stopped ?? "attempt cancelled"));
  }
  const resolved = await resolveAcpAgentLaunch({
    agent: input.agent,
    cwd: input.cwd,
    env: input.env,
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(state.options.namedAgentLaunches === undefined
      ? {}
      : { namedAgentLaunches: state.options.namedAgentLaunches }),
  });
  if (resolved.isErr()) return err({ status: "failed", failure: configFailure(resolved.error) });
  if (slot.stopped || input.signal?.aborted || state.shuttingDown) {
    return err(cancelledStart(slot.stopped ?? "attempt cancelled"));
  }
  try {
    return ok(await startResolvedWorker(state, slot, resolved.value));
  } catch (error) {
    if (error instanceof WorkerReportedFailure) {
      return err({ status: "failed", failure: error.failure });
    }
    if (slot.stopped || input.signal?.aborted || state.shuttingDown) {
      return err(cancelledStart(slot.stopped ?? "attempt cancelled"));
    }
    throw error;
  }
}

async function startResolvedWorker(
  state: ManagedAcpExecutorState,
  slot: StartupSlot,
  resolvedLaunch: AcpAgentLaunch,
): Promise<WorkerState> {
  const { input } = slot;
  await Promise.all([
    mkdir(state.options.workersRoot, { recursive: true, mode: WORKERS_DIRECTORY_MODE }),
    mkdir(state.options.sessionStateDirectoryForRun(input.runId), { recursive: true, mode: WORKERS_DIRECTORY_MODE }),
  ]);
  if (slot.stopped || input.signal?.aborted || state.shuttingDown) {
    throw new Error(slot.stopped ?? "attempt cancelled");
  }
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
      schemaVersion: 2,
      workerId,
      runId: input.runId,
      attemptId: input.attemptId,
      sessionName: input.sessionName,
      owner: state.owner,
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
    let openStartedResolve!: () => void;
    let openStartedReject!: (error: Error) => void;
    const openStarted = new Promise<void>((resolve, reject) => {
      openStartedResolve = resolve;
      openStartedReject = reject;
    });
    void openStarted.catch(() => undefined);
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    void ready.catch(() => undefined);
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
      phase: "bootstrapping",
      openStarted,
      settleOpenStarted: error => error ? openStartedReject(error) : openStartedResolve(),
      ready,
      settleReady: error => error ? readyReject(error) : readyResolve(),
      closed,
      settleClosed: closedResolve,
    };
    const ownedWorker: WorkerState = worker;
    slot.worker = ownedWorker;
    onChildError = error => {
      ownedWorker.settleOpenStarted(error);
      ownedWorker.settleReady(error);
      settleActive(ownedWorker, workerLostResult(ownedWorker, error.message));
    };
    onChildClose = () => {
      ownedWorker.phase = "closed";
      ownedWorker.settleClosed();
      ownedWorker.settleOpenStarted(new Error("ACP worker exited before acknowledging bootstrap."));
      ownedWorker.settleReady(new Error("ACP worker exited before becoming ready."));
      settleActive(ownedWorker, workerLostResult(ownedWorker, "ACP worker exited before returning a turn result."));
    };
    state.workers.set(workerId, ownedWorker);
    child.on("message", value => onWorkerMessage(state, ownedWorker, value));
    if (slot.stopped || input.signal?.aborted || state.shuttingDown) {
      requestStop(state, slot, slot.stopped ?? "attempt cancelled");
      throw new Error(slot.stopped ?? "attempt cancelled");
    }
    send(ownedWorker, {
      type: "initialize",
      protocolVersion: ACP_WORKER_PROTOCOL_VERSION,
      workerId,
      attemptId: input.attemptId,
      recordId: input.sessionName,
      sessionStateDirectory: state.options.sessionStateDirectoryForRun(input.runId),
      cwd: input.cwd,
      env: input.env,
      resolvedLaunch,
      permissionMode: input.permissionMode,
      ...(input.model === undefined ? {} : { model: input.model }),
    });
    await withTimeout(ownedWorker.openStarted, WORKER_BOOTSTRAP_TIMEOUT_MS, "ACP worker did not acknowledge bootstrap in time.");
    if (slot.stopped || input.signal?.aborted || state.shuttingDown) {
      throw new Error(slot.stopped ?? "attempt cancelled");
    }
    await ownedWorker.ready;
    if (slot.stopped || input.signal?.aborted || state.shuttingDown) {
      throw new Error(slot.stopped ?? "attempt cancelled");
    }
    return ownedWorker;
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

function onWorkerMessage(state: ManagedAcpExecutorState, worker: WorkerState, value: unknown): void {
  if (!isAcpWorkerChildMessage(value) || value.workerId !== worker.workerId || value.attemptId !== worker.input.attemptId) {
    faultWorker(state, worker, workerLostFailure("ACP worker sent an invalid IPC message."));
    return;
  }
  const message = value as AcpWorkerChildMessage;
  if (message.type === "open-started") {
    if (worker.phase !== "bootstrapping") {
      if (worker.phase !== "stopping" && worker.phase !== "closed") {
        faultWorker(state, worker, workerLostFailure("ACP worker sent duplicate bootstrap acknowledgement."));
      }
      return;
    }
    worker.phase = "opening";
    worker.settleOpenStarted();
    return;
  }
  if (message.type === "ready") {
    if (worker.phase !== "opening" || worker.cancelled !== undefined) {
      if (worker.phase !== "stopping" && worker.phase !== "closed") {
        faultWorker(state, worker, workerLostFailure("ACP worker reported readiness out of order."));
      }
      return;
    }
    worker.phase = "ready";
    worker.settleReady();
    return;
  }
  if (message.type === "closed") {
    worker.phase = "closed";
    worker.settleClosed();
    if (worker.active) {
      settleActive(worker, workerLostResult(worker, "ACP worker closed before returning a turn result."));
      finishActive(worker);
    }
    return;
  }
  if (message.type === "worker-failure") {
    if (worker.cancelled !== undefined) return;
    faultWorker(state, worker, message.failure);
    return;
  }
  const active = worker.active;
  if (!active || active.turnId !== message.turnId) return;
  if (message.type === "turn-result") {
    settleActive(worker, message.result);
    finishActive(worker);
    return;
  }
  if (active.settled) return;
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
}

function runWorkerTurn(worker: WorkerState, request: AgentTurnRequest): Promise<AgentTurnResult> {
  if (worker.terminalFailure !== undefined) {
    return Promise.resolve(failedWithoutWorker(worker.terminalFailure));
  }
  if (worker.cancelled !== undefined || worker.phase !== "ready") {
    return Promise.resolve(cancelledWithoutWorker(worker.cancelled ?? "Agent attempt is not ready."));
  }
  if (worker.active) return Promise.resolve(workerLostResult(worker, "ACP worker already has an active turn."));
  if (!worker.child.connected) return Promise.resolve(workerLostResult(worker, "ACP worker IPC is closed."));
  return new Promise(resolve => {
    const turnId = `turn_${randomUUID()}`;
    const active: ActiveTurn = {
      turnId,
      startedAt: new Date().toISOString(),
      startedAtMonotonic: performance.now(),
      request,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
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
    const configuration = Object.fromEntries(
      Object.entries(request.config ?? {}).filter(([key]) => key !== "model"),
    );
    send(worker, {
      type: "run-turn",
      protocolVersion: ACP_WORKER_PROTOCOL_VERSION,
      workerId: worker.workerId,
      attemptId: worker.input.attemptId,
      turnId,
      request: {
        prompt: request.prompt,
        ...(Object.keys(configuration).length === 0 ? {} : { configuration }),
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      },
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
  active.signal?.removeEventListener("abort", active.abort);
  active.resolve(result);
}

function finishActive(worker: WorkerState): void {
  const active = worker.active;
  if (!active) return;
  if (active.timeout) clearTimeout(active.timeout);
  if (active.silence?.timer) clearTimeout(active.silence.timer);
  active.signal?.removeEventListener("abort", active.abort);
  delete worker.active;
}

async function cleanupWorker(state: ManagedAcpExecutorState, worker: WorkerState, reason: string): Promise<void> {
  if (worker.cleaning) return worker.cleaning;
  worker.cleaning = cleanupWorkerValue(state, worker, reason);
  void worker.cleaning.catch(() => undefined);
  return worker.cleaning;
}

async function cleanupWorkerValue(state: ManagedAcpExecutorState, worker: WorkerState, reason: string): Promise<void> {
  try {
    if (worker.phase !== "closed") worker.phase = "stopping";
    const alive = await stopWorkerTree(worker, reason);
    await finishAcpOwnership(state.options, worker.manifestPath, worker.manifest, alive, reason);
  } finally {
    state.workers.delete(worker.workerId);
  }
}

function requestStop(state: ManagedAcpExecutorState, slot: StartupSlot, reason: string): void {
  slot.stopped ??= reason;
  const worker = slot.worker;
  if (worker === undefined || slot.stopPromise !== undefined) return;
  worker.cancelled ??= reason;
  if (worker.phase !== "closed") worker.phase = "stopping";
  worker.settleOpenStarted(new Error(reason));
  worker.settleReady(new Error(reason));
  slot.stopPromise = cleanupWorker(state, worker, reason);
  void slot.stopPromise.catch(() => undefined);
}

function faultWorker(
  state: ManagedAcpExecutorState,
  worker: WorkerState,
  failure: AgentBackendFailure,
): void {
  if (worker.phase === "stopping" || worker.phase === "closed") return;
  worker.phase = "stopping";
  worker.terminalFailure = failure;
  const error = new WorkerReportedFailure(failure);
  worker.settleOpenStarted(error);
  worker.settleReady(error);
  if (worker.active) settleActive(worker, failedWithoutWorker(failure, worker.active));
  void cleanupWorker(state, worker, "worker protocol failure");
}

function unavailableAttempt(unavailable: WorkerStartUnavailable | AgentBackendFailure | string): ManagedAcpAttempt {
  if (typeof unavailable === "object" && "status" in unavailable) {
    return unavailable.status === "cancelled"
      ? { runTurn: async () => cancelledWithoutWorker(unavailable.message) }
      : { runTurn: async () => failedWithoutWorker(unavailable.failure) };
  }
  const normalized = typeof unavailable === "string" ? workerLostFailure(unavailable) : unavailable;
  return { runTurn: async () => failedWithoutWorker(normalized) };
}

function cancelledStart(message: string): WorkerStartUnavailable {
  return { status: "cancelled", message };
}

function cancelledWithoutWorker(message: string): AgentTurnResult {
  return {
    status: "cancelled",
    message,
    responses: [],
    stderr: "",
    summary: emptySummary(),
    timing: resultTiming(undefined),
  };
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

function configFailure(failure: AcpAgentResolutionFailure): AgentBackendFailure {
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
    void Promise.resolve(callback?.(value)).catch(() => undefined);
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
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_OPTIONS" && key !== "NODE_PATH")),
    [INHERIT_PROCESS_GROUP_ENV]: randomUUID(),
  };
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
