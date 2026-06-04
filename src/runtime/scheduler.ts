import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { ExecutionPlan, ExecutionPlanStage } from "../compiler/execution-plan.js";
import { runDir as resolveRunDir } from "../run-index/paths.js";
import { appendEvent, readRunIndex, RuntimeErrorCodes, writeRunIndex, type AgentTaskRetryReason, type AttemptIndexEntry, type AttemptStatus, type RunIndex, type StageIndexEntry, type StageStatus } from "../run-index/read-write.js";
import { WorkflowSpecSchema, type Stage, type WorkflowSpec } from "../schema/workflow-spec.js";
import { AGENT_TASK_RETRY_BUDGET, retryExhaustedEnvelope } from "./agent-task-retry.js";
import { createOrchestratorAgentRuntime } from "./agent-runtime.js";
import { attemptDir, attemptId, safeFileName, upsertAttemptIndex, writeAttemptFile } from "./attempts.js";
import {
  buildFanoutItemOutput as buildCoreFanoutItemOutput,
  buildFanoutStageOutput,
  cascadeBlockFanoutItems,
  deriveFanoutSummary,
  expandFanoutItems,
  fanoutItemCounts,
  fanoutItemStatus,
  fanoutTransientStatus,
  hasQueuedFanoutItems,
  hasRunningFanoutItems,
  type FanoutCoreItem,
  type FanoutCoreLaneResult
} from "./fanout-core.js";
import { evaluateFanoutLaneCondition, resolveSource, runAgentWork, runProgramStage, stableItemId, type AgentWorkResult, type AgentWorkUnit } from "./stage-runner.js";

const STALE_RECOVERY_GRACE_MS = 60_000;
export type SyncRunOptions = {
  startPending?: boolean;
  drainFanoutPool?: boolean;
};

type RuntimeSnapshot = {
  cwd: string;
  runId: string;
  runDir: string;
  spec: WorkflowSpec;
  plan: ExecutionPlan;
  input: Record<string, unknown>;
  index: RunIndex;
};

export async function syncRun(cwd: string, logicalRunId: string, options: SyncRunOptions = {}): Promise<RunIndex> {
  const snapshot = await loadSnapshot(cwd, logicalRunId);
  if (options.startPending === false) return snapshot.index;

  let index = ensureStageEntries(snapshot.index, snapshot.spec);
  let changed = index !== snapshot.index;
  const reconciled = await reconcileFanoutRuntimeState({ ...snapshot, index });
  index = reconciled.index;
  changed ||= reconciled.changed;
  const stagesReconciled = await reconcileStageRuntimeState({ ...snapshot, index });
  index = stagesReconciled.index;
  changed ||= stagesReconciled.changed;

  const deterministic = await advanceDeterministicStages({ ...snapshot, index });
  index = deterministic.index;
  changed ||= deterministic.changed;
  if (changed) await writeRunIndex(cwd, index);

  const readyUnits = await collectReadyAgentWork({ ...snapshot, index });
  index = await readRunIndex(cwd, logicalRunId);
  const afterReadyFanout = await completeReadyFanoutAggregates({ ...snapshot, index });
  if (afterReadyFanout.changed) {
    index = afterReadyFanout.index;
    const afterDeterministic = await advanceDeterministicStages({ ...snapshot, index });
    index = updateRunStatus(afterDeterministic.index, snapshot.spec);
    await writeRunIndex(cwd, index);
    return readRunIndex(cwd, logicalRunId);
  }
  const readyFanoutStageId = firstReadyFanoutStageId(readyUnits);
  if (readyFanoutStageId) {
    return runFanoutPool({ ...snapshot, index }, readyFanoutStageId, { drain: options.drainFanoutPool === true });
  }
  const selected = selectRunnableUnits(index, snapshot.plan, readyUnits);
  if (selected.length === 0) {
    const next = updateRunStatus(index, snapshot.spec);
    if (changed || next.status !== index.status || next.blockedReason !== index.blockedReason || next.gateVerdict !== index.gateVerdict) {
      await writeRunIndex(cwd, next);
      await appendEvent(cwd, logicalRunId, { type: "run_synced", status: next.status });
      return readRunIndex(cwd, logicalRunId);
    }
    return index;
  }

  const unit = selected[0];
  index = markUnitsRunning(index, [unit], snapshot.runDir);
  index = { ...index, status: "running" };
  await writeRunIndex(cwd, index);
  await appendEvent(cwd, logicalRunId, { type: "work_started", stageId: unit.stageId });

  const runtime = createOrchestratorAgentRuntime({ cwd, runDir: snapshot.runDir });
  const outputs = await readAuthorOutputs(snapshot.runDir);
  let result: AgentWorkResult;
  try {
    result = await runAgentWork({
      cwd,
      runDir: snapshot.runDir,
      runId: logicalRunId,
      workflowInput: snapshot.input,
      spec: snapshot.spec,
      outputs,
      plan: snapshot.plan,
      unit,
      runtime
    });
  } finally {
    await runtime.dispose?.();
  }

  let merged = await readRunIndex(cwd, logicalRunId);
  merged = { ...merged, stages: index.stages, attempts: index.attempts, agentUsage: index.agentUsage };
  merged = mergeAgentResult(merged, result, snapshot.runDir);
  const stage = snapshot.spec.stages.find((candidate) => candidate.id === result.stageId);
  if (stage?.kind === "route" && result.output) {
    merged = markUnselectedRouteBranches(merged, snapshot.spec, stage, String(result.output.route ?? ""));
  }
  await appendEvent(cwd, logicalRunId, { type: "work_settled", stageId: result.stageId, status: result.status, errorCode: result.errorCode, outputPath: result.outputPath ? path.relative(snapshot.runDir, result.outputPath) : undefined });
  const afterFanout = await completeReadyFanoutAggregates({ ...snapshot, index: merged });
  merged = afterFanout.index;
  const afterDeterministic = await advanceDeterministicStages({ ...snapshot, index: merged });
  merged = updateRunStatus(afterDeterministic.index, snapshot.spec);
  await writeRunIndex(cwd, merged);
  return readRunIndex(cwd, logicalRunId);

}

async function loadSnapshot(cwd: string, runId: string): Promise<RuntimeSnapshot> {
  const runDir = resolveRunDir(runId, cwd);
  const [specRaw, planRaw, inputRaw, index] = await Promise.all([
    fs.readFile(path.join(runDir, "workflow.spec.yaml"), "utf8"),
    fs.readFile(path.join(runDir, "execution-plan.json"), "utf8"),
    fs.readFile(path.join(runDir, "input.json"), "utf8"),
    readRunIndex(cwd, runId)
  ]);
  return {
    cwd,
    runId,
    runDir,
    spec: WorkflowSpecSchema.parse(YAML.parse(specRaw)),
    plan: JSON.parse(planRaw) as ExecutionPlan,
    input: JSON.parse(inputRaw) as Record<string, unknown>,
    index
  };
}

async function reconcileFanoutRuntimeState(snapshot: RuntimeSnapshot): Promise<{ index: RunIndex; changed: boolean }> {
  let index = snapshot.index;
  let changed = false;
  const activityByAttempt = await readAttemptActivity(snapshot.runDir);
  for (const stage of snapshot.spec.stages.filter((candidate): candidate is Extract<Stage, { kind: "fanout" }> => candidate.kind === "fanout")) {
    const state = index.stages[stage.id];
    if (!state?.fanout) continue;
    const planStage = snapshot.plan.stages.find((candidate) => candidate.id === stage.id);
    const staleAfterMs = planStage ? timeoutMs(snapshot.plan, planStage) + STALE_RECOVERY_GRACE_MS : snapshot.plan.limits.stageTimeoutMinutes * 60 * 1000 + STALE_RECOVERY_GRACE_MS;
    let stageChanged = false;
    const items = [...state.fanout.items];
    const attempts: AttemptIndexEntry[] = [];
    for (const [itemPosition, item] of items.entries()) {
      const runningLane = firstRunningFanoutLane(item);
      const currentAttemptId = runningLane?.lane.attemptId;
      const outputPath = fanoutItemOutputPath(snapshot.runDir, stage.id, item);
      const output = await readJsonIfExists(outputPath);
      if (output) {
        const status = statusFromItemOutput(output);
        const relativeOutputPath = path.relative(snapshot.runDir, outputPath);
        if (currentAttemptId) {
          const attempt = terminalAttemptFromFanoutOutput(index, snapshot.runDir, {
            stageId: stage.id,
            itemId: item.id,
            laneId: runningLane.lane.id,
            attemptId: currentAttemptId,
            output,
            outputStatus: status,
            startedAt: item.startedAt ?? state.startedAt
          });
          if (attempt && index.attempts[attempt.id]?.status !== attempt.status) {
            attempts.push(attempt);
            stageChanged = true;
          }
        }
        if (item.status !== status || item.outputPath !== relativeOutputPath || item.completedAt === undefined) {
          if (item.status === "running") {
            await appendEvent(snapshot.cwd, snapshot.runId, {
              type: "run_index_output_mismatch",
              code: RuntimeErrorCodes.RUN_INDEX_OUTPUT_MISMATCH,
              stageId: stage.id,
              itemId: item.id,
              outputPath: relativeOutputPath,
              previousStatus: item.status,
              recoveredStatus: status
            });
          }
          items[itemPosition] = {
            ...item,
            status,
            outputPath: relativeOutputPath,
            blockedReason: stringField(output, "blockedReason") ?? item.blockedReason,
            completedAt: item.completedAt ?? new Date().toISOString(),
            errorCode: stringField(output, "errorCode") ?? stringField(objectRecord(output.runtimeDiagnostics), "errorCode") ?? item.errorCode,
            lanes: item.lanes.map((lane) => ({
              ...lane,
              status,
              outputPath: lane.status === "skipped" ? lane.outputPath : lane.outputPath ?? relativeOutputPath,
              blockedReason: stringField(output, "blockedReason") ?? lane.blockedReason,
              completedAt: lane.status === "skipped" ? lane.completedAt : lane.completedAt ?? new Date().toISOString(),
              errorCode: stringField(output, "errorCode") ?? stringField(objectRecord(output.runtimeDiagnostics), "errorCode") ?? lane.errorCode
            }))
          };
          stageChanged = true;
        }
        continue;
      }

      if (runningLane && currentAttemptId) {
        const laneOutputPath = runningLane.lane.outputPath
          ? path.join(snapshot.runDir, runningLane.lane.outputPath)
          : fanoutLaneOutputPath(snapshot.runDir, stage.id, item.id, runningLane.lane.id);
        const laneOutput = await readJsonIfExists(laneOutputPath);
        if (laneOutput) {
          const laneStatus = statusFromLaneOutput(laneOutput, runningLane.lane.status);
          const relativeLaneOutputPath = path.relative(snapshot.runDir, laneOutputPath);
          const attempt = terminalAttemptFromFanoutOutput(index, snapshot.runDir, {
            stageId: stage.id,
            itemId: item.id,
            laneId: runningLane.lane.id,
            attemptId: currentAttemptId,
            output: laneOutput,
            outputStatus: laneStatus,
            startedAt: runningLane.lane.startedAt ?? item.startedAt ?? state.startedAt
          });
          if (attempt && index.attempts[attempt.id]?.status !== attempt.status) attempts.push(attempt);
          const lanes = item.lanes.map((lane) => lane.id === runningLane.lane.id ? {
              ...lane,
              status: laneStatus,
              outputPath: relativeLaneOutputPath,
              blockedReason: stringField(laneOutput, "blockedReason") ?? lane.blockedReason,
              completedAt: lane.completedAt ?? new Date().toISOString(),
              errorCode: stringField(laneOutput, "errorCode") ?? stringField(objectRecord(laneOutput.runtimeDiagnostics), "errorCode") ?? lane.errorCode
            } : lane);
          const nextItem = { ...item, lanes };
          const itemStatus = fanoutItemStatus(nextItem);
          items[itemPosition] = {
            ...nextItem,
            status: itemStatus,
            outputPath: isTerminalStageStatus(itemStatus) ? path.relative(snapshot.runDir, outputPath) : item.outputPath,
            completedAt: isTerminalStageStatus(itemStatus) ? item.completedAt ?? new Date().toISOString() : item.completedAt
          };
          stageChanged = true;
          continue;
        }
      }

      if (state.status === "completed" || state.status === "blocked" || state.status === "failed") continue;
      if (item.status === "running" && isStaleAttempt({
        attemptId: currentAttemptId,
        fallbackStartedAt: item.startedAt ?? state.startedAt,
        activityByAttempt,
        staleAfterMs
      })) {
        if (currentAttemptId && canScheduleAgentTaskRetry(item.retryOrdinal)) {
          const retryOrdinal = (item.retryOrdinal ?? 0) + 1;
          const retryAttemptId = attemptId({ stageId: stage.id, itemId: item.id, laneId: runningLane?.lane.id, ordinal: retryOrdinal + 1 });
          const message = "Fanout item attempt had no terminal output and no recent activity before scheduler stale recovery; scheduling one stale retry.";
          attempts.push(buildStaleRecoveredAttempt(index, snapshot.runDir, {
            stageId: stage.id,
            itemId: item.id,
            laneId: runningLane.lane.id,
            attemptId: currentAttemptId,
            startedAt: item.startedAt ?? state.startedAt,
            code: RuntimeErrorCodes.FANOUT_ITEM_STALE_RECOVERY,
            message,
            retryOrdinal: item.retryOrdinal
          }));
          items[itemPosition] = {
            ...item,
            status: "ready",
            startedAt: undefined,
            completedAt: undefined,
            blockedReason: undefined,
            errorCode: undefined,
            errorMessage: undefined,
            retryOf: item.retryOf ?? currentAttemptId,
            retryOrdinal: retryOrdinal,
            retryReason: "stale",
            lanes: item.lanes.map((lane) => lane.id === runningLane?.lane.id ? {
                ...lane,
                status: "ready" as StageStatus,
                startedAt: undefined,
                completedAt: undefined,
                blockedReason: undefined,
                errorCode: undefined,
                errorMessage: undefined,
                attemptId: retryAttemptId,
                retryOf: lane.retryOf ?? lane.attemptId ?? currentAttemptId,
                retryOrdinal: retryOrdinal,
                retryReason: "stale"
              } : lane)
          };
          stageChanged = true;
          await appendEvent(snapshot.cwd, snapshot.runId, {
            type: "agent_task_retry_scheduled",
            stageId: stage.id,
            itemId: item.id,
            attemptId: currentAttemptId,
            retryAttemptId,
            retryReason: "stale",
            retryOrdinal: retryOrdinal,
            errorCode: RuntimeErrorCodes.FANOUT_ITEM_STALE_RECOVERY,
            errorMessage: message
          });
          continue;
        }
        if (!runningLane) continue;
        const code = currentAttemptId ? RuntimeErrorCodes.FANOUT_ITEM_STALE_RECOVERY : RuntimeErrorCodes.FANOUT_ITEM_UNSTARTED_TIMEOUT;
        const message = currentAttemptId
          ? "Fanout item attempt had no terminal output and no recent activity before scheduler stale recovery."
          : "Fanout item was selected but no attempt was started before scheduler recovery.";
        const result = await writeRecoveredFanoutItemFailure({
          index,
          cwd: snapshot.cwd,
          runDir: snapshot.runDir,
          runId: snapshot.runId,
          stageId: stage.id,
          itemId: item.id,
          attemptId: currentAttemptId ?? attemptId({ stageId: stage.id, itemId: item.id, laneId: runningLane?.lane.id, kind: "attempt", ordinal: 1 }),
          startedAt: item.startedAt ?? state.startedAt,
          code,
          message,
          outputPath,
          laneId: runningLane.lane.id,
          exhausted: currentAttemptId !== undefined
        });
        const blockedReason = currentAttemptId ? RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED : code;
        items[itemPosition] = {
          ...item,
          status: "blocked",
          outputPath: path.relative(snapshot.runDir, result.outputPath),
          blockedReason,
          completedAt: new Date().toISOString(),
          errorCode: blockedReason,
          errorMessage: message,
          lanes: item.lanes.map((lane) => lane.id === runningLane?.lane.id ? {
              ...lane,
              status: "blocked" as StageStatus,
              completedAt: new Date().toISOString(),
              blockedReason,
              errorCode: blockedReason,
              errorMessage: message
            } : lane)
        };
        attempts.push(result.attempt);
        stageChanged = true;
        if (currentAttemptId && item.retryOrdinal !== undefined) {
          await appendEvent(snapshot.cwd, snapshot.runId, {
            type: "agent_task_retry_exhausted",
            stageId: stage.id,
            itemId: item.id,
            attemptId: result.attempt.id,
            retryOf: item.retryOf,
            retryOrdinal: item.retryOrdinal,
            errorCode: code,
            errorMessage: message
          });
        } else {
          await appendEvent(snapshot.cwd, snapshot.runId, {
            type: "fanout_item_recovered",
            stageId: stage.id,
            itemId: item.id,
            attemptId: result.attempt.id,
            errorCode: code,
            outputPath: path.relative(snapshot.runDir, result.outputPath)
          });
        }
      }
    }
    if (!stageChanged) continue;
    const counts = fanoutItemCounts(items);
    index = updateStage(index, stage.id, {
      ...state,
      status: isTerminalStageStatus(state.status) ? state.status : fanoutTransientStatus(items),
      fanout: {
        ...state.fanout,
        items,
        ...counts
      }
    });
    for (const attempt of attempts) index = upsertAttemptIndex(index, attempt);
    changed = true;
  }
  return { index, changed };
}

async function reconcileStageRuntimeState(snapshot: RuntimeSnapshot): Promise<{ index: RunIndex; changed: boolean }> {
  let index = snapshot.index;
  let changed = false;
  const activityByAttempt = await readAttemptActivity(snapshot.runDir);
  for (const stage of snapshot.spec.stages) {
    if (stage.kind === "fanout") continue;
    let state = index.stages[stage.id];
    if (!state || state.status !== "running") continue;
    const planStage = snapshot.plan.stages.find((candidate) => candidate.id === stage.id);
    if (!planStage || !agentUnitForStage({ ...snapshot, index }, stage, planStage)) continue;

    const outputPath = path.join(snapshot.runDir, "outputs", `${stage.id}.json`);
    const output = await readJsonIfExists(outputPath);
    if (output) {
      const status = statusFromItemOutput(output);
      index = updateStage(index, stage.id, {
        ...state,
        status,
        outputPath: path.relative(snapshot.runDir, outputPath),
        blockedReason: stringField(output, "blockedReason") ?? state.blockedReason,
        completedAt: state.completedAt ?? new Date().toISOString()
      });
      await appendEvent(snapshot.cwd, snapshot.runId, {
        type: "run_index_output_mismatch",
        code: RuntimeErrorCodes.RUN_INDEX_OUTPUT_MISMATCH,
        stageId: stage.id,
        outputPath: path.relative(snapshot.runDir, outputPath),
        previousStatus: state.status,
        recoveredStatus: status
      });
      changed = true;
      continue;
    }

    const currentAttemptId = runningStageAttemptId(index, state, stage.id);
    if (!isStaleAttempt({
      attemptId: currentAttemptId,
      fallbackStartedAt: state.startedAt,
      activityByAttempt,
      staleAfterMs: timeoutMs(snapshot.plan, planStage) + STALE_RECOVERY_GRACE_MS
    })) continue;
    if (canScheduleAgentTaskRetry(state.retryOrdinal)) {
      const retryOrdinal = (state.retryOrdinal ?? 0) + 1;
      const retryAttemptId = attemptId({ stageId: stage.id, ordinal: retryOrdinal + 1 });
      const message = "Agent stage attempt had no terminal output and no recent activity before scheduler stale recovery; scheduling one stale retry.";
      index = upsertAttemptIndex(index, buildStaleRecoveredAttempt(index, snapshot.runDir, {
        stageId: stage.id,
        attemptId: currentAttemptId,
        startedAt: state.startedAt,
        code: RuntimeErrorCodes.AGENT_STAGE_STALE_RECOVERY,
        message,
        retryOrdinal: state.retryOrdinal
      }));
      state = index.stages[stage.id];
      index = updateStage(index, stage.id, {
        ...state,
        status: "ready",
        startedAt: undefined,
        completedAt: undefined,
        blockedReason: undefined,
        retryOf: state.retryOf ?? currentAttemptId,
        retryOrdinal: retryOrdinal,
        retryReason: "stale"
      });
      await appendEvent(snapshot.cwd, snapshot.runId, {
        type: "agent_task_retry_scheduled",
        stageId: stage.id,
        attemptId: currentAttemptId,
        retryAttemptId,
        retryReason: "stale",
        retryOrdinal: retryOrdinal,
        errorCode: RuntimeErrorCodes.AGENT_STAGE_STALE_RECOVERY,
        errorMessage: message
      });
      changed = true;
      continue;
    }

    const message = "Agent stage attempt had no terminal output and no recent activity before scheduler stale recovery.";
    const result = await writeRecoveredStageFailure({
      index,
      cwd: snapshot.cwd,
      runDir: snapshot.runDir,
      runId: snapshot.runId,
      stageId: stage.id,
      attemptId: currentAttemptId,
      startedAt: state.startedAt,
      code: RuntimeErrorCodes.AGENT_STAGE_STALE_RECOVERY,
      message,
      outputPath
    });
    index = upsertAttemptIndex(index, result.attempt);
    index = updateStage(index, stage.id, {
      ...state,
      status: "blocked",
      outputPath: path.relative(snapshot.runDir, result.outputPath),
      blockedReason: RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED,
      completedAt: new Date().toISOString()
    });
    await appendEvent(snapshot.cwd, snapshot.runId, {
      type: "agent_task_retry_exhausted",
      stageId: stage.id,
      attemptId: currentAttemptId,
      retryOf: state.retryOf,
      retryOrdinal: state.retryOrdinal,
      errorCode: RuntimeErrorCodes.AGENT_STAGE_STALE_RECOVERY,
      errorMessage: message
    });
    changed = true;
  }
  return { index, changed };
}

function ensureStageEntries(index: RunIndex, spec: WorkflowSpec): RunIndex {
  let changed = false;
  const stages = { ...index.stages };
  for (const stage of spec.stages) {
    if (stages[stage.id]) continue;
    stages[stage.id] = {
      stageId: stage.id,
      status: "pending",
      attempts: []
    };
    changed = true;
  }
  return changed ? { ...index, stages } : index;
}

async function advanceDeterministicStages(snapshot: RuntimeSnapshot): Promise<{ index: RunIndex; changed: boolean }> {
  let index = snapshot.index;
  let changed = false;
  let progressed = true;
  while (progressed) {
    progressed = false;
    const outputs = await readAuthorOutputs(snapshot.runDir);
    for (const stage of snapshot.spec.stages) {
      const state = index.stages[stage.id];
      if (!state || state.status === "completed" || state.status === "blocked" || state.status === "failed" || state.status === "skipped") continue;
      if (!dependenciesCompleted(stage, index)) continue;
      const planStage = snapshot.plan.stages.find((candidate) => candidate.id === stage.id);
      if (!planStage) continue;
      const startedAt = state.startedAt ?? new Date().toISOString();
      const programOutput = await runProgramStage({ ...snapshot, workflowInput: snapshot.input, stage, planStage, outputs });
      if (!programOutput) continue;
      const outputPath = path.join(snapshot.runDir, "outputs", `${stage.id}.json`);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, `${JSON.stringify(programOutput, null, 2)}\n`, "utf8");
      outputs[stage.id] = programOutput;
      index = updateStage(index, stage.id, {
        status: programOutput.status === "blocked" ? "blocked" : "completed",
        outputPath: path.relative(snapshot.runDir, outputPath),
        startedAt,
        completedAt: new Date().toISOString(),
        blockedReason: typeof programOutput.blockedReason === "string" ? programOutput.blockedReason : undefined
      });
      await appendEvent(snapshot.cwd, snapshot.runId, { type: "program_stage_completed", stageId: stage.id, status: programOutput.status });
      changed = true;
      progressed = true;
      if (stage.kind === "route") index = markUnselectedRouteBranches(index, snapshot.spec, stage, String(programOutput.route ?? ""));
      if (stage.kind === "gate") index = { ...index, gateVerdict: gateVerdictFromOutput(programOutput) ?? index.gateVerdict };
    }
    const fanout = await completeReadyFanoutAggregates({ ...snapshot, index });
    index = fanout.index;
    changed ||= fanout.changed;
    progressed ||= fanout.changed;
  }
  return { index, changed };
}

async function collectReadyAgentWork(snapshot: RuntimeSnapshot): Promise<AgentWorkUnit[]> {
  const outputs = await readAuthorOutputs(snapshot.runDir);
  const units: AgentWorkUnit[] = [];
  for (const stage of snapshot.spec.stages) {
    const state = snapshot.index.stages[stage.id];
    if (!state || state.status === "completed" || state.status === "blocked" || state.status === "failed" || state.status === "skipped") continue;
    if (state.status === "running" && shouldSkipRunningStage(stage, state)) continue;
    if (!dependenciesCompleted(stage, snapshot.index)) continue;
    const planStage = snapshot.plan.stages.find((candidate) => candidate.id === stage.id);
    if (!planStage) continue;
    if (stage.kind === "fanout") {
      units.push(...await collectFanoutUnits(snapshot, stage, planStage, outputs));
      continue;
    }
    const unit = agentUnitForStage(snapshot, stage, planStage);
    if (unit) units.push(unit);
  }
  return units;
}

async function initializeFanoutItem(
  snapshot: RuntimeSnapshot,
  stage: Extract<Stage, { kind: "fanout" }>,
  planStage: ExecutionPlanStage,
  item: unknown,
  itemIndex: number,
  outputs: Record<string, unknown>
): Promise<FanoutItemIndexEntry> {
  void stage;
  const plan = planStage.fanout;
  if (!plan) throw new Error(`Missing fanout plan for ${planStage.id}`);
  const expanded = expandFanoutItems({
    plan,
    items: [item],
    workflowInput: snapshot.input,
    outputs,
    localForItem: (candidate) => ({ item: candidate }),
    itemIdFor: (candidate) => stableItemId(candidate, itemIndex),
    evaluate: evaluateFanoutLaneCondition
  });
  return { ...expanded.items[0], index: itemIndex };
}

async function collectFanoutUnits(snapshot: RuntimeSnapshot, stage: Extract<Stage, { kind: "fanout" }>, planStage: ExecutionPlanStage, outputs: Record<string, unknown>): Promise<AgentWorkUnit[]> {
  let index = snapshot.index;
  let state = index.stages[stage.id];
  const plan = planStage.fanout;
  if (!state || !plan) return [];
  const resumePolicy = fanoutResumePolicy(index, stage.id);
  if (!state.fanout) {
    const resolved = resolveSource(stage.items.source, snapshot.input, outputs);
    const allItems = Array.isArray(resolved) ? resolved : [];
    const maxItems = Math.min(plan.maxItems, resumePolicy?.maxItems ?? plan.maxItems);
    const skippedIndexes = new Set(resumePolicy?.skipItemIndexes ?? []);
    const items = await Promise.all(allItems.slice(0, maxItems).flatMap((item, itemIndex) =>
      skippedIndexes.has(itemIndex) ? [] : [initializeFanoutItem(snapshot, stage, planStage, item, itemIndex, outputs)]
    ));
    state = {
      ...state,
      status: items.length === 0 ? "completed" : "ready",
      fanout: deriveFanoutSummary({
        candidateItemCount: items.length,
        items,
        allowPartial: plan.allowPartial || resumePolicy?.allowPartial === true
      })
    };
    index = updateStage(index, stage.id, state);
    await writeRunIndex(snapshot.cwd, index);
    if (items.length === 0) {
      const results = {
        status: "completed",
        summary: "Fanout completed with 0 item outputs.",
        items: [],
        laneOutputs: [],
        blockedItems: [],
        skippedItems: []
      };
      const fanin = await runFanoutFanin({ ...snapshot, index }, stage, planStage, results);
      index = fanin.index;
      index = updateStage(index, stage.id, {
        ...state,
        status: fanin.status,
        outputPath: fanin.outputPath,
        blockedReason: fanin.blockedReason,
        completedAt: new Date().toISOString()
      });
      await writeRunIndex(snapshot.cwd, index);
      return [];
    }
  } else {
    const applied = applyFanoutResumePolicy(state, resumePolicy);
    if (applied.changed && applied.stage) {
      state = applied.stage;
      index = updateStage(index, stage.id, state);
      await writeRunIndex(snapshot.cwd, index);
    }
  }
  const sourceItems = Array.isArray(resolveSource(stage.items.source, snapshot.input, outputs)) ? resolveSource(stage.items.source, snapshot.input, outputs) as unknown[] : [];
  const units: AgentWorkUnit[] = [];
  for (const item of state.fanout?.items ?? []) {
    if (item.status !== "pending" && item.status !== "ready" && item.status !== "running") continue;
    for (const lane of item.lanes) {
      if (lane.status !== "pending" && lane.status !== "ready") continue;
      const lanePlan = plan.lanes.find((candidate) => candidate.id === lane.id);
      if (!lanePlan) continue;
      const actorLabel = lanePlan.actor.label ?? lanePlan.actor.agent;
      const outputPath = fanoutLaneOutputPath(snapshot.runDir, stage.id, item.id, lane.id);
      units.push({
        type: "fanoutItem",
        stageId: stage.id,
        itemId: item.id,
        itemIndex: item.index,
        item: sourceItems[item.index],
        laneId: lane.id,
        actorLabel,
        actor: lanePlan.actor,
        sessionKey: `fanout:${stage.id}:item:${item.id}:lane:${lane.id}:agent:${actorLabel}`,
        promptId: lanePlan.promptId,
        outputSchema: lanePlan.outputSchema,
        implicitOutputFields: lanePlan.implicitOutputFields,
        outputPath,
        cwd: workflowCwd(snapshot.input),
        timeoutMs: timeoutMs(snapshot.plan, planStage),
        retryOf: lane.retryOf,
        retryOrdinal: lane.retryOrdinal,
        retryReason: lane.retryReason
      });
    }
  }
  return units;
}

function agentUnitForStage(snapshot: RuntimeSnapshot, stage: Stage, planStage: ExecutionPlanStage): AgentWorkUnit | undefined {
  if (stage.kind !== "loop" && !planStage.agent) return undefined;
  const actor = planStage.agent?.actor ?? { agent: "loop", mode: "readOnly" as const, label: "loop" };
  const actorLabel = actor.label ?? actor.agent;
  const promptId = stage.kind === "loop" ? stage.id : planStage.agent?.promptId;
  if (!promptId && stage.kind !== "loop") return undefined;
  return {
    type: stage.kind === "loop" ? "loop" : "stage",
    stageId: stage.id,
    actorLabel,
    actor,
    sessionKey: stage.kind === "loop" ? `loop:${stage.id}` : planStage.session.kind === "linear" ? planStage.session.key : `stage:${stage.id}`,
    promptId: promptId ?? stage.id,
    outputSchema: planStage.agent?.outputSchema,
    implicitOutputFields: planStage.agent?.implicitOutputFields,
    outputPath: path.join(snapshot.runDir, "outputs", `${stage.id}.json`),
    cwd: workflowCwd(snapshot.input),
    timeoutMs: timeoutMs(snapshot.plan, planStage),
    retryOf: snapshot.index.stages[stage.id]?.retryOf,
    retryOrdinal: snapshot.index.stages[stage.id]?.retryOrdinal,
    retryReason: snapshot.index.stages[stage.id]?.retryReason
  };
}

async function runFanoutPool(snapshot: RuntimeSnapshot, stageId: string, options: { drain: boolean }): Promise<RunIndex> {
  const planStage = snapshot.plan.stages.find((stage) => stage.id === stageId);
  const maxConcurrency = planStage?.fanout?.maxConcurrency ?? 1;
  const runtime = createOrchestratorAgentRuntime({ cwd: snapshot.cwd, runDir: snapshot.runDir });
  const active = new Map<string, Promise<AgentWorkResult>>();
  let index = snapshot.index;
  let fastStop = false;
  await appendEvent(snapshot.cwd, snapshot.runId, {
    type: "fanout_pool_started",
    stageId,
    maxConcurrency,
    drain: options.drain
  });

  const startMore = async (): Promise<void> => {
    if (fastStop) return;
    const refreshed = await readRunIndex(snapshot.cwd, snapshot.runId);
    const stage = snapshot.spec.stages.find((candidate): candidate is Extract<Stage, { kind: "fanout" }> => candidate.id === stageId && candidate.kind === "fanout");
    if (!stage || !planStage) return;
    const outputsForCollection = await readAuthorOutputs(snapshot.runDir);
    const readyUnits = await collectFanoutUnits({ ...snapshot, index: refreshed }, stage, planStage, outputsForCollection);
    index = await readRunIndex(snapshot.cwd, snapshot.runId);
    const selected = selectFanoutRunnableUnits(index, snapshot.plan, readyUnits, stageId, active);
    if (selected.length === 0) return;
    index = markUnitsRunning(index, selected, snapshot.runDir);
    index = { ...index, status: "running" };
    await writeRunIndex(snapshot.cwd, index);
    const outputs = await readAuthorOutputs(snapshot.runDir);
    for (const unit of selected) {
      await appendEvent(snapshot.cwd, snapshot.runId, {
        type: "fanout_pool_item_started",
        stageId: unit.stageId,
        itemId: unit.itemId,
        itemIndex: unit.itemIndex,
        laneId: unit.laneId
      });
      active.set(fanoutUnitKey(unit), runFanoutUnitSafely(snapshot, unit, runtime, outputs));
    }
  };

  try {
    await startMore();
    while (active.size > 0) {
      const settled = await Promise.race([...active.entries()].map(([key, promise]) => promise.then((result) => ({ key, result }))));
      active.delete(settled.key);
      index = await readRunIndex(snapshot.cwd, snapshot.runId);
      index = mergeAgentResult(index, settled.result, snapshot.runDir);
      await writeRunIndex(snapshot.cwd, index);
      await appendEvent(snapshot.cwd, snapshot.runId, {
        type: "fanout_pool_item_settled",
        stageId: settled.result.stageId,
        itemId: settled.result.itemId,
        status: settled.result.status,
        errorCode: settled.result.errorCode,
        outputPath: settled.result.outputPath ? path.relative(snapshot.runDir, settled.result.outputPath) : undefined
      });
      if (!fastStop && shouldFastStopFanoutPool(index, stageId, settled.result)) {
        fastStop = true;
        index = await terminalizeQueuedFanoutItems(snapshot, index, stageId);
        await writeRunIndex(snapshot.cwd, index);
      }
      if (options.drain && !fastStop) await startMore();
    }
  } finally {
    await runtime.dispose?.();
  }

  let merged = await readRunIndex(snapshot.cwd, snapshot.runId);
  const afterFanout = await completeReadyFanoutAggregates({ ...snapshot, index: merged });
  merged = afterFanout.index;
  const afterDeterministic = await advanceDeterministicStages({ ...snapshot, index: merged });
  merged = updateRunStatus(afterDeterministic.index, snapshot.spec);
  await writeRunIndex(snapshot.cwd, merged);
  await appendEvent(snapshot.cwd, snapshot.runId, {
    type: "fanout_pool_completed",
    stageId,
    status: merged.stages[stageId]?.status,
    runStatus: merged.status,
    drain: options.drain,
    fastStop
  });
  return readRunIndex(snapshot.cwd, snapshot.runId);
}

function selectFanoutRunnableUnits(
  index: RunIndex,
  plan: ExecutionPlan,
  units: AgentWorkUnit[],
  stageId: string,
  active: Map<string, Promise<AgentWorkResult>>
): AgentWorkUnit[] {
  void index;
  const stagePlan = plan.stages.find((stage) => stage.id === stageId);
  const maxConcurrency = stagePlan?.fanout?.maxConcurrency ?? 1;
  const capacity = Math.max(0, maxConcurrency - active.size);
  if (capacity === 0) return [];
  const sessionKeys = new Set<string>();
  return units
    .filter((unit) => unit.type === "fanoutItem" && unit.stageId === stageId && !active.has(fanoutUnitKey(unit)) && isRunnableUnit(index, plan, unit))
    .filter((unit) => {
      if (sessionKeys.has(unit.sessionKey)) return false;
      sessionKeys.add(unit.sessionKey);
      return true;
    })
    .slice(0, capacity);
}

async function runFanoutUnitSafely(
  snapshot: RuntimeSnapshot,
  unit: AgentWorkUnit,
  runtime: ReturnType<typeof createOrchestratorAgentRuntime>,
  outputs: Record<string, unknown>
): Promise<AgentWorkResult> {
  try {
    return await runAgentWork({
      cwd: snapshot.cwd,
      runDir: snapshot.runDir,
      runId: snapshot.runId,
      workflowInput: snapshot.input,
      spec: snapshot.spec,
      outputs,
      plan: snapshot.plan,
      unit,
      runtime
    });
  } catch (error) {
    await appendEvent(snapshot.cwd, snapshot.runId, {
      type: "fanout_item_runtime_error",
      stageId: unit.stageId,
      itemId: unit.itemId,
      errorCode: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
      errorMessage: errorMessage(error)
    });
    return fanoutItemRuntimeErrorResult({
      cwd: snapshot.cwd,
      runDir: snapshot.runDir,
      runId: snapshot.runId,
      unit,
      error
    });
  }
}

function shouldFastStopFanoutPool(index: RunIndex, stageId: string, result: AgentWorkResult): boolean {
  if (result.status === "completed") return false;
  const stage = index.stages[stageId];
  return stage?.fanout?.allowPartial === false;
}

async function terminalizeQueuedFanoutItems(snapshot: RuntimeSnapshot, index: RunIndex, stageId: string): Promise<RunIndex> {
  const stage = index.stages[stageId];
  if (!stage?.fanout) return index;
  const now = new Date().toISOString();
  const cascaded = cascadeBlockFanoutItems({
    items: stage.fanout.items,
    now,
    outputPathForItem: (item) => path.relative(snapshot.runDir, path.join(snapshot.runDir, "outputs", stageId, `${safeFileName(item.id)}.json`))
  });
  for (const { item, output } of cascaded.outputs) {
    const outputPath = path.join(snapshot.runDir, "outputs", stageId, `${safeFileName(item.id)}.json`);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    const relativeOutputPath = path.relative(snapshot.runDir, outputPath);
    await appendEvent(snapshot.cwd, snapshot.runId, {
      type: "fanout_pool_item_settled",
      stageId,
      itemId: item.id,
      itemIndex: item.index,
      status: "blocked",
      errorCode: RuntimeErrorCodes.FANOUT_ITEM_CASCADE_BLOCKED,
      outputPath: relativeOutputPath,
      cascade: true
    });
  }
  const items = cascaded.items;
  const counts = fanoutItemCounts(items);
  return updateStage(index, stageId, {
    ...stage,
    status: fanoutTransientStatus(items),
    fanout: {
      ...stage.fanout,
      items,
      ...counts
    }
  });
}

function firstReadyFanoutStageId(units: AgentWorkUnit[]): string | undefined {
  return units.find((unit) => unit.type === "fanoutItem")?.stageId;
}

function fanoutUnitKey(unit: AgentWorkUnit): string {
  return `${unit.stageId}:${unit.itemId ?? ""}:${unit.laneId ?? ""}`;
}

function selectRunnableUnits(index: RunIndex, plan: ExecutionPlan, units: AgentWorkUnit[]): AgentWorkUnit[] {
  return units.filter((unit) => isRunnableUnit(index, plan, unit)).slice(0, 1);
}

function isRunnableUnit(index: RunIndex, plan: ExecutionPlan, unit: AgentWorkUnit): boolean {
  const stage = index.stages[unit.stageId];
  const planStage = plan.stages.find((candidate) => candidate.id === unit.stageId);
  if (!stage || !planStage) return false;
  if (unit.type === "fanoutItem") {
    if (!stage.fanout || !unit.itemId || !unit.laneId) return false;
    const item = stage.fanout.items.find((candidate) => candidate.id === unit.itemId);
    const lane = item?.lanes.find((candidate) => candidate.id === unit.laneId);
    return (item?.status === "pending" || item?.status === "ready" || item?.status === "running")
      && (lane?.status === "pending" || lane?.status === "ready");
  }
  return stage.status === "pending" || stage.status === "ready";
}

function markUnitsRunning(index: RunIndex, units: AgentWorkUnit[], runDir: string): RunIndex {
  let next = index;
  for (const unit of units) {
    const stage = next.stages[unit.stageId];
    if (!stage) continue;
    const startedAt = new Date().toISOString();
    if (unit.type === "loop") {
      next = updateStage(next, unit.stageId, {
        status: "running",
        startedAt: stage.startedAt ?? startedAt
      });
    } else if (unit.itemId && stage.fanout) {
      const selectedAttemptId = attemptId({ stageId: unit.stageId, itemId: unit.itemId, laneId: unit.laneId, ordinal: nextAttemptOrdinal(next, unit.stageId, unit.itemId, unit.laneId) });
      const items = stage.fanout.items.map((item) => item.id === unit.itemId ? {
        ...item,
        status: "running" as StageStatus,
        startedAt: item.startedAt ?? startedAt,
        errorCode: undefined,
        errorMessage: undefined,
        lanes: item.lanes.map((lane) => lane.id !== unit.laneId ? lane : {
            ...lane,
            status: "running" as StageStatus,
            attemptId: lane.attemptId ?? selectedAttemptId,
            startedAt: lane.startedAt ?? startedAt,
            retryOf: unit.retryOf ?? lane.retryOf,
            retryOrdinal: unit.retryOrdinal ?? lane.retryOrdinal,
            retryReason: unit.retryReason ?? lane.retryReason,
            errorCode: undefined,
            errorMessage: undefined
        })
      } : item);
      next = updateStage(next, unit.stageId, {
        ...stage,
        status: "running",
        startedAt: stage.startedAt ?? startedAt,
        fanout: { ...stage.fanout, items }
      });
      next = upsertAttemptIndex(next, {
        id: selectedAttemptId,
        stageId: unit.stageId,
        itemId: unit.itemId,
        laneId: unit.laneId,
        kind: "attempt",
        status: "running",
        path: path.relative(runDir, attemptDir(runDir, { stageId: unit.stageId, itemId: unit.itemId, laneId: unit.laneId, ordinal: nextAttemptOrdinal(next, unit.stageId, unit.itemId, unit.laneId) })),
        startedAt,
        sessionKey: unit.sessionKey,
        requestId: selectedAttemptId,
        isRetry: unit.retryReason !== undefined,
        retryOf: unit.retryOf,
        retryOrdinal: unit.retryOrdinal,
        retryReason: unit.retryReason,
        retryBudgetUsed: unit.retryOrdinal ?? 0,
        retryBudgetLimit: AGENT_TASK_RETRY_BUDGET,
        promptPolicy: unit.retryReason === "continuation" ? "continuation" : "original",
        agent: unit.actor.agent,
        actorMode: unit.actor.mode,
        runtimeDisposeInvoked: false
      });
    } else {
      const selectedAttemptId = attemptId({ stageId: unit.stageId, ordinal: nextAttemptOrdinal(next, unit.stageId) });
      next = updateStage(next, unit.stageId, {
        status: "running",
        startedAt: stage.startedAt ?? startedAt,
        retryOf: unit.retryOf,
        retryOrdinal: unit.retryOrdinal,
        retryReason: unit.retryReason
      });
      next = upsertAttemptIndex(next, {
        id: selectedAttemptId,
        stageId: unit.stageId,
        kind: "attempt",
        status: "running",
        path: path.relative(runDir, attemptDir(runDir, { stageId: unit.stageId, ordinal: nextAttemptOrdinal(next, unit.stageId) })),
        startedAt,
        sessionKey: unit.sessionKey,
        requestId: selectedAttemptId,
        isRetry: unit.retryReason !== undefined,
        retryOf: unit.retryOf,
        retryOrdinal: unit.retryOrdinal,
        retryReason: unit.retryReason,
        retryBudgetUsed: unit.retryOrdinal ?? 0,
        retryBudgetLimit: AGENT_TASK_RETRY_BUDGET,
        promptPolicy: unit.retryReason === "continuation" ? "continuation" : "original",
        agent: unit.actor.agent,
        actorMode: unit.actor.mode,
        runtimeDisposeInvoked: false
      });
    }
  }
  return next;
}

function mergeAgentResult(index: RunIndex, result: AgentWorkResult, runDir: string): RunIndex {
  let next = index;
  for (const attempt of result.attempts) next = upsertAttemptIndex(next, attempt);
  const stage = next.stages[result.stageId];
  if (!stage) return next;
  const retryMetadata = retryMetadataFromAttempts(result.attempts);
  const finalAttemptId = result.attempts.at(-1)?.id;
  if (result.itemId && stage.fanout) {
    const items = stage.fanout.items.map((item) => {
      if (item.id !== result.itemId) return item;
      const lanes = item.lanes.map((lane) => lane.id !== result.laneId ? lane : {
          ...lane,
          status: result.status === "failed" ? "failed" as StageStatus : result.status,
          outputPath: result.outputPath ? path.relative(runDir, result.outputPath) : lane.outputPath,
          blockedReason: result.blockedReason,
          completedAt: new Date().toISOString(),
          errorCode: result.errorCode ?? result.blockedReason ?? lane.errorCode,
          errorMessage: result.errorMessage ?? result.error ?? lane.errorMessage,
          attemptId: finalAttemptId ?? lane.attemptId,
          ...retryMetadata
      });
      const status = fanoutItemStatus({ ...item, lanes });
      return {
        ...item,
        status,
        blockedReason: status === "blocked" ? result.blockedReason ?? item.blockedReason : item.blockedReason,
        completedAt: isTerminalStageStatus(status) ? new Date().toISOString() : item.completedAt,
        errorCode: result.errorCode ?? item.errorCode,
        errorMessage: result.errorMessage ?? result.error ?? item.errorMessage,
        ...retryMetadata,
        lanes
      };
    });
    const counts = fanoutItemCounts(items);
    next = updateStage(next, result.stageId, {
      ...stage,
      status: fanoutTransientStatus(items),
      fanout: {
        ...stage.fanout,
        items,
        ...counts
      }
    });
  } else {
    next = updateStage(next, result.stageId, {
      status: result.status === "failed" ? "failed" : result.status,
      outputPath: result.outputPath ? path.relative(runDir, result.outputPath) : stage.outputPath,
      completedAt: new Date().toISOString(),
      blockedReason: result.blockedReason,
      loop: loopIndexFromOutput(stage, result.output),
      ...retryMetadata
    });
    const stageSpec = Object.values(next.stages).find((entry) => entry.stageId === result.stageId);
    void stageSpec;
  }
  const gateVerdict = gateVerdictFromOutput(result.output) ?? next.gateVerdict;
  const retryCounts = retryCountsFromAttempts(result.attempts);
  return {
    ...next,
    gateVerdict,
    agentUsage: {
      ...next.agentUsage,
      actual: next.agentUsage.actual + result.agentCalls,
      retryCalls: next.agentUsage.retryCalls + result.retryCalls,
      retries: {
        runtime: next.agentUsage.retries.runtime + retryCounts.runtime,
        stale: next.agentUsage.retries.stale + retryCounts.stale,
        continuation: next.agentUsage.retries.continuation + retryCounts.continuation
      }
    }
  };
}

function nextAttemptOrdinal(index: RunIndex, stageId: string, itemId?: string, laneId?: string): number {
  return Object.values(index.attempts)
    .filter((attempt) => attempt.stageId === stageId && attempt.itemId === itemId && attempt.laneId === laneId)
    .length + 1;
}

function retryCountsFromAttempts(attempts: AttemptIndexEntry[]): Record<AgentTaskRetryReason, number> {
  return {
    runtime: attempts.filter((attempt) => attempt.retryReason === "runtime").length,
    stale: attempts.filter((attempt) => attempt.retryReason === "stale").length,
    continuation: attempts.filter((attempt) => attempt.retryReason === "continuation").length
  };
}

function retryHistoryForUnit(index: RunIndex, stageId: string, itemId?: string, laneId?: string): unknown[] {
  return Object.values(index.attempts)
    .filter((attempt) => attempt.stageId === stageId && attempt.itemId === itemId && attempt.laneId === laneId)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((attempt) => ({
      id: attempt.id,
      status: attempt.status,
      retryReason: attempt.retryReason,
      retryOf: attempt.retryOf,
      retryOrdinal: attempt.retryOrdinal,
      promptPolicy: attempt.promptPolicy,
      blockedReason: attempt.blockedReason,
      parseErrorCode: attempt.parseErrorCode,
      runtimeErrorCode: attempt.runtimeErrorCode,
      lastFailureCode: attempt.lastFailureCode
    }));
}

function loopIndexFromOutput(stage: StageIndexEntry, output: Record<string, unknown> | undefined): StageIndexEntry["loop"] | undefined {
  if (!output || !Array.isArray(output.rounds)) return stage.loop;
  return {
    maxRounds: Number(output.rounds.length),
    currentRound: typeof output.round === "number" ? output.round : output.rounds.length,
    bodyOutputStageId: typeof output.bodyOutputStageId === "string" ? output.bodyOutputStageId : "",
    rounds: output.rounds as NonNullable<StageIndexEntry["loop"]>["rounds"]
  };
}

function retryMetadataFromAttempts(attempts: AttemptIndexEntry[]): Pick<StageIndexEntry, "retryOf" | "retryOrdinal" | "retryReason"> {
  const retryAttempt = [...attempts].reverse().find((attempt) => attempt.retryOrdinal !== undefined || attempt.retryReason !== undefined);
  return {
    retryOf: retryAttempt?.retryOf,
    retryOrdinal: retryAttempt?.retryOrdinal,
    retryReason: retryAttempt?.retryReason
  };
}

async function completeReadyFanoutAggregates(snapshot: RuntimeSnapshot): Promise<{ index: RunIndex; changed: boolean }> {
  let index = snapshot.index;
  let changed = false;
  for (const stage of snapshot.spec.stages.filter((candidate): candidate is Extract<Stage, { kind: "fanout" }> => candidate.kind === "fanout")) {
    let state = index.stages[stage.id];
    const applied = applyFanoutResumePolicy(state, fanoutResumePolicy(index, stage.id));
    const resumePolicyChangedStage = applied.changed;
    if (applied.changed && applied.stage) {
      state = applied.stage;
      index = updateStage(index, stage.id, state);
      changed = true;
    }
    const resumePolicy = fanoutResumePolicy(index, stage.id);
    const mayReaggregateTerminalBlocked = state?.status === "blocked" && resumePolicy !== undefined && resumePolicyChangedStage;
    if (!state?.fanout || state.status === "completed" || state.status === "failed" || (state.status === "blocked" && !mayReaggregateTerminalBlocked)) continue;
    const items = state.fanout.items;
    if (items.length === 0) continue;
    if (items.some((item) => item.status === "pending" || item.status === "ready" || item.status === "running")) continue;
    const planStage = snapshot.plan.stages.find((candidate) => candidate.id === stage.id);
    const plan = planStage?.fanout;
    if (!plan) continue;
    const itemOutputs = await Promise.all(items.map((item) => buildFanoutItemOutputFromFiles(snapshot.runDir, stage.id, item, state?.fanout?.allowPartial === true)));
    const skippedItems = items.filter((item) => item.status === "skipped").map((item) => ({
      id: item.id,
      index: item.index,
      status: "skipped" as const,
      skippedReason: item.skippedReason
    }));
    const counts = fanoutItemCounts(items);
    const allowsPartialMode = resumePolicy?.allowPartial === true || plan.allowPartial;
    const results = buildFanoutStageOutput({
      plan: { allowPartial: allowsPartialMode, minCompletedRatio: plan.minCompletedRatio, maxBlockedItems: plan.maxBlockedItems },
      itemOutputs,
      skippedItems
    });
    const fanin = results.status === "completed"
      ? await runFanoutFanin({ ...snapshot, index }, stage, planStage, results, { reuseExistingOutput: !mayReaggregateTerminalBlocked })
      : {
          index,
          status: "blocked" as const,
          outputPath: undefined,
          blockedReason: results.blockedReason,
          output: results
        };
    const outputPath = path.join(snapshot.runDir, "outputs", `${stage.id}.json`);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    if (results.status !== "completed") {
      await fs.writeFile(outputPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
    }
    index = updateStage(fanin.index, stage.id, {
      ...state,
      status: fanin.status,
      outputPath: fanin.outputPath ?? path.relative(snapshot.runDir, outputPath),
      blockedReason: fanin.blockedReason,
      completedAt: new Date().toISOString(),
      fanout: {
        ...state.fanout,
        totalItems: items.length,
        completedItems: counts.completedItems,
        blockedItems: results.blockedItems.length,
        failedItems: counts.failedItems,
        skippedItems: skippedItems.length,
        workUnits: results.laneOutputs.length
      }
    });
    await appendEvent(snapshot.cwd, snapshot.runId, { type: "fanout_fanin_completed", stageId: stage.id, status: fanin.status, itemCount: itemOutputs.length, blockedCount: results.blockedItems.length, skippedCount: skippedItems.length, workUnitCount: results.laneOutputs.length });
    changed = true;
  }
  return { index, changed };
}

async function runFanoutFanin(
  snapshot: RuntimeSnapshot,
  stage: Extract<Stage, { kind: "fanout" }>,
  planStage: ExecutionPlanStage,
  results: Record<string, unknown>,
  options: { reuseExistingOutput?: boolean } = {}
): Promise<{ index: RunIndex; status: StageStatus; outputPath?: string; blockedReason?: string; output: Record<string, unknown> }> {
  const fanin = planStage.fanout?.fanin;
  const outputPath = path.join(snapshot.runDir, "outputs", `${stage.id}.json`);
  const existingOutput = options.reuseExistingOutput === false ? undefined : await readJsonIfExists(outputPath);
  if (existingOutput) {
    const status = statusFromItemOutput(existingOutput);
    return {
      index: finalizeStageItemAttempts(snapshot.index, snapshot.runDir, {
        stageId: stage.id,
        itemId: "fanin",
        status,
        output: existingOutput
      }),
      status,
      outputPath: path.relative(snapshot.runDir, outputPath),
      blockedReason: stringField(existingOutput, "blockedReason"),
      output: existingOutput
    };
  }
  if (!fanin) {
    const blocked = {
      status: "blocked",
      data: null,
      blockedReason: RuntimeErrorCodes.PROGRAM_FANIN_INPUT_INVALID,
      errorCode: RuntimeErrorCodes.PROGRAM_FANIN_INPUT_INVALID
    };
    await fs.writeFile(outputPath, `${JSON.stringify(blocked, null, 2)}\n`, "utf8");
    return { index: snapshot.index, status: "blocked", outputPath: path.relative(snapshot.runDir, outputPath), blockedReason: RuntimeErrorCodes.PROGRAM_FANIN_INPUT_INVALID, output: blocked };
  }
  if (fanin.mode === "program") {
    const output = programMergeArraysFanin(results);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    return {
      index: snapshot.index,
      status: output.status === "blocked" ? "blocked" : "completed",
      outputPath: path.relative(snapshot.runDir, outputPath),
      blockedReason: typeof output.blockedReason === "string" ? output.blockedReason : undefined,
      output
    };
  }

  const runtime = createOrchestratorAgentRuntime({ cwd: snapshot.cwd, runDir: snapshot.runDir });
  try {
    const actorLabel = fanin.actor.label ?? fanin.actor.agent;
    const result = await runAgentWork({
      cwd: snapshot.cwd,
      runDir: snapshot.runDir,
      runId: snapshot.runId,
      workflowInput: snapshot.input,
      spec: snapshot.spec,
      outputs: await readAuthorOutputs(snapshot.runDir),
      plan: snapshot.plan,
      runtime,
      unit: {
        type: "stage",
        stageId: stage.id,
        itemId: "fanin",
        actorLabel,
        actor: fanin.actor,
        sessionKey: fanin.sessionKey,
        promptId: fanin.promptId,
        outputSchema: fanin.outputSchema,
        implicitOutputFields: fanin.implicitOutputFields,
        outputPath,
        cwd: workflowCwd(snapshot.input),
        timeoutMs: timeoutMs(snapshot.plan, planStage),
        local: { results }
      }
    });
    let index = snapshot.index;
    for (const attempt of result.attempts) index = upsertAttemptIndex(index, attempt);
    const state = index.stages[stage.id];
    index = updateStage(index, stage.id, {
      ...state,
      attempts: [...(state?.attempts ?? []), ...result.attempts.map((attempt) => attempt.id)]
    });
    return {
      index,
      status: result.status,
      outputPath: result.outputPath ? path.relative(snapshot.runDir, result.outputPath) : undefined,
      blockedReason: result.blockedReason,
      output: result.output ?? {}
    };
  } finally {
    await runtime.dispose?.();
  }
}

function programMergeArraysFanin(results: Record<string, unknown>): Record<string, unknown> {
  const laneOutputs = Array.isArray(results.laneOutputs) ? results.laneOutputs : [];
  const data: unknown[] = [];
  for (const laneResult of laneOutputs) {
    if (objectRecord(laneResult)?.status !== "completed") continue;
    const output = objectRecord(laneResult)?.output;
    const value = objectRecord(output)?.data;
    if (!Array.isArray(value)) {
      return {
        status: "blocked",
        data: [],
        blockedReason: RuntimeErrorCodes.PROGRAM_FANIN_INPUT_INVALID,
        errorCode: RuntimeErrorCodes.PROGRAM_FANIN_INPUT_INVALID
      };
    }
    data.push(...value);
  }
  return { status: "completed", data };
}

function finalizeStageItemAttempts(index: RunIndex, runDir: string, input: {
  stageId: string;
  itemId: string;
  status: StageStatus;
  output: Record<string, unknown>;
}): RunIndex {
  let next = index;
  for (const attempt of Object.values(index.attempts)) {
    if (attempt.stageId !== input.stageId || attempt.itemId !== input.itemId) continue;
    if (attempt.status !== "pending" && attempt.status !== "running" && attempt.status !== "raw_received" && attempt.status !== "parsing") continue;
    next = upsertAttemptIndex(next, {
      ...attempt,
      status: attemptStatusFromStageStatus(input.status),
      endedAt: attempt.endedAt ?? new Date().toISOString(),
      blockedReason: stringField(input.output, "blockedReason") ?? attempt.blockedReason,
      runtimeErrorCode: stringField(objectRecord(input.output.runtimeDiagnostics), "errorCode") ?? attempt.runtimeErrorCode,
      parseErrorCode: stringField(objectRecord(input.output.parseDiagnostics), "errorCode") ?? attempt.parseErrorCode,
      path: attempt.path ?? path.relative(runDir, attemptDir(runDir, {
        stageId: input.stageId,
        itemId: input.itemId,
        kind: attempt.kind,
        ordinal: attemptOrdinalFromAttemptId(attempt.id) ?? (attempt.retryOrdinal ?? 0) + 1
      }))
    });
  }
  return next;
}

function fanoutResumePolicy(index: RunIndex, stageId: string): NonNullable<NonNullable<RunIndex["resumePolicy"]>["fanout"]>[string] | undefined {
  return index.resumePolicy?.fanout?.[stageId];
}

function applyFanoutResumePolicy(
  stage: StageIndexEntry | undefined,
  policy: ReturnType<typeof fanoutResumePolicy>
): { stage: StageIndexEntry | undefined; changed: boolean } {
  if (!stage?.fanout || !policy) return { stage, changed: false };
  const maxItems = policy.maxItems ?? Number.POSITIVE_INFINITY;
  const skippedIndexes = new Set(policy.skipItemIndexes ?? []);
  const items = stage.fanout.items.filter((item) =>
    item.status === "running" || (item.index < maxItems && !skippedIndexes.has(item.index))
  );
  const allowPartial = stage.fanout.allowPartial || policy.allowPartial === true;
  const changed = items.length !== stage.fanout.items.length || allowPartial !== stage.fanout.allowPartial;
  if (!changed) return { stage, changed: false };
  const summary = deriveFanoutSummary({
    candidateItemCount: items.length,
    items,
    allowPartial
  });
  return {
    changed: true,
    stage: {
      ...stage,
      status: isTerminalStageStatus(stage.status) ? stage.status : fanoutTransientStatus(items),
      fanout: {
        ...stage.fanout,
        ...summary
      }
    }
  };
}

type FanoutItemIndexEntry = FanoutCoreItem;

function firstRunningFanoutLane(item: FanoutItemIndexEntry): { lane: FanoutItemIndexEntry["lanes"][number] } | undefined {
  const lane = item.lanes.find((candidate) => candidate.status === "running");
  return lane ? { lane } : undefined;
}

function isTerminalStageStatus(status: StageStatus): boolean {
  return status === "completed" || status === "blocked" || status === "failed" || status === "skipped";
}

function shouldSkipRunningStage(stage: Stage, state: StageIndexEntry): boolean {
  if (stage.kind !== "fanout" || !state.fanout) return true;
  const items = state.fanout.items;
  return hasRunningFanoutItems(items) || !hasQueuedFanoutItems(items);
}

function fanoutLaneOutputPath(runDir: string, stageId: string, itemId: string, laneId: string): string {
  return path.join(runDir, "outputs", stageId, safeFileName(itemId), `${safeFileName(laneId)}.json`);
}

async function buildFanoutItemOutputFromFiles(runDir: string, stageId: string, item: FanoutItemIndexEntry, allowPartial: boolean): Promise<Record<string, unknown>> {
  const existingItemOutput = item.outputPath ? await readJsonIfExists(path.join(runDir, item.outputPath)) : undefined;
  const laneResults: FanoutCoreLaneResult[] = [];
  for (const lane of item.lanes) {
    if (lane.status === "skipped") continue;
    const outputPath = lane.outputPath ? path.join(runDir, lane.outputPath) : fanoutLaneOutputPath(runDir, stageId, item.id, lane.id);
    const output = await readJsonIfExists(outputPath) ?? missingPersistedFanoutLaneOutput(item.id, lane.id, lane.status, lane.errorCode ?? lane.blockedReason ?? item.errorCode ?? item.blockedReason);
    laneResults.push({
      itemId: item.id,
      itemIndex: item.index,
      laneId: lane.id,
      actorLabel: lane.actorLabel,
      status: statusFromLaneOutput(output, lane.status),
      output,
      outputPath: path.relative(runDir, outputPath),
      blockedReason: stringField(output, "blockedReason") ?? lane.blockedReason,
      errorCode: stringField(output, "errorCode") ?? lane.errorCode ?? stringField(output, "blockedReason")
    });
  }
  const output = buildCoreFanoutItemOutput({
    item,
    laneResults,
    allowPartial,
    existingItemOutput,
    missingLaneOutput: (_item, lane) => ({
      itemId: item.id,
      itemIndex: item.index,
      laneId: lane.id,
      actorLabel: lane.actorLabel,
      status: "blocked",
      output: missingFanoutLaneOutput(item.id, lane.id),
      outputPath: path.relative(runDir, fanoutLaneOutputPath(runDir, stageId, item.id, lane.id)),
      blockedReason: RuntimeErrorCodes.MISSING_FANOUT_ITEM_OUTPUT,
      errorCode: RuntimeErrorCodes.MISSING_FANOUT_ITEM_OUTPUT
    })
  });
  const itemOutputPath = path.join(runDir, "outputs", stageId, `${safeFileName(item.id)}.json`);
  await fs.mkdir(path.dirname(itemOutputPath), { recursive: true });
  await fs.writeFile(itemOutputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  return output;
}

function missingFanoutLaneOutput(itemId: string, laneId: string): Record<string, unknown> {
  return {
    status: "blocked",
    summary: `Missing fanout lane output ${itemId}/${laneId}.`,
    blockedReason: RuntimeErrorCodes.MISSING_FANOUT_ITEM_OUTPUT
  };
}

function missingPersistedFanoutLaneOutput(itemId: string, laneId: string, laneStatus: StageStatus, laneErrorCode: string | undefined): Record<string, unknown> {
  if ((laneStatus === "blocked" || laneStatus === "failed") && laneErrorCode) {
    return {
      status: "blocked",
      summary: `Fanout lane ${itemId}/${laneId} has terminal runtime state but no output artifact.`,
      blockedReason: laneErrorCode,
      errorCode: laneErrorCode,
      runtimeDiagnostics: {
        errorCode: laneErrorCode,
        missingOutput: true,
        itemId,
        laneId
      }
    };
  }
  return missingFanoutLaneOutput(itemId, laneId);
}

async function fanoutItemRuntimeErrorResult(input: {
  cwd: string;
  runDir: string;
  runId: string;
  unit: AgentWorkUnit;
  error: unknown;
}): Promise<AgentWorkResult> {
  const itemId = input.unit.itemId ?? "item";
  const attemptOrdinal = (input.unit.retryOrdinal ?? 0) + 1;
  const id = attemptId({ stageId: input.unit.stageId, itemId, laneId: input.unit.laneId, kind: "attempt", ordinal: attemptOrdinal });
  const dir = attemptDir(input.runDir, { stageId: input.unit.stageId, itemId, laneId: input.unit.laneId, kind: "attempt", ordinal: attemptOrdinal });
  const message = errorMessage(input.error);
  const output = runtimeBlockedOutput({
    code: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
    message,
    requestId: id,
    sessionKey: input.unit.sessionKey,
    agent: input.unit.actor.agent,
    actorMode: input.unit.actor.mode
  });
  const now = new Date().toISOString();
  await writeAttemptFile(dir, "output.json", output);
  await fs.mkdir(path.dirname(input.unit.outputPath), { recursive: true });
  await fs.writeFile(input.unit.outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  await appendEvent(input.cwd, input.runId, {
    type: "output_written",
    stageId: input.unit.stageId,
    itemId,
    laneId: input.unit.laneId,
    attemptId: id,
    outputPath: path.relative(input.runDir, input.unit.outputPath),
    status: output.status,
    errorCode: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR
  });
  return {
    stageId: input.unit.stageId,
    itemId,
    laneId: input.unit.laneId,
    status: "blocked",
    output,
    outputPath: input.unit.outputPath,
    attempts: [{
      id,
      stageId: input.unit.stageId,
      itemId,
      laneId: input.unit.laneId,
      kind: "attempt",
      status: "failed",
      path: path.relative(input.runDir, dir),
      startedAt: now,
      endedAt: now,
      blockedReason: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
      rawPreview: "",
      promptPreview: "",
      sessionKey: input.unit.sessionKey,
      requestId: id,
      isRetry: input.unit.retryReason !== undefined,
      retryOf: input.unit.retryOf,
      retryOrdinal: input.unit.retryOrdinal,
      retryReason: input.unit.retryReason,
      retryBudgetUsed: input.unit.retryOrdinal ?? 0,
      retryBudgetLimit: AGENT_TASK_RETRY_BUDGET,
      promptPolicy: input.unit.retryReason === "continuation" ? "continuation" : "original",
      lastFailureCode: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
      runtimeErrorCode: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
      agent: input.unit.actor.agent,
      actorMode: input.unit.actor.mode,
      runtimeDisposeInvoked: false
    }],
    agentCalls: 0,
    retryCalls: 0,
    blockedReason: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
    errorCode: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
    errorMessage: message
  };
}

async function writeRecoveredFanoutItemFailure(input: {
  index: RunIndex;
  cwd: string;
  runDir: string;
  runId: string;
  stageId: string;
  itemId: string;
  laneId: string;
  attemptId: string;
  startedAt?: string;
  code: string;
  message: string;
  outputPath: string;
  exhausted?: boolean;
}): Promise<{ outputPath: string; attempt: AttemptIndexEntry }> {
  const attemptOrdinal = attemptOrdinalFromAttemptId(input.attemptId) ?? 1;
  const retryOrdinal = retryOrdinalFromAttemptId(input.attemptId);
  const dir = attemptDir(input.runDir, { stageId: input.stageId, itemId: input.itemId, laneId: input.laneId, kind: "attempt", ordinal: attemptOrdinal });
  const output = input.exhausted
    ? retryExhaustedEnvelope({
      summary: input.message,
      lastFailureCode: input.code,
      retryHistory: retryHistoryForUnit(input.index, input.stageId, input.itemId, input.laneId)
    })
    : runtimeBlockedOutput({
      code: input.code,
      message: input.message,
      requestId: input.attemptId,
      sessionKey: undefined,
      agent: undefined,
      actorMode: undefined
    });
  const now = new Date().toISOString();
  await writeAttemptFile(dir, "output.json", output);
  await fs.mkdir(path.dirname(input.outputPath), { recursive: true });
  await fs.writeFile(input.outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  await appendEvent(input.cwd, input.runId, {
    type: "output_written",
    stageId: input.stageId,
    itemId: input.itemId,
    laneId: input.laneId,
    attemptId: input.attemptId,
    outputPath: path.relative(input.runDir, input.outputPath),
    status: output.status,
    errorCode: input.code
  });
  return {
    outputPath: input.outputPath,
    attempt: {
      id: input.attemptId,
      stageId: input.stageId,
      itemId: input.itemId,
      laneId: input.laneId,
      kind: "attempt",
      status: "failed",
      path: path.relative(input.runDir, dir),
      startedAt: input.startedAt,
      endedAt: now,
      blockedReason: input.code,
      runtimeErrorCode: input.code,
      retryOrdinal,
      retryReason: retryOrdinal !== undefined && retryOrdinal > 0 ? "stale" : undefined,
      retryBudgetUsed: retryOrdinal ?? 0,
      retryBudgetLimit: AGENT_TASK_RETRY_BUDGET,
      promptPolicy: "original",
      lastFailureCode: input.code,
      rawPreview: "",
      promptPreview: ""
    }
  };
}

async function writeRecoveredStageFailure(input: {
  index: RunIndex;
  cwd: string;
  runDir: string;
  runId: string;
  stageId: string;
  attemptId: string;
  startedAt?: string;
  code: string;
  message: string;
  outputPath: string;
}): Promise<{ outputPath: string; attempt: AttemptIndexEntry }> {
  const attemptOrdinal = attemptOrdinalFromAttemptId(input.attemptId) ?? 1;
  const dir = attemptDir(input.runDir, { stageId: input.stageId, kind: "attempt", ordinal: attemptOrdinal });
  const output = retryExhaustedEnvelope({
    summary: input.message,
    lastFailureCode: input.code,
    retryHistory: retryHistoryForUnit(input.index, input.stageId)
  });
  const now = new Date().toISOString();
  await writeAttemptFile(dir, "output.json", output);
  await fs.mkdir(path.dirname(input.outputPath), { recursive: true });
  await fs.writeFile(input.outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  await appendEvent(input.cwd, input.runId, {
    type: "output_written",
    stageId: input.stageId,
    attemptId: input.attemptId,
    outputPath: path.relative(input.runDir, input.outputPath),
    status: output.status,
    errorCode: input.code
  });
  return {
    outputPath: input.outputPath,
    attempt: buildStaleRecoveredAttempt(input.index, input.runDir, {
      stageId: input.stageId,
      attemptId: input.attemptId,
      startedAt: input.startedAt,
      code: input.code,
      message: input.message,
      retryOrdinal: retryOrdinalFromAttemptId(input.attemptId),
      endedAt: now
    })
  };
}

function buildStaleRecoveredAttempt(index: RunIndex, runDir: string, input: {
  stageId: string;
  attemptId: string;
  itemId?: string;
  laneId?: string;
  startedAt?: string;
  code: string;
  message: string;
  retryOrdinal?: number;
  endedAt?: string;
}): AttemptIndexEntry {
  const existing = index.attempts[input.attemptId];
  const retryOrdinal = input.retryOrdinal ?? retryOrdinalFromAttemptId(input.attemptId);
  const attemptOrdinal = attemptOrdinalFromAttemptId(input.attemptId) ?? (retryOrdinal ?? 0) + 1;
  return {
    id: input.attemptId,
    stageId: input.stageId,
    itemId: input.itemId,
    laneId: input.laneId,
    kind: "attempt",
    status: "failed",
    path: existing?.path ?? path.relative(runDir, attemptDir(runDir, { stageId: input.stageId, itemId: input.itemId, laneId: input.laneId, kind: "attempt", ordinal: attemptOrdinal })),
    startedAt: existing?.startedAt ?? input.startedAt,
    endedAt: input.endedAt ?? new Date().toISOString(),
    blockedReason: input.code,
    runtimeErrorCode: input.code,
    retryOf: existing?.retryOf,
    retryOrdinal: existing?.retryOrdinal ?? retryOrdinal,
    isRetry: existing?.isRetry ?? (retryOrdinal ?? 0) > 0,
    retryReason: existing?.retryReason ?? ((retryOrdinal ?? 0) > 0 ? "stale" : undefined),
    retryBudgetUsed: existing?.retryBudgetUsed ?? retryOrdinal ?? 0,
    retryBudgetLimit: existing?.retryBudgetLimit ?? AGENT_TASK_RETRY_BUDGET,
    promptPolicy: existing?.promptPolicy ?? "original",
    lastFailureCode: existing?.lastFailureCode ?? input.code,
    retryMessage: input.message,
    rawPreview: existing?.rawPreview ?? "",
    promptPreview: existing?.promptPreview ?? "",
    sessionKey: existing?.sessionKey,
    requestId: existing?.requestId ?? input.attemptId,
    agent: existing?.agent,
    actorMode: existing?.actorMode,
    runtimeDisposeInvoked: existing?.runtimeDisposeInvoked ?? false
  };
}

function terminalAttemptFromFanoutOutput(index: RunIndex, runDir: string, input: {
  stageId: string;
  itemId: string;
  laneId: string;
  attemptId: string;
  output: Record<string, unknown>;
  outputStatus: StageStatus;
  startedAt?: string;
}): AttemptIndexEntry | undefined {
  const existing = index.attempts[input.attemptId];
  if (existing && existing.status !== "running" && existing.status !== "pending") return undefined;
  const runtimeDiagnostics = objectRecord(input.output.runtimeDiagnostics);
  const parseDiagnostics = objectRecord(input.output.parseDiagnostics);
  const blockedReason = stringField(input.output, "blockedReason");
  const runtimeErrorCode = stringField(runtimeDiagnostics, "errorCode");
  const parseErrorCode = stringField(parseDiagnostics, "errorCode");
  const retryOrdinal = existing?.retryOrdinal ?? retryOrdinalFromAttemptId(input.attemptId);
  const attemptOrdinal = attemptOrdinalFromAttemptId(input.attemptId) ?? (retryOrdinal ?? 0) + 1;
  return {
    id: input.attemptId,
    stageId: input.stageId,
    itemId: input.itemId,
    laneId: input.laneId,
    kind: existing?.kind ?? "attempt",
    status: attemptStatusFromStageStatus(input.outputStatus),
    path: existing?.path ?? path.relative(runDir, attemptDir(runDir, { stageId: input.stageId, itemId: input.itemId, laneId: input.laneId, kind: "attempt", ordinal: attemptOrdinal })),
    startedAt: existing?.startedAt ?? input.startedAt,
    endedAt: existing?.endedAt ?? new Date().toISOString(),
    blockedReason: blockedReason ?? existing?.blockedReason,
    parseErrorCode: parseErrorCode ?? existing?.parseErrorCode,
    rawPreview: existing?.rawPreview,
    promptPreview: existing?.promptPreview,
    sessionKey: existing?.sessionKey,
    requestId: existing?.requestId ?? input.attemptId,
    stopReason: existing?.stopReason,
    runtimeErrorCode: runtimeErrorCode ?? existing?.runtimeErrorCode,
    retryOf: existing?.retryOf,
    retryOrdinal: existing?.retryOrdinal ?? retryOrdinal,
    retryReason: existing?.retryReason,
    agent: existing?.agent,
    actorMode: existing?.actorMode,
    runtimeDisposeInvoked: existing?.runtimeDisposeInvoked
  };
}

function attemptStatusFromStageStatus(status: StageStatus): AttemptStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "blocked";
}

function canScheduleAgentTaskRetry(retryOrdinal: number | undefined): boolean {
  return (retryOrdinal ?? 0) < AGENT_TASK_RETRY_BUDGET;
}

function runningStageAttemptId(index: RunIndex, state: StageIndexEntry, stageId: string): string {
  const latestRunning = [...state.attempts]
    .reverse()
    .map((id) => index.attempts[id])
    .find((attempt) => attempt?.status === "running");
  return latestRunning?.id ?? attemptId({ stageId, kind: "attempt", ordinal: (state.retryOrdinal ?? 0) + 1 });
}

function retryOrdinalFromAttemptId(attemptIdValue: string): number | undefined {
  const ordinal = attemptOrdinalFromAttemptId(attemptIdValue);
  if (ordinal === undefined) return undefined;
  return ordinal - 1;
}

function attemptOrdinalFromAttemptId(attemptIdValue: string): number | undefined {
  const match = attemptIdValue.match(/:attempt-(\d+)$/);
  if (!match) return undefined;
  const ordinal = Number(match[1]);
  return Number.isInteger(ordinal) && ordinal > 0 ? ordinal : undefined;
}

function runtimeBlockedOutput(input: {
  code: string;
  message: string;
  requestId: string;
  sessionKey?: string;
  agent?: string;
  actorMode?: string;
}): Record<string, unknown> {
  return {
    status: "blocked",
    summary: input.message,
    blockedReason: input.code,
    errorCode: input.code,
    runtimeDiagnostics: {
      requestId: input.requestId,
      sessionKey: input.sessionKey,
      agent: input.agent,
      actorMode: input.actorMode,
      runtimeDisposeInvoked: false,
      errorCode: input.code,
      rawTextPreview: ""
    }
  };
}

function fanoutItemOutputPath(runDir: string, stageId: string, item: { id: string; outputPath?: string }): string {
  return item.outputPath ? path.join(runDir, item.outputPath) : path.join(runDir, "outputs", stageId, `${safeFileName(item.id)}.json`);
}

async function readJsonIfExists(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function statusFromItemOutput(output: Record<string, unknown>): StageStatus {
  if (output.status === "completed") return "completed";
  if (output.status === "failed") return "failed";
  if (output.status === "blocked") return "blocked";
  return output.blockedReason || output.errorCode ? "blocked" : "completed";
}

function statusFromLaneOutput(output: Record<string, unknown>, laneStatus: StageStatus): StageStatus {
  if (output.status === "completed") return "completed";
  if (output.status === "failed") return "failed";
  if (output.status === "blocked") return "blocked";
  if (output.blockedReason || output.errorCode) return "blocked";
  return isTerminalStageStatus(laneStatus) ? laneStatus : "completed";
}

function isStaleAttempt(input: {
  attemptId: string | undefined;
  fallbackStartedAt: string | undefined;
  activityByAttempt: Map<string, number>;
  staleAfterMs: number;
}): boolean {
  const activity = input.attemptId ? input.activityByAttempt.get(input.attemptId) : undefined;
  const fallback = input.fallbackStartedAt ? Date.parse(input.fallbackStartedAt) : NaN;
  const lastActivity = activity ?? fallback;
  return Number.isFinite(lastActivity) && Date.now() - lastActivity >= input.staleAfterMs;
}

async function readAttemptActivity(runDir: string): Promise<Map<string, number>> {
  const activity = new Map<string, number>();
  let raw: string;
  try {
    raw = await fs.readFile(path.join(runDir, "events.ndjson"), "utf8");
  } catch {
    return activity;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const event = parseEventLine(line);
    if (!event) continue;
    const attemptIdValue = stringField(event, "attemptId");
    const type = stringField(event, "type");
    const at = stringField(event, "at");
    if (!attemptIdValue || !type || !at || !isAttemptActivityEvent(type)) continue;
    const timestamp = Date.parse(at);
    if (!Number.isFinite(timestamp)) continue;
    const previous = activity.get(attemptIdValue);
    if (previous === undefined || timestamp > previous) activity.set(attemptIdValue, timestamp);
  }
  return activity;
}

function parseEventLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function isAttemptActivityEvent(type: string): boolean {
  return type === "attempt_started"
    || type === "turn_started"
    || type === "agent_event"
    || type === "turn_finished"
    || type === "agent_task_retry_started";
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" ? field : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function updateRunStatus(index: RunIndex, spec: WorkflowSpec): RunIndex {
  const statuses = Object.values(index.stages).map((stage) => stage.status);
  const gate = spec.stages.find((stage) => stage.kind === "gate");
  const gateState = gate ? index.stages[gate.id] : undefined;
  let gateVerdict = index.gateVerdict;
  let status = index.status;
  if (statuses.includes("failed")) status = "failed";
  else if (statuses.includes("blocked")) status = "blocked";
  else if (gateState?.status === "completed") {
    status = gateVerdict && gateVerdict !== "pass" && gateVerdict !== "pass_with_warnings" ? "blocked" : "completed";
  } else if (statuses.length > 0 && statuses.every((stageStatus) => stageStatus === "completed" || stageStatus === "skipped")) {
    status = "completed";
  } else if (statuses.includes("running") || statuses.includes("ready") || statuses.includes("pending")) {
    status = "running";
  }
  const blocked = Object.values(index.stages).find((stage) => stage.status === "blocked");
  const gateVerdictBlockedReason = blockedReasonFromGateVerdict(gateVerdict);
  const blockedReason = status === "blocked"
    ? blocked?.blockedReason ?? gateVerdictBlockedReason ?? index.blockedReason
    : undefined;
  return {
    ...index,
    status,
    gateVerdict,
    blockedReason
  };
}

function gateVerdictFromOutput(output: Record<string, unknown> | undefined): RunIndex["gateVerdict"] | undefined {
  const value = output?.verdict;
  if (value === "pass" || value === "pass_with_warnings" || value === "blocked" || value === "failed" || value === "unknown") return value;
  return undefined;
}

function blockedReasonFromGateVerdict(gateVerdict: RunIndex["gateVerdict"] | undefined): string | undefined {
  if (gateVerdict === "blocked") return RuntimeErrorCodes.GATE_VERDICT_BLOCKED;
  if (gateVerdict === "failed") return RuntimeErrorCodes.GATE_VERDICT_FAILED;
  if (gateVerdict === "unknown") return RuntimeErrorCodes.GATE_VERDICT_UNKNOWN;
  return undefined;
}

async function readAuthorOutputs(runDir: string): Promise<Record<string, unknown>> {
  const outputs: Record<string, unknown> = {};
  const outputDir = path.join(runDir, "outputs");
  try {
    const entries = await fs.readdir(outputDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const output = await readJsonIfExists(path.join(outputDir, entry.name));
      if (output) outputs[path.basename(entry.name, ".json")] = output;
    }
  } catch {
    // Missing output directory means no stages have completed.
  }
  return outputs;
}

function dependenciesCompleted(stage: Stage, index: RunIndex): boolean {
  return (stage.dependsOn ?? []).every((dep) => {
    const status = index.stages[dep]?.status;
    return status === "completed" || (stage.kind === "gate" && status === "skipped");
  });
}

function markUnselectedRouteBranches(index: RunIndex, spec: WorkflowSpec, stage: Extract<Stage, { kind: "route" }>, selectedRoute: string): RunIndex {
  const dependents = spec.stages.filter((candidate) => (candidate.dependsOn ?? []).includes(stage.id));
  let next = index;
  for (const dependent of dependents) {
    if (dependent.id === selectedRoute) continue;
    const state = next.stages[dependent.id];
    if (!state || state.status !== "pending") continue;
    next = updateStage(next, dependent.id, { status: "skipped", skippedReason: `Route ${stage.id} selected ${selectedRoute || "none"}.` });
  }
  return next;
}

function updateStage(index: RunIndex, stageId: string, patch: Partial<StageIndexEntry>): RunIndex {
  const current = index.stages[stageId] ?? { stageId, status: "pending", attempts: [] };
  return {
    ...index,
    stages: {
      ...index.stages,
      [stageId]: {
        ...current,
        ...patch,
        stageId,
        attempts: patch.attempts ?? current.attempts
      }
    }
  };
}

function workflowCwd(input: Record<string, unknown>): string {
  return path.resolve(typeof input.cwd === "string" ? input.cwd : process.cwd());
}

function timeoutMs(plan: ExecutionPlan, stage: ExecutionPlanStage): number {
  return (stage.limits.stageTimeoutMinutes ?? plan.limits.stageTimeoutMinutes) * 60 * 1000;
}
