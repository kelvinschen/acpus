import fs from "node:fs/promises";
import path from "node:path";
import { runDir } from "../run-index/paths.js";
import type { AttemptIndexEntry, AttemptStatus, RunIndex, StageIndexEntry, StageStatus } from "../run-index/read-write.js";
import { workerSummary } from "../runtime/worker.js";
import type { Stage, WorkflowSpec } from "../schema/workflow-spec.js";

export const RUN_MONITOR_VIEW_VERSION = "acpx-workflow-orchestrator.monitor/v1";
export const TASK_DETAIL_VIEW_VERSION = "acpx-workflow-orchestrator.task-detail/v1";

export type TaskStatus = StageStatus | AttemptStatus;
export type TaskKind = "stage" | "fanoutLane" | "loopStage" | "loopFanoutLane";
export type TaskExecution = "agent" | "deterministic";

export type RunMonitorStage = {
  id: string;
  kind: Stage["kind"];
  status: StageStatus;
  dependsOn: string[];
  startedAt?: string;
  completedAt?: string;
  blockedReason?: string;
  skippedReason?: string;
  outputPath?: string;
  elapsedMs?: number;
  durationMs?: number;
  taskCounts: TaskCounts;
};

export type TaskCounts = {
  total: number;
  pending: number;
  running: number;
  completed: number;
  blocked: number;
  failed: number;
  skipped: number;
};

export type RunMonitorTask = {
  id: string;
  kind: TaskKind;
  execution: TaskExecution;
  stageId: string;
  label: string;
  status: TaskStatus;
  roleName?: string;
  agent?: string;
  roleMode?: string;
  attemptId?: string;
  attemptIds: string[];
  round?: number;
  bodyStageId?: string;
  itemId?: string;
  itemIndex?: number;
  groupId?: string;
  laneId?: string;
  startedAt?: string;
  completedAt?: string;
  blockedReason?: string;
  errorCode?: string;
  outputPath?: string;
  elapsedMs?: number;
  durationMs?: number;
};

export type RunMonitorView = {
  version: typeof RUN_MONITOR_VIEW_VERSION;
  generatedAt: string;
  run: {
    logicalRunId: string;
    workflowName: string;
    status: RunIndex["status"];
    blockedReason?: string;
    gateVerdict?: RunIndex["gateVerdict"];
    runDir: string;
    createdAt: string;
    updatedAt: string;
    elapsedMs?: number;
    durationMs?: number;
    worker?: ReturnType<typeof workerSummary>;
  };
  stages: RunMonitorStage[];
  tasks: RunMonitorTask[];
  progress: {
    knownTasks: number;
    completedTasks: number;
  };
};

export type TaskDetailView = {
  version: typeof TASK_DETAIL_VIEW_VERSION;
  generatedAt: string;
  run: RunMonitorView["run"];
  task: RunMonitorTask;
  prompt?: {
    preview: string;
    lines: number;
  };
  activity: {
    attempts: Array<{
      id: string;
      kind: AttemptIndexEntry["kind"];
      status: AttemptIndexEntry["status"];
      startedAt?: string;
      endedAt?: string;
      path: string;
      blockedReason?: string;
      parseErrorCode?: string;
      runtimeErrorCode?: string;
    }>;
    totalAttempts: number;
  };
  outcome?: {
    path?: string;
    status?: string;
    summary?: string;
    blockedReason?: string;
    artifacts: Array<{ kind?: string; path?: string; url?: string; label?: string }>;
    preview?: string;
  };
};

const MAX_DETAIL_ATTEMPTS = 5;
const MAX_OUTPUT_PREVIEW_CHARS = 2048;

export async function buildRunMonitorView(cwd: string, spec: WorkflowSpec, index: RunIndex): Promise<RunMonitorView> {
  const dir = runDir(index.logicalRunId, cwd);
  const generatedAt = new Date().toISOString();
  const tasks = buildTasks(spec, index, generatedAt);
  return {
    version: RUN_MONITOR_VIEW_VERSION,
    generatedAt,
    run: {
      logicalRunId: index.logicalRunId,
      workflowName: index.workflowName,
      status: index.status,
      blockedReason: index.blockedReason,
      gateVerdict: index.gateVerdict,
      runDir: dir,
      createdAt: index.createdAt,
      updatedAt: index.updatedAt,
      ...timing(index.createdAt, terminalRun(index.status) ? index.updatedAt : undefined, generatedAt),
      worker: workerSummary(index.worker)
    },
    stages: spec.stages.map((stage) => stageSummary(stage, index.stages[stage.id], tasks, generatedAt)),
    tasks,
    progress: {
      knownTasks: tasks.length,
      completedTasks: tasks.filter((task) => task.status === "completed").length
    }
  };
}

export async function buildTaskDetailView(cwd: string, spec: WorkflowSpec, index: RunIndex, taskId: string): Promise<TaskDetailView> {
  const monitor = await buildRunMonitorView(cwd, spec, index);
  const task = monitor.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  const attempts = task.attemptIds
    .map((id) => index.attempts[id])
    .filter((attempt): attempt is AttemptIndexEntry => attempt !== undefined)
    .sort(compareAttempts);
  const latestPrompt = [...attempts].reverse().find((attempt) => typeof attempt.promptPreview === "string" && attempt.promptPreview.length > 0)?.promptPreview;
  const output = await readOutputSummary(path.join(runDir(index.logicalRunId, cwd), task.outputPath ?? ""));
  return {
    version: TASK_DETAIL_VIEW_VERSION,
    generatedAt: new Date().toISOString(),
    run: monitor.run,
    task,
    prompt: latestPrompt ? { preview: latestPrompt, lines: lineCount(latestPrompt) } : undefined,
    activity: {
      attempts: attempts.slice(-MAX_DETAIL_ATTEMPTS).map((attempt) => ({
        id: attempt.id,
        kind: attempt.kind,
        status: attempt.status,
        startedAt: attempt.startedAt,
        endedAt: attempt.endedAt,
        path: attempt.path,
        blockedReason: attempt.blockedReason,
        parseErrorCode: attempt.parseErrorCode,
        runtimeErrorCode: attempt.runtimeErrorCode
      })),
      totalAttempts: attempts.length
    },
    outcome: output
  };
}

function buildTasks(spec: WorkflowSpec, index: RunIndex, now: string): RunMonitorTask[] {
  const tasks: RunMonitorTask[] = [];
  for (const stage of spec.stages) {
    const state = index.stages[stage.id];
    if (!state) continue;
    const roleName = stageRoleName(stage);
    if (roleName) {
      const attempts = topLevelStageAttempts(index, state);
      tasks.push(stageTask(stage, state, roleName, spec, attempts, now));
    } else if (stage.kind !== "fanout" && stage.kind !== "loop") {
      tasks.push(deterministicStageTask(stage, state, now));
    }
    if (stage.kind === "fanout") tasks.push(...fanoutTasks(stage.id, state.fanout, spec, index, now));
    if (stage.kind === "loop") tasks.push(...loopTasks(stage, state, spec, index, now));
  }
  return tasks;
}

function stageTask(stage: Stage, state: StageIndexEntry, roleName: string, spec: WorkflowSpec, attempts: AttemptIndexEntry[], now: string): RunMonitorTask {
  const latest = latestAttempt(attempts);
  const role = spec.roles[roleName];
  return {
    id: stageTaskId(stage.id),
    kind: "stage",
    execution: "agent",
    stageId: stage.id,
    label: stage.id,
    status: latest?.status ?? state.status,
    roleName,
    agent: latest?.agent ?? role?.agent,
    roleMode: latest?.roleMode ?? role?.mode,
    attemptId: latest?.id,
    attemptIds: attempts.map((attempt) => attempt.id),
    startedAt: latest?.startedAt ?? state.startedAt,
    completedAt: latest?.endedAt ?? state.completedAt,
    blockedReason: latest?.blockedReason ?? state.blockedReason,
    errorCode: latest?.runtimeErrorCode ?? latest?.parseErrorCode,
    outputPath: state.outputPath,
    ...timing(latest?.startedAt ?? state.startedAt, latest?.endedAt ?? state.completedAt, now)
  };
}

function deterministicStageTask(stage: Stage, state: StageIndexEntry, now: string): RunMonitorTask {
  return {
    id: stageTaskId(stage.id),
    kind: "stage",
    execution: "deterministic",
    stageId: stage.id,
    label: stage.id,
    status: state.status,
    attemptIds: [],
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    blockedReason: state.blockedReason,
    outputPath: state.outputPath,
    ...timing(state.startedAt, state.completedAt, now)
  };
}

function fanoutTasks(stageId: string, fanout: StageIndexEntry["fanout"], spec: WorkflowSpec, index: RunIndex, now: string): RunMonitorTask[] {
  if (!fanout) return [];
  const tasks: RunMonitorTask[] = [];
  for (const item of fanout.items) {
    for (const group of item.groups ?? []) {
      for (const lane of group.lanes) {
        const attempts = lane.attemptId ? [index.attempts[lane.attemptId]].filter((attempt): attempt is AttemptIndexEntry => attempt !== undefined) : attemptsFor(index, (attempt) => attempt.stageId === stageId && attempt.itemId === item.id && attempt.groupId === group.id && attempt.laneId === lane.id);
        const latest = latestAttempt(attempts);
        const role = spec.roles[lane.roleName];
        tasks.push({
          id: fanoutTaskId(stageId, item.id, group.id, lane.id),
          kind: "fanoutLane",
          execution: "agent",
          stageId,
          label: `${item.id}/${group.id}/${lane.id}`,
          status: latest?.status ?? lane.status,
          roleName: lane.roleName,
          agent: latest?.agent ?? role?.agent,
          roleMode: latest?.roleMode ?? role?.mode,
          attemptId: latest?.id ?? lane.attemptId,
          attemptIds: attempts.map((attempt) => attempt.id),
          itemId: item.id,
          itemIndex: item.index,
          groupId: group.id,
          laneId: lane.id,
          startedAt: latest?.startedAt ?? lane.startedAt ?? item.startedAt,
          completedAt: latest?.endedAt ?? lane.completedAt ?? item.completedAt,
          blockedReason: latest?.blockedReason ?? lane.blockedReason ?? item.blockedReason,
          errorCode: latest?.runtimeErrorCode ?? lane.errorCode ?? item.errorCode,
          outputPath: lane.outputPath ?? item.outputPath,
          ...timing(latest?.startedAt ?? lane.startedAt ?? item.startedAt, latest?.endedAt ?? lane.completedAt ?? item.completedAt, now)
        });
      }
    }
  }
  return tasks;
}

function loopTasks(stage: Extract<Stage, { kind: "loop" }>, state: StageIndexEntry, spec: WorkflowSpec, index: RunIndex, now: string): RunMonitorTask[] {
  if (!state.loop) return [];
  const bodyStages = new Map(stage.body.stages.map((bodyStage) => [bodyStage.id, bodyStage]));
  const tasks: RunMonitorTask[] = [];
  for (const round of state.loop.rounds) {
    for (const roundStage of Object.values(round.stages)) {
      const bodyStage = bodyStages.get(roundStage.stageId);
      if (!bodyStage) continue;
      const roleName = stageRoleName(bodyStage);
      if (roleName) {
        const itemId = loopBodyItemId(round.round, bodyStage.id);
        const attempts = roundStage.attempts
          .map((id) => index.attempts[id])
          .filter((attempt): attempt is AttemptIndexEntry => attempt !== undefined)
          .filter((attempt) => attempt.itemId === itemId || !attempt.itemId);
        const latest = latestAttempt(attempts);
        const role = spec.roles[roleName];
        tasks.push({
          id: loopStageTaskId(stage.id, round.round, bodyStage.id),
          kind: "loopStage",
          execution: "agent",
          stageId: stage.id,
          label: `${round.round}/${bodyStage.id}`,
          status: latest?.status ?? roundStage.status,
          roleName,
          agent: latest?.agent ?? role?.agent,
          roleMode: latest?.roleMode ?? role?.mode,
          attemptId: latest?.id,
          attemptIds: attempts.map((attempt) => attempt.id),
          round: round.round,
          bodyStageId: bodyStage.id,
          startedAt: latest?.startedAt ?? roundStage.startedAt,
          completedAt: latest?.endedAt ?? roundStage.completedAt,
          blockedReason: latest?.blockedReason ?? roundStage.blockedReason,
          errorCode: latest?.runtimeErrorCode ?? latest?.parseErrorCode,
          outputPath: roundStage.outputPath,
          ...timing(latest?.startedAt ?? roundStage.startedAt, latest?.endedAt ?? roundStage.completedAt, now)
        });
      } else if (bodyStage.kind !== "fanout") {
        tasks.push({
          id: loopStageTaskId(stage.id, round.round, bodyStage.id),
          kind: "loopStage",
          execution: "deterministic",
          stageId: stage.id,
          label: `${round.round}/${bodyStage.id}`,
          status: roundStage.status,
          attemptIds: [],
          round: round.round,
          bodyStageId: bodyStage.id,
          startedAt: roundStage.startedAt,
          completedAt: roundStage.completedAt,
          blockedReason: roundStage.blockedReason,
          outputPath: roundStage.outputPath,
          ...timing(roundStage.startedAt, roundStage.completedAt, now)
        });
      }
      if (bodyStage.kind === "fanout") tasks.push(...loopFanoutTasks(stage.id, round.round, roundStage, spec, index, now));
    }
  }
  return tasks;
}

function loopFanoutTasks(loopStageId: string, round: number, roundStage: NonNullable<NonNullable<StageIndexEntry["loop"]>["rounds"][number]["stages"][string]>, spec: WorkflowSpec, index: RunIndex, now: string): RunMonitorTask[] {
  if (!roundStage.fanout) return [];
  const tasks: RunMonitorTask[] = [];
  for (const item of roundStage.fanout.items) {
    for (const group of item.groups ?? []) {
      for (const lane of group.lanes) {
        const itemId = loopFanoutItemId(round, roundStage.stageId, item.id);
        const attempts = lane.attemptId ? [index.attempts[lane.attemptId]].filter((attempt): attempt is AttemptIndexEntry => attempt !== undefined) : attemptsFor(index, (attempt) => attempt.stageId === loopStageId && attempt.itemId === itemId && attempt.groupId === group.id && attempt.laneId === lane.id);
        const latest = latestAttempt(attempts);
        const role = spec.roles[lane.roleName];
        tasks.push({
          id: loopFanoutTaskId(loopStageId, round, roundStage.stageId, item.id, group.id, lane.id),
          kind: "loopFanoutLane",
          execution: "agent",
          stageId: loopStageId,
          label: `${round}/${roundStage.stageId}/${item.id}/${group.id}/${lane.id}`,
          status: latest?.status ?? lane.status,
          roleName: lane.roleName,
          agent: latest?.agent ?? role?.agent,
          roleMode: latest?.roleMode ?? role?.mode,
          attemptId: latest?.id ?? lane.attemptId,
          attemptIds: attempts.map((attempt) => attempt.id),
          round,
          bodyStageId: roundStage.stageId,
          itemId: item.id,
          itemIndex: item.index,
          groupId: group.id,
          laneId: lane.id,
          startedAt: latest?.startedAt ?? lane.startedAt ?? item.startedAt,
          completedAt: latest?.endedAt ?? lane.completedAt ?? item.completedAt,
          blockedReason: latest?.blockedReason ?? lane.blockedReason ?? item.blockedReason,
          errorCode: latest?.runtimeErrorCode ?? lane.errorCode ?? item.errorCode,
          outputPath: lane.outputPath ?? item.outputPath,
          ...timing(latest?.startedAt ?? lane.startedAt ?? item.startedAt, latest?.endedAt ?? lane.completedAt ?? item.completedAt, now)
        });
      }
    }
  }
  return tasks;
}

function stageSummary(stage: Stage, state: StageIndexEntry | undefined, tasks: RunMonitorTask[], now: string): RunMonitorStage {
  const stageTasks = tasks.filter((task) => task.stageId === stage.id);
  return {
    id: stage.id,
    kind: stage.kind,
    status: state?.status ?? "pending",
    dependsOn: stage.dependsOn ?? [],
    startedAt: state?.startedAt,
    completedAt: state?.completedAt,
    blockedReason: state?.blockedReason,
    skippedReason: state?.skippedReason,
    outputPath: state?.outputPath,
    ...timing(state?.startedAt, state?.completedAt, now),
    taskCounts: countTasks(stageTasks)
  };
}

function countTasks(tasks: RunMonitorTask[]): TaskCounts {
  return {
    total: tasks.length,
    pending: tasks.filter((task) => task.status === "pending" || task.status === "ready").length,
    running: tasks.filter((task) => task.status === "running" || task.status === "raw_received" || task.status === "parsing" || task.status === "repairing").length,
    completed: tasks.filter((task) => task.status === "completed").length,
    blocked: tasks.filter((task) => task.status === "blocked").length,
    failed: tasks.filter((task) => task.status === "failed" || task.status === "cancelled" || task.status === "timed_out").length,
    skipped: tasks.filter((task) => task.status === "skipped").length
  };
}

function stageRoleName(stage: Stage): string | undefined {
  if (stage.kind === "agentTask") return stage.role;
  if (stage.kind === "summarize") return stage.role;
  if (stage.kind === "discover" && stage.method === "agent") return stage.role;
  if (stage.kind === "reduce" && stage.mode === "agent") return stage.role;
  if (stage.kind === "decisionGate" && stage.mode === "agent") return stage.role;
  if (stage.kind === "gate" && stage.mode === "agent") return stage.role;
  return undefined;
}

function topLevelStageAttempts(index: RunIndex, state: StageIndexEntry): AttemptIndexEntry[] {
  return state.attempts
    .map((id) => index.attempts[id])
    .filter((attempt): attempt is AttemptIndexEntry => attempt !== undefined)
    .filter((attempt) => !attempt.itemId);
}

function attemptsFor(index: RunIndex, predicate: (attempt: AttemptIndexEntry) => boolean): AttemptIndexEntry[] {
  return Object.values(index.attempts).filter(predicate).sort(compareAttempts);
}

function latestAttempt(attempts: AttemptIndexEntry[]): AttemptIndexEntry | undefined {
  return [...attempts].sort(compareAttempts).at(-1);
}

function compareAttempts(left: AttemptIndexEntry, right: AttemptIndexEntry): number {
  const leftTime = left.startedAt ?? left.endedAt ?? "";
  const rightTime = right.startedAt ?? right.endedAt ?? "";
  if (leftTime !== rightTime) return leftTime.localeCompare(rightTime);
  return left.id.localeCompare(right.id);
}

async function readOutputSummary(filePath: string): Promise<TaskDetailView["outcome"] | undefined> {
  if (!filePath || filePath.endsWith(path.sep)) return undefined;
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    return {
      path: filePath,
      status: typeof parsed.status === "string" ? parsed.status : undefined,
      summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
      blockedReason: typeof parsed.blockedReason === "string" ? parsed.blockedReason : undefined,
      artifacts: artifactSummaries(parsed.artifacts),
      preview: previewJson(parsed)
    };
  } catch {
    return undefined;
  }
}

function artifactSummaries(value: unknown): Array<{ kind?: string; path?: string; url?: string; label?: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object")
    .map((entry) => ({
      kind: typeof entry.kind === "string" ? entry.kind : undefined,
      path: typeof entry.path === "string" ? entry.path : undefined,
      url: typeof entry.url === "string" ? entry.url : undefined,
      label: typeof entry.label === "string" ? entry.label : undefined
    }));
}

function previewJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  return text.length > MAX_OUTPUT_PREVIEW_CHARS ? `${text.slice(0, MAX_OUTPUT_PREVIEW_CHARS)}\n... [truncated]` : text;
}

function lineCount(value: string): number {
  return value.length === 0 ? 0 : value.split(/\r?\n/).length;
}

function timing(startedAt: string | undefined, completedAt: string | undefined, now: string): { elapsedMs?: number; durationMs?: number } {
  if (!startedAt) return {};
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return {};
  const endValue = completedAt ? Date.parse(completedAt) : Date.parse(now);
  if (!Number.isFinite(endValue) || endValue < start) return {};
  const value = endValue - start;
  return completedAt ? { durationMs: value } : { elapsedMs: value };
}

function terminalRun(status: RunIndex["status"]): boolean {
  return status === "completed" || status === "blocked" || status === "diagnosed_blocked" || status === "failed" || status === "cancelled";
}

function stageTaskId(stageId: string): string {
  return `task:${stageId}`;
}

function fanoutTaskId(stageId: string, itemId: string, groupId: string, laneId: string): string {
  return `task:${stageId}:item:${itemId}:group:${groupId}:lane:${laneId}`;
}

function loopStageTaskId(loopStageId: string, round: number, bodyStageId: string): string {
  return `task:${loopStageId}:round:${round}:stage:${bodyStageId}`;
}

function loopFanoutTaskId(loopStageId: string, round: number, bodyStageId: string, itemId: string, groupId: string, laneId: string): string {
  return `task:${loopStageId}:round:${round}:fanout:${bodyStageId}:item:${itemId}:group:${groupId}:lane:${laneId}`;
}

function loopBodyItemId(round: number, bodyStageId: string): string {
  return `round-${round}__stage-${bodyStageId}`;
}

function loopFanoutItemId(round: number, bodyStageId: string, itemId: string): string {
  return `round-${round}__stage-${bodyStageId}__item-${itemId}`;
}
