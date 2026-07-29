import type { AgentObservationInspectionProjection } from "../observations/log.js";
import { utf8Head } from "../utf8.js";
import {
  inspectionSubject,
  inspectionTargetState,
  inspectionVisibility,
} from "./decision-projection.js";
import type {
  RunInspectionAgentExecutionDocument,
  RunInspectionAgentExecutionToolCall,
} from "./types.js";
import type { ResolvedTargetState } from "./resolved-target.js";

const toolLimit = 3;
const toolTextBytes = 2_048;

/**
 * Agent execution deliberately reads one bounded Observation projection. It does
 * not reconcile progress or execution metadata into a claim about full history.
 */
export function projectAgentExecution(input: {
  details: ResolvedTargetState;
  observations?: AgentObservationInspectionProjection;
}): RunInspectionAgentExecutionDocument {
  const state = inspectionTargetState(input.details);
  const common = {
    schemaVersion: 2 as const,
    kind: "execution" as const,
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
      recentTools: [],
    };
  }

  const selectedAttempt = input.details.summary.latestAttempt;
  if (!selectedAttempt) {
    return {
      ...common,
      available: false,
      reason: "not-started",
      summary: { status: state.status },
      recentTools: [],
    };
  }

  const observations = exactObservations(input.observations, selectedAttempt.attemptId);
  const current = observations.currents
    .filter(value => value.postFence !== true)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  const recentTools = observedTools(observations);
  const lastObservedAt = latestTimestamp([
    ...observations.turns.flatMap(turn => [turn.fencedAt ?? turn.finishedAt, turn.startedAt]),
    ...observations.currents.filter(value => value.postFence !== true).map(value => value.updatedAt),
    ...observations.entries
      .filter(value => value.kind === "activity" && value.postFence !== true)
      .map(value => value.at),
  ]);
  const turnCount = maximum(observations.turns.map(turn => turn.turn));

  return {
    ...common,
    available: true,
    summary: {
      status: state.status,
      ...(turnCount === undefined ? {} : { turnCount }),
    },
    ...(lastObservedAt === undefined ? {} : { lastObservedAt }),
    ...(current?.context === undefined
      ? {}
      : {
          contextWindow: {
            used: current.context.used,
            size: current.context.size,
            ...(current.context.size > 0
              ? { percent: (current.context.used / current.context.size) * 100 }
              : {}),
            updatedAt: current.context.updatedAt,
          },
        }),
    ...(current?.tokenUsage === undefined
      ? {}
      : {
          tokenUsage: {
            source: current.tokenUsage.source,
            ...(current.tokenUsage.inputTokens === undefined ? {} : { inputTokens: current.tokenUsage.inputTokens }),
            ...(current.tokenUsage.outputTokens === undefined ? {} : { outputTokens: current.tokenUsage.outputTokens }),
            ...(current.tokenUsage.totalTokens === undefined ? {} : { totalTokens: current.tokenUsage.totalTokens }),
          },
        }),
    ...(current?.response === undefined
      ? {}
      : {
          output: {
            tail: current.response.text,
            totalBytes: current.response.originalBytes,
            truncated: current.response.truncated,
          },
        }),
    ...(input.observations === undefined ? {} : (() => {
      const visibility = inspectionVisibility(input.details, input.observations);
      return visibility === undefined ? {} : { visibility };
    })()),
    recentTools,
  };
}

function exactObservations(
  projection: AgentObservationInspectionProjection | undefined,
  attemptId: string,
): AgentObservationInspectionProjection {
  if (!projection) {
    return {
      version: 0,
      turns: [],
      currents: [],
      entries: [],
      retentionOmittedBefore: 0,
      olderEntryCount: 0,
      hasOlderEntries: false,
    };
  }
  return {
    ...projection,
    turns: projection.turns.filter(value => value.attemptId === attemptId),
    currents: projection.currents.filter(value => value.attemptId === attemptId),
    entries: projection.entries.filter(value => value.attemptId === attemptId),
  };
}

function observedTools(observations: AgentObservationInspectionProjection): RunInspectionAgentExecutionToolCall[] {
  const tools = new Map<string, { at: string; call: RunInspectionAgentExecutionToolCall }>();
  for (const entry of observations.entries) {
    if (entry.kind !== "activity" || entry.postFence || !entry.tool) continue;
    addTool(tools, entry.tool, entry.turn);
  }
  for (const current of observations.currents) {
    if (current.postFence) continue;
    for (const tool of [...(current.tools?.active ?? []), ...(current.tools?.recent ? [current.tools.recent] : [])]) {
      addTool(tools, tool, current.turn);
    }
  }
  return [...tools.values()]
    .sort((left, right) => left.at.localeCompare(right.at))
    .slice(-toolLimit)
    .map(value => value.call);
}

function addTool(
  tools: Map<string, { at: string; call: RunInspectionAgentExecutionToolCall }>,
  tool: {
    toolCallId?: string;
    name: string;
    status?: string;
    input?: { text: string };
    updatedAt: string;
    startedAt?: string;
    finishedAt?: string;
  },
  turn: number,
): void {
  const key = tool.toolCallId ?? `${turn}:${tool.name}:${tool.startedAt ?? tool.updatedAt}`;
  tools.set(key, {
    at: tool.updatedAt,
    call: {
      turn,
      ...(tool.toolCallId === undefined ? {} : { toolCallId: tool.toolCallId }),
      toolName: tool.name,
      ...(tool.status === undefined ? {} : { status: tool.status }),
      ...(tool.startedAt === undefined || tool.finishedAt === undefined
        ? {}
        : { durationMs: Math.max(0, Date.parse(tool.finishedAt) - Date.parse(tool.startedAt)) }),
      ...(tool.input === undefined ? {} : { inputPreview: utf8Head(tool.input.text, toolTextBytes) }),
    },
  });
}

function latestTimestamp(values: readonly (string | undefined)[]): string | undefined {
  return values.filter((value): value is string => value !== undefined).sort().at(-1);
}

function maximum(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : Math.max(...values);
}
