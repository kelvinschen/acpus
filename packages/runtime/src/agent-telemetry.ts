import type {
  AgentAttemptTelemetry,
  AgentAttemptTelemetryState,
  AgentContextUsage,
  AgentIoPreview,
  AgentTelemetry,
  AgentToolCallTelemetry
} from "./types.js";

const DEFAULT_PREVIEW_EDGE_BYTES = 8 * 1024;
const DEFAULT_MAX_TOOL_CALLS = 200;
const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
const FINAL_TOOL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export interface AgentTelemetryAccumulatorOptions {
  attempt: number;
  inputText: string;
  inputArtifactRef?: string;
  startedAt?: string;
  now?: () => number;
  previewEdgeBytes?: number;
  maxToolCalls?: number;
  flushIntervalMs?: number;
  onTelemetry?: (attempt: AgentAttemptTelemetry) => void;
}

export class AgentTelemetryAccumulator {
  private readonly attempt: number;
  private readonly now: () => number;
  private readonly previewEdgeBytes: number;
  private readonly maxToolCalls: number;
  private readonly flushIntervalMs: number;
  private readonly onTelemetry?: (attempt: AgentAttemptTelemetry) => void;
  private readonly startedAt: string;
  private readonly seenToolIds = new Set<string>();
  private readonly tools = new Map<string, MutableToolCall>();
  private partialLine = "";
  private response = "";
  private stopReason: string | undefined;
  private latestContext: AgentContextUsage | undefined;
  private outputArtifactRef: string | undefined;
  private lastPublishedAt = 0;
  private toolSeq = 0;
  private totalToolCallCount = 0;

  constructor(options: AgentTelemetryAccumulatorOptions) {
    this.attempt = options.attempt;
    this.now = options.now ?? Date.now;
    this.previewEdgeBytes = options.previewEdgeBytes ?? DEFAULT_PREVIEW_EDGE_BYTES;
    this.maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.onTelemetry = options.onTelemetry;
    this.startedAt = options.startedAt ?? new Date(this.now()).toISOString();
    this.input = buildPreview(options.inputText, this.previewEdgeBytes, options.inputArtifactRef);
  }

  private readonly input: AgentIoPreview;

  append(chunk: string): void {
    if (chunk.length === 0) return;
    const text = this.partialLine + chunk;
    const lines = text.split("\n");
    this.partialLine = lines.pop() ?? "";
    for (const line of lines) this.parseLine(line);
  }

  flush(): void {
    if (this.partialLine.trim().length > 0) this.parseLine(this.partialLine);
    this.partialLine = "";
    this.publish("running", true);
  }

  responseText(): string {
    return this.response;
  }

  setResponseText(text: string): void {
    this.response = text;
  }

  finalStopReason(): string | undefined {
    return this.stopReason;
  }

  context(): AgentContextUsage | undefined {
    return this.latestContext;
  }

  setOutputArtifactRef(ref: string | undefined): void {
    this.outputArtifactRef = ref;
  }

  snapshot(state: AgentAttemptTelemetryState = "running", completedAt?: string): AgentAttemptTelemetry {
    const updatedAt = completedAt ?? new Date(this.now()).toISOString();
    const recentCalls = [...this.tools.values()]
      .sort((a, b) => b.lastSeq - a.lastSeq)
      .map(({ lastSeq: _lastSeq, ...tool }) => tool);
    return {
      attempt: this.attempt,
      state,
      startedAt: this.startedAt,
      updatedAt,
      completedAt,
      context: this.latestContext,
      input: this.input,
      output: this.response.length > 0
        ? buildPreview(this.response, this.previewEdgeBytes, this.outputArtifactRef)
        : this.outputArtifactRef
          ? buildPreview("", this.previewEdgeBytes, this.outputArtifactRef)
          : undefined,
      tools: {
        totalToolCallCount: this.totalToolCallCount,
        droppedToolCallCount: Math.max(0, this.totalToolCallCount - recentCalls.length),
        recentCalls
      }
    };
  }

  private parseLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parsed = parseObject(trimmed);
    if (!parsed) return;

    this.captureResult(parsed);
    const update = extractUpdate(parsed);
    if (!update) return;

    const kind = update.sessionUpdate;
    if (kind === "agent_message_chunk") {
      const text = readContentText(update.content);
      if (text) {
        this.response += text;
        this.publish("running", false);
      }
      return;
    }

    if (kind === "usage_update") {
      const used = readNonNegativeNumber(update.used);
      const size = readNonNegativeNumber(update.size);
      if (used !== undefined && size !== undefined) {
        // acpx sends used=0 at the start of every LLM API call before the
        // response arrives with real token counts.  Overwriting a known
        // non-zero measurement with 0 would produce misleading telemetry
        // (e.g. "context=0/200k") when a failed attempt's last update was
        // an initial allocation.  Preserve the previous `used` if the new
        // one is 0 and we already have a real measurement.
        if (used === 0 && this.latestContext && this.latestContext.used > 0) {
          this.latestContext = { used: this.latestContext.used, size, updatedAt: new Date(this.now()).toISOString() };
        } else {
          this.latestContext = { used, size, updatedAt: new Date(this.now()).toISOString() };
        }
        this.publish("running", false);
      }
      return;
    }

    if (isToolUpdate(update)) {
      const changed = this.captureTool(update);
      this.publish("running", changed);
    }
  }

  private captureResult(obj: Record<string, unknown>): void {
    const result = readRecord(obj.result);
    if (typeof result?.stopReason === "string") this.stopReason = result.stopReason;
  }

  private captureTool(update: Record<string, unknown>): boolean {
    const toolCallId = readString(update.toolCallId);
    if (!toolCallId) return false;

    const now = new Date(this.now()).toISOString();
    const wasSeen = this.seenToolIds.has(toolCallId);
    if (!wasSeen) {
      this.seenToolIds.add(toolCallId);
      this.totalToolCallCount += 1;
    }

    const previous = this.tools.get(toolCallId);
    const status = readString(update.status);
    const current: MutableToolCall = previous ?? {
      toolCallId,
      startedAt: now,
      updatedAt: now,
      lastSeq: 0
    };
    const statusChanged = status !== undefined && status !== previous?.status;

    current.updatedAt = now;
    current.lastSeq = ++this.toolSeq;
    const title = readString(update.title);
    const kind = readString(update.kind);
    const toolName = readString(readRecord(readRecord(update._meta)?.claudeCode)?.toolName);
    if (title) current.title = title;
    if (kind) current.kind = kind;
    if (toolName) current.toolName = toolName;
    if (status) {
      current.status = status;
      if (FINAL_TOOL_STATUSES.has(status)) current.completedAt = now;
    }

    this.tools.set(toolCallId, current);
    this.trimRecentTools();
    return !wasSeen || statusChanged || (status !== undefined && FINAL_TOOL_STATUSES.has(status));
  }

  private trimRecentTools(): void {
    if (this.tools.size <= this.maxToolCalls) return;
    const ordered = [...this.tools.entries()].sort((a, b) => b[1].lastSeq - a[1].lastSeq);
    const keep = new Set(ordered.slice(0, this.maxToolCalls).map(([id]) => id));
    for (const id of this.tools.keys()) {
      if (!keep.has(id)) this.tools.delete(id);
    }
  }

  private publish(state: AgentAttemptTelemetryState, force: boolean): void {
    if (!this.onTelemetry) return;
    const now = this.now();
    if (!force && now - this.lastPublishedAt < this.flushIntervalMs) return;
    this.lastPublishedAt = now;
    this.onTelemetry(this.snapshot(state));
  }
}

interface MutableToolCall extends AgentToolCallTelemetry {
  lastSeq: number;
}

export function upsertAgentAttemptTelemetry(
  current: AgentTelemetry | undefined,
  attempt: AgentAttemptTelemetry
): AgentTelemetry {
  const previous = current?.attempts.filter((item) => item.attempt !== attempt.attempt) ?? [];
  return {
    currentAttempt: attempt.attempt,
    attempts: [...previous, attempt].sort((a, b) => a.attempt - b.attempt)
  };
}

export function latestAgentAttemptTelemetry(telemetry: AgentTelemetry | undefined): AgentAttemptTelemetry | undefined {
  if (!telemetry) return undefined;
  return telemetry.attempts.find((attempt) => attempt.attempt === telemetry.currentAttempt)
    ?? telemetry.attempts[telemetry.attempts.length - 1];
}

function buildPreview(text: string, edgeBytes: number, artifactRef?: string): AgentIoPreview {
  const originalBytes = Buffer.byteLength(text);
  const maxBytes = edgeBytes * 2;
  if (originalBytes <= maxBytes) {
    return { preview: text, truncated: false, originalBytes, headBytes: originalBytes, artifactRef };
  }
  const bytes = Buffer.from(text);
  const head = bytes.subarray(0, edgeBytes).toString("utf8");
  const tail = bytes.subarray(Math.max(edgeBytes, bytes.length - edgeBytes)).toString("utf8");
  return {
    preview: `${head}\n[acpus truncated: originalBytes=${originalBytes}]\n${tail}`,
    truncated: true,
    originalBytes,
    headBytes: edgeBytes,
    tailBytes: edgeBytes,
    artifactRef
  };
}

function parseObject(line: string): Record<string, unknown> | undefined {
  try {
    return readRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function extractUpdate(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  return readRecord(readRecord(obj.params)?.update);
}

function isToolUpdate(update: Record<string, unknown>): boolean {
  const kind = update.sessionUpdate;
  return kind === "tool_call" || kind === "tool_call_update";
}

function readContentText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const record = readRecord(value);
  if (!record) return undefined;
  if (typeof record.text === "string") return record.text;
  const nested = readRecord(record.content);
  return typeof nested?.text === "string" ? nested.text : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
