import type { AgentTurnResult } from "@acpus/agent-executor";

export function agentTelemetry(eventCount: number): AgentTurnResult["telemetry"] {
  return { eventCount, tools: { totalToolCallCount: 0, calls: [] } };
}

export function completedAgentTurn(responseText: string, stderr = "", telemetry = agentTelemetry(1)): AgentTurnResult {
  return { status: "completed", responseText, stderr, telemetry };
}
