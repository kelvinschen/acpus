import type { AgentToolCallTelemetry, NodeExecutionState, RunState, RunSupervisorClient } from "@acpus/runtime";

type ArtifactPathResolver = Pick<RunSupervisorClient, "getArtifactPath">;

export async function formatRunShow(
  run: RunState,
  client?: ArtifactPathResolver,
  nowMs = Date.now()
): Promise<string> {
  const lines: string[] = [];
  lines.push(`Run: ${run.runId}`);
  lines.push(`Workflow: ${run.workflowName}`);
  if (run.workflowRef) lines.push(`Workflow Ref: ${run.workflowRef}`);
  if (run.workflowSourcePath) lines.push(`Workflow Source: ${run.workflowSourcePath}`);
  if (run.lineage) {
    lines.push(`Forked From: ${run.lineage.sourceRunId} (origin=${run.lineage.forkOriginNodeKey}, inherited=${run.lineage.inheritedNodeCount})`);
  }
  lines.push(`Status: ${run.status}`);
  lines.push(`Created: ${run.createdAt}`);
  lines.push(`Updated: ${run.updatedAt}`);
  lines.push("");
  lines.push("Nodes:");

  for (const node of run.nodes ?? []) {
    lines.push(`  ${node.nodeKey}  [${node.kind}]  ${node.state}  attempt=${node.attempt}`);
    if (node.error) lines.push(`    Error: ${node.error}`);
    if (node.artifactRefs?.length) lines.push(`    Artifacts: ${node.artifactRefs.join(", ")}`);
    const activity = await summarizeRunningAgentActivity(run.runId, node, client, nowMs);
    if (activity) lines.push(`    Activity: ${activity}`);
  }

  return lines.join("\n");
}

async function summarizeRunningAgentActivity(
  runId: string,
  node: NodeExecutionState,
  client: ArtifactPathResolver | undefined,
  nowMs: number
): Promise<string | undefined> {
  void runId;
  void client;
  if (node.kind !== "run.agent" || node.state !== "running") return undefined;
  const telemetry = node.agentTelemetry;
  const attempt = telemetry?.attempts.find((item) => item.attempt === telemetry.currentAttempt)
    ?? telemetry?.attempts[telemetry.attempts.length - 1];
  if (!attempt) return undefined;

  const parts = [`updated=${formatAge(nowMs - Date.parse(attempt.updatedAt))} ago`, `tool_calls=${attempt.tools.totalToolCallCount}`];
  const recent = attempt.tools.recentCalls.slice(0, 3).map(formatToolName).filter(Boolean);
  if (recent.length > 0) parts.push(`recent=${recent.join(", ")}`);
  if (attempt.tools.droppedToolCallCount > 0) parts.push(`dropped=${attempt.tools.droppedToolCallCount}`);
  if (attempt.context) parts.push(`context=${formatContextUsage(attempt.context.used, attempt.context.size)}`);
  return parts.join("; ");
}

function formatContextUsage(used: number, size: number): string {
  return `${formatContextNumber(used)}/${formatContextNumber(size)}`;
}

function formatContextNumber(value: number): string {
  return value < 1000 ? String(value) : `${Math.floor(value / 1000)}k`;
}

function formatToolName(tool: AgentToolCallTelemetry): string {
  const raw = tool.title ?? tool.toolName ?? tool.kind ?? tool.toolCallId;
  return raw.replace(/\s+/g, " ").trim();
}

function formatAge(deltaMs: number): string {
  const safeMs = Number.isFinite(deltaMs) ? Math.max(0, deltaMs) : 0;
  const seconds = Math.floor(safeMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
