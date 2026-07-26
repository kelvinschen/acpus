import type { RunInspectionTargetDetailsDocument } from "@acpus/runtime";
import type { NodeExecutionInspection } from "../api-types.js";
export type { NodeExecutionInspection } from "../api-types.js";

export async function inspectNodeExecution(
  inspection: RunInspectionTargetDetailsDocument,
  loadTurnArtifact: (artifactRef: unknown) => Promise<unknown | undefined>,
): Promise<NodeExecutionInspection> {
  const progress = latestAgentProgress(inspection);
  const compact = inspection.summary.agent;
  const agentEntries = inspection.executionMetadata.filter(item => item.kind === "agent_attempt");
  const agentEntry = latestBy(
    progress?.attemptId ? agentEntries.filter(item => item.attemptId === progress.attemptId) : agentEntries,
    item => item.createdAt,
  );
  const metadata = agentEntry?.metadata;
  const turns = agentTurns(metadata);
  const progressToolCalls = toolCallsFromProgress(progress);
  const metadataToolCalls = turns.length > 0
    ? (await Promise.all(turns.map(turn => toolCallsForTurn(turn, loadTurnArtifact)))).flat().slice(-3)
    : undefined;
  const lastToolCalls = metadataToolCalls ?? progressToolCalls ?? toolCallsFromCompact(compact);
  const contextWindow = contextWindowFromProgress(progress) ?? latestContextWindow(turns) ?? contextWindowFromCompact(compact);
  const tokenUsage = aggregateTokenUsage(turns) ?? tokenUsageFromProgress(progress) ?? tokenUsageFromRecord(metadataRecord(compact?.tokenUsage) ?? {});
  const toolCallCount = totalToolCallCount(turns) ?? toolCallCountFromProgress(progress) ?? compact?.tools?.totalCallCount;
  const available = compact !== undefined || progress !== undefined || agentEntry !== undefined;
  return {
    available,
    ...(available ? {} : { reason: "No agent execution metadata exists for the selected scope." }),
    summary: {
      ...(inspection.summary.nodeStatus ? { status: inspection.summary.nodeStatus } : {}),
      ...(compact?.turnCount === undefined ? {} : { turnCount: compact.turnCount }),
      ...agentExecutionSummary(metadata),
      ...agentProgressSummary(progress),
    },
    ...(progress?.updatedAt ? { lastObservedAt: progress.updatedAt } : compact?.lastObservedAt ? { lastObservedAt: compact.lastObservedAt } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
    ...(progress?.output ? { output: progress.output } : {}),
    ...(toolCallCount === undefined ? {} : { toolCallCount }),
    lastToolCalls,
  };
}

type NodeProgress = RunInspectionTargetDetailsDocument["progress"][number];

function latestAgentProgress(inspection: RunInspectionTargetDetailsDocument): NodeProgress | undefined {
  const attemptIds = new Set(inspection.attempts.map(attempt => attempt.attemptId));
  return latestBy(inspection.progress.filter(progress =>
    progress.kind === "agent"
      && (progress.attemptId === undefined || attemptIds.has(progress.attemptId))), progress => progress.updatedAt);
}

function metadataRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function agentTurns(metadata: unknown): Record<string, unknown>[] {
  const turns = metadataRecord(metadata)?.turns;
  if (!Array.isArray(turns)) return [];
  return turns.flatMap(turn => {
    const record = metadataRecord(turn);
    return record ? [record] : [];
  });
}

function agentExecutionSummary(metadata: unknown): NodeExecutionInspection["summary"] {
  const record = metadataRecord(metadata);
  if (!record) return {};
  return {
    ...(typeof record.status === "string" ? { status: record.status } : {}),
    ...(typeof record.sessionName === "string" ? { sessionName: record.sessionName } : {}),
    ...(typeof record.turnCount === "number" ? { turnCount: record.turnCount } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
  };
}

function agentProgressSummary(progress: NodeProgress | undefined): NodeExecutionInspection["summary"] {
  if (!progress) return {};
  return {
    status: progress.status,
    ...(progress.message ? { message: progress.message } : {}),
  };
}

function contextWindowFromProgress(progress: NodeProgress | undefined): NodeExecutionInspection["contextWindow"] | undefined {
  const context = metadataRecord(progress?.context);
  if (!context) return undefined;
  return contextWindowFromRecord(context);
}

function contextWindowFromCompact(
  compact: RunInspectionTargetDetailsDocument["summary"]["agent"],
): NodeExecutionInspection["contextWindow"] | undefined {
  if (!compact?.context) return undefined;
  const { used, size } = compact.context;
  return {
    used,
    size,
    ...(size > 0 ? { percent: Math.round((used / size) * 100) } : {}),
  };
}

function latestContextWindow(turns: Record<string, unknown>[]): NodeExecutionInspection["contextWindow"] | undefined {
  const context = [...turns].reverse()
    .map(turn => metadataRecord(metadataRecord(turn.summary)?.context))
    .find(Boolean);
  if (!context) return undefined;
  return contextWindowFromRecord(context);
}

function contextWindowFromRecord(context: Record<string, unknown>): NodeExecutionInspection["contextWindow"] | undefined {
  const used = numberField(context.used);
  const size = numberField(context.size);
  const updatedAt = stringField(context.updatedAt);
  if (used === undefined && size === undefined && updatedAt === undefined) return undefined;
  return {
    ...(used === undefined ? {} : { used }),
    ...(size === undefined ? {} : { size }),
    ...(used !== undefined && size !== undefined && size > 0 ? { percent: Math.round((used / size) * 100) } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function tokenUsageFromProgress(progress: NodeProgress | undefined): NodeExecutionInspection["tokenUsage"] | undefined {
  const usage = metadataRecord(progress?.tokenUsage);
  if (!usage) return undefined;
  return tokenUsageFromRecord(usage);
}

function aggregateTokenUsage(turns: Record<string, unknown>[]): NodeExecutionInspection["tokenUsage"] | undefined {
  let source: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let hasUsage = false;
  for (const turn of turns) {
    const usage = metadataRecord(metadataRecord(turn.summary)?.tokenUsage);
    if (!usage) continue;
    hasUsage = true;
    if (typeof usage.source === "string") source = usage.source;
    inputTokens += numberField(usage.inputTokens) ?? 0;
    outputTokens += numberField(usage.outputTokens) ?? 0;
    totalTokens += numberField(usage.totalTokens) ?? 0;
  }
  return hasUsage ? {
    ...(source ? { source } : {}),
    inputTokens,
    outputTokens,
    totalTokens,
  } : undefined;
}

function tokenUsageFromRecord(usage: Record<string, unknown>): NodeExecutionInspection["tokenUsage"] {
  const source = stringField(usage.source);
  const inputTokens = numberField(usage.inputTokens);
  const outputTokens = numberField(usage.outputTokens);
  const totalTokens = numberField(usage.totalTokens);
  if (source === undefined && inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return {
    ...(source ? { source } : {}),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function toolCallsFromCompact(
  compact: RunInspectionTargetDetailsDocument["summary"]["agent"],
): NodeExecutionInspection["lastToolCalls"] {
  if (!compact?.tools) return [];
  return compact.tools.recent.map(tool => ({
    turn: compact.turnCount ?? 0,
    toolName: tool.command,
    ...(tool.status ? { status: tool.status } : {}),
  }));
}

function toolCallCountFromProgress(progress: NodeProgress | undefined): number | undefined {
  return numberField(metadataRecord(progress?.tools)?.totalToolCallCount);
}

function totalToolCallCount(turns: Record<string, unknown>[]): number | undefined {
  let total = 0;
  let hasTools = false;
  for (const turn of turns) {
    const count = numberField(metadataRecord(metadataRecord(turn.summary)?.tools)?.totalToolCallCount);
    if (count === undefined) continue;
    hasTools = true;
    total += count;
  }
  return hasTools ? total : undefined;
}

function toolCallsFromProgress(progress: NodeProgress | undefined): NodeExecutionInspection["lastToolCalls"] | undefined {
  const tools = metadataRecord(progress?.tools);
  const calls = tools?.lastCalls;
  if (!tools || !Array.isArray(calls)) return undefined;
  const turn = numberField(tools.turn) ?? 0;
  return calls.flatMap(call => {
    const record = metadataRecord(call);
    if (!record) return [];
    return [toolCallFromRecord(record, turn, "progress")];
  });
}

async function toolCallsForTurn(
  turn: Record<string, unknown>,
  loadTurnArtifact: (artifactRef: unknown) => Promise<unknown | undefined>,
): Promise<NodeExecutionInspection["lastToolCalls"]> {
  const turnNo = numberField(turn.turn) ?? 0;
  const turnArtifact = metadataRecord(await loadTurnArtifact(turn.turnArtifact));
  const calls = metadataRecord(metadataRecord(turnArtifact?.summary)?.tools)?.calls;
  if (!Array.isArray(calls)) return [];
  return calls.flatMap(call => {
    const record = metadataRecord(call);
    if (!record) return [];
    return [toolCallFromRecord(record, turnNo, "artifact")];
  });
}

function toolCallFromRecord(record: Record<string, unknown>, turn: number, previewMode: "progress" | "artifact"): NodeExecutionInspection["lastToolCalls"][number] {
  const startedAt = stringField(record.startedAt);
  const completedAt = stringField(record.completedAt);
  const toolCallId = stringField(record.toolCallId);
  const toolName = stringField(record.toolName);
  const status = stringField(record.status);
  const inputPreview = previewMode === "progress" ? stringField(record.inputPreview) : previewField(record.input);
  const duration = durationMs(startedAt, completedAt ?? "");
  return {
    turn,
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolName ? { toolName } : {}),
    ...(status ? { status } : {}),
    ...(duration === undefined ? {} : { durationMs: duration }),
    ...(inputPreview ? { inputPreview } : {}),
  };
}

function previewField(value: unknown): string | undefined {
  const record = metadataRecord(value);
  if (!record) return undefined;
  return typeof record.preview === "string" ? record.preview : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function durationMs(startedAt: string | undefined, finishedAt: string): number | undefined {
  if (!startedAt) return undefined;
  const value = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function latestBy<T>(items: T[], getValue: (item: T) => string | undefined): T | undefined {
  return [...items].sort((left, right) => (getValue(right) ?? "").localeCompare(getValue(left) ?? ""))[0];
}
