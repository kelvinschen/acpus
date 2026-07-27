import type { AgentObservationInspectionProjection } from "../observations/log.js";
import type {
  RunExecutionMetadata,
  RunNodeProgress,
} from "../store/store.js";
import { utf8Head } from "../utf8.js";
import {
  inspectionSubject,
  inspectionTargetState,
  resolvedTargetIdentity,
} from "./decision-projection.js";
import { inspectionRevision } from "./revision.js";
import type {
  RunInspectionAgentExecutionDocument,
  RunInspectionAgentExecutionToolCall,
  RunInspectionCursor,
  RunInspectionQuery,
  RunInspectionTargetDetailsDocument,
} from "./types.js";

const toolLimit = 3;
const summaryTextBytes = 1_024;
const toolTextBytes = 2_048;

type AgentMetadata = {
  entry?: RunExecutionMetadata;
  record?: Record<string, unknown>;
  turns: Record<string, unknown>[];
};

type ProjectedToolCall = {
  key: string;
  call: RunInspectionAgentExecutionToolCall;
};

export function projectAgentExecution(input: {
  details: RunInspectionTargetDetailsDocument;
  cursor: RunInspectionCursor;
  query: Extract<RunInspectionQuery, { mode: "execution" }>;
  observations?: AgentObservationInspectionProjection;
}): RunInspectionAgentExecutionDocument {
  const state = inspectionTargetState(input.details);
  const common = {
    schemaVersion: 2 as const,
    kind: "execution" as const,
    revision: inspectionRevision({
      runId: input.details.run.id,
      query: input.query,
      resolvedTarget: resolvedTargetIdentity(input.details),
      cursor: input.cursor,
    }),
    run: {
      id: input.details.run.id,
      status: input.details.run.status,
      updatedAt: input.details.run.updatedAt,
    },
    subject: inspectionSubject(input.details),
  };

  if (input.details.staticNode?.kind !== "agent") {
    return {
      ...common,
      available: false,
      reason: "not-agent",
      summary: { status: state.status },
      lastToolCalls: [],
      recentToolsIncomplete: false,
    };
  }

  const selectedAttempt = input.details.summary.latestAttempt;
  if (!selectedAttempt) {
    return {
      ...common,
      available: false,
      reason: "not-started",
      summary: { status: state.status },
      lastToolCalls: [],
      recentToolsIncomplete: false,
    };
  }

  const attemptId = selectedAttempt.attemptId;
  const progress = selectedProgress(input.details.progress, attemptId);
  const metadata = selectedMetadata(input.details.executionMetadata, attemptId);
  const observations = exactObservations(input.observations, attemptId);
  const progressTools = progressToolCalls(progress);
  const observationTools = observationToolCalls(observations);
  const activeTools = progress === undefined
    ? activeToolCalls(observations)
    : { calls: [], malformed: false };
  const lastToolCalls = mergeToolCalls([
    ...observationTools.calls,
    ...activeTools.calls,
    ...progressTools.calls,
  ]);
  const metadataToolCount = metadataToolCallCount(metadata.turns);
  const progressToolCount = progressToolCallCount(progress);
  const observedToolCount = knownToolCallCount(observationTools.calls, activeTools.calls);
  const toolCallCount = metadataToolCount
    ?? maximumDefined([progressToolCount, observedToolCount]);
  const contextWindow = progressContext(progress) ?? latestMetadataContext(metadata.turns);
  const tokenUsage = aggregateMetadataTokenUsage(metadata.turns) ?? progressTokenUsage(progress);
  const turnCount = maximumDefined([
    nonNegativeInteger(metadata.record?.turnCount),
    progressTurn(progress),
    ...observations.turns.map(turn => turn.turn),
    ...observations.currents.flatMap(current => current.postFence ? [] : [current.turn]),
    ...observations.entries.flatMap(entry =>
      entry.kind === "activity" && entry.postFence ? [] : [entry.turn]),
  ]);
  const sessionName = boundedString(metadata.record?.sessionName, summaryTextBytes);
  const message = boundedString(progress?.message, summaryTextBytes)
    ?? boundedString(metadata.record?.message, summaryTextBytes);
  const fenceAt = latestTimestamp(observations.turns.map(turn => turn.fencedAt));
  const observedAt = latestTimestamp([
    progress?.updatedAt,
    metadata.entry?.createdAt,
    ...observations.turns.flatMap(turn => [turn.finishedAt, turn.startedAt]),
    ...observations.currents.flatMap(current => current.postFence ? [] : [current.updatedAt]),
    ...observations.entries.flatMap(entry => entry.kind === "activity" && entry.postFence ? [] : [entry.at]),
  ]);
  const lastObservedAt = observedAt && fenceAt && observedAt > fenceAt ? fenceAt : observedAt;
  const malformedTools = progressTools.malformed
    || activeTools.malformed
    || observationTools.malformed;
  const sourceUncertainty = observations.missing
    || observations.historyUnavailable
    || observations.observationGap
    || observations.omittedActive;
  const recentToolsIncomplete = metadataToolCount === 0
    ? false
    : malformedTools
      || (metadataToolCount === undefined
        ? lastToolCalls.length < Math.min(toolCallCount ?? 0, toolLimit)
          || sourceUncertainty && lastToolCalls.length < toolLimit
        : lastToolCalls.length < Math.min(metadataToolCount, toolLimit));

  return {
    ...common,
    available: true,
    summary: {
      status: state.status,
      ...(sessionName ? { sessionName } : {}),
      ...(turnCount === undefined ? {} : { turnCount }),
      ...(message ? { message } : {}),
    },
    ...(lastObservedAt ? { lastObservedAt } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
    ...(progress?.output ? { output: progress.output } : {}),
    ...(toolCallCount === undefined ? {} : { toolCallCount }),
    lastToolCalls,
    recentToolsIncomplete,
  };
}

function selectedProgress(
  progress: readonly RunNodeProgress[],
  attemptId: string,
): RunNodeProgress | undefined {
  return [...progress]
    .filter(candidate => candidate.kind === "agent" && candidate.attemptId === attemptId)
    .sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
        || right.nodeKey.localeCompare(left.nodeKey))[0];
}

function selectedMetadata(
  entries: readonly RunExecutionMetadata[],
  attemptId: string,
): AgentMetadata {
  const entry = [...entries]
    .filter(candidate => candidate.kind === "agent_attempt" && candidate.attemptId === attemptId)
    .sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt)
        || right.id - left.id)[0];
  const record = metadataRecord(entry?.metadata);
  const turns = Array.isArray(record?.turns)
    ? record.turns.flatMap(turn => {
      const value = metadataRecord(turn);
      return value ? [value] : [];
    })
    : [];
  return {
    ...(entry ? { entry } : {}),
    ...(record ? { record } : {}),
    turns,
  };
}

function exactObservations(
  projection: AgentObservationInspectionProjection | undefined,
  attemptId: string,
): AgentObservationInspectionProjection & {
  missing: boolean;
  historyUnavailable: boolean;
  observationGap: boolean;
  omittedActive: boolean;
} {
  if (!projection) {
    return {
      version: 0,
      turns: [],
      currents: [],
      entries: [],
      retentionOmittedBefore: 0,
      olderEntryCount: 0,
      hasOlderEntries: false,
      missing: true,
      historyUnavailable: false,
      observationGap: false,
      omittedActive: false,
    };
  }
  const turns = projection.turns.filter(turn => turn.attemptId === attemptId);
  const currents = projection.currents.filter(current => current.attemptId === attemptId);
  const entries = projection.entries.filter(entry => entry.attemptId === attemptId);
  return {
    ...projection,
    turns,
    currents,
    entries,
    missing: false,
    historyUnavailable: projection.omittedTurnEvidence === true
      || projection.retentionOmittedBefore > 0
      || projection.hasOlderEntries
      || projection.olderEntryCount > 0,
    observationGap: turns.some(turn => turn.completeness === "degraded" || turn.gapCount > 0)
      || entries.some(entry => entry.kind === "gap"),
    omittedActive: currents.some(current =>
      current.postFence !== true && (current.tools?.omittedActive ?? 0) > 0),
  };
}

function progressContext(
  progress: RunNodeProgress | undefined,
): RunInspectionAgentExecutionDocument["contextWindow"] | undefined {
  return contextWindow(metadataRecord(progress?.context));
}

function latestMetadataContext(
  turns: readonly Record<string, unknown>[],
): RunInspectionAgentExecutionDocument["contextWindow"] | undefined {
  return [...turns]
    .sort((left, right) => (nonNegativeInteger(right.turn) ?? 0) - (nonNegativeInteger(left.turn) ?? 0))
    .map(turn => contextWindow(metadataRecord(metadataRecord(turn.summary)?.context)))
    .find(context => context !== undefined);
}

function contextWindow(
  context: Record<string, unknown> | undefined,
): RunInspectionAgentExecutionDocument["contextWindow"] | undefined {
  if (!context) return undefined;
  const used = nonNegativeNumber(context.used);
  const size = nonNegativeNumber(context.size);
  const updatedAt = boundedString(context.updatedAt, summaryTextBytes);
  if (used === undefined && size === undefined && updatedAt === undefined) return undefined;
  return {
    ...(used === undefined ? {} : { used }),
    ...(size === undefined ? {} : { size }),
    ...(used !== undefined && size !== undefined && size > 0
      ? { percent: Math.round((used / size) * 100) }
      : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function aggregateMetadataTokenUsage(
  turns: readonly Record<string, unknown>[],
): RunInspectionAgentExecutionDocument["tokenUsage"] | undefined {
  let source: "prompt_response" | "usage_update" | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let hasUsage = false;
  for (const turn of turns) {
    const usage = metadataRecord(metadataRecord(turn.summary)?.tokenUsage);
    if (!usage) continue;
    const projected = tokenUsage(usage);
    if (!projected) continue;
    hasUsage = true;
    source = projected.source ?? source;
    inputTokens += projected.inputTokens ?? 0;
    outputTokens += projected.outputTokens ?? 0;
    totalTokens += projected.totalTokens ?? 0;
  }
  return hasUsage
    ? {
        ...(source ? { source } : {}),
        inputTokens,
        outputTokens,
        totalTokens,
      }
    : undefined;
}

function progressTokenUsage(
  progress: RunNodeProgress | undefined,
): RunInspectionAgentExecutionDocument["tokenUsage"] | undefined {
  return tokenUsage(metadataRecord(progress?.tokenUsage));
}

function tokenUsage(
  usage: Record<string, unknown> | undefined,
): RunInspectionAgentExecutionDocument["tokenUsage"] | undefined {
  if (!usage) return undefined;
  const source = usage.source === "prompt_response" || usage.source === "usage_update"
    ? usage.source
    : undefined;
  const inputTokens = nonNegativeInteger(usage.inputTokens);
  const outputTokens = nonNegativeInteger(usage.outputTokens);
  const totalTokens = nonNegativeInteger(usage.totalTokens);
  if (source === undefined
    && inputTokens === undefined
    && outputTokens === undefined
    && totalTokens === undefined) return undefined;
  return {
    ...(source ? { source } : {}),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function metadataToolCallCount(turns: readonly Record<string, unknown>[]): number | undefined {
  const counts = turns.flatMap(turn => {
    const count = nonNegativeInteger(metadataRecord(metadataRecord(turn.summary)?.tools)?.totalToolCallCount);
    return count === undefined ? [] : [count];
  });
  return counts.length === 0 ? undefined : counts.reduce((total, count) => total + count, 0);
}

function progressToolCallCount(progress: RunNodeProgress | undefined): number | undefined {
  return nonNegativeInteger(metadataRecord(progress?.tools)?.totalToolCallCount);
}

function knownToolCallCount(
  terminal: readonly ProjectedToolCall[],
  active: readonly ProjectedToolCall[],
): number | undefined {
  const count = new Set([...terminal, ...active].map(call => call.key)).size;
  return count === 0 ? undefined : count;
}

function progressTurn(progress: RunNodeProgress | undefined): number | undefined {
  return nonNegativeInteger(metadataRecord(progress?.tools)?.turn);
}

function progressToolCalls(progress: RunNodeProgress | undefined): {
  calls: ProjectedToolCall[];
  malformed: boolean;
} {
  const tools = metadataRecord(progress?.tools);
  if (!tools || tools.lastCalls === undefined) return { calls: [], malformed: false };
  if (!Array.isArray(tools.lastCalls)) return { calls: [], malformed: true };
  const turn = nonNegativeInteger(tools.turn) ?? 0;
  let malformed = false;
  const calls = tools.lastCalls.flatMap((value, index) => {
    const record = metadataRecord(value);
    if (!record) {
      malformed = true;
      return [];
    }
    const toolCallId = boundedString(record.toolCallId, toolTextBytes);
    const toolName = boundedString(record.toolName, toolTextBytes)
      ?? boundedString(record.title, toolTextBytes)
      ?? boundedString(record.kind, toolTextBytes);
    const status = boundedString(record.status, toolTextBytes);
    const inputPreview = boundedString(record.inputPreview, toolTextBytes);
    const duration = durationMs(
      boundedString(record.startedAt, summaryTextBytes),
      boundedString(record.completedAt, summaryTextBytes),
    );
    return [{
      key: toolCallKey(turn, toolCallId, `progress:${index}`),
      call: {
        turn,
        ...(toolCallId ? { toolCallId } : {}),
        ...(toolName ? { toolName } : {}),
        ...(status ? { status } : {}),
        ...(duration === undefined ? {} : { durationMs: duration }),
        ...(inputPreview ? { inputPreview } : {}),
      },
    }];
  });
  return { calls, malformed };
}

function observationToolCalls(
  observations: ReturnType<typeof exactObservations>,
): {
  calls: ProjectedToolCall[];
  malformed: boolean;
} {
  const entries = observations.entries.flatMap(entry => {
    if (entry.kind !== "activity"
      || entry.channel !== "tool"
      || entry.postFence === true
      || !entry.tool) return [];
    return [{ entry, tool: entry.tool }];
  }).sort((left, right) => compareObservationEntries(left.entry, right.entry));
  const latest = new Map<string, typeof entries[number]>();
  for (const candidate of entries) {
    const key = toolCallKey(
      candidate.entry.turn,
      candidate.tool.toolCallId,
      `entry:${candidate.entry.id}`,
    );
    latest.delete(key);
    latest.set(key, candidate);
  }
  const calls = [...latest.entries()].map(([key, candidate]) => {
    const { entry, tool } = candidate;
    const toolCallId = boundedString(tool.toolCallId, toolTextBytes);
    const toolName = boundedString(tool.name, toolTextBytes);
    const status = boundedString(tool.status, toolTextBytes);
    const inputPreview = boundedString(tool.input?.text, toolTextBytes);
    const duration = durationMs(tool.startedAt, tool.finishedAt);
    return {
      key,
      call: {
        turn: entry.turn,
        ...(toolCallId ? { toolCallId } : {}),
        ...(toolName ? { toolName } : {}),
        ...(status ? { status } : {}),
        ...(duration === undefined ? {} : { durationMs: duration }),
        ...(inputPreview ? { inputPreview } : {}),
      },
    };
  });
  return { calls, malformed: false };
}

function activeToolCalls(
  observations: ReturnType<typeof exactObservations>,
): {
  calls: ProjectedToolCall[];
  malformed: boolean;
} {
  const calls = observations.currents
    .filter(current => current.postFence !== true)
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.turn - right.turn)
    .flatMap(current => current.tools?.active.map((tool, index) => {
      const toolCallId = boundedString(tool.toolCallId, toolTextBytes);
      const toolName = boundedString(tool.name, toolTextBytes);
      const status = boundedString(tool.status, toolTextBytes);
      const inputPreview = boundedString(tool.input?.text, toolTextBytes);
      const duration = durationMs(tool.startedAt, tool.finishedAt);
      return {
        key: toolCallKey(current.turn, toolCallId, `active:${current.turn}:${index}`),
        call: {
          turn: current.turn,
          ...(toolCallId ? { toolCallId } : {}),
          ...(toolName ? { toolName } : {}),
          ...(status ? { status } : {}),
          ...(duration === undefined ? {} : { durationMs: duration }),
          ...(inputPreview ? { inputPreview } : {}),
        },
      };
    }) ?? []);
  return { calls, malformed: false };
}

function mergeToolCalls(calls: readonly ProjectedToolCall[]): RunInspectionAgentExecutionToolCall[] {
  const latest = new Map<string, RunInspectionAgentExecutionToolCall>();
  for (const candidate of calls) {
    latest.delete(candidate.key);
    latest.set(candidate.key, candidate.call);
  }
  return [...latest.values()].slice(-toolLimit);
}

function compareObservationEntries(
  left: AgentObservationInspectionProjection["entries"][number],
  right: AgentObservationInspectionProjection["entries"][number],
): number {
  return left.observationVersion - right.observationVersion
    || left.sourceSequence - right.sourceSequence
    || left.id.localeCompare(right.id);
}

function toolCallKey(turn: number, toolCallId: string | undefined, fallback: string): string {
  return `${turn}\u0000${toolCallId ?? fallback}`;
}

function durationMs(startedAt: string | undefined, finishedAt: string | undefined): number | undefined {
  if (!startedAt || !finishedAt) return undefined;
  const duration = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function latestTimestamp(values: Array<string | undefined>): string | undefined {
  return values.filter((value): value is string => value !== undefined)
    .sort((left, right) => right.localeCompare(left))[0];
}

function maximumDefined(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length === 0 ? undefined : Math.max(...defined);
}

function metadataRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedString(value: unknown, bytes: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? utf8Head(value, bytes) : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}
