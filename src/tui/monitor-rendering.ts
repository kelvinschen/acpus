import type { RunMonitorStage, RunMonitorView, RunMonitorWorkUnit, WorkUnitDetailView } from "../projections/run-monitor.js";

export type MonitorFocus = "stages" | "workUnits" | "detail";

export function defaultStageIndex(stages: RunMonitorStage[]): number {
  const running = stages.findIndex((stage) => stage.status === "running");
  if (running >= 0) return running;
  const blocked = stages.findIndex((stage) => stage.status === "blocked" || stage.status === "failed");
  if (blocked >= 0) return blocked;
  const open = stages.findIndex((stage) => stage.status !== "completed" && stage.status !== "skipped");
  return open >= 0 ? open : 0;
}

export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

export function workUnitsForStage(view: RunMonitorView | undefined, stageId: string | undefined): RunMonitorWorkUnit[] {
  if (!view || !stageId) return [];
  return view.workUnits.filter((unit) => unit.stageId === stageId);
}

export function stageProgressLabel(stage: RunMonitorStage): string {
  const counts = stage.workUnitCounts;
  return `${counts.completed}/${counts.total}`;
}

export function runProgressLabel(view: RunMonitorView): string {
  return `${view.progress.completedWorkUnits}/${view.progress.knownWorkUnits} agents`;
}

export function statusMark(status: string | undefined): string {
  if (status === "completed") return "[x]";
  if (status === "running" || status === "raw_received" || status === "parsing" || status === "repairing") return "[>]";
  if (status === "blocked" || status === "failed" || status === "cancelled" || status === "timed_out") return "[!]";
  if (status === "skipped") return "[-]";
  return "[ ]";
}

export function shorten(value: string | undefined, width: number): string {
  if (!value) return "";
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width <= 3) return value.slice(0, width);
  return `${value.slice(0, width - 3)}...`;
}

export function detailSummary(detail: WorkUnitDetailView | undefined): string[] {
  if (!detail) return ["Loading detail..."];
  const lines = [
    `${statusMark(detail.workUnit.status)} ${detail.workUnit.status} - ${detail.workUnit.agent ?? "agent"}`,
    detail.workUnit.blockedReason ? `Reason: ${detail.workUnit.blockedReason}` : undefined,
    detail.outcome?.summary ? `Outcome: ${detail.outcome.summary}` : undefined,
    detail.outcome?.path ? `Output: ${detail.outcome.path}` : undefined,
    detail.prompt ? `Prompt: ${detail.prompt.lines} line(s)` : undefined,
    detail.prompt?.preview ? detail.prompt.preview : undefined,
    detail.activity.totalAttempts > 0 ? `Attempts: ${detail.activity.totalAttempts}` : undefined,
    ...detail.activity.attempts.map((attempt) => `${attempt.id} ${attempt.status} ${attempt.path}`),
    ...((detail.outcome?.artifacts ?? []).map((artifact) => `Artifact: ${artifact.label ?? artifact.kind ?? "artifact"} ${artifact.path ?? artifact.url ?? ""}`))
  ];
  return lines.filter((line): line is string => typeof line === "string" && line.length > 0);
}

export function nextIndex(current: number, delta: number, length: number): number {
  return clampIndex(current + delta, length);
}
