import { createHash, randomUUID } from "node:crypto";
import {
  createAcpRuntime,
  createAgentRegistry,
  type AcpRuntime,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
  type AcpRuntimeTurnResult,
} from "acpx/runtime";
import type {
  AgentBackendFailure,
  AgentJsonValue,
  AgentObservationEvent,
  AgentToolCallSummary,
  AgentTurnProgress,
  AgentTurnRequest,
  AgentTurnResult,
  AgentTurnSummary,
} from "./types.js";
import { observationEventFromRuntime, toAgentJsonValue } from "./runtime-event.js";
import { createAcpusSessionStore } from "./session-store.js";
import { createTurnResponseCollector } from "./turn-responses.js";
import { failureFromAcpRuntime, type AcpRuntimeOperation } from "./worker-failure.js";
import {
  ACP_WORKER_PROTOCOL_VERSION,
  isAcpWorkerParentMessage,
  type AcpWorkerChildMessage,
  type AcpWorkerParentMessage,
} from "./worker-protocol.js";

type InitializedWorker = {
  workerId: string;
  attemptId: string;
  cwd: string;
  agentName: string;
  model?: string;
  runtime: AcpRuntime;
};

type ActiveTurn = {
  turnId: string;
  controller: AbortController;
  cancel: () => Promise<void>;
  abortReason?: "aborted" | "timeout" | "inactivity";
};

type WorkerTurnRequest = Omit<AgentTurnRequest, "signal" | "onProgress" | "onObservation">;

type TurnAccumulator = {
  startedAt: string;
  startedAtMonotonic: number;
  sequence: number;
  responses: ReturnType<typeof createTurnResponseCollector>;
  context?: AgentTurnSummary["context"];
  tokenUsage?: AgentTurnSummary["tokenUsage"];
  tools: Map<string, AgentToolCallSummary>;
  eventCount: number;
  acpxRecordId?: string;
};

let initialized: InitializedWorker | undefined;
let handle: AcpRuntimeHandle | undefined;
let active: ActiveTurn | undefined;
let closing = false;

process.on("message", raw => {
  if (!isAcpWorkerParentMessage(raw)) return;
  void receive(raw).catch(error => fail(error));
});

process.once("disconnect", () => {
  void closeWorker("parent disconnected");
});

async function receive(message: AcpWorkerParentMessage): Promise<void> {
  if (message.type === "initialize") {
    if (initialized) throw new Error("ACP worker received duplicate initialization.");
    applyEnvironment(message.env);
    if (message.agent.kind === "named" && message.agent.name === "claude" && process.env.ACPX_CLAUDE_INCLUDE_USER_SETTINGS === undefined) {
      process.env.ACPX_CLAUDE_INCLUDE_USER_SETTINGS = "1";
    }
    const agentName = workerAgentName(message.agent);
    initialized = {
      workerId: message.workerId,
      attemptId: message.attemptId,
      cwd: message.cwd,
      agentName,
      ...(message.model === undefined ? {} : { model: message.model }),
      runtime: createAcpRuntime({
        cwd: message.cwd,
        sessionStore: createAcpusSessionStore(message.sessionStateDirectory),
        agentRegistry: createAgentRegistry({ overrides: { [agentName]: message.resolvedCommand } }),
        permissionMode: message.permissionMode,
      }),
    };
    send({ type: "ready", protocolVersion: ACP_WORKER_PROTOCOL_VERSION, workerId: message.workerId, attemptId: message.attemptId });
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
    await active.cancel().catch(() => {});
    return;
  }
  await closeWorker(message.reason);
}

async function runTurn(
  state: InitializedWorker,
  turnId: string,
  request: Omit<AgentTurnRequest, "signal" | "onProgress" | "onObservation">,
): Promise<void> {
  const accumulator = createAccumulator();
  let operation: AcpRuntimeOperation = "sessions.ensure";
  try {
    handle ??= await state.runtime.ensureSession({
      sessionKey: request.sessionName,
      agent: state.agentName,
      mode: "persistent",
      cwd: state.cwd,
      ...(state.model === undefined ? {} : { sessionOptions: { model: state.model } }),
    });
    if (handle.acpxRecordId !== undefined) accumulator.acpxRecordId = handle.acpxRecordId;
    for (const [key, value] of Object.entries(request.config ?? {}).filter(([key]) => key !== "model").sort(([left], [right]) => left.localeCompare(right))) {
      operation = "session.set_config_option";
      await state.runtime.setConfigOption?.({ handle, key, value });
    }

    operation = "prompt";
    const controller = new AbortController();
    const turn = state.runtime.startTurn({
      handle,
      text: request.prompt,
      mode: "prompt",
      requestId: randomUUID(),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      signal: controller.signal,
    });
    active = {
      turnId,
      controller,
      cancel: () => turn.cancel({ reason: "acpus attempt cleanup" }),
    };
    emitActivity(state, turnId);
    for await (const event of turn.events) emitRuntimeEvent(state, turnId, accumulator, event);
    const terminal = await turn.result;
    const result = terminalResult(accumulator, terminal, active?.abortReason);
    emitTurnEnd(state, turnId, accumulator, result);
    send({ type: "turn-result", protocolVersion: ACP_WORKER_PROTOCOL_VERSION, workerId: state.workerId, attemptId: state.attemptId, turnId, result });
  } catch (error) {
    const result = failedResult(accumulator, failureFromAcpRuntime(error, operation));
    emitTurnEnd(state, turnId, accumulator, result);
    send({ type: "turn-result", protocolVersion: ACP_WORKER_PROTOCOL_VERSION, workerId: state.workerId, attemptId: state.attemptId, turnId, result });
  } finally {
    active = undefined;
  }
}

function emitRuntimeEvent(state: InitializedWorker, turnId: string, accumulator: TurnAccumulator, event: AcpRuntimeEvent): void {
  const observedAt = new Date().toISOString();
  const elapsedMs = elapsed(accumulator);
  accumulator.eventCount += 1;
  updateAccumulator(accumulator, event, observedAt);
  const projected = observationEventFromRuntime(event, accumulator.sequence++, observedAt, elapsedMs);
  if (projected) {
    const observation = {
      event: projected,
      progress: progress(accumulator, observedAt),
    };
    send({ type: "turn-observation", protocolVersion: ACP_WORKER_PROTOCOL_VERSION, workerId: state.workerId, attemptId: state.attemptId, turnId, observation });
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
    workerId: state.workerId,
    attemptId: state.attemptId,
    turnId,
    observation: { event, progress: progress(accumulator, observedAt) },
  });
}

function updateAccumulator(accumulator: TurnAccumulator, event: AcpRuntimeEvent, observedAt: string): void {
  accumulator.responses.observe(event);
  if (event.type === "text_delta") return;
  if (event.type === "status") {
    if (event.used !== undefined && event.size !== undefined) {
      accumulator.context = { used: event.used, size: event.size, updatedAt: observedAt };
    }
    if (event.breakdown) {
      accumulator.tokenUsage = {
        source: "usage_update",
        ...event.breakdown,
      };
    }
    return;
  }
  if (event.type !== "tool_call") return;
  const id = event.toolCallId ?? `tool-${accumulator.eventCount}`;
  const previous = accumulator.tools.get(id);
  const startedAt = previous?.startedAt ?? observedAt;
  accumulator.tools.set(id, {
    toolCallId: id,
    ...(event.title === undefined ? {} : { title: event.title }),
    ...(event.kind === undefined ? {} : { kind: event.kind }),
    ...(event.status === undefined ? {} : { status: event.status }),
    ...(event.rawInput === undefined ? {} : { input: preview(event.rawInput) }),
    startedAt,
    updatedAt: observedAt,
    ...(terminalToolStatus(event.status) ? { completedAt: observedAt } : {}),
  });
}

function terminalResult(
  accumulator: TurnAccumulator,
  terminal: AcpRuntimeTurnResult,
  abortReason: ActiveTurn["abortReason"],
): AgentTurnResult {
  return terminalResultFromRuntime(accumulator, terminal, abortReason);
}

function terminalResultFromRuntime(
  accumulator: TurnAccumulator,
  terminal: AcpRuntimeTurnResult,
  abortReason: ActiveTurn["abortReason"],
): AgentTurnResult {
  if (abortReason === "inactivity") return staleResult(accumulator);
  if (abortReason === "timeout") return failedResult(accumulator, { kind: "timeout", origin: "runtime", message: "Agent turn exceeded its authored timeout." });
  if (abortReason === "aborted" || terminal.status === "cancelled") {
    return cancelledResult(accumulator, "Agent turn was aborted.", terminal.status === "cancelled" ? terminal.stopReason : undefined);
  }
  if (terminal.status === "failed") {
    return failedResult(accumulator, {
      kind: terminal.error?.code === "ACP_TURN_FAILED" ? "provider_exit" : "spawn",
      origin: "provider",
      message: terminal.error?.message ?? "ACP agent turn failed.",
      ...(terminal.error?.retryable === undefined ? {} : { retryable: terminal.error.retryable }),
      ...(terminal.error?.code === undefined ? {} : { upstream: { source: "acpx", operation: "prompt", code: terminal.error.code } }),
    });
  }
  return completedResult(accumulator, terminal.stopReason);
}

function createAccumulator(): TurnAccumulator {
  return {
    startedAt: new Date().toISOString(),
    startedAtMonotonic: performance.now(),
    sequence: 0,
    responses: createTurnResponseCollector(),
    tools: new Map(),
    eventCount: 0,
    ...(handle?.acpxRecordId === undefined ? {} : { acpxRecordId: handle.acpxRecordId }),
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

function failedResult(accumulator: TurnAccumulator, failure: AgentBackendFailure, stopReason?: string): AgentTurnResult {
  return {
    status: "failed",
    failure,
    responses: accumulator.responses.snapshot(),
    stderr: "",
    summary: summary(accumulator, stopReason),
    timing: timing(accumulator),
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
  }, undefined);
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
    ...(accumulator.acpxRecordId === undefined ? {} : { acpxRecordId: accumulator.acpxRecordId }),
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
  send({ type: "acp-activity", protocolVersion: ACP_WORKER_PROTOCOL_VERSION, workerId: state.workerId, attemptId: state.attemptId, turnId, observedAt });
}

async function closeWorker(reason: string): Promise<void> {
  if (closing) return;
  closing = true;
  active?.controller.abort();
  await active?.cancel().catch(() => {});
  if (initialized && handle) {
    await initialized.runtime.cancel({ handle, reason }).catch(() => {});
    await initialized.runtime.close({ handle, reason, discardPersistentState: false }).catch(() => {});
  }
  if (initialized) send({ type: "closed", protocolVersion: ACP_WORKER_PROTOCOL_VERSION, workerId: initialized.workerId, attemptId: initialized.attemptId });
  process.disconnect?.();
  process.exit(process.exitCode ?? 0);
}

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (initialized) send({ type: "worker-failure", protocolVersion: ACP_WORKER_PROTOCOL_VERSION, workerId: initialized.workerId, attemptId: initialized.attemptId, message });
  process.exitCode = 1;
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

function applyEnvironment(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function workerAgentName(agent: WorkerTurnRequest["agent"]): string {
  if (agent.kind === "named") return agent.name;
  return `acpus-command-${createHash("sha256").update(agent.command).digest("hex").slice(0, 16)}`;
}

function terminalToolStatus(status: string | undefined): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function preview(value: unknown) {
  const rendered = JSON.stringify(toAgentJsonValue(value));
  const originalBytes = Buffer.byteLength(rendered, "utf8");
  const limit = 4 * 1024;
  if (originalBytes <= limit) return { preview: rendered, truncated: false, originalBytes, headBytes: originalBytes };
  const preview = Buffer.from(rendered, "utf8").subarray(0, limit).toString("utf8");
  return { preview, truncated: true, originalBytes, headBytes: Buffer.byteLength(preview, "utf8") };
}
