import type { AgentTurnRequest, AgentTurnResult } from "@acpus/agent-executor";

export function agentSummary(eventCount: number): AgentTurnResult["summary"] {
  return {
    eventCount,
    availability: { context: "unavailable", tokenUsage: "unavailable" },
    tools: { totalToolCallCount: 0, calls: [] },
  };
}

export function agentTiming(elapsedMs = 1): AgentTurnResult["timing"] {
  return {
    startedAt: "2026-07-01T00:00:00.000Z",
    finishedAt: "2026-07-01T00:00:00.001Z",
    elapsedMs,
  };
}

export function completedAgentTurn(finalResponse: string, stderr = "", summary = agentSummary(1)): AgentTurnResult {
  return segmentedCompletedAgentTurn(finalResponse.length === 0 ? [] : [finalResponse], finalResponse, stderr, summary);
}

export function segmentedCompletedAgentTurn(
  responses: readonly string[],
  finalResponse: string,
  stderr = "",
  summary = agentSummary(1),
): AgentTurnResult {
  return { status: "completed", responses: [...responses], finalResponse, stderr, summary, timing: agentTiming() };
}

export function taggedAgentOutput(payload: string): string {
  return `<ACPUS_OUTPUT>\n${payload}\n</ACPUS_OUTPUT>`;
}

export function observedCompletedAgentTurn(request: AgentTurnRequest, finalResponse: string): AgentTurnResult {
  const result = completedAgentTurn(finalResponse);
  request.onObservation?.({
    event: {
      schemaVersion: 1,
      sequence: 0,
      observedAt: "2026-07-01T00:00:00.001Z",
      elapsedMs: 1,
      type: "message",
      channel: "assistant",
      content: finalResponse,
    },
    progress: {
      responses: [...result.responses],
      summary: result.summary,
      updatedAt: "2026-07-01T00:00:00.001Z",
    },
  });
  request.onObservation?.({
    event: {
      schemaVersion: 1,
      sequence: 1,
      observedAt: "2026-07-01T00:00:00.001Z",
      elapsedMs: 1,
      type: "turn_end",
      status: "completed",
    },
    progress: {
      responses: [...result.responses],
      summary: result.summary,
      updatedAt: "2026-07-01T00:00:00.001Z",
    },
  });
  return result;
}
