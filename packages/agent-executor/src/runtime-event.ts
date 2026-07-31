import type { AcpRuntimeEvent } from "acpx/runtime";
import type { AgentJsonValue, AgentObservationEvent } from "./types.js";

const activityOnlyStatusTags = new Set([
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
]);

const clientOperationMethods = new Set([
  "fs/read_text_file",
  "fs/write_text_file",
  "terminal/create",
  "terminal/output",
  "terminal/wait_for_exit",
  "terminal/kill",
  "terminal/release",
]);

const clientOperationStatuses = new Set(["running", "completed", "failed"]);

export function observationEventFromRuntime(
  event: AcpRuntimeEvent,
  sequence: number,
  observedAt: string,
  elapsedMs: number,
): AgentObservationEvent | undefined {
  const base = { schemaVersion: 1 as const, sequence, observedAt, elapsedMs };
  if (event.type === "text_delta") {
    return {
      ...base,
      type: "message",
      channel: event.stream === "thought" ? "thought" : "assistant",
      content: event.text,
      ...(event.tag === undefined ? {} : { tag: event.tag }),
    };
  }
  if (event.type === "status") {
    const context = event.used === undefined || event.size === undefined ? undefined : { used: event.used, size: event.size };
    const tokenUsage = event.breakdown;
    if (context !== undefined || tokenUsage !== undefined) {
      return {
        ...base,
        type: "usage",
        ...(context === undefined ? {} : { context: toAgentJsonValue(context) }),
        ...(tokenUsage === undefined ? {} : { tokenUsage: toAgentJsonValue(tokenUsage) }),
      };
    }
    if (event.tag === "plan") return { ...base, type: "plan", value: event.text };
    if (event.tag !== undefined
      && (event.tag === "usage_update" || activityOnlyStatusTags.has(event.tag))) return;
    if (event.tag === undefined && activityOnlyUntaggedStatus(event.text)) return;
    return {
      ...base,
      type: "unknown",
      ...(event.tag === undefined ? {} : { tag: event.tag }),
      value: event.text,
    };
  }
  if (event.type === "tool_call") {
    return {
      ...base,
      type: "tool",
      action: event.status === undefined ? "call" : "update",
      ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
      ...(event.title === undefined ? {} : { title: event.title }),
      ...(event.kind === undefined ? {} : { kind: event.kind }),
      ...(event.status === undefined ? {} : { status: event.status }),
      ...(event.rawInput === undefined ? {} : { rawInput: toAgentJsonValue(event.rawInput) }),
      ...(event.rawOutput === undefined ? {} : { rawOutput: toAgentJsonValue(event.rawOutput) }),
      ...(event.content === undefined ? {} : { content: toAgentJsonValue(event.content) }),
      ...(event.locations === undefined ? {} : { locations: toAgentJsonValue(event.locations) }),
    };
  }
  return undefined;
}

function activityOnlyUntaggedStatus(text: string): boolean {
  if (text === "session resumed") return true;
  const [method, status] = text.split(/\s+/, 2);
  return method !== undefined
    && status !== undefined
    && clientOperationMethods.has(method)
    && clientOperationStatuses.has(status);
}

export function toAgentJsonValue(value: unknown): AgentJsonValue {
  try {
    const rendered = JSON.stringify(value);
    return rendered === undefined ? String(value) : JSON.parse(rendered) as AgentJsonValue;
  } catch {
    return String(value);
  }
}
