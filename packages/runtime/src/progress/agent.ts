import type {
  AgentToolCallSummary,
  AgentTurnEvent,
  AgentTurnSnapshot,
  AgentTurnSummary,
  AcpEvent,
} from "@acpus/agent-executor";
type AcpJsonValue = Extract<AcpEvent, { type: "message" }>["content"];
import type { JsonValue } from "@acpus/expression/ir";
import { pruneUndefined } from "../stable-json.js";
import type { WriteNodeProgressInput } from "../store/store.js";
import { utf8Head, utf8Tail } from "../utf8.js";
import type { NodeProgressWriter } from "./writer.js";

const FLUSH_INTERVAL_MS = 1_000;
const ACP_ACTIVITY_FLUSH_INTERVAL_MS = 5_000;
const OUTPUT_TAIL_BYTES = 16 * 1024;
const TOOL_LIMIT = 3;
const DETAIL_EDGE_BYTES = 2 * 1024;

export type AgentProgressTerminalStatus = "completed" | "failed" | "cancelled" | "timed_out";

export type AgentProgressTurnInput = {
  writer: NodeProgressWriter;
  runId: string;
  nodeKey: string;
  nodeId: string;
  attemptId: string;
  attemptNo: number;
  ownerEpoch: number;
  turn: number;
  signal?: AbortSignal;
};

export type AgentProgressTurn = {
  callbacks: {
    onEvent(event: AgentTurnEvent): void;
  };
  publishTerminal(
    status: AgentProgressTerminalStatus,
    snapshot: AgentTurnSnapshot,
    message?: string,
  ): void;
  recordAcpActivity(observedAt: string): void;
  clearAcpActivity(): void;
};

type ObservationState = {
  intent?: JsonValue;
  toolOutputs: Map<string, JsonValue>;
};

type ProgressSample = Pick<AgentTurnSnapshot, "responses" | "summary">;

export function createAgentProgressTurn(input: AgentProgressTurnInput): AgentProgressTurn {
  const observation: ObservationState = { toolOutputs: new Map() };
  let lastFlushAt: number | undefined;
  let lastSignature = "";
  let lastSample: ProgressSample = { responses: [], summary: emptySummary() };
  let openResponse: number | undefined;
  const tools = new Map<string, AgentToolCallSummary>();
  let acpActivityAt: string | undefined;
  let lastAcpActivityFlushAt: number | undefined;

  return {
    callbacks: {
      onEvent: event => {
        updateObservation(observation, event);
        if (input.signal?.aborted) return;
        const reduced = reduceProgressEvent(lastSample, tools, event, openResponse);
        lastSample = reduced.sample;
        openResponse = reduced.openResponse;
        const next = progressSnapshot(input, lastSample, latestResponse(lastSample.responses), observation, "running", `turn ${input.turn}`, acpActivityAt);
        const signature = JSON.stringify([next.context, next.tokenUsage, next.tools, next.intent, next.acpActivityAt]);
        const now = Date.now();
        if (lastFlushAt !== undefined && signature === lastSignature && now - lastFlushAt < FLUSH_INTERVAL_MS) return;
        input.writer.writeNodeProgress(next);
        lastFlushAt = now;
        lastSignature = signature;
      },
    },
    publishTerminal: (status, snapshot, message) => {
      if (input.signal?.aborted) return;
      acpActivityAt = undefined;
      input.writer.writeNodeProgress(progressSnapshot(
        input,
        snapshot,
        latestResponse(snapshot.responses),
        observation,
        status,
        message ?? `turn ${input.turn} ${status}`,
        undefined,
      ));
    },
    recordAcpActivity: observedAt => {
      if (input.signal?.aborted) return;
      acpActivityAt = observedAt;
      const now = Date.now();
      if (lastAcpActivityFlushAt !== undefined && now - lastAcpActivityFlushAt < ACP_ACTIVITY_FLUSH_INTERVAL_MS) return;
      input.writer.writeNodeProgress(progressSnapshot(input, lastSample, latestResponse(lastSample.responses), observation, "running", `turn ${input.turn}`, acpActivityAt));
      lastAcpActivityFlushAt = now;
    },
    clearAcpActivity: () => {
      if (input.signal?.aborted || acpActivityAt === undefined) return;
      acpActivityAt = undefined;
      input.writer.writeNodeProgress(progressSnapshot(input, lastSample, latestResponse(lastSample.responses), observation));
    },
  };
}

function progressSnapshot(
  input: AgentProgressTurnInput,
  progress: ProgressSample,
  response: string,
  observation: ObservationState,
  status: "running" | AgentProgressTerminalStatus = "running",
  message = `turn ${input.turn}`,
  acpActivityAt?: string,
): WriteNodeProgressInput {
  const output = outputTail(response);
  return pruneUndefined({
    runId: input.runId,
    nodeKey: input.nodeKey,
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    attemptNo: input.attemptNo,
    ownerEpoch: input.ownerEpoch,
    kind: "agent",
    status,
    message,
    output,
    context: progress.summary.context,
    tokenUsage: progress.summary.tokenUsage,
    tools: progressTools(progress.summary.tools, input.turn, observation.toolOutputs),
    intent: observation.intent,
    acpActivityAt,
  }) as WriteNodeProgressInput;
}

function latestResponse(responses: readonly string[]): string {
  return responses.at(-1) ?? "";
}

function emptySummary(): AgentTurnSummary {
  return {
    eventCount: 0,
    availability: { context: "unavailable", tokenUsage: "unavailable" },
    tools: { totalToolCallCount: 0, calls: [] },
  };
}

function outputTail(value: string): NonNullable<WriteNodeProgressInput["output"]> | undefined {
  if (value.length === 0) return undefined;
  const totalBytes = Buffer.byteLength(value, "utf8");
  if (totalBytes <= OUTPUT_TAIL_BYTES) return { tail: value, totalBytes, truncated: false };
  return { tail: utf8Tail(value, OUTPUT_TAIL_BYTES), totalBytes, truncated: true };
}

function progressTools(
  tools: AgentTurnSummary["tools"],
  turn: number,
  outputs: ReadonlyMap<string, JsonValue>,
): JsonValue {
  return {
    turn,
    totalToolCallCount: tools.totalToolCallCount,
    lastCalls: tools.calls.slice(-TOOL_LIMIT).map(call => progressToolCall(call, outputs.get(call.toolCallId))),
  };
}

function progressToolCall(call: AgentToolCallSummary, output?: JsonValue): JsonValue {
  return pruneUndefined({
    toolCallId: call.toolCallId,
    title: call.title,
    kind: call.kind,
    toolName: call.toolName,
    status: call.status,
    inputPreview: call.input?.preview,
    output,
    startedAt: call.startedAt,
    updatedAt: call.updatedAt,
    completedAt: call.completedAt,
  }) as JsonValue;
}

function updateObservation(state: ObservationState, observation: AgentTurnEvent): void {
  const event = observation.event;
  if (event.type === "plan") {
    state.intent = {
      kind: "plan",
      value: boundedProgressValue(event.value),
      updatedAt: observation.observedAt,
    };
    return;
  }
  if (event.type === "message" && event.channel === "thought") {
    state.intent = {
      kind: "reported-thought",
      value: boundedProgressValue(event.content),
      updatedAt: observation.observedAt,
    };
    return;
  }
  if (event.type !== "tool") return;
  const output = event.output ?? event.content;
  if (output !== undefined) state.toolOutputs.set(event.toolCallId, boundedProgressValue(output));
}

function reduceProgressEvent(
  previous: ProgressSample,
  tools: Map<string, AgentToolCallSummary>,
  envelope: AgentTurnEvent,
  currentOpenResponse: number | undefined,
): { sample: ProgressSample; openResponse?: number } {
  const responses = [...previous.responses];
  const summary = { ...previous.summary };
  const event = envelope.event;
  let openResponse = currentOpenResponse;
  if (event.type === "message") {
    if (event.channel === "thought") openResponse = undefined;
    else if (typeof event.content === "object" && event.content !== null && !Array.isArray(event.content)
      && event.content.type === "text" && typeof event.content.text === "string") {
      if (openResponse === undefined) openResponse = responses.push(event.content.text) - 1;
      else responses[openResponse] = (responses[openResponse] ?? "") + event.content.text;
    }
  } else if (event.type === "tool") {
    openResponse = undefined;
    const prior = tools.get(event.toolCallId);
    const status = event.status ?? prior?.status;
    tools.set(event.toolCallId, {
      toolCallId: event.toolCallId,
      ...optionalStringValue("title", event.title ?? prior?.title),
      ...optionalStringValue("toolName", event.name ?? prior?.toolName),
      ...optionalStringValue("kind", event.kind ?? prior?.kind),
      ...(status ? { status } : {}),
      startedAt: prior?.startedAt ?? envelope.observedAt,
      updatedAt: envelope.observedAt,
      ...(["completed", "failed", "cancelled"].includes(status ?? "") ? { completedAt: envelope.observedAt } : {}),
    });
  } else if (event.type === "plan") {
    openResponse = undefined;
  } else if (event.type === "usage") {
    if (event.context) summary.context = { ...event.context, updatedAt: envelope.observedAt };
    if (event.tokens) summary.tokenUsage = { source: "usage_update", ...event.tokens };
  }
  summary.eventCount += 1;
  summary.availability = {
    context: summary.context ? "available" : "unavailable",
    tokenUsage: summary.tokenUsage ? "available" : "unavailable",
  };
  summary.tools = { totalToolCallCount: tools.size, calls: [...tools.values()] };
  return { sample: { responses, summary }, ...(openResponse === undefined ? {} : { openResponse }) };
}

function optionalStringValue<Key extends string>(key: Key, value: string | undefined): { [K in Key]?: string } {
  return value === undefined ? {} : { [key]: value } as { [K in Key]: string };
}

function boundedProgressValue(value: AcpJsonValue): JsonValue {
  const json = JSON.stringify(value);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= DETAIL_EDGE_BYTES * 2) return value as JsonValue;
  return {
    truncated: true,
    originalBytes: bytes,
    head: utf8Head(json, DETAIL_EDGE_BYTES),
    tail: utf8Tail(json, DETAIL_EDGE_BYTES),
  };
}
