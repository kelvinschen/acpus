import {
  openAcpSession,
  type AcpEvent,
  type AcpSession,
  type AcpSessionConfiguration,
  type AcpTurnResult,
} from "@acpus/acp";
import type {
  AgentBackendFailure,
  AgentJsonValue,
  AgentObservationEvent,
  AgentToolCallSummary,
  AgentTurnProgress,
  AgentTurnResult,
  AgentTurnSummary,
} from "./types.js";
import { observationEventFromRuntime, toAgentJsonValue } from "./runtime-event.js";
import { createTurnResponseCollector } from "./turn-responses.js";
import { failureFromAcpError } from "./worker-failure.js";
import {
  ACP_WORKER_PROTOCOL_VERSION,
  isAcpWorkerParentMessage,
  type AcpWorkerChildMessage,
  type AcpWorkerParentMessage,
  type AcpWorkerTurnRequest,
} from "./worker-protocol.js";

const INHERIT_PROCESS_GROUP_ENV = "ACPUS_INTERNAL_ACP_INHERIT_PROCESS_GROUP";

type WorkerIdentity = {
  workerId: string;
  attemptId: string;
};

type InitializedWorker = WorkerIdentity & {
  cwd: string;
  model?: string;
  session: AcpSession;
};

type ActiveTurn = {
  turnId: string;
  controller: AbortController;
  abortReason?: "aborted" | "timeout" | "inactivity";
};

type TurnAccumulator = {
  startedAt: string;
  startedAtMonotonic: number;
  sequence: number;
  responses: ReturnType<typeof createTurnResponseCollector>;
  context?: AgentTurnSummary["context"];
  tokenUsage?: AgentTurnSummary["tokenUsage"];
  tools: Map<string, AgentToolCallSummary>;
  eventCount: number;
  sessionProjectionPath: string;
};

let identity: WorkerIdentity | undefined;
let initialized: InitializedWorker | undefined;
let openingController: AbortController | undefined;
let opening: Promise<void> | undefined;
let active: ActiveTurn | undefined;
let closing = false;
let closingPromise: Promise<void> | undefined;

process.on("message", raw => {
  if (!isAcpWorkerParentMessage(raw)) return;
  void receive(raw).catch(error => fail(workerLostFailure(error)));
});

process.once("disconnect", () => {
  void closeWorker("parent disconnected");
});

async function receive(message: AcpWorkerParentMessage): Promise<void> {
  if (message.type === "initialize") {
    if (identity) throw new Error("ACP worker received duplicate initialization.");
    identity = { workerId: message.workerId, attemptId: message.attemptId };
    openingController = new AbortController();
    send({ type: "open-started", protocolVersion: ACP_WORKER_PROTOCOL_VERSION, ...identity });
    opening = openWorker(message, openingController.signal);
    await opening;
    opening = undefined;
    openingController = undefined;
    if (!initialized && !closing) await failAndClose();
    return;
  }
  if (message.type === "close-attempt") {
    await closeWorker(message.reason);
    return;
  }

  const state = requireInitialized(message);
  if (message.type === "run-turn") {
    if (active) throw new Error("ACP worker received a second active turn.");
    await runTurn(state, message.turnId, message.request);
    return;
  }
  if (message.type === "abort-turn") {
    if (active?.turnId !== message.turnId) return;
    active.abortReason = message.reason;
    active.controller.abort();
    return;
  }
}

async function openWorker(
  message: Extract<AcpWorkerParentMessage, { type: "initialize" }>,
  signal: AbortSignal,
): Promise<void> {
  const opened = await openAcpSession({
    recordId: message.recordId,
    stateDirectory: message.sessionStateDirectory,
    launch: message.resolvedLaunch,
    cwd: message.cwd,
    env: {
      ...message.env,
      ...(process.env[INHERIT_PROCESS_GROUP_ENV] === undefined
        ? {}
        : { [INHERIT_PROCESS_GROUP_ENV]: process.env[INHERIT_PROCESS_GROUP_ENV] }),
    },
    permissionMode: message.permissionMode,
    signal,
  });
  if (opened.isErr()) {
    if (!closing) sendFailure(failureFromAcpError(opened.error));
    return;
  }
  initialized = {
    ...identityOfMessage(message),
    cwd: message.cwd,
    ...(message.model === undefined ? {} : { model: message.model }),
    session: opened.value,
  };
  if (!closing) {
    send({ type: "ready", protocolVersion: ACP_WORKER_PROTOCOL_VERSION, ...identityOfMessage(message) });
  }
}

async function runTurn(
  state: InitializedWorker,
  turnId: string,
  request: AcpWorkerTurnRequest,
): Promise<void> {
  const accumulator = createAccumulator(state.session.projectionPath);
  const controller = new AbortController();
  active = { turnId, controller };
  emitActivity(state, turnId);
  try {
    const configuration = turnConfiguration(state, request);
    const terminal = await state.session.runTurn({
      prompt: request.prompt,
      ...(configuration === undefined ? {} : { configuration }),
      signal: controller.signal,
      onEvent: event => emitRuntimeEvent(state, turnId, accumulator, event),
    });
    const result = terminal.isErr()
      ? resultFromFailure(accumulator, terminal.error, active?.abortReason)
      : resultFromTerminal(accumulator, terminal.value, active?.abortReason);
    emitTurnEnd(state, turnId, accumulator, result);
    send({ type: "turn-result", protocolVersion: ACP_WORKER_PROTOCOL_VERSION, ...identityOf(state), turnId, result });
  } catch (error) {
    fail(workerLostFailure(error));
  } finally {
    if (active?.turnId === turnId) active = undefined;
  }
}

function turnConfiguration(
  state: InitializedWorker,
  request: AcpWorkerTurnRequest,
): AcpSessionConfiguration | undefined {
  if (state.model === undefined && request.configuration === undefined) return undefined;
  return {
    ...(state.model === undefined ? {} : { model: state.model }),
    ...(request.configuration === undefined ? {} : { options: request.configuration }),
  };
}

function emitRuntimeEvent(
  state: InitializedWorker,
  turnId: string,
  accumulator: TurnAccumulator,
  event: AcpEvent,
): void {
  const observedAt = new Date().toISOString();
  const elapsedMs = elapsed(accumulator);
  accumulator.eventCount += 1;
  updateAccumulator(accumulator, event, observedAt);
  const projected = observationEventFromRuntime(event, accumulator.sequence++, observedAt, elapsedMs);
  if (projected) {
    send({
      type: "turn-observation",
      protocolVersion: ACP_WORKER_PROTOCOL_VERSION,
      ...identityOf(state),
      turnId,
      observation: { event: projected, progress: progress(accumulator, observedAt) },
    });
  }
  emitActivity(state, turnId, observedAt);
}

function emitTurnEnd(state: InitializedWorker, turnId: string, accumulator: TurnAccumulator, result: AgentTurnResult): void {
  const observedAt = new Date().toISOString();
  const event: AgentObservationEvent = {
    schemaVersion: 1,
    sequence: accumulator.sequence++,
    observedAt,
    elapsedMs: elapsed(accumulator),
    type: "turn_end",
    status: result.status === "failed" && result.failure.kind === "timeout" ? "timed_out" : result.status,
    ...(result.summary.stopReason === undefined ? {} : { stopReason: result.summary.stopReason }),
    ...(result.status === "failed" ? { failure: result.failure as unknown as AgentJsonValue, message: result.failure.message } : {}),
    ...(result.status === "cancelled" ? { message: result.message } : {}),
  };
  send({
    type: "turn-observation",
    protocolVersion: ACP_WORKER_PROTOCOL_VERSION,
    ...identityOf(state),
    turnId,
    observation: { event, progress: progress(accumulator, observedAt) },
  });
}

function updateAccumulator(accumulator: TurnAccumulator, event: AcpEvent, observedAt: string): void {
  accumulator.responses.observe(event);
  if (event.type === "usage") {
    if (event.context) accumulator.context = { ...event.context, updatedAt: observedAt };
    if (event.tokens) accumulator.tokenUsage = { source: "usage_update", ...event.tokens };
    return;
  }
  if (event.type !== "tool") return;
  const previous = accumulator.tools.get(event.toolCallId);
  const status = event.status ?? previous?.status;
  accumulator.tools.set(event.toolCallId, {
    toolCallId: event.toolCallId,
    ...optionalValue("title", event.title ?? previous?.title),
    ...optionalValue("toolName", event.name ?? previous?.toolName),
    ...optionalValue("kind", event.kind ?? previous?.kind),
    ...optionalValue("status", status),
    ...(event.input === undefined
      ? optionalValue("input", previous?.input)
      : { input: preview(event.input) }),
    startedAt: previous?.startedAt ?? observedAt,
    updatedAt: observedAt,
    ...(terminalToolStatus(status)
      ? { completedAt: previous?.completedAt ?? observedAt }
      : {}),
  });
}

function resultFromFailure(
  accumulator: TurnAccumulator,
  error: Parameters<typeof failureFromAcpError>[0],
  abortReason: ActiveTurn["abortReason"],
): AgentTurnResult {
  if (abortReason === "inactivity") return staleResult(accumulator);
  if (abortReason === "timeout") return failedResult(accumulator, timeoutFailure());
  if (abortReason === "aborted") return cancelledResult(accumulator, "Agent turn was aborted.");
  return failedResult(accumulator, failureFromAcpError(error));
}

function resultFromTerminal(
  accumulator: TurnAccumulator,
  terminal: AcpTurnResult,
  abortReason: ActiveTurn["abortReason"],
): AgentTurnResult {
  if (terminal.usage) accumulator.tokenUsage = { source: "prompt_response", ...terminal.usage };
  if (abortReason === "inactivity") return staleResult(accumulator);
  if (abortReason === "timeout") return failedResult(accumulator, timeoutFailure());
  if (abortReason === "aborted" || terminal.status === "cancelled") {
    return cancelledResult(accumulator, "Agent turn was aborted.", terminal.stopReason);
  }
  return completedResult(accumulator, terminal.stopReason);
}

function createAccumulator(sessionProjectionPath: string): TurnAccumulator {
  return {
    startedAt: new Date().toISOString(),
    startedAtMonotonic: performance.now(),
    sequence: 0,
    responses: createTurnResponseCollector(),
    tools: new Map(),
    eventCount: 0,
    sessionProjectionPath,
  };
}

function completedResult(accumulator: TurnAccumulator, stopReason?: string): AgentTurnResult {
  return {
    status: "completed",
    ...accumulator.responses.complete(),
    stderr: "",
    summary: summary(accumulator, stopReason),
    timing: timing(accumulator),
  };
}

function cancelledResult(accumulator: TurnAccumulator, message: string, stopReason?: string): AgentTurnResult {
  return {
    status: "cancelled",
    message,
    responses: accumulator.responses.snapshot(),
    stderr: "",
    summary: summary(accumulator, stopReason),
    timing: timing(accumulator),
  };
}

function failedResult(accumulator: TurnAccumulator, failure: AgentBackendFailure): AgentTurnResult {
  return {
    status: "failed",
    failure,
    responses: accumulator.responses.snapshot(),
    stderr: "",
    summary: summary(accumulator),
    timing: timing(accumulator),
  };
}

function timeoutFailure(): AgentBackendFailure {
  return { kind: "timeout", origin: "runtime", message: "Agent turn exceeded its authored timeout." };
}

function workerLostFailure(error: unknown): AgentBackendFailure {
  return {
    kind: "worker_lost",
    origin: "runtime",
    retryable: true,
    message: error instanceof Error ? error.message : String(error),
  };
}

function staleResult(accumulator: TurnAccumulator): AgentTurnResult {
  const silentForMs = Math.max(0, Math.round(performance.now() - accumulator.startedAtMonotonic));
  return failedResult(accumulator, {
    kind: "inactivity_stale",
    origin: "runtime",
    retryable: true,
    message: "ACP agent was silent for the configured inactivity limit.",
    evidence: {
      failAfterMs: 0,
      silentForMs,
      silenceStartedAt: accumulator.startedAt,
    },
  });
}

function progress(accumulator: TurnAccumulator, updatedAt: string): AgentTurnProgress {
  return { responses: accumulator.responses.snapshot(), summary: summary(accumulator), updatedAt };
}

function summary(accumulator: TurnAccumulator, stopReason?: string): AgentTurnSummary {
  return {
    eventCount: accumulator.eventCount,
    availability: {
      context: accumulator.context ? "available" : "unavailable",
      tokenUsage: accumulator.tokenUsage ? "available" : "unavailable",
    },
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(accumulator.context === undefined ? {} : { context: accumulator.context }),
    ...(accumulator.tokenUsage === undefined ? {} : { tokenUsage: accumulator.tokenUsage }),
    tools: { totalToolCallCount: accumulator.tools.size, calls: [...accumulator.tools.values()] },
    ...(initialized?.cwd === undefined ? {} : { cwd: initialized.cwd }),
    sessionProjectionPath: accumulator.sessionProjectionPath,
  };
}

function timing(accumulator: TurnAccumulator) {
  const finishedAt = new Date().toISOString();
  return { startedAt: accumulator.startedAt, finishedAt, elapsedMs: elapsed(accumulator) };
}

function elapsed(accumulator: TurnAccumulator): number {
  return Math.max(0, Math.round(performance.now() - accumulator.startedAtMonotonic));
}

function emitActivity(state: InitializedWorker, turnId: string, observedAt = new Date().toISOString()): void {
  send({ type: "acp-activity", protocolVersion: ACP_WORKER_PROTOCOL_VERSION, ...identityOf(state), turnId, observedAt });
}

async function closeWorker(reason: string): Promise<void> {
  if (closingPromise !== undefined) return closingPromise;
  closing = true;
  closingPromise = (async () => {
    openingController?.abort();
    active?.controller.abort();
    await opening?.catch(() => undefined);
    if (initialized) await initialized.session.close(reason).then(() => undefined);
    if (identity) send({ type: "closed", protocolVersion: ACP_WORKER_PROTOCOL_VERSION, ...identity });
    process.disconnect?.();
    process.exit(process.exitCode ?? 0);
  })();
  return closingPromise;
}

function sendFailure(failure: AgentBackendFailure): void {
  if (identity) send({ type: "worker-failure", protocolVersion: ACP_WORKER_PROTOCOL_VERSION, ...identity, failure });
  process.exitCode = 1;
}

async function failAndClose(): Promise<void> {
  process.exitCode = 1;
  await closeWorker("worker failure");
}

function fail(failure: AgentBackendFailure): void {
  sendFailure(failure);
  void closeWorker("worker failure");
}

function send(message: AcpWorkerChildMessage): void {
  if (!process.connected) return;
  process.send?.(message);
}

function requireInitialized(message: AcpWorkerParentMessage): InitializedWorker {
  if (!initialized || initialized.workerId !== message.workerId || initialized.attemptId !== message.attemptId) {
    throw new Error("ACP worker received a message before initialization.");
  }
  return initialized;
}

function identityOf(state: InitializedWorker): WorkerIdentity {
  return { workerId: state.workerId, attemptId: state.attemptId };
}

function identityOfMessage(
  message: Pick<AcpWorkerParentMessage, "workerId" | "attemptId">,
): WorkerIdentity {
  return { workerId: message.workerId, attemptId: message.attemptId };
}

function terminalToolStatus(status: string | undefined): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function optionalValue<Key extends string, Value>(key: Key, value: Value | undefined): { [K in Key]?: Value } {
  return value === undefined ? {} : { [key]: value } as { [K in Key]: Value };
}

function preview(value: unknown) {
  const rendered = JSON.stringify(toAgentJsonValue(value));
  const originalBytes = Buffer.byteLength(rendered, "utf8");
  const limit = 4 * 1024;
  if (originalBytes <= limit) return { preview: rendered, truncated: false, originalBytes, headBytes: originalBytes };
  const content = Buffer.from(rendered, "utf8").subarray(0, limit).toString("utf8");
  return { preview: content, truncated: true, originalBytes, headBytes: Buffer.byteLength(content, "utf8") };
}
