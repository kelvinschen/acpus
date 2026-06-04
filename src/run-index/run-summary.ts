import fs from "node:fs/promises";
import path from "node:path";
import { runsDir } from "./paths.js";
import { readRunIndex, type RunIndex, type RunStatus } from "./read-write.js";
import { workerSummary } from "../runtime/worker.js";

export type RunSummaryEntry = {
  runId: string;
  runDir: string;
  workflowName?: string;
  status?: RunStatus;
  progress?: {
    completedStages: number;
    totalStages: number;
    label: string;
  };
  createdAt?: string;
  updatedAt?: string;
  durationMs?: number;
  elapsedMs?: number;
  worker?: ReturnType<typeof workerSummary>;
  invalid?: boolean;
  error?: string;
  sortTime: string;
};

export type RunSummaryList = {
  kind: "runs";
  dir: string;
  entries: RunSummaryEntry[];
};

export async function listRunSummaries(cwd = process.cwd()): Promise<RunSummaryList> {
  const dir = runsDir(cwd);
  let entries: Array<{ name: string; mtimeMs: number }>;
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .map((name) => ({ name, mtimeMs: 0 }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "runs", dir, entries: [] };
    throw error;
  }

  const withMtime = await Promise.all(entries.map(async (entry) => {
    try {
      const stat = await fs.stat(path.join(dir, entry.name));
      return { ...entry, mtimeMs: stat.mtimeMs };
    } catch {
      return entry;
    }
  }));
  const summaries = await Promise.all(withMtime.map((entry) => runSummary(cwd, dir, entry.name, entry.mtimeMs)));
  summaries.sort((left, right) => parseTime(right.sortTime) - parseTime(left.sortTime) || right.runId.localeCompare(left.runId));
  return { kind: "runs", dir, entries: summaries };
}

export function formatRunSummaryList(list: RunSummaryList): string {
  if (list.entries.length === 0) return `runs in ${list.dir}\nNo runs found.\n`;
  const lines = [`runs in ${list.dir}`];
  for (const entry of list.entries) {
    const status = entry.status ?? "invalid";
    const workflow = entry.workflowName ? ` ${entry.workflowName}` : "";
    const progress = entry.progress ? ` ${entry.progress.label}` : "";
    const worker = entry.worker ? ` worker=${entry.worker.status}` : "";
    const updated = entry.updatedAt ?? entry.sortTime;
    const invalid = entry.invalid && entry.error ? ` error=${entry.error}` : "";
    lines.push(`- ${entry.runId} ${status}${progress}${worker}${workflow} updated=${updated}${invalid}`);
  }
  return `${lines.join("\n")}\n`;
}

async function runSummary(cwd: string, parentDir: string, runId: string, mtimeMs: number): Promise<RunSummaryEntry> {
  const runDir = path.join(parentDir, runId);
  const fallbackTime = timeFromRunId(runId) ?? new Date(mtimeMs || 0).toISOString();
  try {
    const index = await readRunIndex(cwd, runId);
    const progress = stageProgress(index);
    const terminalAt = terminalTime(index);
    const updatedAt = index.updatedAt ?? terminalAt;
    const createdAtMs = parseTimeOrUndefined(index.createdAt);
    const terminalAtMs = terminalAt ? parseTimeOrUndefined(terminalAt) : undefined;
    return {
      runId,
      runDir,
      workflowName: index.workflowName,
      status: index.status,
      progress,
      createdAt: index.createdAt,
      updatedAt,
      durationMs: terminalAtMs !== undefined && createdAtMs !== undefined ? terminalAtMs - createdAtMs : undefined,
      elapsedMs: terminalAt ? undefined : createdAtMs !== undefined ? Date.now() - createdAtMs : undefined,
      worker: workerSummary(index.worker),
      sortTime: firstValidTime(updatedAt, index.createdAt, fallbackTime)
    };
  } catch (error) {
    return {
      runId,
      runDir,
      invalid: true,
      error: error instanceof Error ? error.message : String(error),
      sortTime: fallbackTime
    };
  }
}

function stageProgress(index: RunIndex): RunSummaryEntry["progress"] {
  const stages = Object.values(index.stages);
  const completed = stages.filter((stage) => stage.status === "completed" || stage.status === "skipped").length;
  return {
    completedStages: completed,
    totalStages: stages.length,
    label: `${completed}/${stages.length} stages`
  };
}

function terminalTime(index: RunIndex): string | undefined {
  const completed = Object.values(index.stages)
    .map((stage) => stage.completedAt)
    .filter((value): value is string => Boolean(value))
    .sort();
  return completed.at(-1);
}

function timeFromRunId(runId: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(runId);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, ms] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${ms}Z`;
}

function firstValidTime(...values: Array<string | undefined>): string {
  return values.find((value) => value !== undefined && parseTimeOrUndefined(value) !== undefined) ?? new Date(0).toISOString();
}

function parseTime(value: string): number {
  return parseTimeOrUndefined(value) ?? 0;
}

function parseTimeOrUndefined(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
