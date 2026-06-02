import fs from "node:fs/promises";
import path from "node:path";
import { estimateAgentCalls } from "./run-view.js";
import { runDir } from "../run-index/paths.js";
import type { AttemptIndexEntry, AttemptStatus, RunIndex, StageIndexEntry, StageStatus } from "../run-index/read-write.js";
import type { Stage, WorkflowSpec } from "../schema/workflow-spec.js";

export const RUN_MONITOR_VIEW_VERSION = "acpx-workflow-orchestrator.monitor/v1";
export const WORK_UNIT_DETAIL_VIEW_VERSION = "acpx-workflow-orchestrator.work-unit-detail/v1";

export type WorkUnitStatus = StageStatus | AttemptStatus;
export type WorkUnitKind = "stage" | "fanoutLane" | "loopStage" | "loopFanoutLane";

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
  workUnitCounts: WorkUnitCounts;
};

export type WorkUnitCounts = {
  total: number;
  pending: number;
  running: number;
  completed: number;
  blocked: number;
  failed: number;
  skipped: number;
};

export type RunMonitorWorkUnit = {
  id: string;
  kind: WorkUnitKind;
  stageId: string;
  label: string;
  status: WorkUnitStatus;
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
  };
  stages: RunMonitorStage[];
  workUnits: RunMonitorWorkUnit[];
  progress: {
    knownWorkUnits: number;
    completedWorkUnits: number;
    estimatedWorkUnits: number;
  };
};

export type WorkUnitDetailView = {
  version: typeof WORK_UNIT_DETAIL_VIEW_VERSION;
  generatedAt: string;
  run: RunMonitorView["run"];
  workUnit: RunMonitorWorkUnit;
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
  const workUnits = buildWorkUnits(spec, index);
  return {
    version: RUN_MONITOR_VIEW_VERSION,
    generatedAt: new Date().toISOString(),
    run: {
      logicalRunId: index.logicalRunId,
      workflowName: index.workflowName,
      status: index.status,
      blockedReason: index.blockedReason,
      gateVerdict: index.gateVerdict,
      runDir: dir,
      createdAt: index.createdAt,
      updatedAt: index.updatedAt
    },
    stages: spec.stages.map((stage) => stageSummary(stage, index.stages[stage.id], workUnits)),
    workUnits,
    progress: {
      knownWorkUnits: workUnits.length,
      completedWorkUnits: workUnits.filter((unit) => unit.status === "completed").length,
      estimatedWorkUnits: estimateAgentCalls(spec)
    }
  };
}

export async function buildWorkUnitDetailView(cwd: string, spec: WorkflowSpec, index: RunIndex, workUnitId: string): Promise<WorkUnitDetailView> {
  const monitor = await buildRunMonitorView(cwd, spec, index);
  const workUnit = monitor.workUnits.find((unit) => unit.id === workUnitId);
  if (!workUnit) throw new Error(`Unknown work unit: ${workUnitId}`);
  const attempts = workUnit.attemptIds
    .map((id) => index.attempts[id])
    .filter((attempt): attempt is AttemptIndexEntry => attempt !== undefined)
    .sort(compareAttempts);
  const latestPrompt = [...attempts].reverse().find((attempt) => typeof attempt.promptPreview === "string" && attempt.promptPreview.length > 0)?.promptPreview;
  const output = await readOutputSummary(path.join(runDir(index.logicalRunId, cwd), workUnit.outputPath ?? ""));
  return {
    version: WORK_UNIT_DETAIL_VIEW_VERSION,
    generatedAt: new Date().toISOString(),
    run: monitor.run,
    workUnit,
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

function buildWorkUnits(spec: WorkflowSpec, index: RunIndex): RunMonitorWorkUnit[] {
  const units: RunMonitorWorkUnit[] = [];
  for (const stage of spec.stages) {
    const state = index.stages[stage.id];
    if (!state) continue;
    const roleName = stageRoleName(stage);
    if (roleName) {
      const attempts = topLevelStageAttempts(index, state);
      units.push(stageWorkUnit(stage, state, roleName, spec, attempts));
    }
    if (stage.kind === "fanout") units.push(...fanoutWorkUnits(stage.id, state.fanout, spec, index));
    if (stage.kind === "loop") units.push(...loopWorkUnits(stage, state, spec, index));
  }
  return units;
}

function stageWorkUnit(stage: Stage, state: StageIndexEntry, roleName: string, spec: WorkflowSpec, attempts: AttemptIndexEntry[]): RunMonitorWorkUnit {
  const latest = latestAttempt(attempts);
  const role = spec.roles[roleName];
  return {
    id: `stage:${stage.id}`,
    kind: "stage",
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
    outputPath: state.outputPath
  };
}

function fanoutWorkUnits(stageId: string, fanout: StageIndexEntry["fanout"], spec: WorkflowSpec, index: RunIndex): RunMonitorWorkUnit[] {
  if (!fanout) return [];
  const units: RunMonitorWorkUnit[] = [];
  for (const item of fanout.items) {
    for (const group of item.groups ?? []) {
      for (const lane of group.lanes) {
        const attempts = lane.attemptId ? [index.attempts[lane.attemptId]].filter((attempt): attempt is AttemptIndexEntry => attempt !== undefined) : attemptsFor(index, (attempt) => attempt.stageId === stageId && attempt.itemId === item.id && attempt.groupId === group.id && attempt.laneId === lane.id);
        const latest = latestAttempt(attempts);
        const role = spec.roles[lane.roleName];
        units.push({
          id: fanoutWorkUnitId(stageId, item.id, group.id, lane.id),
          kind: "fanoutLane",
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
          outputPath: lane.outputPath ?? item.outputPath
        });
      }
    }
  }
  return units;
}

function loopWorkUnits(stage: Extract<Stage, { kind: "loop" }>, state: StageIndexEntry, spec: WorkflowSpec, index: RunIndex): RunMonitorWorkUnit[] {
  if (!state.loop) return [];
  const bodyStages = new Map(stage.body.stages.map((bodyStage) => [bodyStage.id, bodyStage]));
  const units: RunMonitorWorkUnit[] = [];
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
        units.push({
          id: loopStageWorkUnitId(stage.id, round.round, bodyStage.id),
          kind: "loopStage",
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
          outputPath: roundStage.outputPath
        });
      }
      if (bodyStage.kind === "fanout") units.push(...loopFanoutWorkUnits(stage.id, round.round, roundStage, spec, index));
    }
  }
  return units;
}

function loopFanoutWorkUnits(loopStageId: string, round: number, roundStage: NonNullable<NonNullable<StageIndexEntry["loop"]>["rounds"][number]["stages"][string]>, spec: WorkflowSpec, index: RunIndex): RunMonitorWorkUnit[] {
  if (!roundStage.fanout) return [];
  const units: RunMonitorWorkUnit[] = [];
  for (const item of roundStage.fanout.items) {
    for (const group of item.groups ?? []) {
      for (const lane of group.lanes) {
        const itemId = loopFanoutItemId(round, roundStage.stageId, item.id);
        const attempts = lane.attemptId ? [index.attempts[lane.attemptId]].filter((attempt): attempt is AttemptIndexEntry => attempt !== undefined) : attemptsFor(index, (attempt) => attempt.stageId === loopStageId && attempt.itemId === itemId && attempt.groupId === group.id && attempt.laneId === lane.id);
        const latest = latestAttempt(attempts);
        const role = spec.roles[lane.roleName];
        units.push({
          id: loopFanoutWorkUnitId(loopStageId, round, roundStage.stageId, item.id, group.id, lane.id),
          kind: "loopFanoutLane",
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
          outputPath: lane.outputPath ?? item.outputPath
        });
      }
    }
  }
  return units;
}

function stageSummary(stage: Stage, state: StageIndexEntry | undefined, workUnits: RunMonitorWorkUnit[]): RunMonitorStage {
  const stageUnits = workUnits.filter((unit) => unit.stageId === stage.id);
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
    workUnitCounts: countWorkUnits(stageUnits)
  };
}

function countWorkUnits(units: RunMonitorWorkUnit[]): WorkUnitCounts {
  return {
    total: units.length,
    pending: units.filter((unit) => unit.status === "pending" || unit.status === "ready").length,
    running: units.filter((unit) => unit.status === "running" || unit.status === "raw_received" || unit.status === "parsing" || unit.status === "repairing").length,
    completed: units.filter((unit) => unit.status === "completed").length,
    blocked: units.filter((unit) => unit.status === "blocked").length,
    failed: units.filter((unit) => unit.status === "failed" || unit.status === "cancelled" || unit.status === "timed_out").length,
    skipped: units.filter((unit) => unit.status === "skipped").length
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

async function readOutputSummary(filePath: string): Promise<WorkUnitDetailView["outcome"] | undefined> {
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

function fanoutWorkUnitId(stageId: string, itemId: string, groupId: string, laneId: string): string {
  return `fanout:${stageId}:item:${itemId}:group:${groupId}:lane:${laneId}`;
}

function loopStageWorkUnitId(loopStageId: string, round: number, bodyStageId: string): string {
  return `loop:${loopStageId}:round:${round}:stage:${bodyStageId}`;
}

function loopFanoutWorkUnitId(loopStageId: string, round: number, bodyStageId: string, itemId: string, groupId: string, laneId: string): string {
  return `loop:${loopStageId}:round:${round}:fanout:${bodyStageId}:item:${itemId}:group:${groupId}:lane:${laneId}`;
}

function loopBodyItemId(round: number, bodyStageId: string): string {
  return `round-${round}__stage-${bodyStageId}`;
}

function loopFanoutItemId(round: number, bodyStageId: string, itemId: string): string {
  return `round-${round}__stage-${bodyStageId}__item-${itemId}`;
}
