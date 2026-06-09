import { approximateTokenSize } from "tokenx";

export type OutputTokenSource = "exact" | "estimated" | "unknown";

export interface AgentToolCallSummary {
  toolCallId: string;
  title?: string;
  status?: string;
  kind?: string;
  toolName?: string;
  updatedSeq?: number;
}

export interface AgentExecutionSummary {
  outputTokens?: number;
  outputTokenSource: OutputTokenSource;
  toolCallCount: number;
  recentToolCalls: AgentToolCallSummary[];
  toolCalls?: AgentToolCallSummary[];
}

interface MutableToolCall extends AgentToolCallSummary {
  lastSeq: number;
}

export function emptyAgentExecutionSummary(): AgentExecutionSummary {
  return { outputTokenSource: "unknown", toolCallCount: 0, recentToolCalls: [], toolCalls: [] };
}

export class AgentTranscriptAccumulator {
  private exactOutputTokens: number | undefined;
  private outputText = "";
  private sawOutputChunks = false;
  private readonly tools = new Map<string, MutableToolCall>();
  private partialLine = "";
  private seq = 0;

  append(chunk: string): void {
    if (chunk.length === 0) return;
    const text = this.partialLine + chunk;
    const lines = text.split("\n");
    this.partialLine = lines.pop() ?? "";
    for (const line of lines) this.parseLine(line);
  }

  flush(): void {
    if (this.partialLine.trim().length === 0) {
      this.partialLine = "";
      return;
    }
    this.parseLine(this.partialLine);
    this.partialLine = "";
  }

  reset(): void {
    this.exactOutputTokens = undefined;
    this.outputText = "";
    this.sawOutputChunks = false;
    this.tools.clear();
    this.partialLine = "";
    this.seq = 0;
  }

  summary(orderOffset = 0): AgentExecutionSummary {
    const toolCalls = [...this.tools.values()]
      .map(({ lastSeq, ...tool }) => ({ ...tool, updatedSeq: orderOffset + lastSeq }))
      .sort((a, b) => (b.updatedSeq ?? 0) - (a.updatedSeq ?? 0));
    const estimatedTokens = safeApproximateTokenSize(this.outputText);
    const outputTokens = this.exactOutputTokens ?? estimatedTokens;
    const outputTokenSource: OutputTokenSource = this.exactOutputTokens !== undefined
      ? "exact"
      : estimatedTokens !== undefined
        ? "estimated"
        : "unknown";
    return {
      outputTokens,
      outputTokenSource,
      toolCallCount: toolCalls.length,
      recentToolCalls: toolCalls.slice(0, 3),
      toolCalls
    };
  }

  private parseLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parsed = parseObject(trimmed);
    if (!parsed) return;
    const update = extractUpdate(parsed);
    if (!update) return;

    if (isUsageUpdate(update)) {
      this.exactOutputTokens = readOutputTokens(update) ?? this.exactOutputTokens;
      return;
    }

    if (isAgentMessageChunk(update)) {
      const text = readContentText(update.content);
      if (text) {
        this.sawOutputChunks = true;
        this.outputText += text;
      }
      return;
    }

    if (isAgentMessage(update)) {
      const text = readContentText(update.content);
      if (text && !this.sawOutputChunks) this.outputText += text;
      return;
    }

    if (isToolUpdate(update)) {
      const toolCallId = readString(update.toolCallId);
      if (!toolCallId) return;
      this.seq += 1;
      const current: MutableToolCall = this.tools.get(toolCallId) ?? { toolCallId, lastSeq: this.seq };
      current.lastSeq = this.seq;
      const title = readString(update.title);
      const status = readString(update.status);
      const kind = readString(update.kind);
      const toolName = readString(readRecord(readRecord(update._meta)?.claudeCode)?.toolName);
      if (title) current.title = title;
      if (status) current.status = status;
      if (kind) current.kind = kind;
      if (toolName) current.toolName = toolName;
      this.tools.set(toolCallId, current);
    }
  }
}

export function parseAgentTranscript(text: string): AgentExecutionSummary {
  const accumulator = new AgentTranscriptAccumulator();
  accumulator.append(text);
  accumulator.flush();
  return accumulator.summary();
}

export function mergeAgentExecutionSummaries(summaries: AgentExecutionSummary[]): AgentExecutionSummary {
  const tools = new Map<string, AgentToolCallSummary>();
  let totalTokens = 0;
  let sawExact = false;
  let sawEstimated = false;
  for (let summaryIndex = 0; summaryIndex < summaries.length; summaryIndex++) {
    const summary = summaries[summaryIndex];
    const allTools = summary.toolCalls ?? summary.recentToolCalls;
    for (const tool of allTools) {
      const orderedTool = { ...tool, updatedSeq: (summaryIndex + 1) * 1_000_000_000 + (tool.updatedSeq ?? 0) };
      const current = tools.get(tool.toolCallId);
      if (!current) {
        tools.set(tool.toolCallId, orderedTool);
      } else if ((orderedTool.updatedSeq ?? 0) >= (current.updatedSeq ?? 0)) {
        tools.set(tool.toolCallId, mergeToolCall(current, orderedTool));
      } else {
        tools.set(tool.toolCallId, mergeToolCall(orderedTool, current));
      }
    }
    if (summary.outputTokens !== undefined) {
      totalTokens += summary.outputTokens;
      if (summary.outputTokenSource === "estimated") sawEstimated = true;
      if (summary.outputTokenSource === "exact") sawExact = true;
    }
  }

  const toolCalls = [...tools.values()].sort((a, b) => (b.updatedSeq ?? 0) - (a.updatedSeq ?? 0));
  const outputTokenSource: OutputTokenSource = sawEstimated ? "estimated" : sawExact ? "exact" : "unknown";
  return {
    outputTokens: outputTokenSource === "unknown" ? undefined : totalTokens,
    outputTokenSource,
    toolCallCount: toolCalls.length,
    recentToolCalls: toolCalls.slice(0, 3),
    toolCalls
  };
}

function mergeToolCall(previous: AgentToolCallSummary, latest: AgentToolCallSummary): AgentToolCallSummary {
  return {
    toolCallId: latest.toolCallId,
    title: latest.title ?? previous.title,
    status: latest.status ?? previous.status,
    kind: latest.kind ?? previous.kind,
    toolName: latest.toolName ?? previous.toolName,
    updatedSeq: latest.updatedSeq ?? previous.updatedSeq
  };
}

function safeApproximateTokenSize(text: string): number | undefined {
  if (text.length === 0) return undefined;
  try {
    return approximateTokenSize(text);
  } catch {
    return undefined;
  }
}

function parseObject(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line);
    return readRecord(parsed);
  } catch {
    return undefined;
  }
}

function extractUpdate(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  const params = readRecord(obj.params);
  const update = readRecord(params?.update);
  if (update) return update;
  if (typeof obj.type === "string" || typeof obj.tag === "string" || typeof obj.sessionUpdate === "string") return obj;
  return undefined;
}

function isUsageUpdate(update: Record<string, unknown>): boolean {
  const kind = update.sessionUpdate ?? update.tag ?? update.type;
  return kind === "usage_update";
}

function isAgentMessageChunk(update: Record<string, unknown>): boolean {
  const kind = update.sessionUpdate ?? update.tag ?? update.type;
  return kind === "agent_message_chunk";
}

function isAgentMessage(update: Record<string, unknown>): boolean {
  const kind = update.sessionUpdate ?? update.tag ?? update.type;
  return kind === "agent_message";
}

function isToolUpdate(update: Record<string, unknown>): boolean {
  const kind = update.sessionUpdate ?? update.tag ?? update.type;
  return kind === "tool_call" || kind === "tool_call_update";
}

function readOutputTokens(update: Record<string, unknown>): number | undefined {
  const metaUsage = readRecord(readRecord(update._meta)?.usage);
  const usage = readRecord(update.usage);
  return readNonNegativeNumber(metaUsage?.output_tokens)
    ?? readNonNegativeNumber(metaUsage?.outputTokens)
    ?? readNonNegativeNumber(usage?.output_tokens)
    ?? readNonNegativeNumber(usage?.outputTokens)
    ?? readNonNegativeNumber(update.output_tokens)
    ?? readNonNegativeNumber(update.outputTokens);
}

function readContentText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const record = readRecord(value);
  if (!record) return undefined;
  if (typeof record.text === "string") return record.text;
  const nested = readRecord(record.content);
  return typeof nested?.text === "string" ? nested.text : undefined;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
