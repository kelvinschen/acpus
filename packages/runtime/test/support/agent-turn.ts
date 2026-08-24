import type {
  AcpError,
  AcpEvent,
  AgentPermissionMode,
  AgentSelector,
  AgentTurnEvent,
  AgentTurnSummary,
  AgentTurnTiming,
} from "@acpus/agent-executor";

export type FixtureAgentBackendFailure = {
  kind: "config" | "spawn" | "provider_exit" | "timeout" | "worker_lost" | "inactivity_stale";
  origin?: "provider" | "runtime";
  retryable?: boolean;
  message: string;
  evidence?: { failAfterMs: number; silentForMs: number; silenceStartedAt: string };
  upstream?: { source: "acp"; operation: "open_session" | "configure_session" | "run_turn"; code?: string | number; origin?: string };
};

export type FixtureAgentTurnProgress = {
  responses: readonly string[];
  summary: AgentTurnSummary;
  updatedAt: string;
};

export type FixtureObservationEvent = Omit<AgentTurnEvent, "event"> & ({
  schemaVersion: 1;
} & (
  | { type: "message"; channel: "assistant" | "thought"; content: unknown }
  | { type: "tool"; action: "call" | "update"; toolCallId?: string; title?: string; kind?: string; toolName?: string; status?: string; rawInput?: unknown; rawOutput?: unknown; content?: unknown; locations?: unknown }
  | { type: "usage"; context?: unknown; tokenUsage?: unknown }
  | { type: "plan"; value: unknown }
  | { type: "unknown"; tag?: string; value: unknown }
  | { type: "turn_end"; status: "completed" | "failed" | "cancelled" | "timed_out"; stopReason?: string; failure?: unknown; message?: string }
));

export type FixtureAgentTurnObservation = {
  event: FixtureObservationEvent;
  progress: FixtureAgentTurnProgress;
};

export type FixtureAgentTurnRequest = {
  agent: AgentSelector;
  prompt: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  agentSessionId: string;
  permissionMode: AgentPermissionMode;
  model?: string;
  config?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentTurnEvent) => unknown;
  onProgress?: (progress: FixtureAgentTurnProgress) => unknown;
  onObservation?: (observation: FixtureAgentTurnObservation) => unknown;
};

type FixtureAgentTurnBase = {
  responses: readonly string[];
  stderr: string;
  summary: AgentTurnSummary;
  timing: AgentTurnTiming;
};

export type FixtureAgentTurnResult = FixtureAgentTurnBase & (
  | { status: "completed"; finalResponse: string }
  | { status: "failed"; failure: FixtureAgentBackendFailure }
  | { status: "cancelled"; message: string }
);

export function agentSummary(eventCount: number): AgentTurnSummary {
  return {
    eventCount,
    availability: { context: "unavailable", tokenUsage: "unavailable" },
    tools: { totalToolCallCount: 0, calls: [] },
  };
}

export function agentTiming(elapsedMs = 1): AgentTurnTiming {
  return {
    startedAt: "2026-07-01T00:00:00.000Z",
    finishedAt: "2026-07-01T00:00:00.001Z",
    elapsedMs,
  };
}

export function completedAgentTurn(finalResponse: string, stderr = "", summary = agentSummary(1)): FixtureAgentTurnResult {
  return segmentedCompletedAgentTurn(finalResponse.length === 0 ? [] : [finalResponse], finalResponse, stderr, summary);
}

export function segmentedCompletedAgentTurn(
  responses: readonly string[],
  finalResponse: string,
  stderr = "",
  summary = agentSummary(1),
): FixtureAgentTurnResult {
  return { status: "completed", responses: [...responses], finalResponse, stderr, summary, timing: agentTiming() };
}

export function taggedAgentOutput(payload: string): string {
  return `<ACPUS_OUTPUT>\n${payload}\n</ACPUS_OUTPUT>`;
}

export function observedCompletedAgentTurn(request: FixtureAgentTurnRequest, finalResponse: string): FixtureAgentTurnResult {
  const result = completedAgentTurn(finalResponse);
  request.onObservation?.({
    event: {
      schemaVersion: 1,
      sequence: 0,
      observedAt: "2026-07-01T00:00:00.001Z",
      elapsedMs: 1,
      type: "message",
      channel: "assistant",
      content: { type: "text", text: finalResponse },
    },
    progress: { responses: [...result.responses], summary: result.summary, updatedAt: "2026-07-01T00:00:00.001Z" },
  });
  return result;
}

export function fixtureEvent(value: FixtureObservationEvent): AcpEvent | undefined {
  if (value.type === "turn_end") return undefined;
  if (value.type === "message") {
    const content = typeof value.content === "string" ? { type: "text", text: value.content } : value.content;
    return { type: "message", channel: value.channel, content: json(content) };
  }
  if (value.type === "tool") return {
    type: "tool",
    action: value.action,
    toolCallId: value.toolCallId ?? `fixture-tool-${value.sequence}`,
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(value.toolName === undefined ? {} : { name: value.toolName }),
    ...(value.kind === undefined ? {} : { kind: value.kind }),
    ...(value.status === undefined ? {} : { status: value.status }),
    ...(value.rawInput === undefined ? {} : { input: json(value.rawInput) }),
    ...(value.rawOutput === undefined ? {} : { output: json(value.rawOutput) }),
    ...(value.content === undefined ? {} : { content: json(value.content) }),
    ...(value.locations === undefined ? {} : { locations: json(value.locations) }),
  };
  if (value.type === "usage") return {
    type: "usage",
    ...(isContext(value.context) ? { context: value.context } : {}),
    ...(isTokens(value.tokenUsage) ? { tokens: value.tokenUsage } : {}),
  };
  if (value.type === "plan") return { type: "plan", value: json(value.value) };
  return { type: "unknown", name: value.tag ?? "fixture", value: json(value.value) };
}

export function acpErrorFromFixture(failure: FixtureAgentBackendFailure): AcpError {
  const operation = failure.upstream?.operation ?? "run_turn";
  const common = {
    operation,
    origin: failure.origin === "runtime" ? "client" as const : "provider" as const,
    providerEvidence: "terminal_response" as const,
    message: failure.message,
    retryable: failure.retryable ?? false,
    ...(failure.upstream?.code === undefined ? {} : { code: failure.upstream.code }),
  };
  if (failure.kind === "config") return { type: "configuration", ...common };
  if (failure.kind === "spawn") return { type: "spawn", ...common, origin: "process", providerEvidence: "none" };
  return { type: "protocol", ...common };
}

function json(value: unknown): Extract<AcpEvent, { type: "message" }>["content"] {
  return JSON.parse(JSON.stringify(value ?? null)) as Extract<AcpEvent, { type: "message" }>["content"];
}

function isContext(value: unknown): value is { used: number; size: number } {
  return !!value && typeof value === "object" && typeof (value as { used?: unknown }).used === "number" && typeof (value as { size?: unknown }).size === "number";
}

function isTokens(value: unknown): value is NonNullable<Extract<AcpEvent, { type: "usage" }>["tokens"]> {
  return !!value && typeof value === "object";
}
