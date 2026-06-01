import fs from "node:fs/promises";
import path from "node:path";
import type { ExecutionPlan, ExecutionPlanStage } from "../compiler/execution-plan.js";
import { stageRoleName } from "../compiler/compile-execution-plan.js";
import { runDir as resolveRunDir } from "../run-index/paths.js";
import { appendEvent, readRunIndex, RuntimeErrorCodes, writeRunIndex, type AttemptIndexEntry, type AttemptStatus, type RunIndex, type StageIndexEntry, type StageStatus } from "../run-index/read-write.js";
import { WorkflowSpecSchema, type Stage, type WorkflowSpec } from "../schema/workflow-spec.js";
import { createOrchestratorAgentRuntime } from "./agent-runtime.js";
import { attemptDir, attemptId, safeFileName, upsertAttemptIndex, writeAttemptFile } from "./attempts.js";
import { resolveSource, runAgentWork, runProgramStage, stableItemId, type AgentWorkResult, type AgentWorkUnit } from "./stage-runner.js";

const STALE_FANOUT_ITEM_RECOVERY_MS = 30_000;
const MAX_RUNTIME_RETRIES = 1;

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
  let index = ensureStageEntries(snapshot.index, snapshot.spec);
  let changed = index !== snapshot.index;
  const reconciled = await reconcileFanoutRuntimeState({ ...snapshot, index });
  index = reconciled.index;
  changed ||= reconciled.changed;
  const stagesReconciled = await reconcileStageRuntimeState({ ...snapshot, index });
  index = stagesReconciled.index;
  changed ||= stagesReconciled.changed;
  if (options.startPending === false) {
    const afterFanout = await completeReadyFanoutAggregates({ ...snapshot, index });
    index = afterFanout.index;
    changed ||= afterFanout.changed;
    index = updateRunStatus(index, snapshot.spec);
    await writeRunIndex(cwd, index);
    await appendEvent(cwd, logicalRunId, { type: "run_synced", status: index.status, startPending: false });
    return readRunIndex(cwd, logicalRunId);
  }

  const deterministic = await advanceDeterministicStages({ ...snapshot, index });
  index = deterministic.index;
  changed ||= deterministic.changed;
  if (changed) await writeRunIndex(cwd, index);

  const readyUnits = await collectReadyAgentWork({ ...snapshot, index });
  index = await readRunIndex(cwd, logicalRunId);
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
  if (stage?.kind === "decisionGate" && result.output) {
    merged = markUnselectedDecisionRoutes(merged, snapshot.spec, stage, String(result.output.route ?? "blocked"));
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
    fs.readFile(path.join(runDir, "workflow.spec.json"), "utf8"),
    fs.readFile(path.join(runDir, "execution-plan.json"), "utf8"),
    fs.readFile(path.join(runDir, "input.json"), "utf8"),
    readRunIndex(cwd, runId)
  ]);
  return {
    cwd,
    runId,
    runDir,
    spec: WorkflowSpecSchema.parse(JSON.parse(specRaw)),
    plan: JSON.parse(planRaw) as ExecutionPlan,
    input: JSON.parse(inputRaw) as Record<string, unknown>,
    index
  };
}

async function reconcileFanoutRuntimeState(snapshot: RuntimeSnapshot): Promise<{ index: RunIndex; changed: boolean }> {
  let index = snapshot.index;
  let changed = false;
  for (const stage of snapshot.spec.stages.filter((candidate): candidate is Extract<Stage, { kind: "fanout" }> => candidate.kind === "fanout")) {
    const state = index.stages[stage.id];
    if (!state?.fanout) continue;
    let stageChanged = false;
    const items = [...state.fanout.items];
    const attempts: AttemptIndexEntry[] = [];
    for (const [itemPosition, item] of items.entries()) {
      const outputPath = fanoutItemOutputPath(snapshot.runDir, stage.id, item);
      const output = await readJsonIfExists(outputPath);
      if (output) {
        const status = statusFromItemOutput(output);
        const relativeOutputPath = path.relative(snapshot.runDir, outputPath);
        if (item.attemptId) {
          const attempt = terminalAttemptFromFanoutOutput(index, snapshot.runDir, {
            stageId: stage.id,
            itemId: item.id,
            attemptId: item.attemptId,
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
            errorCode: stringField(output, "blockedReason") ?? item.errorCode
          };
          stageChanged = true;
        }
        continue;
      }

      if (state.status === "completed" || state.status === "blocked" || state.status === "failed") continue;
      if (item.status === "running" && isStaleFanoutItem(item.startedAt ?? state.startedAt)) {
        if (item.attemptId && canScheduleRuntimeRetry(item.runtimeRetryOrdinal)) {
          const retryOrdinal = (item.runtimeRetryOrdinal ?? 0) + 1;
          const retryAttemptId = attemptId({ stageId: stage.id, itemId: item.id, kind: "attempt", ordinal: 1, runtimeRetryOrdinal: retryOrdinal });
          const message = "Fanout item attempt did not produce a terminal output before scheduler recovery; scheduling one runtime retry.";
          attempts.push(recoveredRuntimeAttempt(index, snapshot.runDir, {
            stageId: stage.id,
            itemId: item.id,
            attemptId: item.attemptId,
            startedAt: item.startedAt ?? state.startedAt,
            code: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
            message,
            runtimeRetryOrdinal: item.runtimeRetryOrdinal
          }));
          items[itemPosition] = {
            ...item,
            status: "ready",
            startedAt: undefined,
            completedAt: undefined,
            blockedReason: undefined,
            errorCode: undefined,
            errorMessage: undefined,
            attemptId: retryAttemptId,
            runtimeRetryOf: item.runtimeRetryOf ?? item.attemptId,
            runtimeRetryOrdinal: retryOrdinal
          };
          stageChanged = true;
          await appendEvent(snapshot.cwd, snapshot.runId, {
            type: "runtime_retry_scheduled",
            stageId: stage.id,
            itemId: item.id,
            attemptId: item.attemptId,
            retryAttemptId,
            runtimeRetryOrdinal: retryOrdinal,
            errorCode: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
            errorMessage: message
          });
          continue;
        }
        const code = item.attemptId ? RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR : RuntimeErrorCodes.FANOUT_ITEM_UNSTARTED_TIMEOUT;
        const message = item.attemptId
          ? "Fanout item attempt did not produce a terminal output before scheduler recovery."
          : "Fanout item was selected but no attempt was started before scheduler recovery.";
        const result = await writeRecoveredFanoutItemFailure({
          cwd: snapshot.cwd,
          runDir: snapshot.runDir,
          runId: snapshot.runId,
          stageId: stage.id,
          itemId: item.id,
          attemptId: item.attemptId ?? attemptId({ stageId: stage.id, itemId: item.id, kind: "attempt", ordinal: 1 }),
          startedAt: item.startedAt ?? state.startedAt,
          code,
          message,
          outputPath
        });
        items[itemPosition] = {
          ...item,
          status: "blocked",
          outputPath: path.relative(snapshot.runDir, result.outputPath),
          blockedReason: code,
          completedAt: new Date().toISOString(),
          errorCode: code,
          errorMessage: message,
          attemptId: result.attempt.id
        };
        attempts.push(result.attempt);
        stageChanged = true;
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

    if (!isStaleFanoutItem(state.startedAt)) continue;
    const currentAttemptId = runningStageAttemptId(index, state, stage.id);
    if (canScheduleRuntimeRetry(state.runtimeRetryOrdinal)) {
      const retryOrdinal = (state.runtimeRetryOrdinal ?? 0) + 1;
      const retryAttemptId = attemptId({ stageId: stage.id, kind: "attempt", ordinal: 1, runtimeRetryOrdinal: retryOrdinal });
      const message = "Agent stage attempt did not produce a terminal output before scheduler recovery; scheduling one runtime retry.";
      index = upsertAttemptIndex(index, recoveredRuntimeAttempt(index, snapshot.runDir, {
        stageId: stage.id,
        attemptId: currentAttemptId,
        startedAt: state.startedAt,
        code: RuntimeErrorCodes.AGENT_RUNTIME_ERROR,
        message,
        runtimeRetryOrdinal: state.runtimeRetryOrdinal
      }));
      state = index.stages[stage.id];
      index = updateStage(index, stage.id, {
        ...state,
        status: "ready",
        startedAt: undefined,
        completedAt: undefined,
        blockedReason: undefined,
        runtimeRetryOf: state.runtimeRetryOf ?? currentAttemptId,
        runtimeRetryOrdinal: retryOrdinal
      });
      await appendEvent(snapshot.cwd, snapshot.runId, {
        type: "runtime_retry_scheduled",
        stageId: stage.id,
        attemptId: currentAttemptId,
        retryAttemptId,
        runtimeRetryOrdinal: retryOrdinal,
        errorCode: RuntimeErrorCodes.AGENT_RUNTIME_ERROR,
        errorMessage: message
      });
      changed = true;
      continue;
    }

    const message = "Agent stage attempt did not produce a terminal output before scheduler recovery.";
    const result = await writeRecoveredStageFailure({
      index,
      cwd: snapshot.cwd,
      runDir: snapshot.runDir,
      runId: snapshot.runId,
      stageId: stage.id,
      attemptId: currentAttemptId,
      startedAt: state.startedAt,
      code: RuntimeErrorCodes.AGENT_RUNTIME_ERROR,
      message,
      outputPath
    });
    index = upsertAttemptIndex(index, result.attempt);
    index = updateStage(index, stage.id, {
      ...state,
      status: "blocked",
      outputPath: path.relative(snapshot.runDir, result.outputPath),
      blockedReason: RuntimeErrorCodes.AGENT_RUNTIME_ERROR,
      completedAt: new Date().toISOString()
    });
    await appendEvent(snapshot.cwd, snapshot.runId, {
      type: "runtime_retry_exhausted",
      stageId: stage.id,
      attemptId: currentAttemptId,
      runtimeRetryOf: state.runtimeRetryOf,
      runtimeRetryOrdinal: state.runtimeRetryOrdinal,
      errorCode: RuntimeErrorCodes.AGENT_RUNTIME_ERROR,
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
      const programOutput = await runProgramStage({ ...snapshot, workflowInput: snapshot.input, stage, planStage, outputs });
      if (!programOutput) continue;
      const outputPath = path.join(snapshot.runDir, "outputs", `${stage.id}.json`);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, `${JSON.stringify(programOutput, null, 2)}\n`, "utf8");
      outputs[stage.id] = programOutput;
      index = updateStage(index, stage.id, {
        status: programOutput.status === "blocked" ? "blocked" : "completed",
        outputPath: path.relative(snapshot.runDir, outputPath),
        completedAt: new Date().toISOString(),
        blockedReason: typeof programOutput.blockedReason === "string" ? programOutput.blockedReason : undefined
      });
      await appendEvent(snapshot.cwd, snapshot.runId, { type: "program_stage_completed", stageId: stage.id, status: programOutput.status });
      changed = true;
      progressed = true;
      if (stage.kind === "decisionGate") index = markUnselectedDecisionRoutes(index, snapshot.spec, stage, String(programOutput.route ?? "blocked"));
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
    const items = allItems.slice(0, maxItems).flatMap((item, itemIndex) => skippedIndexes.has(itemIndex) ? [] : [{
      id: stableItemId(item, itemIndex),
      index: itemIndex,
      status: "pending" as StageStatus
    }]);
    state = {
      ...state,
      status: items.length === 0 ? "completed" : "ready",
      fanout: {
        totalItems: items.length,
        completedItems: 0,
        blockedItems: 0,
        allowPartial: plan.allowPartial || resumePolicy?.allowPartial === true,
        items
      }
    };
    index = updateStage(index, stage.id, state);
    await writeRunIndex(snapshot.cwd, index);
    if (items.length === 0) {
      const output = {
        status: "completed",
        summary: "Fanout completed with 0 item outputs.",
        items: [],
        blockedItems: [],
        artifacts: [],
        nextFocus: "reduce"
      };
      const outputPath = path.join(snapshot.runDir, "outputs", `${stage.id}.json`);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
      index = updateStage(index, stage.id, {
        ...state,
        outputPath: path.relative(snapshot.runDir, outputPath),
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
  return (state.fanout?.items ?? [])
    .filter((item) => item.status === "pending" || item.status === "ready")
    .map((item): AgentWorkUnit => {
      const role = snapshot.spec.roles[stage.role];
      const outputPath = path.join(snapshot.runDir, "outputs", stage.id, `${safeFileName(item.id)}.json`);
      return {
        type: "fanoutItem",
        stageId: stage.id,
        itemId: item.id,
        itemIndex: item.index,
        item: sourceItems[item.index],
        roleName: stage.role,
        role,
        sessionKey: `role:${stage.role}:fanout:${stage.id}:item:${item.id}`,
        promptId: stage.id,
        contract: planStage.contract ?? { name: "base" },
        outputPath,
        cwd: workflowCwd(snapshot.input),
        timeoutMs: timeoutMs(snapshot.plan, planStage),
        runtimeRetryOf: item.runtimeRetryOf,
        runtimeRetryOrdinal: item.runtimeRetryOrdinal
      };
    });
}

function agentUnitForStage(snapshot: RuntimeSnapshot, stage: Stage, planStage: ExecutionPlanStage): AgentWorkUnit | undefined {
  const needsAgent =
    stage.kind === "agentTask"
    || (stage.kind === "gate" && stage.mode === "agent")
    || (stage.kind === "discover" && stage.method === "agent")
    || (stage.kind === "reduce" && stage.mode === "agent")
    || (stage.kind === "decisionGate" && stage.mode === "agent")
    || stage.kind === "fixLoop";
  if (!needsAgent) return undefined;
  const roleName = stage.kind === "fixLoop" ? planStage.fixLoop?.validator.roleName : stageRoleName(stage);
  const resolvedRoleName = roleName ?? stageRoleName(stage);
  if (!resolvedRoleName) return undefined;
  const role = snapshot.spec.roles[resolvedRoleName];
  const promptId = stage.kind === "fixLoop" ? planStage.fixLoop?.validator.promptId : planStage.promptId;
  if (!role || !promptId && stage.kind !== "fixLoop") return undefined;
  return {
    type: stage.kind === "fixLoop" ? "fixLoop" : "stage",
    stageId: stage.id,
    roleName: resolvedRoleName,
    role,
    sessionKey: `role:${resolvedRoleName}`,
    promptId: promptId ?? stage.id,
    contract: planStage.contract ?? { name: "base" },
    outputPath: path.join(snapshot.runDir, "outputs", `${stage.id}.json`),
    cwd: workflowCwd(snapshot.input),
    timeoutMs: timeoutMs(snapshot.plan, planStage),
    runtimeRetryOf: snapshot.index.stages[stage.id]?.runtimeRetryOf,
    runtimeRetryOrdinal: snapshot.index.stages[stage.id]?.runtimeRetryOrdinal
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
        itemIndex: unit.itemIndex
      });
      active.set(unit.itemId ?? unit.sessionKey, runFanoutUnitSafely(snapshot, unit, runtime, outputs));
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
    .filter((unit) => unit.type === "fanoutItem" && unit.stageId === stageId && !active.has(unit.itemId ?? unit.sessionKey))
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
  const items: FanoutItemIndexEntry[] = [];
  for (const item of stage.fanout.items) {
    if (item.status !== "pending" && item.status !== "ready") {
      items.push(item);
      continue;
    }
    const outputPath = path.join(snapshot.runDir, "outputs", stageId, `${safeFileName(item.id)}.json`);
    const output = {
      status: "blocked",
      summary: `Fanout item ${item.id} was not started because an earlier item blocked and partial fanout is disabled.`,
      artifacts: [],
      nextFocus: "diagnose",
      blockedReason: RuntimeErrorCodes.FANOUT_ITEM_CASCADE_BLOCKED
    };
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    const relativeOutputPath = path.relative(snapshot.runDir, outputPath);
    items.push({
      ...item,
      status: "blocked",
      outputPath: relativeOutputPath,
      blockedReason: RuntimeErrorCodes.FANOUT_ITEM_CASCADE_BLOCKED,
      errorCode: RuntimeErrorCodes.FANOUT_ITEM_CASCADE_BLOCKED,
      completedAt: now
    });
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

function selectRunnableUnits(index: RunIndex, plan: ExecutionPlan, units: AgentWorkUnit[]): AgentWorkUnit[] {
  void index;
  void plan;
  return units.slice(0, 1);
}

function markUnitsRunning(index: RunIndex, units: AgentWorkUnit[], runDir: string): RunIndex {
  let next = index;
  for (const unit of units) {
    const stage = next.stages[unit.stageId];
    if (!stage) continue;
    const startedAt = new Date().toISOString();
    if (unit.itemId && stage.fanout) {
      const selectedAttemptId = attemptId({ stageId: unit.stageId, itemId: unit.itemId, kind: "attempt", ordinal: 1, runtimeRetryOrdinal: unit.runtimeRetryOrdinal });
      const items = stage.fanout.items.map((item) => item.id === unit.itemId ? {
        ...item,
        status: "running" as StageStatus,
        attemptId: item.attemptId ?? selectedAttemptId,
        startedAt: item.startedAt ?? startedAt,
        runtimeRetryOf: unit.runtimeRetryOf ?? item.runtimeRetryOf,
        runtimeRetryOrdinal: unit.runtimeRetryOrdinal ?? item.runtimeRetryOrdinal,
        errorCode: undefined,
        errorMessage: undefined
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
        kind: "attempt",
        status: "running",
        path: path.relative(runDir, attemptDir(runDir, { stageId: unit.stageId, itemId: unit.itemId, kind: "attempt", ordinal: 1, runtimeRetryOrdinal: unit.runtimeRetryOrdinal })),
        startedAt,
        sessionKey: unit.sessionKey,
        requestId: selectedAttemptId,
        runtimeRetryOf: unit.runtimeRetryOf,
        runtimeRetryOrdinal: unit.runtimeRetryOrdinal,
        agent: unit.role.agent,
        roleMode: unit.role.mode,
        runtimeDisposeInvoked: false
      });
    } else {
      const selectedAttemptId = attemptId({ stageId: unit.stageId, kind: "attempt", ordinal: 1, runtimeRetryOrdinal: unit.runtimeRetryOrdinal });
      next = updateStage(next, unit.stageId, {
        status: "running",
        startedAt: stage.startedAt ?? startedAt,
        runtimeRetryOf: unit.runtimeRetryOf,
        runtimeRetryOrdinal: unit.runtimeRetryOrdinal
      });
      next = upsertAttemptIndex(next, {
        id: selectedAttemptId,
        stageId: unit.stageId,
        kind: "attempt",
        status: "running",
        path: path.relative(runDir, attemptDir(runDir, { stageId: unit.stageId, kind: "attempt", ordinal: 1, runtimeRetryOrdinal: unit.runtimeRetryOrdinal })),
        startedAt,
        sessionKey: unit.sessionKey,
        requestId: selectedAttemptId,
        runtimeRetryOf: unit.runtimeRetryOf,
        runtimeRetryOrdinal: unit.runtimeRetryOrdinal,
        agent: unit.role.agent,
        roleMode: unit.role.mode,
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
  const retryMetadata = runtimeRetryMetadataFromAttempts(result.attempts);
  if (result.itemId && stage.fanout) {
    const items = stage.fanout.items.map((item) => {
      if (item.id !== result.itemId) return item;
      return {
        ...item,
        status: result.status === "failed" ? "failed" as StageStatus : result.status,
        outputPath: result.outputPath ? path.relative(runDir, result.outputPath) : item.outputPath,
        blockedReason: result.blockedReason,
        completedAt: new Date().toISOString(),
        errorCode: result.errorCode ?? result.blockedReason ?? item.errorCode,
        errorMessage: result.errorMessage ?? result.error ?? item.errorMessage,
        ...retryMetadata
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
      ...retryMetadata
    });
    const stageSpec = Object.values(next.stages).find((entry) => entry.stageId === result.stageId);
    void stageSpec;
  }
  const gateVerdict = gateVerdictFromOutput(result.output) ?? next.gateVerdict;
  return {
    ...next,
    gateVerdict,
    agentUsage: {
      ...next.agentUsage,
      actual: next.agentUsage.actual + result.agentCalls,
      repairCalls: next.agentUsage.repairCalls + result.repairCalls
    }
  };
}

function runtimeRetryMetadataFromAttempts(attempts: AttemptIndexEntry[]): Pick<StageIndexEntry, "runtimeRetryOf" | "runtimeRetryOrdinal"> {
  const retryAttempt = [...attempts].reverse().find((attempt) => attempt.runtimeRetryOrdinal !== undefined);
  return {
    runtimeRetryOf: retryAttempt?.runtimeRetryOf,
    runtimeRetryOrdinal: retryAttempt?.runtimeRetryOrdinal
  };
}

async function completeReadyFanoutAggregates(snapshot: RuntimeSnapshot): Promise<{ index: RunIndex; changed: boolean }> {
  let index = snapshot.index;
  let changed = false;
  for (const stage of snapshot.spec.stages.filter((candidate): candidate is Extract<Stage, { kind: "fanout" }> => candidate.kind === "fanout")) {
    let state = index.stages[stage.id];
    const applied = applyFanoutResumePolicy(state, fanoutResumePolicy(index, stage.id));
    if (applied.changed && applied.stage) {
      state = applied.stage;
      index = updateStage(index, stage.id, state);
      changed = true;
    }
    if (!state?.fanout || state.status === "completed" || state.status === "blocked" || state.status === "failed") continue;
    const items = state.fanout.items;
    if (items.length === 0) continue;
    if (items.some((item) => item.status === "pending" || item.status === "ready" || item.status === "running")) continue;
    const activeItems = items.filter((item) => item.status !== "skipped");
    const outputs = await Promise.all(activeItems.map(async (item) => {
      const itemPath = path.join(snapshot.runDir, "outputs", stage.id, `${safeFileName(item.id)}.json`);
      try {
        return JSON.parse(await fs.readFile(itemPath, "utf8")) as Record<string, unknown>;
      } catch {
        return {
          status: "blocked",
          summary: `Missing fanout item output ${item.id}.`,
          artifacts: [],
          nextFocus: "diagnose",
          blockedReason: RuntimeErrorCodes.MISSING_FANOUT_ITEM_OUTPUT
        };
      }
    }));
    const blockedItems = outputs.filter((output) => output.status === "blocked");
    const completed = outputs.filter((output) => output.status === "completed").length;
    const failed = activeItems.filter((item) => item.status === "failed").length;
    const nonCompletedItems = outputs.filter((output) => output.status !== "completed");
    const ratio = outputs.length === 0 ? 1 : completed / outputs.length;
    const policy = stage.fanoutPolicy;
    const resumePolicy = fanoutResumePolicy(index, stage.id);
    const allowsPartialMode = resumePolicy?.allowPartial === true || (policy?.allowPartial ?? false);
    const partialAllowed = allowsPartialMode
      && (policy?.minCompletedRatio == null || ratio >= policy.minCompletedRatio)
      && (policy?.maxBlockedItems == null || nonCompletedItems.length <= policy.maxBlockedItems);
    const status = nonCompletedItems.length > 0 && !partialAllowed ? "blocked" : "completed";
    const aggregate = {
      status,
      summary: `Fanout completed with ${outputs.length} item output(s).`,
      items: outputs,
      blockedItems,
      artifacts: [],
      nextFocus: "reduce",
      blockedReason: status === "blocked" ? RuntimeErrorCodes.FANOUT_ITEM_BLOCKED : undefined
    };
    const outputPath = path.join(snapshot.runDir, "outputs", `${stage.id}.json`);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(aggregate, null, 2)}\n`, "utf8");
    index = updateStage(index, stage.id, {
      ...state,
      status,
      outputPath: path.relative(snapshot.runDir, outputPath),
      blockedReason: aggregate.blockedReason,
      completedAt: new Date().toISOString(),
      fanout: {
        ...state.fanout,
        totalItems: activeItems.length,
        completedItems: completed,
        blockedItems: blockedItems.length,
        failedItems: failed
      }
    });
    await appendEvent(snapshot.cwd, snapshot.runId, { type: "fanout_aggregated", stageId: stage.id, status, itemCount: outputs.length, blockedCount: blockedItems.length });
    changed = true;
  }
  return { index, changed };
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
  const counts = fanoutItemCounts(items);
  return {
    changed: true,
    stage: {
      ...stage,
      status: isTerminalStageStatus(stage.status) ? stage.status : fanoutTransientStatus(items),
      fanout: {
        ...stage.fanout,
        totalItems: items.length,
        ...counts,
        allowPartial,
        items
      }
    }
  };
}

type FanoutItemIndexEntry = NonNullable<StageIndexEntry["fanout"]>["items"][number];

function fanoutTransientStatus(items: FanoutItemIndexEntry[]): StageStatus {
  return hasRunningFanoutItems(items) ? "running" : "ready";
}

function isTerminalStageStatus(status: StageStatus): boolean {
  return status === "completed" || status === "blocked" || status === "failed" || status === "skipped";
}

function shouldSkipRunningStage(stage: Stage, state: StageIndexEntry): boolean {
  if (stage.kind !== "fanout" || !state.fanout) return true;
  const items = state.fanout.items;
  return hasRunningFanoutItems(items) || !hasQueuedFanoutItems(items);
}

function hasRunningFanoutItems(items: FanoutItemIndexEntry[]): boolean {
  return items.some((item) => item.status === "running");
}

function hasQueuedFanoutItems(items: FanoutItemIndexEntry[]): boolean {
  return items.some((item) => item.status === "pending" || item.status === "ready");
}

function fanoutItemCounts(items: FanoutItemIndexEntry[]): Pick<NonNullable<StageIndexEntry["fanout"]>, "completedItems" | "blockedItems" | "failedItems"> {
  return {
    completedItems: items.filter((item) => item.status === "completed").length,
    blockedItems: items.filter((item) => item.status === "blocked").length,
    failedItems: items.filter((item) => item.status === "failed").length
  };
}

async function fanoutItemRuntimeErrorResult(input: {
  cwd: string;
  runDir: string;
  runId: string;
  unit: AgentWorkUnit;
  error: unknown;
}): Promise<AgentWorkResult> {
  const itemId = input.unit.itemId ?? "item";
  const id = attemptId({ stageId: input.unit.stageId, itemId, kind: "attempt", ordinal: 1, runtimeRetryOrdinal: input.unit.runtimeRetryOrdinal });
  const dir = attemptDir(input.runDir, { stageId: input.unit.stageId, itemId, kind: "attempt", ordinal: 1, runtimeRetryOrdinal: input.unit.runtimeRetryOrdinal });
  const message = errorMessage(input.error);
  const output = runtimeBlockedOutput({
    code: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
    message,
    requestId: id,
    sessionKey: input.unit.sessionKey,
    agent: input.unit.role.agent,
    roleMode: input.unit.role.mode
  });
  const now = new Date().toISOString();
  await writeAttemptFile(dir, "output.json", output);
  await fs.mkdir(path.dirname(input.unit.outputPath), { recursive: true });
  await fs.writeFile(input.unit.outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  await appendEvent(input.cwd, input.runId, {
    type: "output_written",
    stageId: input.unit.stageId,
    itemId,
    attemptId: id,
    outputPath: path.relative(input.runDir, input.unit.outputPath),
    status: output.status,
    errorCode: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR
  });
  return {
    stageId: input.unit.stageId,
    itemId,
    status: "blocked",
    output,
    outputPath: input.unit.outputPath,
    attempts: [{
      id,
      stageId: input.unit.stageId,
      itemId,
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
      runtimeRetryOf: input.unit.runtimeRetryOf,
      runtimeRetryOrdinal: input.unit.runtimeRetryOrdinal,
      runtimeErrorCode: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
      agent: input.unit.role.agent,
      roleMode: input.unit.role.mode,
      runtimeDisposeInvoked: false
    }],
    agentCalls: 0,
    repairCalls: 0,
    blockedReason: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
    errorCode: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
    errorMessage: message
  };
}

async function writeRecoveredFanoutItemFailure(input: {
  cwd: string;
  runDir: string;
  runId: string;
  stageId: string;
  itemId: string;
  attemptId: string;
  startedAt?: string;
  code: string;
  message: string;
  outputPath: string;
}): Promise<{ outputPath: string; attempt: AttemptIndexEntry }> {
  const runtimeRetryOrdinal = runtimeRetryOrdinalFromAttemptId(input.attemptId);
  const dir = attemptDir(input.runDir, { stageId: input.stageId, itemId: input.itemId, kind: "attempt", ordinal: 1, runtimeRetryOrdinal });
  const output = runtimeBlockedOutput({
    code: input.code,
    message: input.message,
    requestId: input.attemptId,
    sessionKey: undefined,
    agent: undefined,
    roleMode: undefined
  });
  const now = new Date().toISOString();
  await writeAttemptFile(dir, "output.json", output);
  await fs.mkdir(path.dirname(input.outputPath), { recursive: true });
  await fs.writeFile(input.outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  await appendEvent(input.cwd, input.runId, {
    type: "output_written",
    stageId: input.stageId,
    itemId: input.itemId,
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
      kind: "attempt",
      status: "failed",
      path: path.relative(input.runDir, dir),
      startedAt: input.startedAt,
      endedAt: now,
      blockedReason: input.code,
      runtimeErrorCode: input.code,
      runtimeRetryOrdinal,
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
  const dir = attemptDir(input.runDir, { stageId: input.stageId, kind: "attempt", ordinal: 1, runtimeRetryOrdinal: runtimeRetryOrdinalFromAttemptId(input.attemptId) });
  const output = runtimeBlockedOutput({
    code: input.code,
    message: input.message,
    requestId: input.attemptId,
    sessionKey: undefined,
    agent: undefined,
    roleMode: undefined
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
    attempt: recoveredRuntimeAttempt(input.index, input.runDir, {
      stageId: input.stageId,
      attemptId: input.attemptId,
      startedAt: input.startedAt,
      code: input.code,
      message: input.message,
      runtimeRetryOrdinal: runtimeRetryOrdinalFromAttemptId(input.attemptId),
      endedAt: now
    })
  };
}

function recoveredRuntimeAttempt(index: RunIndex, runDir: string, input: {
  stageId: string;
  attemptId: string;
  itemId?: string;
  startedAt?: string;
  code: string;
  message: string;
  runtimeRetryOrdinal?: number;
  endedAt?: string;
}): AttemptIndexEntry {
  const existing = index.attempts[input.attemptId];
  const runtimeRetryOrdinal = input.runtimeRetryOrdinal ?? runtimeRetryOrdinalFromAttemptId(input.attemptId);
  return {
    id: input.attemptId,
    stageId: input.stageId,
    itemId: input.itemId,
    kind: "attempt",
    status: "failed",
    path: existing?.path ?? path.relative(runDir, attemptDir(runDir, { stageId: input.stageId, itemId: input.itemId, kind: "attempt", ordinal: 1, runtimeRetryOrdinal })),
    startedAt: existing?.startedAt ?? input.startedAt,
    endedAt: input.endedAt ?? new Date().toISOString(),
    blockedReason: input.code,
    runtimeErrorCode: input.code,
    runtimeRetryOf: existing?.runtimeRetryOf,
    runtimeRetryOrdinal: existing?.runtimeRetryOrdinal ?? runtimeRetryOrdinal,
    runtimeRetryReason: input.message,
    rawPreview: existing?.rawPreview ?? "",
    promptPreview: existing?.promptPreview ?? "",
    sessionKey: existing?.sessionKey,
    requestId: existing?.requestId ?? input.attemptId,
    agent: existing?.agent,
    roleMode: existing?.roleMode,
    runtimeDisposeInvoked: existing?.runtimeDisposeInvoked ?? false
  };
}

function terminalAttemptFromFanoutOutput(index: RunIndex, runDir: string, input: {
  stageId: string;
  itemId: string;
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
  const runtimeRetryOrdinal = existing?.runtimeRetryOrdinal ?? runtimeRetryOrdinalFromAttemptId(input.attemptId);
  return {
    id: input.attemptId,
    stageId: input.stageId,
    itemId: input.itemId,
    kind: existing?.kind ?? "attempt",
    status: attemptStatusFromStageStatus(input.outputStatus),
    path: existing?.path ?? path.relative(runDir, attemptDir(runDir, { stageId: input.stageId, itemId: input.itemId, kind: "attempt", ordinal: 1, runtimeRetryOrdinal })),
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
    runtimeRetryOf: existing?.runtimeRetryOf,
    runtimeRetryOrdinal: existing?.runtimeRetryOrdinal ?? runtimeRetryOrdinal,
    runtimeRetryReason: existing?.runtimeRetryReason,
    agent: existing?.agent,
    roleMode: existing?.roleMode,
    runtimeDisposeInvoked: existing?.runtimeDisposeInvoked
  };
}

function attemptStatusFromStageStatus(status: StageStatus): AttemptStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "blocked";
}

function canScheduleRuntimeRetry(runtimeRetryOrdinal: number | undefined): boolean {
  return (runtimeRetryOrdinal ?? 0) < MAX_RUNTIME_RETRIES;
}

function runningStageAttemptId(index: RunIndex, state: StageIndexEntry, stageId: string): string {
  const latestRunning = [...state.attempts]
    .reverse()
    .map((id) => index.attempts[id])
    .find((attempt) => attempt?.status === "running");
  return latestRunning?.id ?? attemptId({ stageId, kind: "attempt", ordinal: 1, runtimeRetryOrdinal: state.runtimeRetryOrdinal });
}

function runtimeRetryOrdinalFromAttemptId(attemptIdValue: string): number | undefined {
  const match = attemptIdValue.match(/-runtime-retry-(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

function runtimeBlockedOutput(input: {
  code: string;
  message: string;
  requestId: string;
  sessionKey?: string;
  agent?: string;
  roleMode?: string;
}): Record<string, unknown> {
  return {
    status: "blocked",
    summary: input.message,
    artifacts: [],
    nextFocus: "diagnose",
    blockedReason: input.code,
    runtimeDiagnostics: {
      requestId: input.requestId,
      sessionKey: input.sessionKey,
      agent: input.agent,
      roleMode: input.roleMode,
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
  return "blocked";
}

function isStaleFanoutItem(startedAt: string | undefined): boolean {
  if (!startedAt) return false;
  const start = Date.parse(startedAt);
  return Number.isFinite(start) && Date.now() - start >= STALE_FANOUT_ITEM_RECOVERY_MS;
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
  if (index.status === "diagnosed_blocked" && (statuses.includes("blocked") || statuses.includes("failed"))) {
    status = "diagnosed_blocked";
  } else if (statuses.includes("failed")) status = "failed";
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
  const blockedReason = status === "blocked" || status === "diagnosed_blocked"
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
      outputs[path.basename(entry.name, ".json")] = JSON.parse(await fs.readFile(path.join(outputDir, entry.name), "utf8"));
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

function markUnselectedDecisionRoutes(index: RunIndex, spec: WorkflowSpec, stage: Extract<Stage, { kind: "decisionGate" }>, selectedRoute: string): RunIndex {
  const dependents = spec.stages.filter((candidate) => (candidate.dependsOn ?? []).includes(stage.id));
  let next = index;
  for (const dependent of dependents) {
    if (dependent.id === selectedRoute) continue;
    const state = next.stages[dependent.id];
    if (!state || state.status !== "pending") continue;
    next = updateStage(next, dependent.id, { status: "skipped", skippedReason: `Decision ${stage.id} selected ${selectedRoute}.` });
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
