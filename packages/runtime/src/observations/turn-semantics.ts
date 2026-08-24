import {
  type AgentContextSummary,
  type AgentTokenUsageSummary,
  type AgentTurnEvent,
  type AgentTurnSnapshot,
  type AcpEvent,
} from "@acpus/agent-executor";
import { utf8Head, utf8Tail } from "../utf8.js";

const responseCheckpointBytes = 512;
const checkpointIntervalMs = 10_000;
const currentResponseBytes = 1536;
const currentIntentBytes = 768;
const currentToolBytes = 768;
const timelineEntryBytes = 512;
const terminalToolStatuses = new Set(["completed", "failed", "cancelled", "canceled"]);

export type AgentPromptKind = "task" | "steer" | "repair";
export type AgentObservationState = "recording" | "settled" | "incomplete";
export type AgentObservationCompleteness = "complete" | "degraded";
type AgentObservationPhase =
  | "starting"
  | "responding"
  | "thinking"
  | "planning"
  | "tool"
  | "repairing"
  | "between"
  | "settled";

type AgentObservationIdentity = {
  attemptId: string;
  turn: number;
  promptKind: AgentPromptKind;
};

export type AgentObservationExcerpt = {
  text: string;
  originalBytes: number;
  truncated: boolean;
};

export type AgentObservationToolActivity = {
  toolCallId?: string;
  name: string;
  title?: string;
  status?: string;
  input?: AgentObservationExcerpt;
  output?: AgentObservationExcerpt;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
};

export type AgentObservationCurrent = {
  attemptId: string;
  turn: number;
  promptKind: AgentPromptKind;
  phase: AgentObservationPhase;
  updatedAt: string;
  postFence?: true;
  response?: AgentObservationExcerpt;
  context?: AgentContextSummary;
  tokenUsage?: AgentTokenUsageSummary;
  intent?: {
    kind: "plan" | "reported-thought";
    excerpt: AgentObservationExcerpt;
  };
  tools?: {
    active: AgentObservationToolActivity[];
    recent?: AgentObservationToolActivity;
    omittedActive: number;
  };
  state: AgentObservationState;
  completeness: AgentObservationCompleteness;
};

export type AgentObservationEntryBase = {
  id: string;
  observationVersion: number;
  attemptId: string;
  turn: number;
  sourceSequence: number;
  at: string;
};

export type AgentObservationSemanticEntry =
  | AgentObservationEntryBase & {
      kind: "activity";
      channel: "response" | "reported-thought" | "plan" | "tool";
      summary: AgentObservationExcerpt;
      tool?: AgentObservationToolActivity;
      postFence?: true;
    }
  | AgentObservationEntryBase & {
      kind: "gap";
      dropped: number;
      reason: string;
    };

export type PendingSemanticEntry =
  | Omit<Extract<AgentObservationSemanticEntry, { kind: "activity" }>, "observationVersion">
  | Omit<Extract<AgentObservationSemanticEntry, { kind: "gap" }>, "observationVersion">;

export type SemanticMutation = {
  entries: PendingSemanticEntry[];
  checkpoint: boolean;
  current: AgentObservationCurrent | undefined;
  observedAt: string;
};

export class AgentObservationSemanticReducer {
  private segment: {
    channel: "response" | "reported-thought" | "plan";
    sourceSequence: number;
    at: string;
    text: string;
    originalBytes: number;
  } | undefined;
  private readonly tools = new Map<string, AgentObservationToolActivity & { sourceSequence: number }>();
  private recentTool: AgentObservationToolActivity | undefined;
  private updatedAt: string;
  private lastCheckpointAt = 0;
  private lastCheckpointTextBytes = 0;
  private unknownSeen = false;
  private fenced = false;
  private context?: AgentContextSummary;
  private tokenUsage?: AgentTokenUsageSummary;

  constructor(private readonly identity: AgentObservationIdentity) {
    this.updatedAt = "";
  }

  initialCurrent(observedAt: string): AgentObservationCurrent {
    this.updatedAt = observedAt;
    this.lastCheckpointAt = Date.parse(observedAt);
    return this.current(false);
  }

  observe(
    observation: AgentTurnEvent,
    degraded: boolean,
  ): SemanticMutation {
    const { event } = observation;
    const telemetryChanged = this.updateTelemetry(event, observation.observedAt);
    if (event.type === "usage") {
      this.updatedAt = observation.observedAt;
      return {
        entries: [],
        checkpoint: telemetryChanged,
        current: telemetryChanged ? this.current(degraded) : undefined,
        observedAt: observation.observedAt,
      };
    }
    this.updatedAt = observation.observedAt;
    const beforePhase = this.phase();
    const entries: PendingSemanticEntry[] = [];
    let toolBoundary = false;
    const firstUnknown = event.type === "unknown" && !this.unknownSeen;
    if (event.type === "unknown") this.unknownSeen = true;
    if (event.type === "message") {
      const channel = event.channel === "assistant" ? "response" : "reported-thought";
      if (this.segment?.channel !== channel) entries.push(...this.closeSegment());
      this.segment ??= {
        channel,
        sourceSequence: observation.sequence,
        at: observation.observedAt,
        text: "",
        originalBytes: 0,
      };
      appendSemanticText(this.segment, eventText(event.content));
      this.segment.at = observation.observedAt;
    } else if (event.type === "plan") {
      if (this.segment?.channel !== "plan") entries.push(...this.closeSegment());
      this.segment ??= {
        channel: "plan",
        sourceSequence: observation.sequence,
        at: observation.observedAt,
        text: "",
        originalBytes: 0,
      };
      appendSemanticText(this.segment, eventText(event.value));
      this.segment.at = observation.observedAt;
    } else if (event.type === "tool") {
      entries.push(...this.closeSegment());
      const id = event.toolCallId;
      const previous = this.tools.get(id);
      const tool = mergeTool(previous, { ...event, sequence: observation.sequence, observedAt: observation.observedAt });
      if (terminalToolStatuses.has(tool.status ?? "")) {
        toolBoundary = true;
        entries.push(toolEntry(
          this.identity,
          tool,
          previous?.sourceSequence ?? observation.sequence,
          this.fenced,
        ));
        this.tools.delete(id);
        this.recentTool = tool;
      } else {
        toolBoundary = previous === undefined;
        this.tools.set(id, { ...tool, sourceSequence: previous?.sourceSequence ?? observation.sequence });
      }
    }
    const afterPhase = this.phase();
    const now = Date.parse(observation.observedAt);
    const textBytes = this.segment?.originalBytes ?? 0;
    const checkpoint = entries.length > 0
      || beforePhase !== afterPhase
      || toolBoundary
      || firstUnknown
      || telemetryChanged
      || textBytes - this.lastCheckpointTextBytes >= responseCheckpointBytes
      || Number.isFinite(now) && now - this.lastCheckpointAt >= checkpointIntervalMs;
    if (checkpoint) {
      this.lastCheckpointAt = Number.isFinite(now) ? now : this.lastCheckpointAt;
      this.lastCheckpointTextBytes = textBytes;
    }
    return {
      entries,
      checkpoint,
      current: this.current(degraded),
      observedAt: observation.observedAt,
    };
  }

  boundary(at: string): SemanticMutation {
    this.updatedAt = at;
    const entries = this.closeAll();
    this.fenced = true;
    return { entries, checkpoint: true, current: undefined, observedAt: at };
  }

  terminal(
    snapshot: AgentTurnSnapshot,
    degraded: boolean,
    completed?: Readonly<{ finalResponse: string }>,
  ): SemanticMutation {
    const at = snapshot.timing.finishedAt;
    this.updatedAt = at;
    if (snapshot.summary.context === undefined) delete this.context;
    else this.context = snapshot.summary.context;
    if (snapshot.summary.tokenUsage === undefined) delete this.tokenUsage;
    else this.tokenUsage = snapshot.summary.tokenUsage;
    const entries = this.closeAll();
    const response = completed?.finalResponse ?? snapshot.responses.at(-1) ?? "";
    return {
      entries,
      checkpoint: true,
      current: this.current(degraded, {
        phase: "settled",
        state: "settled",
        ...(response.length === 0
          ? {}
          : { response: excerpt(response, currentResponseBytes, "tail") }),
      }),
      observedAt: at,
    };
  }

  gap(
    at: string,
    sourceSequence: number,
    dropped: number,
    reason: string,
  ): SemanticMutation {
    this.updatedAt = at;
    const entries = this.closeAll();
    entries.push({
      id: `observation:${this.identity.attemptId}:${this.identity.turn}:${sourceSequence}:gap`,
      kind: "gap",
      attemptId: this.identity.attemptId,
      turn: this.identity.turn,
      sourceSequence,
      at,
      dropped,
      reason,
    });
    return { entries, checkpoint: true, current: undefined, observedAt: at };
  }

  private current(
    degraded: boolean,
    terminal: Partial<Pick<AgentObservationCurrent, "phase" | "response" | "state">> = {},
  ): AgentObservationCurrent {
    const active = [...this.tools.values()]
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    const selected = active.slice(-2).map(({ sourceSequence: _sourceSequence, ...tool }) => tool);
    const phase = this.phase();
    const segment = this.segment;
    return {
      attemptId: this.identity.attemptId,
      turn: this.identity.turn,
      promptKind: this.identity.promptKind,
      phase: terminal.phase ?? phase,
      updatedAt: this.updatedAt,
      ...(this.fenced ? { postFence: true } : {}),
      ...(terminal.response
        ? { response: terminal.response }
        : segment?.channel === "response" && segment.text
        ? { response: semanticExcerpt(segment, currentResponseBytes) }
        : {}),
      ...(this.context === undefined ? {} : { context: this.context }),
      ...(this.tokenUsage === undefined ? {} : { tokenUsage: this.tokenUsage }),
      ...(segment && segment.channel !== "response" && segment.text
        ? {
            intent: {
              kind: segment.channel,
              excerpt: semanticExcerpt(segment, currentIntentBytes),
            },
          }
        : {}),
      ...(active.length > 0 || this.recentTool
        ? {
            tools: {
              active: selected,
              ...(active.length === 0 && this.recentTool ? { recent: this.recentTool } : {}),
              omittedActive: Math.max(0, active.length - selected.length),
            },
          }
        : {}),
      state: terminal.state ?? "recording",
      completeness: degraded ? "degraded" : "complete",
    };
  }

  private updateTelemetry(event: AcpEvent, observedAt: string): boolean {
    if (event.type !== "usage") return false;
    const context = event.context === undefined ? undefined : { ...event.context, updatedAt: observedAt };
    const tokenUsage = event.tokens === undefined ? undefined : { source: "usage_update" as const, ...event.tokens };
    const changed = !equalTelemetry(this.context, context) || !equalTelemetry(this.tokenUsage, tokenUsage);
    if (context === undefined) delete this.context;
    else this.context = context;
    if (tokenUsage === undefined) delete this.tokenUsage;
    else this.tokenUsage = tokenUsage;
    return changed;
  }

  private phase(): AgentObservationPhase {
    if (this.tools.size > 0) return "tool";
    if (this.segment?.channel === "plan") return "planning";
    if (this.segment?.channel === "reported-thought") return "thinking";
    if (this.segment?.channel === "response" && this.segment.text) return "responding";
    if (this.recentTool) return "between";
    return this.identity.promptKind === "repair" ? "repairing" : "starting";
  }

  private closeAll(): PendingSemanticEntry[] {
    const entries = this.closeSegment();
    for (const tool of this.tools.values()) {
      entries.push(toolEntry(this.identity, tool, tool.sourceSequence, this.fenced));
    }
    this.tools.clear();
    return entries;
  }

  private closeSegment(): PendingSemanticEntry[] {
    const segment = this.segment;
    this.segment = undefined;
    if (!segment?.text) return [];
    return [{
      id: `observation:${this.identity.attemptId}:${this.identity.turn}:${segment.sourceSequence}:${segment.channel}`,
      kind: "activity",
      attemptId: this.identity.attemptId,
      turn: this.identity.turn,
      sourceSequence: segment.sourceSequence,
      at: segment.at,
      channel: segment.channel,
      summary: semanticExcerpt(segment, timelineEntryBytes),
      ...(this.fenced ? { postFence: true } : {}),
    }];
  }
}

function equalTelemetry(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeTool(
  previous: (AgentObservationToolActivity & { sourceSequence: number }) | undefined,
  event: Extract<AcpEvent, { type: "tool" }> & { sequence: number; observedAt: string },
): AgentObservationToolActivity {
  const inputText = event.input === undefined ? undefined : eventText(event.input);
  const outputValue = event.output ?? event.content;
  const outputText = outputValue === undefined ? undefined : eventText(outputValue);
  const [inputBudget, outputBudget] = inputText !== undefined && outputText !== undefined
    ? [Math.floor(currentToolBytes / 2), Math.ceil(currentToolBytes / 2)]
    : [currentToolBytes, currentToolBytes];
  const status = event.status ?? previous?.status;
  const toolCallId = event.toolCallId ?? previous?.toolCallId;
  const title = observationToolTitle(event, previous);
  return {
    ...(toolCallId ? { toolCallId } : {}),
    name: observationToolName(event, previous),
    ...(title === undefined ? {} : { title }),
    ...(status ? { status: visible(status, 64) } : {}),
    ...(inputText === undefined
      ? previous?.input ? { input: previous.input } : {}
      : { input: excerpt(inputText, inputBudget, "head") }),
    ...(outputText === undefined
      ? previous?.output ? { output: previous.output } : {}
      : { output: excerpt(outputText, outputBudget, "tail") }),
    startedAt: previous?.startedAt ?? event.observedAt,
    updatedAt: event.observedAt,
    ...(terminalToolStatuses.has(status ?? "") ? { finishedAt: event.observedAt } : {}),
  };
}

const toolKindNames: Readonly<Record<string, string>> = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  execute: "Execute",
  think: "Think",
  fetch: "Fetch",
  switch_mode: "Switch mode",
};

const genericToolNames = new Set(["tool", "tool call", "unknown tool"]);

function observationToolName(
  event: Extract<AcpEvent, { type: "tool" }>,
  previous: AgentObservationToolActivity | undefined,
): string {
  const explicit = event.name === undefined ? undefined : visibleToolName(event.name);
  if (explicit && !genericToolNames.has(explicit.toLowerCase())) return explicit;
  const prior = previous?.name;
  if (prior && !genericToolNames.has(prior.toLowerCase())) return prior;
  const kind = event.kind === undefined ? undefined : toolKindNames[event.kind];
  if (kind !== undefined) return kind;
  return "Tool";
}

function observationToolTitle(
  event: Extract<AcpEvent, { type: "tool" }>,
  previous: AgentObservationToolActivity | undefined,
): string | undefined {
  const title = event.title === undefined ? undefined : visibleToolName(event.title);
  return title && !genericToolNames.has(title.toLowerCase()) ? title : previous?.title;
}

function toolEntry(
  identity: AgentObservationIdentity,
  tool: AgentObservationToolActivity,
  sourceSequence: number,
  postFence: boolean,
): PendingSemanticEntry {
  const { sourceSequence: _sourceSequence, ...activity } =
    tool as AgentObservationToolActivity & { sourceSequence?: number };
  const bounded = boundAgentObservationTimelineTool(activity);
  return {
    id: `observation:${identity.attemptId}:${identity.turn}:${sourceSequence}:tool`,
    kind: "activity",
    attemptId: identity.attemptId,
    turn: identity.turn,
    sourceSequence,
    at: activity.updatedAt,
    channel: "tool",
    summary: bounded.summary,
    tool: bounded.tool,
    ...(postFence ? { postFence: true } : {}),
  };
}

export function boundAgentObservationTimelineTool(tool: AgentObservationToolActivity): {
  summary: AgentObservationExcerpt;
  tool: AgentObservationToolActivity;
} {
  const summary = excerpt(
    `${tool.name}${tool.status ? ` ${tool.status}` : ""}`,
    timelineEntryBytes,
    "head",
  );
  const remaining = Math.max(0, timelineEntryBytes - Buffer.byteLength(summary.text));
  const inputBudget = tool.input && tool.output ? Math.floor(remaining / 2) : remaining;
  const outputBudget = tool.input && tool.output ? remaining - inputBudget : remaining;
  return {
    summary,
    tool: {
      ...tool,
      ...(tool.input ? { input: limitAgentObservationExcerpt(tool.input, inputBudget, "head") } : {}),
      ...(tool.output ? { output: limitAgentObservationExcerpt(tool.output, outputBudget, "tail") } : {}),
    },
  };
}

export function limitAgentObservationExcerpt(
  value: AgentObservationExcerpt,
  maxBytes: number,
  side: "head" | "tail",
): AgentObservationExcerpt {
  const bytes = Buffer.byteLength(value.text);
  return {
    text: bytes <= maxBytes
      ? value.text
      : side === "head" ? utf8Head(value.text, maxBytes) : utf8Tail(value.text, maxBytes),
    originalBytes: value.originalBytes,
    truncated: value.truncated || bytes > maxBytes,
  };
}

function excerpt(value: string, maxBytes: number, side: "head" | "tail"): AgentObservationExcerpt {
  const originalBytes = Buffer.byteLength(value);
  return {
    text: originalBytes <= maxBytes
      ? value
      : side === "head" ? utf8Head(value, maxBytes) : utf8Tail(value, maxBytes),
    originalBytes,
    truncated: originalBytes > maxBytes,
  };
}

function appendSemanticText(
  segment: { text: string; originalBytes: number },
  value: string,
): void {
  segment.originalBytes += Buffer.byteLength(value);
  segment.text = utf8Tail(segment.text + value, currentResponseBytes);
}

function semanticExcerpt(
  segment: { text: string; originalBytes: number },
  maxBytes: number,
): AgentObservationExcerpt {
  return {
    text: utf8Tail(segment.text, maxBytes),
    originalBytes: segment.originalBytes,
    truncated: segment.originalBytes > maxBytes,
  };
}

function visible(value: string, maxCharacters: number): string {
  return [...value.replace(/\s+/g, " ").trim()].slice(0, maxCharacters).join("");
}

function visibleToolName(value: string): string {
  const characters = [...value.replace(/\s+/g, " ").trim()];
  return characters.length <= 160 ? characters.join("") : `${characters.slice(0, 159).join("")}…`;
}

function eventText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(eventText).join("");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.content === "string") return record.content;
    if (typeof record.value === "string") return record.value;
  }
  return value === undefined ? "" : JSON.stringify(value);
}
