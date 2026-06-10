import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { NodeExecutionState, RunState, RunSupervisorClient } from "@acpus/runtime";
import {
  AgentTranscriptAccumulator,
  mergeAgentExecutionSummaries,
  type AgentExecutionSummary
} from "@acpus/tui/agent-transcript";

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
  lines.push(`Status: ${run.status}`);
  lines.push(`Created: ${run.createdAt}`);
  lines.push(`Updated: ${run.updatedAt}`);
  lines.push("");
  lines.push("Nodes:");

  for (const node of run.nodes ?? []) {
    lines.push(`  ${node.nodeKey}  [${node.kind}]  ${node.state}  attempt=${node.attempt}`);
    if (node.error) lines.push(`    Error: ${node.error}`);
    if (node.artifactRefs?.length) lines.push(`    Artifacts: ${node.artifactRefs.join(", ")}`);
    const activity = client ? await summarizeRunningAgentActivity(run.runId, node, client, nowMs) : undefined;
    if (activity) lines.push(`    Activity: ${activity}`);
  }

  return lines.join("\n");
}

async function summarizeRunningAgentActivity(
  runId: string,
  node: NodeExecutionState,
  client: ArtifactPathResolver,
  nowMs: number
): Promise<string | undefined> {
  if (node.kind !== "run.agent" || node.state !== "running") return undefined;
  const transcriptRefs = (node.artifactRefs ?? []).filter((ref) => ref.endsWith(".transcript.jsonl"));
  if (transcriptRefs.length === 0) return undefined;

  const parsed = await Promise.all(transcriptRefs.map((ref) => readTranscriptSummary(runId, ref, client)));
  const available = parsed.filter((item): item is TranscriptRead => item !== undefined);
  if (available.length === 0) return undefined;

  const summary = mergeAgentExecutionSummaries(available.map((item) => item.summary));
  const updatedMs = Math.max(...available.map((item) => item.updatedMs));
  const parts = [`updated=${formatAge(nowMs - updatedMs)} ago`, `tool_calls=${summary.toolCallCount}`];
  const recent = summary.recentToolCalls.map(formatToolName).filter(Boolean);
  if (recent.length > 0) parts.push(`recent=${recent.join(", ")}`);
  if (summary.outputTokens !== undefined) {
    const prefix = summary.outputTokenSource === "estimated" ? "~" : "";
    parts.push(`output_tokens=${prefix}${summary.outputTokens}`);
  }
  return parts.join("; ");
}

interface TranscriptRead {
  summary: AgentExecutionSummary;
  updatedMs: number;
}

async function readTranscriptSummary(
  runId: string,
  ref: string,
  client: ArtifactPathResolver
): Promise<TranscriptRead | undefined> {
  try {
    const absPath = await client.getArtifactPath(runId, ref);
    const fileStat = await stat(absPath);
    const accumulator = new AgentTranscriptAccumulator();
    for await (const chunk of createReadStream(absPath, { encoding: "utf8" })) {
      accumulator.append(chunk);
    }
    accumulator.flush();
    return { summary: accumulator.summary(), updatedMs: fileStat.mtimeMs };
  } catch {
    return undefined;
  }
}

function formatToolName(tool: { title?: string; toolName?: string; kind?: string; toolCallId: string }): string {
  const raw = tool.title ?? tool.toolName ?? tool.kind ?? tool.toolCallId;
  return raw.replace(/\s+/g, " ").trim();
}

function formatAge(deltaMs: number): string {
  const safeMs = Math.max(0, deltaMs);
  const seconds = Math.floor(safeMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
