import type { AgentTurnResult } from "@acpus/agent-executor";

export function agentSummary(eventCount: number): AgentTurnResult["summary"] {
  return { eventCount, tools: { totalToolCallCount: 0, calls: [] } };
}

export function agentTiming(elapsedMs = 1): AgentTurnResult["timing"] {
  return {
    startedAt: "2026-07-01T00:00:00.000Z",
    finishedAt: "2026-07-01T00:00:00.001Z",
    elapsedMs,
  };
}

export function completedAgentTurn(responseText: string, stderr = "", summary = agentSummary(1)): AgentTurnResult {
  return { status: "completed", responseText, stderr, summary, timing: agentTiming() };
}
