import type { AcpEvent } from "@acpus/acp";
import type { AgentJsonValue, AgentObservationEvent } from "./types.js";

export function observationEventFromRuntime(
  event: AcpEvent,
  sequence: number,
  observedAt: string,
  elapsedMs: number,
): AgentObservationEvent | undefined {
  const base = { schemaVersion: 1 as const, sequence, observedAt, elapsedMs };
  if (event.type === "message") {
    return {
      ...base,
      type: "message",
      channel: event.channel,
      content: toAgentJsonValue(event.content),
    };
  }
  if (event.type === "tool") {
    return {
      ...base,
      type: "tool",
      action: event.action,
      toolCallId: event.toolCallId,
      ...(event.title === undefined ? {} : { title: event.title }),
      ...(event.name === undefined ? {} : { toolName: event.name }),
      ...(event.kind === undefined ? {} : { kind: event.kind }),
      ...(event.status === undefined ? {} : { status: event.status }),
      ...(event.input === undefined ? {} : { rawInput: toAgentJsonValue(event.input) }),
      ...(event.output === undefined ? {} : { rawOutput: toAgentJsonValue(event.output) }),
      ...(event.content === undefined ? {} : { content: toAgentJsonValue(event.content) }),
      ...(event.locations === undefined ? {} : { locations: toAgentJsonValue(event.locations) }),
    };
  }
  if (event.type === "usage") {
    return {
      ...base,
      type: "usage",
      ...(event.context === undefined ? {} : { context: toAgentJsonValue(event.context) }),
      ...(event.tokens === undefined ? {} : { tokenUsage: toAgentJsonValue(event.tokens) }),
    };
  }
  if (event.type === "plan") {
    return { ...base, type: "plan", value: toAgentJsonValue(event.value) };
  }
  if (event.type === "unknown") {
    return {
      ...base,
      type: "unknown",
      tag: event.name,
      value: toAgentJsonValue(event.value),
    };
  }
  return undefined;
}

export function toAgentJsonValue(value: unknown): AgentJsonValue {
  try {
    const rendered = JSON.stringify(value);
    return rendered === undefined ? String(value) : JSON.parse(rendered) as AgentJsonValue;
  } catch {
    return String(value);
  }
}
