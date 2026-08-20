import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AcpError } from "@acpus/acp";
import { err, ok, type Result } from "neverthrow";
import { finishAcpOwnership, writeAcpOwnershipManifest } from "./ownership.js";
import type { NormalizedRuntimeOwnerIdentity } from "./owner.js";
import {
  processStartToken,
  PROCESS_TREE_CLEANUP_BUDGET_MS,
  stopProcessTreeWithDisposition,
} from "./process-tree.js";
import type {
  AcpAgentLaunch,
  AcpOwnershipManifest,
  AgentSessionCleanupError,
  AgentSessionIntent,
  AgentSessionSupervisorOptions,
  AgentTurnEvent,
  AgentTurnPolicyEvidence,
  AgentTurnSnapshot,
  AttemptContext,
  HardCleanupEvidence,
  ProcessCapsuleError,
  SessionNeutralizationEvidence,
} from "./types.js";
import { createAgentTurnReducer, type AgentTurnReducer } from "./turn-reducer.js";
import {
  ACP_WORKER_PROTOCOL_VERSION,
  isAcpWorkerChildMessage,
  type AcpWorkerChildMessage,
  type AcpWorkerParentMessage,
  type ProcessCapsuleTerminal,
} from "./worker-protocol.js";

const CAPSULE_OPEN_TIMEOUT_MS = 30_000;
const COOPERATIVE_CLOSE_GRACE_MS = 4_000;
const WORKERS_DIRECTORY_MODE = 0o700;
const INHERIT_PROCESS_GROUP_ENV = "ACPUS_INTERNAL_ACP_INHERIT_PROCESS_GROUP";

export type ProcessCapsuleOpenInput = Readonly<{
  options: AgentSessionSupervisorOptions;
  owner: NormalizedRuntimeOwnerIdentity;
  attempt: AttemptContext;
  session: AgentSessionIntent;
  sessionLeaseId: string;
  resolvedLaunch: AcpAgentLaunch;
}>;

export type ProcessCapsuleOpenFailure =
  | Readonly<{ type: "cancelled"; message: string }>
  | Readonly<{ type: "session_open_failed"; error: AcpError }>
  | Readonly<{ type: "capsule_open_failed"; error: ProcessCapsuleError }>;

type ProcessCapsuleTurnInput<E> = Readonly<{
  turnId: string;
  prompt: string;
  signal: AbortSignal;
  deadlineAt?: string;
  inactivityFailAfterMs?: number;
  onEvent: (event: AgentTurnEvent) => Result<void, E>;
}>;

export type ProcessCapsuleTurnSettlement<E> = Readonly<{
  snapshot: AgentTurnSnapshot;
  finalResponse: string;
  terminal?: ProcessCapsuleTerminal;
  policy?: AgentTurnPolicyEvidence;
  hardCleanup?: HardCleanupEvidence;
  sinkError?: E;
  capsuleError?: ProcessCapsuleError;
}>;

export type ProcessCapsule = Readonly<{
  hostId: string;
  agentSessionId: string;
  sessionLeaseId: string;
  projectionRef: string;
  reportedVersion?: string;
  runTurn<E>(input: ProcessCapsuleTurnInput<E>): Promise<ProcessCapsuleTurnSettlement<E>>;
  close(
    reason: "lease_settled" | "open_failed" | "neutralize" | "shutdown",
  ): Promise<Result<SessionNeutralizationEvidence, AgentSessionCleanupError>>;
}>;

type CapsulePhase = "opening" | "ready" | "running" | "cancelling" | "cleaning" | "closed";

type ActiveTurn = {
  turnId: string;
  startedAt: string;
  startedAtMonotonic: number;
  signal: AbortSignal;
  abort: () => void;
  onEvent: (event: AgentTurnEvent) => Result<void, unknown>;
  resolve: (settlement: ProcessCapsuleTurnSettlement<unknown>) => void;
  reducer: AgentTurnReducer;
  sequence: number;
  sinkError?: unknown;
  policy?: AgentTurnPolicyEvidence;
  silence?: {
    startedAt: string;
    startedAtMonotonic: number;
    timer?: ReturnType<typeof setTimeout>;
  };
  deadlineTimer?: ReturnType<typeof setTimeout>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  terminal: boolean;
};

type CapsuleState = {
  readonly input: ProcessCapsuleOpenInput;
  readonly hostId: string;
  readonly child: ChildProcess;
  readonly manifestPath: string;
  manifest: AcpOwnershipManifest;
  manifestWrites: Promise<void>;
  manifestError?: ProcessCapsuleError;
  phase: CapsulePhase;
  projectionRef?: string;
  reportedVersion?: string;
  openFailure?: ProcessCapsuleOpenFailure;
  ready: Promise<void>;
  settleReady(error?: Error): void;
  closed: Promise<void>;
  settleClosed(): void;
  active?: ActiveTurn;
  capsuleError?: ProcessCapsuleError;
  cleanup?: Promise<Result<SessionNeutralizationEvidence, AgentSessionCleanupError>>;
  hardCleanup?: HardCleanupEvidence;
};

/** Opens one cold process capsule after the caller already owns the Session guard. */
export async function openProcessCapsule(
  input: ProcessCapsuleOpenInput,
): Promise<Result<ProcessCapsule, ProcessCapsuleOpenFailure>> {
  if (input.attempt.signal.aborted) return err({ type: "cancelled", message: "Agent Session acquire was cancelled." });
  const deadlineFailure = openingDeadline(input.attempt.deadlineAt);
  if (deadlineFailure !== undefined) return err(deadlineFailure);
  await Promise.all([
    mkdir(input.options.workersRoot, { recursive: true, mode: WORKERS_DIRECTORY_MODE }),
    mkdir(input.options.sessionStateDirectoryForRun(input.attempt.runId), { recursive: true, mode: WORKERS_DIRECTORY_MODE }),
  ]);
  if (input.attempt.signal.aborted) return err({ type: "cancelled", message: "Agent Session acquire was cancelled." });

  const hostId = `host_${randomUUID()}`;
  const child = spawn(process.execPath, workerEntryArgs(), {
    detached: process.platform !== "win32",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: safeWorkerEnvironment(),
  });
  if (child.pid === undefined) {
    return err({ type: "capsule_open_failed", error: capsuleError("bootstrap", "worker_spawn_failed", "ACP capsule did not provide a process id.") });
  }

  const workerStartToken = await processStartToken(child.pid);
  const manifest: AcpOwnershipManifest = {
    schemaVersion: 3,
    hostId,
    agentSessionId: input.session.agentSessionId,
    sessionLeaseId: input.sessionLeaseId,
    runId: input.attempt.runId,
    attemptId: input.attempt.attemptId,
    owner: input.owner,
    worker: {
      pid: child.pid,
      ...(workerStartToken === undefined ? {} : { startToken: workerStartToken }),
      ...(process.platform === "win32" ? {} : { pgid: child.pid }),
    },
    state: { phase: "opening" },
    createdAt: new Date().toISOString(),
  };
  const manifestPath = join(input.options.workersRoot, `acp_capsule_${hostId.slice("host_".length)}.json`);
  let state: CapsuleState | undefined;
  try {
    await writeAcpOwnershipManifest(manifestPath, manifest);
    state = createState(input, hostId, child, manifest, manifestPath);
    bindChild(state);
    const onAbort = (): void => {
      state!.openFailure ??= { type: "cancelled", message: "Agent Session acquire was cancelled." };
      void closeCapsule(state!, "open_failed");
    };
    input.attempt.signal.addEventListener("abort", onAbort, { once: true });
    try {
      send(state, {
        type: "open",
        protocolVersion: ACP_WORKER_PROTOCOL_VERSION,
        input: {
          hostId,
          sessionLeaseId: input.sessionLeaseId,
          runId: input.attempt.runId,
          attemptId: input.attempt.attemptId,
          agentSessionId: input.session.agentSessionId,
          sessionOpenMode: input.session.sessionOpenMode,
          sessionStateDirectory: input.options.sessionStateDirectoryForRun(input.attempt.runId),
          resolvedLaunch: input.resolvedLaunch,
          cwd: input.session.cwd,
          env: definedEnvironment(input.session.env),
          permissionMode: input.session.permissionMode,
          configuration: input.session.configuration,
        },
      });
      await withTimeout(state.ready, openTimeout(input.attempt.deadlineAt), "ACP capsule did not become ready in time.");
    } finally {
      input.attempt.signal.removeEventListener("abort", onAbort);
    }
    if (state.openFailure !== undefined) {
      await closeCapsule(state, "open_failed");
      return err(state.openFailure);
    }
    if (!state.projectionRef) {
      const failure = { type: "capsule_open_failed" as const, error: capsuleError("opening", "ipc_protocol", "ACP capsule became ready without a projection reference.") };
      await closeCapsule(state, "open_failed");
      return err(failure);
    }
    return ok(publicCapsule(state));
  } catch (error) {
    const failure = state?.openFailure ?? {
      type: "capsule_open_failed" as const,
      error: capsuleError("opening", "worker_exception", errorMessage(error)),
    };
    if (state) await closeCapsule(state, "open_failed");
    else await stopProcessTreeWithDisposition(child.pid, performance.now() + PROCESS_TREE_CLEANUP_BUDGET_MS);
    return err(failure);
  }
}

function createState(
  input: ProcessCapsuleOpenInput,
  hostId: string,
  child: ChildProcess,
  manifest: AcpOwnershipManifest,
  manifestPath: string,
): CapsuleState {
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  void ready.catch(() => undefined);
  let closedResolve!: () => void;
  const closed = new Promise<void>(resolve => { closedResolve = resolve; });
  let readySettled = false;
  return {
    input,
    hostId,
    child,
    manifest,
    manifestWrites: Promise.resolve(),
    manifestPath,
    phase: "opening",
    ready,
    settleReady: error => {
      if (readySettled) return;
      readySettled = true;
      if (error) readyReject(error);
      else readyResolve();
    },
    closed,
    settleClosed: closedResolve,
  };
}

function bindChild(state: CapsuleState): void {
  state.child.on("message", value => onChildMessage(state, value));
  state.child.on("error", error => faultCapsule(state, capsuleError(phaseForError(state), "worker_exception", error.message)));
  state.child.on("close", () => {
    state.phase = "closed";
    state.settleClosed();
    if (!state.projectionRef) state.settleReady(new Error("ACP capsule exited before readiness."));
    if (state.active) settleActive(state, failedSettlement(state));
  });
}

function onChildMessage(state: CapsuleState, value: unknown): void {
  if (!isAcpWorkerChildMessage(value)
    || value.hostId !== state.hostId
    || value.sessionLeaseId !== state.input.sessionLeaseId) {
    faultCapsule(state, capsuleError(phaseForError(state), "ipc_protocol", "ACP capsule sent an invalid IPC message."));
    return;
  }
  const message = value as AcpWorkerChildMessage;
  if (message.type === "ready") {
    if (state.phase !== "opening") {
      faultCapsule(state, capsuleError(phaseForError(state), "ipc_protocol", "ACP capsule reported readiness out of order."));
      return;
    }
    state.phase = "ready";
    state.projectionRef = message.projectionRef;
    if (message.reportedVersion !== undefined) state.reportedVersion = message.reportedVersion;
    void updateManifestPhase(state, { phase: "ready" })
      .then(() => state.settleReady())
      .catch(error => faultCapsule(state, manifestError(state, error)));
    return;
  }
  if (message.type === "open_failed") {
    state.openFailure = { type: "session_open_failed", error: message.error };
    state.settleReady(new Error(message.error.message));
    return;
  }
  if (message.type === "closed") {
    state.phase = "closed";
    state.settleClosed();
    return;
  }
  if (message.type === "failed") {
    state.capsuleError = message.error;
    if (!state.projectionRef) {
      state.openFailure = { type: "capsule_open_failed", error: message.error };
      state.settleReady(new Error(message.error.message));
    }
    if (state.active) settleActive(state, failedSettlement(state));
    return;
  }
  const active = state.active;
  if ((message.type === "event" || message.type === "terminal")
    && (!active || active.turnId !== message.turnId || active.terminal)) {
    faultCapsule(state, capsuleError(phaseForError(state), "ipc_protocol", "ACP capsule sent an event outside the active Turn."));
    return;
  }
  if (!active) return;
  if (message.type === "terminal") {
    settleActive(state, settlementFromTerminal(state, active, message.terminal));
    return;
  }
  if (message.type !== "event") return;
  const envelope: AgentTurnEvent = {
    sequence: active.sequence++,
    observedAt: new Date().toISOString(),
    elapsedMs: Math.max(0, Math.round(performance.now() - active.startedAtMonotonic)),
    event: message.event,
  };
  active.reducer.observe(envelope);
  noteActivity(state, active, envelope.observedAt);
  if (active.sinkError !== undefined) return;
  let accepted: Result<void, unknown>;
  try {
    accepted = active.onEvent(envelope);
  } catch (error) {
    accepted = err(error);
  }
  if (accepted.isErr()) {
    active.sinkError = accepted.error;
    requestPolicy(state, active, {
      type: "cancelled",
      reason: "event_sink",
      requestedAt: new Date().toISOString(),
    });
  }
}

function publicCapsule(state: CapsuleState): ProcessCapsule {
  return {
    hostId: state.hostId,
    agentSessionId: state.input.session.agentSessionId,
    sessionLeaseId: state.input.sessionLeaseId,
    projectionRef: state.projectionRef!,
    ...(state.reportedVersion === undefined ? {} : { reportedVersion: state.reportedVersion }),
    runTurn: input => runCapsuleTurn(state, input),
    close: reason => closeCapsule(state, reason),
  };
}

function runCapsuleTurn<E>(
  state: CapsuleState,
  input: ProcessCapsuleTurnInput<E>,
): Promise<ProcessCapsuleTurnSettlement<E>> {
  if (state.phase !== "ready" || state.active || !state.child.connected) {
    return Promise.resolve(failedSettlement(state) as ProcessCapsuleTurnSettlement<E>);
  }
  return new Promise(resolve => {
    const active: ActiveTurn = {
      turnId: input.turnId,
      startedAt: new Date().toISOString(),
      startedAtMonotonic: performance.now(),
      signal: input.signal,
      onEvent: input.onEvent as (event: AgentTurnEvent) => Result<void, unknown>,
      resolve: resolve as (settlement: ProcessCapsuleTurnSettlement<unknown>) => void,
      reducer: createAgentTurnReducer(),
      sequence: 0,
      abort: () => requestPolicy(state, active, {
        type: "cancelled",
        reason: input.signal.reason === "steer" ? "steer" : "operator",
        requestedAt: new Date().toISOString(),
      }),
      terminal: false,
    };
    state.active = active;
    state.phase = "running";
    void updateManifestPhase(state, { phase: "running", turnId: input.turnId }).then(() => {
      if (state.active !== active || active.terminal) return;
      noteActivity(state, active, active.startedAt, input.inactivityFailAfterMs);
      const deadlineMs = millisecondsUntil(input.deadlineAt);
      if (deadlineMs !== undefined) {
        active.deadlineTimer = setTimeout(() => requestPolicy(state, active, {
          type: "deadline",
          deadlineAt: input.deadlineAt!,
          requestedAt: new Date().toISOString(),
        }), deadlineMs);
      }
      input.signal.addEventListener("abort", active.abort, { once: true });
      if (input.signal.aborted) active.abort();
      else send(state, {
        type: "run",
        protocolVersion: ACP_WORKER_PROTOCOL_VERSION,
        hostId: state.hostId,
        sessionLeaseId: state.input.sessionLeaseId,
        turnId: input.turnId,
        prompt: input.prompt,
      });
    }).catch(error => faultCapsule(state, manifestError(state, error)));
  });
}

function noteActivity(
  state: CapsuleState,
  active: ActiveTurn,
  observedAt: string,
  configuredFailAfterMs = state.input.attempt.inactivityFailAfterMs,
): void {
  if (active.terminal || active.policy !== undefined) return;
  if (active.silence?.timer) clearTimeout(active.silence.timer);
  const silence = { startedAt: observedAt, startedAtMonotonic: performance.now() } as NonNullable<ActiveTurn["silence"]>;
  active.silence = silence;
  if (configuredFailAfterMs === undefined) return;
  silence.timer = setTimeout(() => {
    if (active.terminal || active.silence !== silence || active.policy !== undefined) return;
    requestPolicy(state, active, {
      type: "inactivity",
      failAfterMs: configuredFailAfterMs,
      silentForMs: Math.max(0, Math.round(performance.now() - silence.startedAtMonotonic)),
      silenceStartedAt: silence.startedAt,
      requestedAt: new Date().toISOString(),
    });
  }, configuredFailAfterMs);
}

function requestPolicy(state: CapsuleState, active: ActiveTurn, policy: AgentTurnPolicyEvidence): void {
  if (state.active !== active || active.terminal || active.policy !== undefined) return;
  active.policy = policy;
  state.phase = "cancelling";
  clearTurnTimers(active);
  void updateManifestPhase(state, { phase: "cancelling", turnId: active.turnId }).then(() => {
    if (state.active !== active || active.terminal) return;
    send(state, {
      type: "cancel",
      protocolVersion: ACP_WORKER_PROTOCOL_VERSION,
      hostId: state.hostId,
      sessionLeaseId: state.input.sessionLeaseId,
      turnId: active.turnId,
      reason: policy.type === "deadline" ? "deadline" : policy.type === "inactivity" ? "inactivity" : policy.reason,
    });
  }).catch(error => faultCapsule(state, manifestError(state, error)));
  active.cleanupTimer = setTimeout(() => {
    if (state.active !== active || active.terminal) return;
    void closeCapsule(state, "lease_settled");
  }, COOPERATIVE_CLOSE_GRACE_MS);
}

function settleActive(state: CapsuleState, settlement: ProcessCapsuleTurnSettlement<unknown>): void {
  const active = state.active;
  if (!active || active.terminal) return;
  active.terminal = true;
  clearTurnTimers(active);
  active.signal.removeEventListener("abort", active.abort);
  const resolved = {
    ...settlement,
    ...(active.policy === undefined ? {} : { policy: active.policy }),
    ...(active.sinkError === undefined ? {} : { sinkError: active.sinkError }),
    ...(state.hardCleanup === undefined ? {} : { hardCleanup: state.hardCleanup }),
  };
  delete state.active;
  if (state.phase !== "cleaning" && state.phase !== "closed") {
    state.phase = "ready";
    void updateManifestPhase(state, { phase: "ready" })
      .then(() => active.resolve(resolved))
      .catch(error => {
        const failure = manifestError(state, error);
        state.capsuleError ??= failure;
        active.resolve({ ...resolved, capsuleError: failure });
        void closeCapsule(state, "lease_settled");
      });
    return;
  }
  active.resolve(resolved);
}

async function closeCapsule(
  state: CapsuleState,
  reason: "lease_settled" | "open_failed" | "neutralize" | "shutdown",
): Promise<Result<SessionNeutralizationEvidence, AgentSessionCleanupError>> {
  if (state.cleanup) return state.cleanup;
  state.cleanup = closeCapsuleValue(state, reason);
  return state.cleanup;
}

async function closeCapsuleValue(
  state: CapsuleState,
  reason: "lease_settled" | "open_failed" | "neutralize" | "shutdown",
): Promise<Result<SessionNeutralizationEvidence, AgentSessionCleanupError>> {
  state.phase = "cleaning";
  await updateManifestPhase(state, { phase: "cleaning" }).catch(error => {
    state.manifestError ??= manifestError(state, error);
  });
  if (state.active && state.active.policy === undefined) {
    requestPolicy(state, state.active, {
      type: "cancelled",
      reason: reason === "neutralize" ? "lease_lost" : "operator",
      requestedAt: new Date().toISOString(),
    });
  }
  send(state, {
    type: "close",
    protocolVersion: ACP_WORKER_PROTOCOL_VERSION,
    hostId: state.hostId,
    sessionLeaseId: state.input.sessionLeaseId,
    reason,
  });
  const startedAt = new Date().toISOString();
  const deadline = performance.now() + PROCESS_TREE_CLEANUP_BUDGET_MS;
  await settleWithin(state.closed, Math.min(COOPERATIVE_CLOSE_GRACE_MS, remaining(deadline)));
  const stopped = await stopProcessTreeWithDisposition(state.manifest.worker.pid, deadline);
  const finishedAt = new Date().toISOString();
  state.hardCleanup = { disposition: stopped.disposition, startedAt, finishedAt };
  if (state.active) settleActive(state, failedSettlement(state));
  let ownership;
  try {
    ownership = await finishAcpOwnership(
      state.manifestPath,
      state.manifest,
      stopped.alive,
      "cleanup_unverified",
    );
  } catch (error) {
    const failure = manifestError(state, error);
    return err({
      type: "cleanup_unverified",
      agentSessionId: state.input.session.agentSessionId,
      evidence: {
        state: "unverified",
        observedAt: new Date().toISOString(),
        reason: failure.message,
      },
      message: "ACP capsule ownership cleanup could not be persisted.",
    });
  }
  if (stopped.alive) {
    return err({
      type: ownership.state === "unverified" ? "cleanup_unverified" : "cleanup_failed",
      agentSessionId: state.input.session.agentSessionId,
      evidence: ownership as Extract<typeof ownership, { state: "unverified" }> & { state: "unverified" },
      message: "ACP capsule process-tree death could not be proven.",
    } as AgentSessionCleanupError);
  }
  if (state.manifestError) {
    return err({
      type: "cleanup_failed",
      agentSessionId: state.input.session.agentSessionId,
      evidence: {
        state: "dead",
        observedAt: finishedAt,
        reason: state.manifestError.message,
      },
      message: state.manifestError.message,
    });
  }
  state.phase = "closed";
  return ok({
    session: { runId: state.input.attempt.runId, agentSessionId: state.input.session.agentSessionId },
    disposition: stopped.disposition === "unverified" ? "kill" : stopped.disposition,
    observedAt: finishedAt,
  });
}

function faultCapsule(state: CapsuleState, error: ProcessCapsuleError): void {
  state.capsuleError ??= error;
  if (!state.projectionRef) {
    state.openFailure ??= { type: "capsule_open_failed", error };
    state.settleReady(new Error(error.message));
  }
  if (state.active) settleActive(state, failedSettlement(state));
  void closeCapsule(state, state.projectionRef ? "lease_settled" : "open_failed");
}

function failedSettlement(
  state: CapsuleState,
): ProcessCapsuleTurnSettlement<never> {
  const active = state.active;
  return {
    snapshot: active?.reducer.snapshot() ?? emptySnapshot(),
    finalResponse: active?.reducer.finalResponse() ?? "",
    ...(state.capsuleError === undefined ? {} : { capsuleError: state.capsuleError }),
    ...(state.hardCleanup === undefined ? {} : { hardCleanup: state.hardCleanup }),
  };
}

async function updateManifestPhase(state: CapsuleState, phase: AcpOwnershipManifest["state"]): Promise<void> {
  const manifest = { ...state.manifest, state: phase };
  state.manifest = manifest;
  const write = state.manifestWrites.then(() => writeAcpOwnershipManifest(state.manifestPath, manifest));
  state.manifestWrites = write.catch(() => undefined);
  await write;
}

function manifestError(state: CapsuleState, error: unknown): ProcessCapsuleError {
  const failure = capsuleError(phaseForError(state), "worker_exception", `ACP ownership manifest write failed: ${errorMessage(error)}`);
  state.manifestError ??= failure;
  return failure;
}

function clearTurnTimers(active: ActiveTurn): void {
  if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
  if (active.silence?.timer) clearTimeout(active.silence.timer);
  if (active.cleanupTimer) clearTimeout(active.cleanupTimer);
}

function settlementFromTerminal(
  state: CapsuleState,
  active: ActiveTurn,
  terminal: ProcessCapsuleTerminal,
): ProcessCapsuleTurnSettlement<unknown> {
  const protocolResult = terminal.type === "provider_result" ? terminal.result : undefined;
  return {
    terminal,
    snapshot: active.reducer.snapshot(protocolResult),
    finalResponse: active.reducer.finalResponse(),
    ...(active.policy === undefined ? {} : { policy: active.policy }),
    ...(active.sinkError === undefined ? {} : { sinkError: active.sinkError }),
    ...(state.hardCleanup === undefined ? {} : { hardCleanup: state.hardCleanup }),
  };
}

function send(state: CapsuleState, message: AcpWorkerParentMessage): void {
  if (!state.child.connected) {
    faultCapsule(state, capsuleError(phaseForError(state), "ipc_closed", "ACP capsule IPC is closed."));
    return;
  }
  state.child.send(message, error => {
    if (error) faultCapsule(state, capsuleError(phaseForError(state), "ipc_closed", "ACP capsule IPC write failed."));
  });
}

function phaseForError(state: CapsuleState): ProcessCapsuleError["phase"] {
  if (state.phase === "opening") return "opening";
  if (state.phase === "running" || state.phase === "cancelling") return "running";
  if (state.phase === "cleaning" || state.phase === "closed") return "closing";
  return "ready";
}

function capsuleError(
  phase: ProcessCapsuleError["phase"],
  code: ProcessCapsuleError["code"],
  message: string,
): ProcessCapsuleError {
  return { type: "process_capsule", phase, code, message };
}

function emptySnapshot(): AgentTurnSnapshot {
  const now = new Date().toISOString();
  return {
    responses: [],
    summary: {
      eventCount: 0,
      availability: { context: "unavailable", tokenUsage: "unavailable" },
      tools: { totalToolCallCount: 0, calls: [] },
    },
    timing: { startedAt: now, finishedAt: now, elapsedMs: 0 },
  };
}

function definedEnvironment(env: Readonly<NodeJS.ProcessEnv>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function workerEntryArgs(): string[] {
  const sourceMode = fileURLToPath(import.meta.url).endsWith(".ts");
  const entry = fileURLToPath(new URL(`./worker-entry.${sourceMode ? "ts" : "js"}`, import.meta.url));
  return sourceMode
    ? ["--conditions=development", "--import", import.meta.resolve("tsx"), entry]
    : [entry];
}

function safeWorkerEnvironment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_OPTIONS" && key !== "NODE_PATH")),
    [INHERIT_PROCESS_GROUP_ENV]: randomUUID(),
  };
}

function openTimeout(deadlineAt: string | undefined): number {
  const remainingMs = millisecondsUntil(deadlineAt);
  return remainingMs === undefined ? CAPSULE_OPEN_TIMEOUT_MS : Math.min(CAPSULE_OPEN_TIMEOUT_MS, remainingMs);
}

function openingDeadline(deadlineAt: string | undefined): ProcessCapsuleOpenFailure | undefined {
  if (deadlineAt === undefined || millisecondsUntil(deadlineAt)! > 0) return undefined;
  return { type: "cancelled", message: "Agent Session acquire deadline elapsed before capsule open." };
}

function millisecondsUntil(deadlineAt: string | undefined): number | undefined {
  if (deadlineAt === undefined) return undefined;
  return Math.max(0, new Date(deadlineAt).getTime() - Date.now());
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function settleWithin(promise: Promise<void>, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) return;
  await withTimeout(promise, timeoutMs, "cleanup wait elapsed").catch(() => undefined);
}

function remaining(deadline: number): number {
  return Math.max(0, Math.floor(deadline - performance.now()));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
