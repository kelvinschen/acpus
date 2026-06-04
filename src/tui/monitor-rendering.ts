import type { RunMonitorStage, RunMonitorView, RunMonitorTask, TaskDetailView } from "../projections/run-monitor.js";

export type MonitorFocus = "stages" | "tasks" | "detail";

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

export function tasksForStage(view: RunMonitorView | undefined, stageId: string | undefined): RunMonitorTask[] {
  if (!view || !stageId) return [];
  return view.tasks.filter((task) => task.stageId === stageId);
}

export function stageProgressLabel(stage: RunMonitorStage): string {
  const counts = stage.taskCounts;
  return `${counts.completed}/${counts.total}`;
}

export function runProgressLabel(view: RunMonitorView): string {
  return `${view.progress.completedTasks}/${view.progress.knownTasks} tasks`;
}

export function runStatusLabel(view: RunMonitorView): string {
  if ((view.run.status === "running" || view.run.status === "pending") && view.run.worker?.status === "stale") return "stale";
  return view.run.status;
}

export function statusMark(status: string | undefined): string {
  if (status === "completed") return "✔";
  if (status === "running" || status === "raw_received" || status === "parsing") return "●";
  if (status === "blocked" || status === "failed" || status === "cancelled" || status === "timed_out") return "!";
  if (status === "skipped") return "-";
  return " ";
}

export function shorten(value: string | undefined, width: number): string {
  if (!value) return "";
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width <= 3) return value.slice(0, width);
  return `${value.slice(0, width - 3)}...`;
}

export function detailSummary(detail: TaskDetailView | undefined): string[] {
  if (!detail) return ["No task selected"];
  const lines = [
    `${statusMark(detail.task.status)} ${detail.task.status} - ${detail.task.execution}${detail.task.agent ? ` - ${detail.task.agent}` : ""}`,
    detail.task.durationMs !== undefined || detail.task.elapsedMs !== undefined ? `Time: ${formatDuration(detail.task.durationMs ?? detail.task.elapsedMs ?? 0)}` : undefined,
    detail.task.blockedReason ? `Reason: ${detail.task.blockedReason}` : undefined,
    detail.task.lastRetryReason ? `Retry: ${detail.task.lastRetryReason} ${detail.task.retryBudgetUsed ?? 0}/${detail.task.retryBudgetLimit ?? "?"}` : undefined,
    detail.task.lastFailureCode ? `Last failure: ${detail.task.lastFailureCode}` : undefined,
    detail.outcome?.summary ? `Outcome: ${detail.outcome.summary}` : undefined,
    detail.outcome?.path ? `Output: ${detail.outcome.path}` : undefined,
    detail.prompt ? `Prompt: ${detail.prompt.lines} line(s)` : undefined,
    detail.prompt?.preview ? detail.prompt.preview : undefined,
    detail.activity.totalAttempts > 0 ? `Attempts: ${detail.activity.totalAttempts}` : "No agent attempts",
    ...detail.activity.attempts.map((attempt) => {
      const retry = attempt.isRetry ? ` retry=${attempt.retryReason ?? "unknown"}#${attempt.retryOrdinal ?? "?"}` : "";
      const failure = attempt.lastFailureCode ? ` last=${attempt.lastFailureCode}` : "";
      return `${attempt.id} ${attempt.status}${retry}${failure} ${attempt.path}`;
    })
  ];
  return lines.filter((line): line is string => typeof line === "string" && line.length > 0);
}

export function nextIndex(current: number, delta: number, length: number): number {
  return clampIndex(current + delta, length);
}

export function formatDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return "";
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
