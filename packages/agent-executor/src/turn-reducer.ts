import type { AcpJsonValue, AcpTurnResult } from "@acpus/acp";
import type {
  AgentContextSummary,
  AgentTokenUsageSummary,
  AgentToolCallSummary,
  AgentTurnEvent,
  AgentTurnSnapshot,
  AgentTurnSummary,
} from "./types.js";

export type AgentTurnReducer = Readonly<{
  observe(envelope: AgentTurnEvent): void;
  snapshot(
    terminal?: AcpTurnResult,
    timing?: Readonly<{ finishedAt: string; elapsedMs: number }>,
  ): AgentTurnSnapshot;
  finalResponse(): string;
}>;

export function createAgentTurnReducer(startedAt = new Date().toISOString()): AgentTurnReducer {
  const startedAtMonotonic = performance.now();
  const responses: string[] = [];
  const tools = new Map<string, AgentToolCallSummary>();
  let openResponse: number | undefined;
  let finalCandidate: number | undefined;
  let context: AgentContextSummary | undefined;
  let tokenUsage: AgentTokenUsageSummary | undefined;
  let eventCount = 0;

  const observe = (envelope: AgentTurnEvent): void => {
    eventCount += 1;
    const event = envelope.event;
    if (event.type === "message") {
      if (event.channel === "thought") {
        openResponse = undefined;
        return;
      }
      const text = textBlockContent(event.content);
      if (!text) return;
      if (openResponse === undefined) openResponse = responses.push(text) - 1;
      else responses[openResponse] += text;
      finalCandidate = openResponse;
      return;
    }
    if (event.type === "tool") {
      openResponse = undefined;
      if (event.action === "call") finalCandidate = undefined;
      const previous = tools.get(event.toolCallId);
      const status = event.status ?? previous?.status;
      tools.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        ...optional("title", event.title ?? previous?.title),
        ...optional("toolName", event.name ?? previous?.toolName),
        ...optional("kind", event.kind ?? previous?.kind),
        ...optional("status", status),
        ...(event.input === undefined ? optional("input", previous?.input) : { input: preview(event.input) }),
        startedAt: previous?.startedAt ?? envelope.observedAt,
        updatedAt: envelope.observedAt,
        ...(terminalToolStatus(status) ? { completedAt: previous?.completedAt ?? envelope.observedAt } : {}),
      });
      return;
    }
    if (event.type === "plan") {
      openResponse = undefined;
      return;
    }
    if (event.type === "usage") {
      if (event.context) context = { ...event.context, updatedAt: envelope.observedAt };
      if (event.tokens) tokenUsage = { source: "usage_update", ...event.tokens };
    }
  };

  const snapshot = (
    terminal?: AcpTurnResult,
    timing?: Readonly<{ finishedAt: string; elapsedMs: number }>,
  ): AgentTurnSnapshot => {
    if (terminal?.usage) tokenUsage = { source: "prompt_response", ...terminal.usage };
    const finishedAt = timing?.finishedAt ?? new Date().toISOString();
    const summary: AgentTurnSummary = {
      eventCount,
      availability: {
        context: context ? "available" : "unavailable",
        tokenUsage: tokenUsage ? "available" : "unavailable",
      },
      ...(terminal?.stopReason === undefined ? {} : { stopReason: terminal.stopReason }),
      ...(context === undefined ? {} : { context }),
      ...(tokenUsage === undefined ? {} : { tokenUsage }),
      tools: { totalToolCallCount: tools.size, calls: [...tools.values()] },
    };
    return {
      responses: [...responses],
      summary,
      timing: {
        startedAt,
        finishedAt,
        elapsedMs: timing?.elapsedMs ?? Math.max(0, Math.round(performance.now() - startedAtMonotonic)),
      },
    };
  };

  return {
    observe,
    snapshot,
    finalResponse: () => finalCandidate === undefined ? "" : responses[finalCandidate]!,
  };
}

function textBlockContent(content: AcpJsonValue): string | undefined {
  if (content === null || Array.isArray(content) || typeof content !== "object") return undefined;
  return content.type === "text" && typeof content.text === "string" ? content.text : undefined;
}

function terminalToolStatus(status: string | undefined): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function optional<Key extends string, Value>(key: Key, value: Value | undefined): { [K in Key]?: Value } {
  return value === undefined ? {} : { [key]: value } as { [K in Key]: Value };
}

function preview(value: AcpJsonValue) {
  const rendered = JSON.stringify(value);
  const originalBytes = Buffer.byteLength(rendered, "utf8");
  const limit = 4 * 1024;
  if (originalBytes <= limit) return { preview: rendered, truncated: false, originalBytes, headBytes: originalBytes };
  const content = Buffer.from(rendered, "utf8").subarray(0, limit).toString("utf8");
  return { preview: content, truncated: true, originalBytes, headBytes: Buffer.byteLength(content, "utf8") };
}
