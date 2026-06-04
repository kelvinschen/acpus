import fs from "node:fs/promises";
import path from "node:path";
import { runDir } from "../run-index/paths.js";
import type { AttemptIndexEntry, AttemptStatus, RunIndex, StageIndexEntry, StageStatus } from "../run-index/read-write.js";
import { workerSummary } from "../runtime/worker.js";
import type { Actor, Stage, WorkflowSpec } from "../schema/workflow-spec.js";
import { readFinalOutput } from "./final-output.js";

export const RUN_MONITOR_VIEW_VERSION = "acpus.monitor/v1";
export const TASK_DETAIL_VIEW_VERSION = "acpus.task-detail/v1";

export type TaskStatus = StageStatus | AttemptStatus;
export type TaskKind = "stage" | "fanoutLane" | "fanoutFanin" | "loopStage" | "loopFanoutLane" | "loopFanoutFanin";
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
  actorLabel?: string;
  agent?: string;
  actorMode?: string;
  attemptId?: string;
  attemptIds: string[];
  round?: number;
  bodyStageId?: string;
  itemId?: string;
  itemIndex?: number;
  laneId?: string;
  startedAt?: string;
  completedAt?: string;
  blockedReason?: string;
  errorCode?: string;
  outputPath?: string;
  elapsedMs?: number;
  durationMs?: number;
  attemptCount?: number;
  currentAttemptOrdinal?: number;
  lastRetryReason?: AttemptIndexEntry["retryReason"];
  retryBudgetUsed?: number;
  retryBudgetLimit?: number;
  lastFailureCode?: string;
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
  finalOutput?: Record<string, unknown>;
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
      isRetry?: boolean;
      retryReason?: AttemptIndexEntry["retryReason"];
      retryOf?: string;
      retryOrdinal?: number;
      retryBudgetUsed?: number;
      retryBudgetLimit?: number;
      promptPolicy?: AttemptIndexEntry["promptPolicy"];
      lastFailureCode?: string;
      retryMessage?: string;
    }>;
    totalAttempts: number;
  };
  outcome?: {
    path?: string;
    status?: string;
    summary?: string;
    blockedReason?: string;
    preview?: string;
  };
};

const MAX_DETAIL_ATTEMPTS = 5;
const MAX_OUTPUT_PREVIEW_CHARS = 2048;

export async function buildRunMonitorView(cwd: string, spec: WorkflowSpec, index: RunIndex): Promise<RunMonitorView> {
  const dir = runDir(index.logicalRunId, cwd);
  const generatedAt = new Date().toISOString();
  const worker = workerSummary(index.worker);
  const observationNow = monitorObservationNow(index, worker, generatedAt);
  const tasks = buildTasks(spec, index, observationNow);
  const finalOutput = terminalRun(index.status) ? await readFinalOutput(dir, spec) : undefined;
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
      ...timing(index.createdAt, terminalRun(index.status) ? index.updatedAt : undefined, observationNow),
      worker
    },
    stages: spec.stages.map((stage) => stageSummary(stage, index.stages[stage.id], tasks, observationNow)),
    tasks,
    progress: {
      knownTasks: tasks.length,
      completedTasks: tasks.filter((task) => task.status === "completed").length
    },
    finalOutput
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
        runtimeErrorCode: attempt.runtimeErrorCode,
        isRetry: attempt.isRetry,
        retryReason: attempt.retryReason,
        retryOf: attempt.retryOf,
        retryOrdinal: attempt.retryOrdinal,
        retryBudgetUsed: attempt.retryBudgetUsed,
        retryBudgetLimit: attempt.retryBudgetLimit,
        promptPolicy: attempt.promptPolicy,
        lastFailureCode: attempt.lastFailureCode,
        retryMessage: attempt.retryMessage
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
    const actorLabel = stageActorLabel(stage);
    if (actorLabel) {
      const attempts = topLevelStageAttempts(index, state);
      tasks.push(stageTask(stage, state, actorLabel, stageActor(stage), attempts, now));
    } else if (stage.kind !== "fanout" && stage.kind !== "loop") {
      tasks.push(deterministicStageTask(stage, state, now));
    }
    if (stage.kind === "fanout") tasks.push(...fanoutTasks(stage, state, spec, index, now));
    if (stage.kind === "loop") tasks.push(...loopTasks(stage, state, spec, index, now));
  }
  return tasks;
}

function stageTask(stage: Stage, state: StageIndexEntry, actorLabel: string, actor: Actor | undefined, attempts: AttemptIndexEntry[], now: string): RunMonitorTask {
  const latest = latestAttempt(attempts);
  const retry = retrySummary(attempts);
  return {
    id: stageTaskId(stage.id),
    kind: "stage",
    execution: "agent",
    stageId: stage.id,
    label: stage.id,
    status: latest?.status ?? state.status,
    actorLabel,
    agent: latest?.agent ?? actor?.agent,
    actorMode: latest?.actorMode ?? actor?.mode,
    attemptId: latest?.id,
    attemptIds: attempts.map((attempt) => attempt.id),
    startedAt: latest?.startedAt ?? state.startedAt,
    completedAt: latest?.endedAt ?? state.completedAt,
    blockedReason: latest?.blockedReason ?? state.blockedReason,
    errorCode: latest?.runtimeErrorCode ?? latest?.parseErrorCode,
    outputPath: state.outputPath,
    ...retry,
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

function fanoutTasks(stage: Extract<Stage, { kind: "fanout" }>, state: StageIndexEntry, spec: WorkflowSpec, index: RunIndex, now: string): RunMonitorTask[] {
  const fanout = state.fanout;
  if (!fanout) return [];
  const stageId = stage.id;
  const tasks: RunMonitorTask[] = [];
  for (const item of fanout.items) {
    for (const lane of item.lanes) {
      const attempts = attemptsFor(index, (attempt) => attempt.stageId === stageId && attempt.itemId === item.id && attempt.laneId === lane.id);
      const latest = latestAttempt(attempts);
      const actor = fanoutLaneActor(spec, stageId, lane.id);
      const retry = retrySummary(attempts);
      tasks.push({
        id: fanoutTaskId(stageId, item.id, lane.id),
        kind: "fanoutLane",
        execution: "agent",
        stageId,
        label: `${item.id}/${lane.id}`,
        status: latest?.status ?? lane.status,
        actorLabel: lane.actorLabel,
        agent: latest?.agent ?? actor?.agent,
        actorMode: latest?.actorMode ?? actor?.mode,
        attemptId: latest?.id ?? lane.attemptId,
        attemptIds: attempts.map((attempt) => attempt.id),
        itemId: item.id,
        itemIndex: item.index,
        laneId: lane.id,
        startedAt: latest?.startedAt ?? lane.startedAt ?? item.startedAt,
        completedAt: latest?.endedAt ?? lane.completedAt ?? item.completedAt,
        blockedReason: latest?.blockedReason ?? lane.blockedReason ?? lane.skippedReason ?? item.blockedReason ?? item.skippedReason,
        errorCode: latest?.runtimeErrorCode ?? lane.errorCode ?? item.errorCode,
        outputPath: lane.outputPath ?? item.outputPath,
        ...retry,
        ...timing(latest?.startedAt ?? lane.startedAt ?? item.startedAt, latest?.endedAt ?? lane.completedAt ?? item.completedAt, now)
      });
    }
  }
  tasks.push(fanoutFaninTask(stage, state, index, now));
  return tasks;
}

function fanoutFaninTask(stage: Extract<Stage, { kind: "fanout" }>, state: StageIndexEntry, index: RunIndex, now: string): RunMonitorTask {
  const attempts = attemptsFor(index, (attempt) => attempt.stageId === stage.id && attempt.itemId === "fanin");
  const latest = latestAttempt(attempts);
  const retry = retrySummary(attempts);
  const faninStatus = latest?.status ?? faninProjectionStatus(state.status, state.fanout);
  const startedAt = latest?.startedAt;
  const completedAt = latest?.endedAt ?? state.completedAt;
  return {
    id: fanoutFaninTaskId(stage.id),
    kind: "fanoutFanin",
    execution: stage.fanin.mode === "agent" ? "agent" : "deterministic",
    stageId: stage.id,
    label: `${stage.id}/fanin`,
    status: faninStatus,
    actorLabel: stage.fanin.mode === "agent" ? stage.fanin.actor.label ?? stage.fanin.actor.agent : undefined,
    agent: latest?.agent ?? (stage.fanin.mode === "agent" ? stage.fanin.actor.agent : undefined),
    actorMode: latest?.actorMode ?? (stage.fanin.mode === "agent" ? stage.fanin.actor.mode : undefined),
    attemptId: latest?.id,
    attemptIds: attempts.map((attempt) => attempt.id),
    startedAt,
    completedAt,
    blockedReason: latest?.blockedReason ?? state.blockedReason,
    errorCode: latest?.runtimeErrorCode ?? latest?.parseErrorCode,
    outputPath: state.outputPath,
    ...retry,
    ...timing(startedAt, completedAt, now)
  };
}

function loopTasks(stage: Extract<Stage, { kind: "loop" }>, state: StageIndexEntry, spec: WorkflowSpec, index: RunIndex, now: string): RunMonitorTask[] {
  if (!state.loop) return [];
  const bodyStages = new Map(stage.body.stages.map((bodyStage) => [bodyStage.id, bodyStage]));
  const tasks: RunMonitorTask[] = [];
  for (const round of state.loop.rounds) {
    for (const roundStage of Object.values(round.stages)) {
      const bodyStage = bodyStages.get(roundStage.stageId);
      if (!bodyStage) continue;
      const actorLabel = stageActorLabel(bodyStage);
      if (actorLabel) {
        const itemId = loopBodyItemId(round.round, bodyStage.id);
        const attempts = roundStage.attempts
          .map((id) => index.attempts[id])
          .filter((attempt): attempt is AttemptIndexEntry => attempt !== undefined)
          .filter((attempt) => attempt.itemId === itemId || !attempt.itemId);
        const latest = latestAttempt(attempts);
        const actor = stageActor(bodyStage);
        tasks.push({
          id: loopStageTaskId(stage.id, round.round, bodyStage.id),
          kind: "loopStage",
          execution: "agent",
          stageId: stage.id,
          label: `${round.round}/${bodyStage.id}`,
          status: latest?.status ?? roundStage.status,
          actorLabel,
          agent: latest?.agent ?? actor?.agent,
          actorMode: latest?.actorMode ?? actor?.mode,
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
      if (bodyStage.kind === "fanout") tasks.push(...loopFanoutTasks(stage.id, round.round, roundStage, bodyStage, spec, index, now));
    }
  }
  return tasks;
}

function loopFanoutTasks(loopStageId: string, round: number, roundStage: NonNullable<NonNullable<StageIndexEntry["loop"]>["rounds"][number]["stages"][string]>, bodyStage: Extract<Stage, { kind: "fanout" }>, spec: WorkflowSpec, index: RunIndex, now: string): RunMonitorTask[] {
  if (!roundStage.fanout) return [];
  const tasks: RunMonitorTask[] = [];
  for (const item of roundStage.fanout.items) {
    for (const lane of item.lanes) {
      const itemId = loopFanoutItemId(round, roundStage.stageId, item.id);
      const attempts = attemptsFor(index, (attempt) => attempt.stageId === loopStageId && attempt.itemId === itemId && attempt.laneId === lane.id);
      const latest = latestAttempt(attempts);
      const actor = loopFanoutLaneActor(spec, loopStageId, roundStage.stageId, lane.id);
      const retry = retrySummary(attempts);
      tasks.push({
        id: loopFanoutTaskId(loopStageId, round, roundStage.stageId, item.id, lane.id),
        kind: "loopFanoutLane",
        execution: "agent",
        stageId: loopStageId,
        label: `${round}/${roundStage.stageId}/${item.id}/${lane.id}`,
        status: latest?.status ?? lane.status,
        actorLabel: lane.actorLabel,
        agent: latest?.agent ?? actor?.agent,
        actorMode: latest?.actorMode ?? actor?.mode,
        attemptId: latest?.id ?? lane.attemptId,
        attemptIds: attempts.map((attempt) => attempt.id),
        round,
        bodyStageId: roundStage.stageId,
        itemId: item.id,
        itemIndex: item.index,
        laneId: lane.id,
        startedAt: latest?.startedAt ?? lane.startedAt ?? item.startedAt,
        completedAt: latest?.endedAt ?? lane.completedAt ?? item.completedAt,
        blockedReason: latest?.blockedReason ?? lane.blockedReason ?? lane.skippedReason ?? item.blockedReason ?? item.skippedReason,
        errorCode: latest?.runtimeErrorCode ?? lane.errorCode ?? item.errorCode,
        outputPath: lane.outputPath ?? item.outputPath,
        ...retry,
        ...timing(latest?.startedAt ?? lane.startedAt ?? item.startedAt, latest?.endedAt ?? lane.completedAt ?? item.completedAt, now)
      });
    }
  }
  tasks.push(loopFanoutFaninTask(loopStageId, round, roundStage, bodyStage, index, now));
  return tasks;
}

function loopFanoutFaninTask(loopStageId: string, round: number, roundStage: NonNullable<NonNullable<StageIndexEntry["loop"]>["rounds"][number]["stages"][string]>, bodyStage: Extract<Stage, { kind: "fanout" }>, index: RunIndex, now: string): RunMonitorTask {
  const faninItemId = `round-${round}__fanin-${roundStage.stageId}`;
  const attempts = attemptsFor(index, (attempt) => attempt.stageId === loopStageId && attempt.itemId === faninItemId);
  const latest = latestAttempt(attempts);
  const retry = retrySummary(attempts);
  const faninStatus = latest?.status ?? faninProjectionStatus(roundStage.status, roundStage.fanout);
  const startedAt = latest?.startedAt;
  const completedAt = latest?.endedAt ?? roundStage.completedAt;
  return {
    id: loopFanoutFaninTaskId(loopStageId, round, roundStage.stageId),
    kind: "loopFanoutFanin",
    execution: bodyStage.fanin.mode === "agent" ? "agent" : "deterministic",
    stageId: loopStageId,
    label: `${round}/${roundStage.stageId}/fanin`,
    status: faninStatus,
    actorLabel: bodyStage.fanin.mode === "agent" ? bodyStage.fanin.actor.label ?? bodyStage.fanin.actor.agent : undefined,
    agent: latest?.agent ?? (bodyStage.fanin.mode === "agent" ? bodyStage.fanin.actor.agent : undefined),
    actorMode: latest?.actorMode ?? (bodyStage.fanin.mode === "agent" ? bodyStage.fanin.actor.mode : undefined),
    attemptId: latest?.id,
    attemptIds: attempts.map((attempt) => attempt.id),
    round,
    bodyStageId: roundStage.stageId,
    startedAt,
    completedAt,
    blockedReason: latest?.blockedReason ?? roundStage.blockedReason,
    errorCode: latest?.runtimeErrorCode ?? latest?.parseErrorCode,
    outputPath: roundStage.outputPath,
    ...retry,
    ...timing(startedAt, completedAt, now)
  };
}

function faninProjectionStatus(stageStatus: StageStatus, fanout: StageIndexEntry["fanout"] | undefined): TaskStatus {
  if (!allFanoutItemsTerminal(fanout)) return "pending";
  return stageStatus;
}

function allFanoutItemsTerminal(fanout: StageIndexEntry["fanout"] | undefined): boolean {
  if (!fanout) return false;
  for (const item of fanout.items) {
    if (!isTerminalStatus(item.status)) return false;
    for (const lane of item.lanes) {
      if (!isTerminalStatus(lane.status)) return false;
    }
  }
  return true;
}

function isTerminalStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "blocked" || status === "failed" || status === "skipped" || status === "cancelled" || status === "timed_out";
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
    running: tasks.filter((task) => task.status === "running" || task.status === "raw_received" || task.status === "parsing").length,
    completed: tasks.filter((task) => task.status === "completed").length,
    blocked: tasks.filter((task) => task.status === "blocked").length,
    failed: tasks.filter((task) => task.status === "failed" || task.status === "cancelled" || task.status === "timed_out").length,
    skipped: tasks.filter((task) => task.status === "skipped").length
  };
}

function stageActorLabel(stage: Stage): string | undefined {
  const actor = stageActor(stage);
  return actor ? actor.label ?? actor.agent : undefined;
}

function stageActor(stage: Stage): Actor | undefined {
  if (stage.kind === "task" && stage.mode === "agent") return stage.actor;
  if (stage.kind === "route" && stage.mode === "agent") return stage.actor;
  if (stage.kind === "gate" && stage.mode === "agent") return stage.actor;
  return undefined;
}

function fanoutLaneActor(spec: WorkflowSpec, stageId: string, laneId: string): Actor | undefined {
  const stage = spec.stages.find((candidate): candidate is Extract<Stage, { kind: "fanout" }> => candidate.id === stageId && candidate.kind === "fanout");
  return stage?.lanes.find((lane) => lane.id === laneId)?.actor;
}

function loopFanoutLaneActor(spec: WorkflowSpec, loopStageId: string, bodyStageId: string, laneId: string): Actor | undefined {
  const loop = spec.stages.find((candidate): candidate is Extract<Stage, { kind: "loop" }> => candidate.id === loopStageId && candidate.kind === "loop");
  const fanout = loop?.body.stages.find((candidate): candidate is Extract<Stage, { kind: "fanout" }> => candidate.id === bodyStageId && candidate.kind === "fanout");
  return fanout?.lanes.find((lane) => lane.id === laneId)?.actor;
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

function retrySummary(attempts: AttemptIndexEntry[]): Pick<RunMonitorTask, "attemptCount" | "currentAttemptOrdinal" | "lastRetryReason" | "retryBudgetUsed" | "retryBudgetLimit" | "lastFailureCode"> {
  const sorted = [...attempts].sort(compareAttempts);
  const latest = sorted.at(-1);
  return {
    attemptCount: sorted.length,
    currentAttemptOrdinal: latest ? attemptOrdinal(latest.id) : undefined,
    lastRetryReason: latest?.retryReason ?? [...sorted].reverse().find((attempt) => attempt.retryReason)?.retryReason,
    retryBudgetUsed: latest?.retryBudgetUsed ?? latest?.retryOrdinal,
    retryBudgetLimit: latest?.retryBudgetLimit,
    lastFailureCode: latest?.lastFailureCode ?? latest?.runtimeErrorCode ?? latest?.parseErrorCode
  };
}

function attemptOrdinal(attemptId: string): number | undefined {
  const match = attemptId.match(/:attempt-(\d+)$/);
  if (!match) return undefined;
  const ordinal = Number(match[1]);
  return Number.isInteger(ordinal) && ordinal > 0 ? ordinal : undefined;
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
      preview: previewJson(parsed)
    };
  } catch {
    return undefined;
  }
}

function previewJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  return text.length > MAX_OUTPUT_PREVIEW_CHARS ? `${text.slice(0, MAX_OUTPUT_PREVIEW_CHARS)}\n... [truncated]` : text;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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

function monitorObservationNow(index: RunIndex, worker: ReturnType<typeof workerSummary>, generatedAt: string): string {
  if (terminalRun(index.status)) return generatedAt;
  if (worker?.status === "stale") return index.worker?.exitedAt ?? index.worker?.heartbeatAt ?? generatedAt;
  return generatedAt;
}

function terminalRun(status: RunIndex["status"]): boolean {
  return status === "completed" || status === "blocked" || status === "failed" || status === "cancelled";
}

function stageTaskId(stageId: string): string {
  return `task:${stageId}`;
}

function fanoutTaskId(stageId: string, itemId: string, laneId: string): string {
  return `task:${stageId}:item:${itemId}:lane:${laneId}`;
}

function fanoutFaninTaskId(stageId: string): string {
  return `task:${stageId}:fanin`;
}

function loopStageTaskId(loopStageId: string, round: number, bodyStageId: string): string {
  return `task:${loopStageId}:round:${round}:stage:${bodyStageId}`;
}

function loopFanoutTaskId(loopStageId: string, round: number, bodyStageId: string, itemId: string, laneId: string): string {
  return `task:${loopStageId}:round:${round}:fanout:${bodyStageId}:item:${itemId}:lane:${laneId}`;
}

function loopFanoutFaninTaskId(loopStageId: string, round: number, bodyStageId: string): string {
  return `task:${loopStageId}:round:${round}:fanout:${bodyStageId}:fanin`;
}

function loopBodyItemId(round: number, bodyStageId: string): string {
  return `round-${round}__stage-${bodyStageId}`;
}

function loopFanoutItemId(round: number, bodyStageId: string, itemId: string): string {
  return `round-${round}__stage-${bodyStageId}__item-${itemId}`;
}
