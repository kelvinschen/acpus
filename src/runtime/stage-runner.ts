import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import type { AcpRuntimeEvent } from "acpx/runtime";
import { z } from "zod";
import type { CompiledSchema } from "../contracts/schema-dsl.js";
import type { ExecutionPlan, ExecutionPlanStage, PromptPlan } from "../compiler/execution-plan.js";
import type { Actor, Stage, WorkflowSpec, ConditionNode, Variable } from "../schema/workflow-spec.js";
import { applyTransforms } from "../transformers/builtins.js";
import { renderPrompt } from "../variables/interpolate.js";
import { appendEvent, RuntimeErrorCodes, updateRunIndex, type AgentTaskRetryPromptPolicy, type AgentTaskRetryReason, type AttemptIndexEntry, type StageIndexEntry, type StageStatus } from "../run-index/read-write.js";
import { attemptDir, attemptId, previewText, safeFileName, upsertAttemptIndex, writeAttemptFile } from "./attempts.js";
import type { AgentTurnResult, OrchestratorAgentRuntime } from "./agent-runtime.js";
import { AGENT_TASK_RETRY_BUDGET, agentTaskRetryDelayMs, formatContinuationPrompt, retryableOutputFailure, retryExhaustedEnvelope } from "./agent-task-retry.js";
import { parseWorkflowOutput } from "./output-parser.js";
import { recordSessionBinding } from "./session-bindings.js";
import {
  buildFanoutItemOutput,
  buildFanoutStageOutput,
  cascadeBlockFanoutItems,
  deriveFanoutSummary,
  expandFanoutItems,
  fanoutItemStatus,
  type FanoutCoreItem,
  type FanoutCoreLaneResult,
  type FanoutCoreWorkUnit
} from "./fanout-core.js";

const execFileAsync = promisify(execFile);

export type AgentWorkUnit = {
  type: "stage" | "fanoutItem" | "loop";
  stageId: string;
  itemId?: string;
  itemIndex?: number;
  item?: unknown;
  laneId?: string;
  actorLabel: string;
  actor: Actor;
  sessionKey: string;
  promptId: string;
  outputSchema?: CompiledSchema;
  implicitOutputFields?: string[];
  outputPath: string;
  cwd: string;
  timeoutMs: number;
  local?: Record<string, unknown>;
  retryOf?: string;
  retryOrdinal?: number;
  retryReason?: AgentTaskRetryReason;
};

export type AgentWorkResult = {
  stageId: string;
  itemId?: string;
  laneId?: string;
  status: "completed" | "blocked" | "failed";
  output?: Record<string, unknown>;
  outputPath?: string;
  attempts: AttemptIndexEntry[];
  agentCalls: number;
  retryCalls: number;
  blockedReason?: string;
  error?: string;
  errorCode?: string;
  errorMessage?: string;
};

type RuntimeTurnExecution = {
  ok: true;
  turn: AgentTurnResult;
  attempts: AttemptIndexEntry[];
  attemptBase: AttemptIndexEntry;
  attemptId: string;
  attemptDir: string;
  agentCalls: number;
};

type RuntimeTurnFailureExecution = {
  ok: false;
  attempt: AttemptIndexEntry;
  failure: RuntimeFailureSummary;
  attemptDir: string;
  attemptId: string;
};

type RuntimeFailureSummary = {
  code: string;
  message: string;
  requestId: string;
  retryable?: boolean;
  rawText?: string;
  stopReason?: string;
};

export async function runProgramStage(input: {
  cwd: string;
  runDir: string;
  workflowInput: Record<string, unknown>;
  spec: WorkflowSpec;
  plan: ExecutionPlan;
  stage: Stage;
  planStage: ExecutionPlanStage;
  outputs: Record<string, unknown>;
}): Promise<Record<string, unknown> | undefined> {
  const stage = input.stage;
  if (stage.kind === "task" && stage.mode === "program") {
    return runCommandProgramStage({ cwd: input.cwd, stage, workflowInput: input.workflowInput });
  }
  if (stage.kind === "route" && stage.mode === "program") {
    const route = evaluateRoute(stage, input.outputs, input.workflowInput);
    return {
      status: route ? "completed" : "blocked",
      summary: route ? `Route selected: ${route}` : "Route matched no rule.",
      data: { route },
      route,
      blockedReason: route ? undefined : RuntimeErrorCodes.ROUTE_UNMATCHED,
      errorCode: route ? undefined : RuntimeErrorCodes.ROUTE_UNMATCHED
    };
  }
  if (stage.kind === "gate" && stage.mode === "program") {
    return programGate(stage, input.outputs, input.workflowInput);
  }
  return undefined;
}

export async function runAgentWork(input: {
  cwd: string;
  runDir: string;
  runId: string;
  workflowInput: Record<string, unknown>;
  spec: WorkflowSpec;
  outputs: Record<string, unknown>;
  plan: ExecutionPlan;
  unit: AgentWorkUnit;
  runtime: OrchestratorAgentRuntime;
}): Promise<AgentWorkResult> {
  if (input.unit.type === "loop") return runLoopWork(input);
  return runSingleAgentUnit(input);
}

export function renderPlannedPrompt(input: {
  prompt: PromptPlan;
  workflowInput: Record<string, unknown>;
  outputs: Record<string, unknown>;
  local?: Record<string, unknown>;
  run?: Record<string, unknown>;
}): string {
  const values: Record<string, unknown> = {};
  for (const variable of input.prompt.variables) {
    const resolved = resolveVariable(variable, input.workflowInput, input.outputs, input.local ?? {}, input.run ?? {});
    values[variable.name] = resolved;
  }
  return `${renderPrompt(input.prompt.template, values)}${input.prompt.footer}`;
}

class VariableResolutionError extends Error {
  readonly variableName: string;
  readonly source: string;

  constructor(variable: Variable) {
    super(`Variable ${variable.name} resolved to a missing value from ${variable.source}. Add an explicit default transformer if this is optional.`);
    this.name = "VariableResolutionError";
    this.variableName = variable.name;
    this.source = variable.source;
  }
}

async function renderPromptOrBlocked(input: {
  prompt: PromptPlan;
  workflowInput: Record<string, unknown>;
  outputs: Record<string, unknown>;
  local?: Record<string, unknown>;
  run?: Record<string, unknown>;
  outputPath: string;
  cwd: string;
  runId: string;
  stageId: string;
  itemId?: string;
  laneId?: string;
}): Promise<{ prompt: string } | { result: AgentWorkResult }> {
  try {
    return { prompt: renderPlannedPrompt(input) };
  } catch (error) {
    if (!(error instanceof VariableResolutionError)) throw error;
    const output = {
      status: "blocked",
      summary: error.message,
      blockedReason: RuntimeErrorCodes.VARIABLE_RESOLUTION_FAILED,
      errorCode: RuntimeErrorCodes.VARIABLE_RESOLUTION_FAILED,
      runtimeDiagnostics: {
        errorCode: RuntimeErrorCodes.VARIABLE_RESOLUTION_FAILED,
        variableName: error.variableName,
        source: error.source
      }
    };
    await fs.mkdir(path.dirname(input.outputPath), { recursive: true });
    await fs.writeFile(input.outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    await appendEvent(input.cwd, input.runId, {
      type: "variable_resolution_failed",
      stageId: input.stageId,
      itemId: input.itemId,
      laneId: input.laneId,
      errorCode: RuntimeErrorCodes.VARIABLE_RESOLUTION_FAILED,
      variableName: error.variableName,
      source: error.source
    });
    return {
      result: {
        stageId: input.stageId,
        itemId: input.itemId,
        laneId: input.laneId,
        status: "blocked",
        output,
        outputPath: input.outputPath,
        attempts: [],
        agentCalls: 0,
        retryCalls: 0,
        blockedReason: RuntimeErrorCodes.VARIABLE_RESOLUTION_FAILED,
        errorCode: RuntimeErrorCodes.VARIABLE_RESOLUTION_FAILED,
        errorMessage: error.message
      }
    };
  }
}

export function resolveSource(source: string, workflowInput: Record<string, unknown>, outputs: Record<string, unknown>, local: Record<string, unknown> = {}, run: Record<string, unknown> = {}): unknown {
  const parts = source.split(".");
  const root = parts.shift();
  let current: unknown;
  if (root === "input") current = workflowInput;
  else if (root === "outputs") current = outputs;
  else if (root === "item") current = local.item;
  else if (root === "results") current = local.results;
  else if (root === "loop") current = local.loop;
  else return undefined;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function stableItemId(item: unknown, index: number): string {
  if (item && typeof item === "object") {
    const record = item as Record<string, unknown>;
    if (typeof record.id === "string" && record.id) return safeFileName(record.id);
    if (typeof record.path === "string" && record.path) return `path-${hashShort(record.path)}`;
  }
  if (typeof item === "string" && item) return `value-${hashShort(item)}`;
  return `item-${index + 1}`;
}

async function runSingleAgentUnit(input: {
  cwd: string;
  runDir: string;
  runId: string;
  workflowInput: Record<string, unknown>;
  spec: WorkflowSpec;
  outputs: Record<string, unknown>;
  plan: ExecutionPlan;
  unit: AgentWorkUnit;
  runtime: OrchestratorAgentRuntime;
}): Promise<AgentWorkResult> {
  const prompt = input.plan.prompts[input.unit.promptId];
  if (!prompt) throw new Error(`Missing prompt plan: ${input.unit.promptId}`);
  const rendered = await renderPromptOrBlocked({
    prompt,
    workflowInput: input.workflowInput,
    outputs: input.outputs,
    local: { ...(input.unit.local ?? {}), ...(input.unit.itemId ? { item: input.unit.item } : {}) },
    outputPath: input.unit.outputPath,
    cwd: input.cwd,
    runId: input.runId,
    stageId: input.unit.stageId,
    itemId: input.unit.itemId,
    laneId: input.unit.laneId
  });
  if ("result" in rendered) return rendered.result;
  return executeAgentWorkWithRetry({
    ...input,
    prompt: rendered.prompt,
    outputSchema: input.unit.outputSchema,
    implicitOutputFields: input.unit.implicitOutputFields
  });
}

async function runLoopWork(input: {
  cwd: string;
  runDir: string;
  runId: string;
  workflowInput: Record<string, unknown>;
  spec: WorkflowSpec;
  outputs: Record<string, unknown>;
  plan: ExecutionPlan;
  unit: AgentWorkUnit;
  runtime: OrchestratorAgentRuntime;
}): Promise<AgentWorkResult> {
  const stage = input.plan.stages.find((candidate) => candidate.id === input.unit.stageId);
  if (!stage?.loop) throw new Error(`Missing loop plan for ${input.unit.stageId}`);
  const attempts: AttemptIndexEntry[] = [];
  let agentCalls = 0;
  let retryCalls = 0;
  const rounds: Array<Record<string, unknown>> = [];
  let previous: Record<string, unknown> | undefined;

  for (let round = 1; round <= stage.loop.maxRounds; round += 1) {
    const roundResult = await runLoopRound({ ...input, planStage: stage, round, previous });
    attempts.push(...roundResult.attempts);
    agentCalls += roundResult.agentCalls;
    retryCalls += roundResult.retryCalls;
    rounds.push(roundResult.roundRecord);
    if (roundResult.status !== "completed") {
      const blocked = loopOutput(stage.id, stage.loop.body.output, round, rounds, roundResult.outputs, roundResult.bodyOutput, "blocked", roundResult.blockedReason ?? RuntimeErrorCodes.LOOP_BODY_STAGE_BLOCKED);
      await fs.mkdir(path.dirname(input.unit.outputPath), { recursive: true });
      await fs.writeFile(input.unit.outputPath, `${JSON.stringify(blocked, null, 2)}\n`, "utf8");
      return { stageId: input.unit.stageId, status: "blocked", output: blocked, outputPath: input.unit.outputPath, attempts, agentCalls, retryCalls, blockedReason: String(blocked.blockedReason) };
    }
    const current = { output: roundResult.bodyOutput, outputs: roundResult.outputs };
    const shouldContinue = evaluateCondition(stage.loop.continueWhen, input.outputs, input.workflowInput, { loop: { round, current, previous } });
    previous = current;
    if (!shouldContinue) {
      const output = loopOutput(stage.id, stage.loop.body.output, round, rounds, roundResult.outputs, roundResult.bodyOutput, "completed");
      await fs.mkdir(path.dirname(input.unit.outputPath), { recursive: true });
      await fs.writeFile(input.unit.outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
      return { stageId: input.unit.stageId, status: "completed", output, outputPath: input.unit.outputPath, attempts, agentCalls, retryCalls };
    }
  }

  const lastRound = rounds.at(-1);
  const outputs = objectRecord(lastRound?.outputs) ?? {};
  const bodyOutput = objectRecord(lastRound?.bodyOutput);
  const blocked = loopOutput(stage.id, stage.loop.body.output, stage.loop.maxRounds, rounds, outputs, bodyOutput, "blocked", RuntimeErrorCodes.LOOP_EXHAUSTED);
  await fs.mkdir(path.dirname(input.unit.outputPath), { recursive: true });
  await fs.writeFile(input.unit.outputPath, `${JSON.stringify(blocked, null, 2)}\n`, "utf8");
  return { stageId: input.unit.stageId, status: "blocked", output: blocked, outputPath: input.unit.outputPath, attempts, agentCalls, retryCalls, blockedReason: RuntimeErrorCodes.LOOP_EXHAUSTED };
}

async function runLoopRound(input: {
  cwd: string;
  runDir: string;
  runId: string;
  workflowInput: Record<string, unknown>;
  spec: WorkflowSpec;
  outputs: Record<string, unknown>;
  plan: ExecutionPlan;
  planStage: ExecutionPlanStage;
  unit: AgentWorkUnit;
  runtime: OrchestratorAgentRuntime;
  round: number;
  previous?: Record<string, unknown>;
}): Promise<{
  status: "completed" | "blocked" | "failed";
  outputs: Record<string, unknown>;
  bodyOutput?: Record<string, unknown>;
  roundRecord: Record<string, unknown>;
  attempts: AttemptIndexEntry[];
  agentCalls: number;
  retryCalls: number;
  blockedReason?: string;
}> {
  const loop = input.planStage.loop;
  if (!loop) throw new Error(`Missing loop plan for ${input.planStage.id}`);
  const attempts: AttemptIndexEntry[] = [];
  let agentCalls = 0;
  let retryCalls = 0;
  const outputs: Record<string, unknown> = {};
  const stageStates: Record<string, Record<string, unknown>> = {};
  const startedAt = new Date().toISOString();
  const bodyStages = loop.body.stages;

  for (const bodyStagePlan of bodyStages) {
    const bodyStage = bodyStagePlan.id ? findLoopBodyStage(input.planStage.id, input.spec, bodyStagePlan.id) : undefined;
    if (!bodyStage) {
      const stageId = bodyStagePlan.id || "<unknown>";
      stageStates[stageId] = {
        stageId,
        status: "blocked",
        attempts: [],
        blockedReason: RuntimeErrorCodes.LOOP_BODY_STAGE_FAILED,
        completedAt: new Date().toISOString()
      };
      const roundRecord = buildRoundRecord(input.round, "blocked", startedAt, outputs, loop.body.output, stageStates, RuntimeErrorCodes.LOOP_BODY_STAGE_FAILED);
      return { status: "blocked", outputs, roundRecord, attempts, agentCalls, retryCalls, blockedReason: RuntimeErrorCodes.LOOP_BODY_STAGE_FAILED };
    }
    if (!loopBodyDependenciesCompleted(bodyStage, stageStates)) continue;
    const visibleOutputs = { ...input.outputs, ...outputs };
    const bodyOutputPath = loopBodyOutputPath(input.runDir, input.planStage.id, input.round, bodyStage.id);
    let output: Record<string, unknown> | undefined;
    if (bodyStage.kind === "fanout") {
      const fanout = await runLoopFanoutStage({ ...input, bodyStage, bodyStagePlan, outputs: visibleOutputs, previous: input.previous });
      output = fanout.output;
      attempts.push(...fanout.attempts);
      agentCalls += fanout.agentCalls;
      retryCalls += fanout.retryCalls;
      stageStates[bodyStage.id] = {
        stageId: bodyStage.id,
        status: fanout.outputStatus,
        attempts: fanout.attempts.map((attempt) => attempt.id),
        outputPath: path.relative(input.runDir, bodyOutputPath),
        blockedReason: typeof output.blockedReason === "string" ? output.blockedReason : undefined,
        completedAt: new Date().toISOString(),
        fanout: fanout.fanout
      };
    } else {
      const bodyStartedAt = new Date().toISOString();
      const programOutput = await runProgramStage({
        cwd: input.cwd,
        runDir: input.runDir,
        workflowInput: input.workflowInput,
        spec: { ...input.spec, root: loop.body.root, stages: loopBodyStagesFromSpec(input.spec, input.planStage.id) },
        plan: input.plan,
        stage: bodyStage,
        planStage: bodyStagePlan,
        outputs: visibleOutputs
      });
      if (programOutput) {
        output = programOutput;
        await fs.mkdir(path.dirname(bodyOutputPath), { recursive: true });
        await fs.writeFile(bodyOutputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
        await appendEvent(input.cwd, input.runId, { type: "loop_body_program_stage_completed", stageId: input.planStage.id, bodyStageId: bodyStage.id, round: input.round, status: output.status });
        stageStates[bodyStage.id] = {
          stageId: bodyStage.id,
          status: output.status === "blocked" ? "blocked" : "completed",
          attempts: [],
          outputPath: path.relative(input.runDir, bodyOutputPath),
          startedAt: bodyStartedAt,
          blockedReason: typeof output.blockedReason === "string" ? output.blockedReason : undefined,
          completedAt: new Date().toISOString()
        };
      } else {
        const agent = await runLoopBodyAgentStage({ ...input, bodyStage, bodyStagePlan, outputs: visibleOutputs, previous: input.previous, outputPath: bodyOutputPath });
        output = agent.output;
        attempts.push(...agent.attempts);
        agentCalls += agent.agentCalls;
        retryCalls += agent.retryCalls;
        stageStates[bodyStage.id] = {
          stageId: bodyStage.id,
          status: agent.status,
          attempts: agent.attempts.map((attempt) => attempt.id),
          outputPath: path.relative(input.runDir, bodyOutputPath),
          blockedReason: agent.blockedReason,
          completedAt: new Date().toISOString()
        };
      }
    }
    outputs[bodyStage.id] = output;
    if (stageStates[bodyStage.id]?.status === "blocked") {
      const roundRecord = buildRoundRecord(input.round, "blocked", startedAt, outputs, loop.body.output, stageStates, RuntimeErrorCodes.LOOP_BODY_STAGE_BLOCKED);
      return { status: "blocked", outputs, bodyOutput: objectRecord(outputs[loop.body.output]), roundRecord, attempts, agentCalls, retryCalls, blockedReason: RuntimeErrorCodes.LOOP_BODY_STAGE_BLOCKED };
    }
  }

  const bodyOutput = objectRecord(outputs[loop.body.output]);
  if (!bodyOutput) {
    const roundRecord = buildRoundRecord(input.round, "blocked", startedAt, outputs, loop.body.output, stageStates, RuntimeErrorCodes.LOOP_BODY_OUTPUT_MISSING);
    return { status: "blocked", outputs, roundRecord, attempts, agentCalls, retryCalls, blockedReason: RuntimeErrorCodes.LOOP_BODY_OUTPUT_MISSING };
  }
  const roundRecord = buildRoundRecord(input.round, "completed", startedAt, outputs, loop.body.output, stageStates);
  return { status: "completed", outputs, bodyOutput, roundRecord, attempts, agentCalls, retryCalls };
}

function findLoopBodyStage(loopId: string, spec: WorkflowSpec, bodyStageId: string): Stage | undefined {
  const loopStage = spec.stages.find((stage): stage is Extract<Stage, { kind: "loop" }> => stage.id === loopId && stage.kind === "loop");
  return loopStage?.body.stages.find((stage) => stage.id === bodyStageId) as Stage | undefined;
}

function loopBodyStagesFromSpec(spec: WorkflowSpec, loopId: string): Stage[] {
  const loopStage = spec.stages.find((stage): stage is Extract<Stage, { kind: "loop" }> => stage.id === loopId && stage.kind === "loop");
  return (loopStage?.body.stages ?? []) as Stage[];
}

async function runLoopBodyAgentStage(input: {
  cwd: string;
  runDir: string;
  runId: string;
  workflowInput: Record<string, unknown>;
  spec: WorkflowSpec;
  outputs: Record<string, unknown>;
  plan: ExecutionPlan;
  planStage: ExecutionPlanStage;
  unit: AgentWorkUnit;
  runtime: OrchestratorAgentRuntime;
  round: number;
  previous?: Record<string, unknown>;
  bodyStage: Stage;
  bodyStagePlan: ExecutionPlanStage;
  outputPath: string;
}): Promise<AgentWorkResult> {
  const agentPlan = input.bodyStagePlan.agent;
  if (!agentPlan) {
    return {
      stageId: input.unit.stageId,
      status: "blocked",
      output: blockedOutput(RuntimeErrorCodes.LOOP_BODY_STAGE_BLOCKED, `Loop body stage ${input.bodyStage.id} is not executable as an agent stage.`),
      outputPath: input.outputPath,
      attempts: [],
      agentCalls: 0,
      retryCalls: 0,
      blockedReason: RuntimeErrorCodes.LOOP_BODY_STAGE_BLOCKED
    };
  }
  const actorLabel = agentPlan.actor.label ?? agentPlan.actor.agent;
  const prompt = input.plan.prompts[agentPlan.promptId];
  if (!prompt) throw new Error(`Missing loop body prompt for ${input.planStage.id}/${input.bodyStage.id}`);
  const loopLocal = loopLocalContext(input.round, input.outputs, input.previous, objectRecord(input.outputs[input.planStage.loop?.body.output ?? ""]));
  const rendered = await renderPromptOrBlocked({
    prompt,
    workflowInput: input.workflowInput,
    outputs: input.outputs,
    local: loopLocal,
    outputPath: input.outputPath,
    cwd: input.cwd,
    runId: input.runId,
    stageId: input.unit.stageId,
    itemId: `round-${input.round}__stage-${input.bodyStage.id}`
  });
  if ("result" in rendered) return rendered.result;
  return executeAgentWorkWithRetry({
    cwd: input.cwd,
    runDir: input.runDir,
    runId: input.runId,
    workflowInput: input.workflowInput,
    outputs: input.outputs,
    plan: input.plan,
    runtime: input.runtime,
    unit: {
      type: "stage",
      stageId: input.unit.stageId,
      itemId: `round-${input.round}__stage-${input.bodyStage.id}`,
      actorLabel,
      actor: agentPlan.actor,
      sessionKey: `loop:${input.planStage.id}:round:${input.round}:stage:${input.bodyStage.id}:agent:${actorLabel}`,
      promptId: agentPlan.promptId,
      outputSchema: agentPlan.outputSchema,
      implicitOutputFields: agentPlan.implicitOutputFields,
      outputPath: input.outputPath,
      cwd: input.unit.cwd,
      timeoutMs: input.unit.timeoutMs,
      local: loopLocal
    },
    prompt: rendered.prompt,
    outputSchema: agentPlan.outputSchema,
    implicitOutputFields: agentPlan.implicitOutputFields
  });
}

async function runLoopFanoutStage(input: {
  cwd: string;
  runDir: string;
  runId: string;
  workflowInput: Record<string, unknown>;
  spec: WorkflowSpec;
  outputs: Record<string, unknown>;
  plan: ExecutionPlan;
  planStage: ExecutionPlanStage;
  unit: AgentWorkUnit;
  runtime: OrchestratorAgentRuntime;
  round: number;
  previous?: Record<string, unknown>;
  bodyStage: Extract<Stage, { kind: "fanout" }>;
  bodyStagePlan: ExecutionPlanStage;
}): Promise<{ output: Record<string, unknown>; outputStatus: StageStatus; attempts: AttemptIndexEntry[]; agentCalls: number; retryCalls: number; fanout: NonNullable<StageIndexEntry["fanout"]> }> {
  const plan = input.bodyStagePlan.fanout;
  if (!plan) throw new Error(`Missing loop fanout plan for ${input.bodyStage.id}`);
  const source = resolveSource(plan.itemsSource, input.workflowInput, input.outputs, loopLocalContext(input.round, input.outputs, input.previous, objectRecord(input.outputs[input.bodyStage.id])));
  const items = Array.isArray(source) ? source.slice(0, plan.maxItems) : [];
  const attempts: AttemptIndexEntry[] = [];
  let agentCalls = 0;
  let retryCalls = 0;
  const expanded = expandFanoutItems({
    plan,
    items,
    workflowInput: input.workflowInput,
    outputs: input.outputs,
    localForItem: (item) => ({ item, ...loopLocalContext(input.round, input.outputs, input.previous, objectRecord(input.outputs[input.bodyStage.id])) }),
    itemIdFor: stableItemId,
    evaluate: evaluateFanoutLaneCondition
  });
  const fanoutItems = expanded.items;
  const laneResultsByItemIndex = new Map<number, FanoutCoreLaneResult[]>();
  const itemOutputsByIndex = new Map<number, Record<string, unknown>>(expanded.preExecutionItemOutputs);
  type LoopFanoutTask = FanoutCoreWorkUnit & {
    ordinal: number;
    laneOutputPath: string;
  };
  type LoopFanoutTaskResult = { task: LoopFanoutTask; result: AgentWorkResult };
  const tasks: LoopFanoutTask[] = expanded.workUnits.map((workUnit, ordinal) => ({
    ...workUnit,
    ordinal,
    laneOutputPath: loopFanoutLaneOutputPath(input.runDir, input.planStage.id, input.round, input.bodyStage.id, workUnit.itemId, workUnit.laneId)
  }));
  let progressWrite: Promise<void> = Promise.resolve();
  let progressError: unknown;
  const enqueueLoopProgress = (bodyStageState: LoopRoundStageStateUpdate): void => {
    const snapshot = cloneLoopRoundStageState(bodyStageState);
    progressWrite = progressWrite
      .catch((error: unknown) => {
        progressError ??= error;
      })
      .then(async () => {
        if (progressError) return;
        await persistLoopBodyStage(input, input.bodyStage.id, snapshot);
      })
      .catch((error: unknown) => {
        progressError ??= error;
      });
  };
  const flushLoopProgress = async (): Promise<void> => {
    await progressWrite;
    if (progressError) throw progressError;
  };
  await persistLoopBodyStage(input, input.bodyStage.id, {
    stageId: input.bodyStage.id,
    status: fanoutItems.length === 0 ? "completed" : "running",
    attempts: [],
    startedAt: new Date().toISOString(),
    fanout: deriveFanoutSummary({ candidateItemCount: items.length, items: fanoutItems, allowPartial: plan.allowPartial })
  });

  let nextTask = 0;
  let fastStop = false;
  const workerCount = Math.min(Math.max(1, plan.maxConcurrency), tasks.length);
  const taskResults: LoopFanoutTaskResult[] = [];
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextTask < tasks.length) {
      if (fastStop || progressError) return;
      const task = tasks[nextTask];
      nextTask += 1;
      markLoopFanoutLaneRunning(fanoutItems, task);
      enqueueLoopProgress({
        stageId: input.bodyStage.id,
        status: "running",
        fanout: deriveFanoutSummary({ candidateItemCount: items.length, items: fanoutItems, allowPartial: plan.allowPartial })
      });
      const result = await runLoopFanoutLaneTask(input, task);
      taskResults.push({ task, result });
      attempts.push(...result.attempts);
      agentCalls += result.agentCalls;
      retryCalls += result.retryCalls;
      applyLoopFanoutLaneResult(fanoutItems, input.runDir, task, result);
      const existing = laneResultsByItemIndex.get(task.itemIndex) ?? [];
      if (result.outputPath && result.output) {
        existing.push({
          itemId: task.itemId,
          itemIndex: task.itemIndex,
          laneId: task.laneId,
          actorLabel: task.actorLabel,
          status: result.status,
          output: result.output,
          outputPath: path.relative(input.runDir, result.outputPath),
          blockedReason: result.blockedReason,
          errorCode: result.errorCode
        });
      }
      laneResultsByItemIndex.set(task.itemIndex, existing);
      enqueueLoopProgress({
        stageId: input.bodyStage.id,
        status: "running",
        attempts: attempts.map((attempt) => attempt.id),
        startedAt: new Date().toISOString(),
        fanout: deriveFanoutSummary({ candidateItemCount: items.length, items: fanoutItems, allowPartial: plan.allowPartial })
      });
      if (result.status !== "completed" && !plan.allowPartial) {
        fastStop = true;
      }
    }
  }));
  await flushLoopProgress();
  taskResults.sort((left, right) => left.task.ordinal - right.task.ordinal);
  attempts.splice(0, attempts.length, ...taskResults.flatMap(({ result }) => result.attempts));

  if (fastStop) {
    const cascaded = cascadeBlockFanoutItems({
      items: fanoutItems,
      now: new Date().toISOString(),
      outputPathForItem: (item) => path.relative(input.runDir, loopFanoutItemOutputPath(input.runDir, input.planStage.id, input.round, input.bodyStage.id, item.id))
    });
    fanoutItems.splice(0, fanoutItems.length, ...cascaded.items);
    for (const { item, output } of cascaded.outputs) {
      itemOutputsByIndex.set(item.index, output);
    }
  }
  for (const item of fanoutItems) {
    if (itemOutputsByIndex.has(item.index)) continue;
    const itemOutput = buildFanoutItemOutput({
      item,
      laneResults: laneResultsByItemIndex.get(item.index) ?? [],
      allowPartial: plan.allowPartial,
      missingLaneOutput: (_item, lane) => ({
        itemId: item.id,
        itemIndex: item.index,
        laneId: lane.id,
        actorLabel: lane.actorLabel,
        status: "blocked",
        output: missingLoopFanoutLaneOutput(item.id, lane.id),
        outputPath: path.relative(input.runDir, loopFanoutLaneOutputPath(input.runDir, input.planStage.id, input.round, input.bodyStage.id, item.id, lane.id)),
        blockedReason: RuntimeErrorCodes.MISSING_FANOUT_ITEM_OUTPUT,
        errorCode: RuntimeErrorCodes.MISSING_FANOUT_ITEM_OUTPUT
      })
    });
    itemOutputsByIndex.set(item.index, itemOutput);
    item.status = itemOutput.status === "blocked" ? "blocked" : "completed";
    item.lanes = Array.isArray(itemOutput.lanes) ? itemOutput.lanes as FanoutCoreItem["lanes"] : item.lanes;
    item.blockedReason = typeof itemOutput.blockedReason === "string" ? itemOutput.blockedReason : undefined;
    item.errorCode = typeof itemOutput.errorCode === "string" ? itemOutput.errorCode : item.blockedReason;
    item.outputPath = path.relative(input.runDir, loopFanoutItemOutputPath(input.runDir, input.planStage.id, input.round, input.bodyStage.id, item.id));
    item.completedAt = new Date().toISOString();
  }

  const itemOutputs = Array.from(itemOutputsByIndex.entries()).sort(([left], [right]) => left - right).map(([, output]) => output);
  for (const itemOutput of itemOutputs) {
    const itemId = String(itemOutput.itemId);
    const itemOutputPath = loopFanoutItemOutputPath(input.runDir, input.planStage.id, input.round, input.bodyStage.id, itemId);
    await fs.mkdir(path.dirname(itemOutputPath), { recursive: true });
    await fs.writeFile(itemOutputPath, `${JSON.stringify(itemOutput, null, 2)}\n`, "utf8");
    const item = fanoutItems.find((candidate) => candidate.id === itemId);
    if (item) {
      item.outputPath = path.relative(input.runDir, itemOutputPath);
      item.completedAt = item.completedAt ?? new Date().toISOString();
    }
  }

  const skippedItems = fanoutItems.filter((item) => item.status === "skipped").map((item) => ({
    id: item.id,
    index: item.index,
    status: "skipped" as const,
    skippedReason: item.skippedReason
  }));
  const results = buildFanoutStageOutput({ plan, itemOutputs, skippedItems });
  const outputPath = loopBodyOutputPath(input.runDir, input.planStage.id, input.round, input.bodyStage.id);
  const faninResult = results.status === "completed"
    ? await runLoopFanoutFanin({ ...input, results, outputPath })
    : { output: results, attempts: [], agentCalls: 0, retryCalls: 0 };
  const output = faninResult.output;
  const outputStatus: StageStatus = output.status === "blocked" || results.status === "blocked" ? "blocked" : "completed";
  attempts.push(...faninResult.attempts);
  agentCalls += faninResult.agentCalls;
  retryCalls += faninResult.retryCalls;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  const fanout = deriveFanoutSummary({ candidateItemCount: items.length, items: fanoutItems, allowPartial: plan.allowPartial });
  await persistLoopBodyStage(input, input.bodyStage.id, {
    stageId: input.bodyStage.id,
    status: outputStatus,
    attempts: attempts.map((attempt) => attempt.id),
    outputPath: path.relative(input.runDir, outputPath),
    blockedReason: typeof output.blockedReason === "string" ? output.blockedReason : undefined,
    completedAt: new Date().toISOString(),
    fanout
  });
  return { output, outputStatus, attempts, agentCalls, retryCalls, fanout };
}

async function runLoopFanoutFanin(input: {
  cwd: string;
  runDir: string;
  runId: string;
  workflowInput: Record<string, unknown>;
  spec: WorkflowSpec;
  outputs: Record<string, unknown>;
  plan: ExecutionPlan;
  planStage: ExecutionPlanStage;
  unit: AgentWorkUnit;
  runtime: OrchestratorAgentRuntime;
  round: number;
  previous?: Record<string, unknown>;
  bodyStage: Extract<Stage, { kind: "fanout" }>;
  bodyStagePlan: ExecutionPlanStage;
  results: Record<string, unknown>;
  outputPath: string;
}): Promise<{ output: Record<string, unknown>; attempts: AttemptIndexEntry[]; agentCalls: number; retryCalls: number }> {
  const fanin = input.bodyStagePlan.fanout?.fanin;
  if (!fanin) {
    return { output: {
      status: "blocked",
      data: [],
      blockedReason: RuntimeErrorCodes.PROGRAM_FANIN_INPUT_INVALID,
      errorCode: RuntimeErrorCodes.PROGRAM_FANIN_INPUT_INVALID
    }, attempts: [], agentCalls: 0, retryCalls: 0 };
  }
  if (fanin.mode === "program") {
    return { output: mergeArraysFaninOutput(input.results), attempts: [], agentCalls: 0, retryCalls: 0 };
  }
  const actorLabel = fanin.actor.label ?? fanin.actor.agent;
  const result = await runAgentWork({
    cwd: input.cwd,
    runDir: input.runDir,
    runId: input.runId,
    workflowInput: input.workflowInput,
    spec: input.spec,
    outputs: input.outputs,
    plan: input.plan,
    runtime: input.runtime,
    unit: {
      type: "stage",
      stageId: input.unit.stageId,
      itemId: `round-${input.round}__fanin-${input.bodyStage.id}`,
      actorLabel,
      actor: fanin.actor,
      sessionKey: fanin.sessionKey.replace("{round}", String(input.round)),
      promptId: fanin.promptId,
      outputSchema: fanin.outputSchema,
      implicitOutputFields: fanin.implicitOutputFields,
      outputPath: input.outputPath,
      cwd: input.unit.cwd,
      timeoutMs: input.unit.timeoutMs,
      local: {
        results: input.results,
        ...loopLocalContext(input.round, input.outputs, input.previous, objectRecord(input.outputs[input.bodyStage.id]))
      }
    }
  });
  return { output: result.output ?? {}, attempts: result.attempts, agentCalls: result.agentCalls, retryCalls: result.retryCalls };
}

function mergeArraysFaninOutput(results: Record<string, unknown>): Record<string, unknown> {
  const laneOutputs = Array.isArray(results.laneOutputs) ? results.laneOutputs : [];
  const data: unknown[] = [];
  for (const laneResult of laneOutputs) {
    const lane = objectRecord(laneResult);
    if (lane?.status !== "completed") continue;
    const value = objectRecord(lane.output)?.data;
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

type LoopRoundStageState = NonNullable<NonNullable<StageIndexEntry["loop"]>["rounds"][number]["stages"][string]>;
type LoopRoundStageStateUpdate = Pick<LoopRoundStageState, "stageId" | "status"> & Partial<Omit<LoopRoundStageState, "stageId" | "status">>;

function cloneLoopRoundStageState(state: LoopRoundStageStateUpdate): LoopRoundStageStateUpdate {
  return JSON.parse(JSON.stringify(state)) as LoopRoundStageStateUpdate;
}

async function persistLoopBodyStage(input: {
  cwd: string;
  runId: string;
  planStage: ExecutionPlanStage;
  round: number;
}, bodyStageId: string, bodyStageState: LoopRoundStageStateUpdate): Promise<void> {
  await updateRunIndex(input.cwd, input.runId, (index) => {
    const existingStage = index.stages[input.planStage.id];
    if (!existingStage) return index;
    const existingLoop = existingStage.loop;
    const rounds = [...(existingLoop?.rounds ?? [])];
    const roundIndex = rounds.findIndex((entry) => entry.round === input.round);
    const existingRound = roundIndex >= 0 ? rounds[roundIndex] : undefined;
    const previousStageState = existingRound?.stages?.[bodyStageId];
    const nextStageState: LoopRoundStageState = {
      ...(previousStageState ?? { stageId: bodyStageId, status: "pending" as StageStatus, attempts: [] }),
      ...bodyStageState
    };
    nextStageState.attempts = bodyStageState.attempts ?? previousStageState?.attempts ?? [];
    nextStageState.startedAt = previousStageState?.startedAt ?? bodyStageState.startedAt;
    const nextRound: NonNullable<StageIndexEntry["loop"]>["rounds"][number] = {
      round: input.round,
      status: "running" as StageStatus,
      startedAt: existingRound?.startedAt ?? new Date().toISOString(),
      bodyOutputStageId: input.planStage.loop?.body.output ?? existingLoop?.bodyOutputStageId ?? "",
      bodyOutput: existingRound?.bodyOutput,
      outputs: existingRound?.outputs ?? {},
      stages: {
        ...(existingRound?.stages ?? {}),
        [bodyStageId]: nextStageState
      }
    };
    if (roundIndex >= 0) rounds[roundIndex] = nextRound;
    else rounds.push(nextRound);
    return {
      ...index,
      stages: {
        ...index.stages,
        [input.planStage.id]: {
          ...existingStage,
          status: "running",
          loop: {
            maxRounds: existingLoop?.maxRounds ?? input.planStage.loop?.maxRounds ?? input.round,
            currentRound: input.round,
            bodyOutputStageId: nextRound.bodyOutputStageId,
            rounds
          }
        }
      }
    };
  });
}

function markLoopFanoutLaneRunning(fanoutItems: FanoutCoreItem[], task: FanoutCoreWorkUnit): void {
  const now = new Date().toISOString();
  const item = fanoutItems.find((candidate) => candidate.index === task.itemIndex);
  const lane = item?.lanes.find((candidate) => candidate.id === task.laneId);
  if (!item || !lane) return;
  item.status = "running";
  item.startedAt = item.startedAt ?? now;
  lane.status = "running";
  lane.startedAt = lane.startedAt ?? now;
}

async function runLoopFanoutLaneTask(
  input: {
    cwd: string;
    runDir: string;
    runId: string;
    workflowInput: Record<string, unknown>;
    spec: WorkflowSpec;
    outputs: Record<string, unknown>;
    plan: ExecutionPlan;
    planStage: ExecutionPlanStage;
    unit: AgentWorkUnit;
    runtime: OrchestratorAgentRuntime;
    round: number;
    previous?: Record<string, unknown>;
    bodyStage: Extract<Stage, { kind: "fanout" }>;
  },
  task: {
    item: unknown;
    itemIndex: number;
    itemId: string;
    laneId: string;
    actorLabel: string;
    actor: Actor;
    promptId: string;
    outputSchema?: CompiledSchema;
    implicitOutputFields?: string[];
    laneOutputPath: string;
  }
): Promise<AgentWorkResult> {
  const prompt = input.plan.prompts[task.promptId];
  if (!prompt) throw new Error(`Missing loop fanout lane prompt for ${input.bodyStage.id}/${task.laneId}`);
  const local = { item: task.item, ...loopLocalContext(input.round, input.outputs, input.previous, objectRecord(input.outputs[input.bodyStage.id])) };
  const unitBase = {
    type: "fanoutItem" as const,
    stageId: input.unit.stageId,
    itemId: `round-${input.round}__stage-${input.bodyStage.id}__item-${task.itemId}`,
    itemIndex: task.itemIndex,
    item: task.item,
    laneId: task.laneId,
    actorLabel: task.actorLabel,
    actor: task.actor,
    sessionKey: `loop:${input.planStage.id}:round:${input.round}:stage:${input.bodyStage.id}:item:${task.itemId}:lane:${task.laneId}:agent:${task.actorLabel}`,
    promptId: task.promptId,
    outputSchema: task.outputSchema,
    implicitOutputFields: task.implicitOutputFields,
    outputPath: task.laneOutputPath,
    cwd: input.unit.cwd,
    timeoutMs: input.unit.timeoutMs,
    local
  };
  const rendered = await renderPromptOrBlocked({
    prompt,
    workflowInput: input.workflowInput,
    outputs: input.outputs,
    local,
    outputPath: task.laneOutputPath,
    cwd: input.cwd,
    runId: input.runId,
    stageId: input.unit.stageId,
    itemId: unitBase.itemId,
    laneId: task.laneId
  });
  if ("result" in rendered) {
    return rendered.result;
  }
  const result = await executeAgentWorkWithRetry({
    cwd: input.cwd,
    runDir: input.runDir,
    runId: input.runId,
    workflowInput: input.workflowInput,
    outputs: input.outputs,
    plan: input.plan,
    runtime: input.runtime,
    unit: unitBase,
    prompt: rendered.prompt,
    outputSchema: task.outputSchema,
    implicitOutputFields: task.implicitOutputFields
  });
  return result;
}

function applyLoopFanoutLaneResult(
  fanoutItems: FanoutCoreItem[],
  runDir: string,
  task: FanoutCoreWorkUnit & { laneOutputPath: string },
  result: AgentWorkResult
): void {
  const item = fanoutItems.find((candidate) => candidate.index === task.itemIndex);
  const lane = item?.lanes.find((candidate) => candidate.id === task.laneId);
  if (!item || !lane) return;
  lane.status = result.status;
  lane.outputPath = result.outputPath ? path.relative(runDir, result.outputPath) : path.relative(runDir, task.laneOutputPath);
  lane.blockedReason = result.blockedReason;
  lane.attemptId = result.attempts.at(-1)?.id;
  lane.completedAt = new Date().toISOString();
  lane.errorCode = result.errorCode;
  lane.errorMessage = result.errorMessage;
  item.status = fanoutItemStatus(item);
}

function missingLoopFanoutLaneOutput(itemId: string, laneId: string): Record<string, unknown> {
  return {
    status: "blocked",
    summary: `Missing fanout lane output ${itemId}/${laneId}.`,
    blockedReason: RuntimeErrorCodes.MISSING_FANOUT_ITEM_OUTPUT
  };
}

function loopBodyDependenciesCompleted(stage: Stage, stageStates: Record<string, Record<string, unknown>>): boolean {
  return (stage.dependsOn ?? []).every((dep) => stageStates[dep]?.status === "completed");
}

function buildRoundRecord(round: number, status: StageStatus, startedAt: string, outputs: Record<string, unknown>, outputStageId: string, stages: Record<string, Record<string, unknown>>, blockedReason?: string): Record<string, unknown> {
  return {
    round,
    status,
    startedAt,
    completedAt: new Date().toISOString(),
    bodyOutputStageId: outputStageId,
    bodyOutput: outputs[outputStageId],
    outputs,
    stages,
    blockedReason
  };
}

function loopOutput(loopId: string, outputStageId: string, round: number, rounds: Array<Record<string, unknown>>, finalOutputs: Record<string, unknown>, bodyOutput: Record<string, unknown> | undefined, status: "completed" | "blocked", blockedReason?: string): Record<string, unknown> {
  return {
    status,
    summary: typeof bodyOutput?.summary === "string" ? bodyOutput.summary : `Loop ${loopId} ${status}.`,
    round,
    bodyOutputStageId: outputStageId,
    bodyOutput,
    finalOutputs,
    rounds,
    blockedReason
  };
}

function loopLocalContext(round: number, outputs: Record<string, unknown>, previous?: Record<string, unknown>, currentOutput?: Record<string, unknown>): Record<string, unknown> {
  return {
    loop: {
      round,
      current: {
        outputs,
        output: currentOutput
      },
      previous
    }
  };
}

function loopBodyOutputPath(runDir: string, loopId: string, round: number, bodyStageId: string): string {
  return path.join(runDir, "outputs", loopId, `round-${round}`, `${safeFileName(bodyStageId)}.json`);
}

function loopFanoutItemOutputPath(runDir: string, loopId: string, round: number, bodyStageId: string, itemId: string): string {
  return path.join(runDir, "outputs", loopId, `round-${round}`, safeFileName(bodyStageId), `${safeFileName(itemId)}.json`);
}

function loopFanoutLaneOutputPath(runDir: string, loopId: string, round: number, bodyStageId: string, itemId: string, laneId: string): string {
  return path.join(runDir, "outputs", loopId, `round-${round}`, safeFileName(bodyStageId), safeFileName(itemId), `${safeFileName(laneId)}.json`);
}

function blockedOutput(code: string, summary: string): Record<string, unknown> {
  return { status: "blocked", summary, blockedReason: code, errorCode: code };
}

async function executeAgentWorkWithRetry(input: {
  cwd: string;
  runDir: string;
  runId: string;
  workflowInput: Record<string, unknown>;
  outputs: Record<string, unknown>;
  plan: ExecutionPlan;
  unit: AgentWorkUnit;
  runtime: OrchestratorAgentRuntime;
  prompt: string;
  outputSchema?: CompiledSchema;
  implicitOutputFields?: string[];
  attemptOrdinal?: number;
}): Promise<AgentWorkResult> {
  const attempts: AttemptIndexEntry[] = [];
  let ordinal = input.attemptOrdinal ?? (input.unit.retryOrdinal ? input.unit.retryOrdinal + 1 : 1);
  let prompt = input.prompt;
  let retryReason = input.unit.retryReason;
  let retryOf = input.unit.retryOf;
  let retryOrdinal = input.unit.retryOrdinal;
  let promptPolicy: AgentTaskRetryPromptPolicy = retryReason === "continuation" ? "continuation" : "original";
  let lastFailureCode: string | undefined;

  while (true) {
    const execution = await executeRuntimeTurn({
      ...input,
      ordinal,
      prompt,
      retryReason,
      retryOf,
      retryOrdinal,
      promptPolicy,
      lastFailureCode
    });

    if (!execution.ok) {
      attempts.push(execution.attempt);
      const failure = execution.failure;
      if (canRetryAgentTask(input.unit, attempts) && failure.retryable !== false) {
        const next = nextRetry(input, attempts, ordinal, execution.attemptId, "runtime", failure.code, "original");
        await appendRetryScheduledEvent(input, execution.attemptId, next, failure.message);
        await waitForAgentTaskRetryDelay();
        ordinal = next.ordinal;
        retryReason = next.retryReason;
        retryOf = next.retryOf;
        retryOrdinal = next.retryOrdinal;
        promptPolicy = next.promptPolicy;
        lastFailureCode = next.lastFailureCode;
        prompt = input.prompt;
        continue;
      }
      return blockForRetryExhaustion(input, attempts, execution.attemptDir, execution.attemptId, failure.message, failure.code);
    }

    const { turn, attemptBase, attemptDir: dir, attemptId: id } = execution;

    if (turn.status !== "completed") {
      const code = turn.status === "cancelled" ? RuntimeErrorCodes.AGENT_TURN_CANCELLED : RuntimeErrorCodes.AGENT_TURN_FAILED;
      const attempt = {
        ...attemptBase,
        status: "blocked" as const,
        endedAt: new Date().toISOString(),
        blockedReason: code,
        rawPreview: previewText(turn.rawText),
        stopReason: turn.stopReason,
        runtimeErrorCode: turn.errorDetailCode ?? turn.errorCode ?? code
      };
      attempts.push(attempt);
      const output = {
        status: "blocked",
        summary: turn.error ?? `Agent turn ${turn.status}.`,
        blockedReason: code,
        errorCode: code,
        runtimeDiagnostics: runtimeDiagnostics(input, id, turn)
      };
      await writeAttemptFile(dir, "output.json", output);
      await writeUnitOutput(input, output, "blocked", id);
      return agentWorkBlocked(input, output, attempts, code, attempts.length);
    }

    const parsed = parseWorkflowOutput(turn.rawText, {
      outputSchema: input.outputSchema,
      implicitFields: implicitOutputFieldSchemas(input.implicitOutputFields)
    });
    await writeAttemptFile(dir, "parse.json", parsed.diagnostics);
    if (parsed.ok) {
      const output = withOutputParseMetadata(parsed.value, parsed.outputParse);
      await writeAttemptFile(dir, "output.json", output);
      await writeUnitOutput(input, output, "completed", id);
      attempts.push({ ...attemptBase, status: "completed", endedAt: new Date().toISOString(), parseErrorCode: parsed.diagnostics.errorCode, rawPreview: previewText(turn.rawText) });
      return {
        stageId: input.unit.stageId,
        itemId: input.unit.itemId,
        laneId: input.unit.laneId,
        status: "completed",
        output,
        outputPath: input.unit.outputPath,
        attempts,
        agentCalls: attempts.length,
        retryCalls: retryAttemptCount(attempts),
        blockedReason: undefined
      };
    }

    attempts.push({ ...attemptBase, status: "blocked", endedAt: new Date().toISOString(), blockedReason: parsed.errorCode, parseErrorCode: parsed.errorCode, rawPreview: previewText(turn.rawText) });
    await writeAttemptFile(dir, "output.json", {
      status: "blocked",
      summary: parsed.summary,
      blockedReason: parsed.errorCode,
      parseDiagnostics: parsed.diagnostics
    });
    if (retryableOutputFailure(parsed.errorCode) && canRetryAgentTask(input.unit, attempts)) {
      const next = nextRetry(input, attempts, ordinal, id, "continuation", parsed.errorCode, "continuation");
      await appendRetryScheduledEvent(input, id, next, parsed.summary);
      await waitForAgentTaskRetryDelay();
      ordinal = next.ordinal;
      retryReason = next.retryReason;
      retryOf = next.retryOf;
      retryOrdinal = next.retryOrdinal;
      promptPolicy = next.promptPolicy;
      lastFailureCode = next.lastFailureCode;
      prompt = formatContinuationPrompt({
        failure: parsed,
        outputSchema: input.outputSchema,
        implicitOutputFields: input.implicitOutputFields
      });
      continue;
    }
    return blockForRetryExhaustion(input, attempts, dir, id, parsed.summary, parsed.errorCode);
  }
}

function resolveVariable(variable: Variable, workflowInput: Record<string, unknown>, outputs: Record<string, unknown>, local: Record<string, unknown>, run: Record<string, unknown>): unknown {
  const value = resolveSource(variable.source, workflowInput, outputs, local, run);
  const transforms = variable.transform ?? [];
  if ((value === undefined || value === null) && !transforms.some((transform) => transform.fn === "default")) {
    throw new VariableResolutionError(variable);
  }
  return applyTransforms(value, transforms);
}

function withOutputParseMetadata(output: Record<string, unknown>, outputParse: Record<string, unknown>): Record<string, unknown> {
  const metadata = output.metadata && typeof output.metadata === "object" ? output.metadata as Record<string, unknown> : {};
  return {
    ...output,
    metadata: {
      ...metadata,
      outputParse
    }
  };
}

function implicitOutputFieldSchemas(fields: string[] | undefined): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields ?? []) {
    if (field === "verdict") {
      shape.verdict = z.enum(["pass", "pass_with_warnings", "blocked", "failed", "unknown"]);
      continue;
    }
    if (field.startsWith("route:")) {
      const routes = field.slice("route:".length).split("|").filter(Boolean);
      shape.route = routes.length > 0 ? z.enum(routes as [string, ...string[]]) : z.string();
    }
  }
  return shape;
}

async function executeRuntimeTurn(input: {
  cwd: string;
  runDir: string;
  runId: string;
  unit: AgentWorkUnit;
  runtime: OrchestratorAgentRuntime;
  ordinal: number;
  prompt: string;
  retryReason?: AgentTaskRetryReason;
  retryOf?: string;
  retryOrdinal?: number;
  promptPolicy: AgentTaskRetryPromptPolicy;
  lastFailureCode?: string;
}): Promise<RuntimeTurnExecution | RuntimeTurnFailureExecution> {
  const promptAuditId = input.unit.itemId && input.unit.laneId
    ? `${input.unit.stageId}__${input.unit.itemId}__${input.unit.laneId}__attempt-${input.ordinal}`
    : input.unit.itemId ? `${input.unit.stageId}__${input.unit.itemId}__attempt-${input.ordinal}` : `${input.unit.stageId}__attempt-${input.ordinal}`;
  await writePromptAudit(input.runDir, promptAuditId, input.prompt);
  const id = attemptId({ stageId: input.unit.stageId, itemId: input.unit.itemId, laneId: input.unit.laneId, ordinal: input.ordinal });
  const dir = attemptDir(input.runDir, { stageId: input.unit.stageId, itemId: input.unit.itemId, laneId: input.unit.laneId, ordinal: input.ordinal });
  await writeAttemptFile(dir, "prompt.md", input.prompt);
  const startedAt = new Date().toISOString();
  const attemptBase: AttemptIndexEntry = {
    id,
    stageId: input.unit.stageId,
    itemId: input.unit.itemId,
    laneId: input.unit.laneId,
    kind: "attempt",
    status: "running",
    path: path.relative(input.runDir, dir),
    startedAt,
    promptPreview: previewText(input.prompt),
    sessionKey: input.unit.sessionKey,
    requestId: id,
    agent: input.unit.actor.agent,
    actorMode: input.unit.actor.mode,
    runtimeDisposeInvoked: false,
    isRetry: input.retryReason !== undefined,
    retryReason: input.retryReason,
    retryOf: input.retryOf,
    retryOrdinal: input.retryOrdinal,
    retryBudgetUsed: input.retryOrdinal ?? 0,
    retryBudgetLimit: AGENT_TASK_RETRY_BUDGET,
    promptPolicy: input.promptPolicy,
    lastFailureCode: input.lastFailureCode
  };
  await persistRunningStageAttempt(input, attemptBase);
  await appendEvent(input.cwd, input.runId, {
    type: input.retryReason ? "agent_task_retry_started" : "attempt_started",
    stageId: input.unit.stageId,
    itemId: input.unit.itemId,
    attemptId: id,
    retryReason: input.retryReason,
    retryOf: input.retryOf,
    retryOrdinal: input.retryOrdinal,
    promptPolicy: input.promptPolicy,
    lastFailureCode: input.lastFailureCode
  });
  await appendEvent(input.cwd, input.runId, {
    type: "turn_started",
    stageId: input.unit.stageId,
    itemId: input.unit.itemId,
    attemptId: id,
    sessionKey: input.unit.sessionKey,
    agent: input.unit.actor.agent,
    actorMode: input.unit.actor.mode,
    retryReason: input.retryReason,
    promptPolicy: input.promptPolicy
  });

  let turn: AgentTurnResult;
  try {
    turn = await input.runtime.runTurn({
      sessionKey: input.unit.sessionKey,
      actorLabel: input.unit.actorLabel,
      actor: input.unit.actor,
      cwd: input.unit.cwd,
      prompt: input.prompt,
      requestId: id,
      timeoutMs: input.unit.timeoutMs
    }, async (event) => appendTurnEvent(input.cwd, input.runId, input.unit.stageId, input.unit.itemId, id, event));
    await appendEvent(input.cwd, input.runId, {
      type: "turn_finished",
      stageId: input.unit.stageId,
      itemId: input.unit.itemId,
      attemptId: id,
      status: turn.status,
      stopReason: turn.stopReason,
      errorCode: turn.errorDetailCode ?? turn.errorCode,
      retryReason: input.retryReason,
      promptPolicy: input.promptPolicy
    });
    await recordSessionBinding(input.runDir, {
      sessionKey: input.unit.sessionKey,
      actorLabel: input.unit.actorLabel,
      agent: input.unit.actor.agent,
      cwd: input.unit.cwd,
      handle: turn.handle
    });
    await writeAttemptFile(dir, "raw.txt", turn.rawText);
  } catch (error) {
    const failure = runtimeFailureFromError(error, id);
    await appendEvent(input.cwd, input.runId, { type: "turn_finished", stageId: input.unit.stageId, itemId: input.unit.itemId, attemptId: id, status: "failed", error: failure.message, errorCode: failure.code, retryReason: input.retryReason });
    return { ok: false, attempt: finalizeRuntimeFailedAttempt(attemptBase, failure), failure, attemptDir: dir, attemptId: id };
  }

  const retryFailure = retryableRuntimeTurnFailure(turn, id);
  if (retryFailure) {
    return { ok: false, attempt: finalizeRuntimeFailedAttempt(attemptBase, retryFailure), failure: retryFailure, attemptDir: dir, attemptId: id };
  }

  return { ok: true, turn, attempts: [], attemptBase, attemptId: id, attemptDir: dir, agentCalls: 1 };
}

async function persistRunningStageAttempt(input: {
  cwd: string;
  runId: string;
  unit: AgentWorkUnit;
}, attempt: AttemptIndexEntry): Promise<void> {
  if (input.unit.type !== "stage" && input.unit.type !== "fanoutItem") return;
  if (input.unit.type === "fanoutItem" && input.unit.itemId?.startsWith("round-")) return;
  await updateRunIndex(input.cwd, input.runId, (index) => {
    if (input.unit.type === "stage") return upsertAttemptIndex(index, attempt);
    if (!input.unit.itemId || !input.unit.laneId) return index;
    const stage = index.stages[input.unit.stageId];
    if (!stage?.fanout) return index;
    let next = upsertAttemptIndex(index, attempt);
    const items = stage.fanout.items.map((item) => {
      if (item.id !== input.unit.itemId) return item;
      const lanes = item.lanes.map((lane) => lane.id === input.unit.laneId ? {
        ...lane,
        status: "running" as StageStatus,
        attemptId: attempt.id,
        startedAt: lane.startedAt ?? attempt.startedAt,
        retryOf: attempt.retryOf ?? lane.retryOf,
        retryOrdinal: attempt.retryOrdinal ?? lane.retryOrdinal,
        retryReason: attempt.retryReason ?? lane.retryReason
      } : lane);
      return {
        ...item,
        status: fanoutItemStatus({ ...item, lanes }),
        lanes,
        retryOf: attempt.retryOf ?? item.retryOf,
        retryOrdinal: attempt.retryOrdinal ?? item.retryOrdinal,
        retryReason: attempt.retryReason ?? item.retryReason
      };
    });
    next = {
      ...next,
      stages: {
        ...next.stages,
        [input.unit.stageId]: {
          ...stage,
          status: "running",
          fanout: {
            ...stage.fanout,
            items
          }
        }
      }
    };
    return next;
  });
}

function retryableRuntimeTurnFailure(turn: AgentTurnResult, requestId: string): RuntimeFailureSummary | undefined {
  if (turn.status !== "failed") return undefined;
  if (turn.retryable === false) return undefined;
  const code = turn.errorDetailCode ?? turn.errorCode ?? RuntimeErrorCodes.AGENT_TURN_FAILED;
  const message = turn.error ?? `Agent turn ${turn.status}.`;
  if (turn.retryable === true || looksTransientRuntimeFailure([code, message])) {
    return {
      code,
      message,
      requestId,
      retryable: turn.retryable,
      rawText: turn.rawText,
      stopReason: turn.stopReason
    };
  }
  return undefined;
}

function looksTransientRuntimeFailure(parts: string[]): boolean {
  const text = parts.filter(Boolean).join(" ").toLowerCase();
  if (!text) return false;
  if (/(permission|denied|unauthorized|forbidden|invalid runtime option|invalid config|auth|credential|schema|parse)/.test(text)) return false;
  return /(429|rate.?limit|too many requests|queue|rejected|transport|reset|econnreset|socket|network|timeout|timed out|temporary|temporar|unavailable|backend unavailable|session init|spawn|process|connection|stream|aborted)/.test(text);
}

function runtimeFailureFromError(error: unknown, requestId: string): RuntimeFailureSummary {
  const code = stringField(error, "detailCode") ?? stringField(error, "code") ?? RuntimeErrorCodes.AGENT_RUNTIME_ERROR;
  return {
    code,
    message: errorMessage(error),
    requestId,
    retryable: true
  };
}

function finalizeRuntimeFailedAttempt(attempt: AttemptIndexEntry, failure: RuntimeFailureSummary): AttemptIndexEntry {
  return {
    ...attempt,
    status: "failed",
    endedAt: new Date().toISOString(),
    blockedReason: failure.code,
    runtimeErrorCode: failure.code,
    retryMessage: failure.message,
    lastFailureCode: failure.code,
    rawPreview: previewText(failure.rawText ?? ""),
    stopReason: failure.stopReason
  };
}

function canRetryAgentTask(unit: AgentWorkUnit, attempts: AttemptIndexEntry[]): boolean {
  return retryBudgetUsed(unit, attempts) < AGENT_TASK_RETRY_BUDGET;
}

async function waitForAgentTaskRetryDelay(): Promise<void> {
  const delayMs = agentTaskRetryDelayMs();
  if (delayMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function retryAttemptCount(attempts: AttemptIndexEntry[]): number {
  return attempts.filter((attempt) => attempt.isRetry).length;
}

function retryBudgetUsed(unit: AgentWorkUnit, attempts: AttemptIndexEntry[]): number {
  return Math.max(
    unit.retryOrdinal ?? 0,
    ...attempts.map((attempt) => attempt.retryOrdinal ?? 0),
    retryAttemptCount(attempts)
  );
}

function nextRetry(input: {
  unit: AgentWorkUnit;
}, attempts: AttemptIndexEntry[], currentOrdinal: number, retryOf: string, retryReason: AgentTaskRetryReason, lastFailureCode: string, promptPolicy: AgentTaskRetryPromptPolicy): {
  ordinal: number;
  retryReason: AgentTaskRetryReason;
  retryOf: string;
  retryOrdinal: number;
  promptPolicy: AgentTaskRetryPromptPolicy;
  lastFailureCode: string;
} {
  return {
    ordinal: currentOrdinal + 1,
    retryReason,
    retryOf,
    retryOrdinal: retryBudgetUsed(input.unit, attempts) + 1,
    promptPolicy,
    lastFailureCode
  };
}

async function appendRetryScheduledEvent(input: {
  cwd: string;
  runId: string;
  unit: AgentWorkUnit;
}, attemptIdValue: string, next: {
  ordinal: number;
  retryReason: AgentTaskRetryReason;
  retryOf: string;
  retryOrdinal: number;
  promptPolicy: AgentTaskRetryPromptPolicy;
  lastFailureCode: string;
}, message: string): Promise<void> {
  const retryAttemptId = attemptId({
    stageId: input.unit.stageId,
    itemId: input.unit.itemId,
    laneId: input.unit.laneId,
    ordinal: next.ordinal
  });
  await appendEvent(input.cwd, input.runId, {
    type: "agent_task_retry_scheduled",
    stageId: input.unit.stageId,
    itemId: input.unit.itemId,
    attemptId: attemptIdValue,
    retryAttemptId,
    retryReason: next.retryReason,
    retryOf: next.retryOf,
    retryOrdinal: next.retryOrdinal,
    promptPolicy: next.promptPolicy,
    lastFailureCode: next.lastFailureCode,
    errorMessage: message
  });
}

async function blockForRetryExhaustion(input: {
  cwd: string;
  runDir: string;
  runId: string;
  unit: AgentWorkUnit;
}, attempts: AttemptIndexEntry[], dir: string, attemptIdValue: string, summary: string, lastFailureCode: string): Promise<AgentWorkResult> {
  const output = retryExhaustedEnvelope({
    summary,
    lastFailureCode,
    retryHistory: retryHistory(attempts)
  });
  await writeAttemptFile(dir, "output.json", output);
  await writeUnitOutput(input, output, "blocked", attemptIdValue);
  await appendEvent(input.cwd, input.runId, {
    type: "agent_task_retry_exhausted",
    stageId: input.unit.stageId,
    itemId: input.unit.itemId,
    attemptId: attemptIdValue,
    errorCode: lastFailureCode,
    blockedReason: RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED
  });
  return agentWorkBlocked(input, output, attempts, RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED, attempts.length);
}

function agentWorkBlocked(input: {
  unit: AgentWorkUnit;
}, output: Record<string, unknown>, attempts: AttemptIndexEntry[], blockedReason: string, agentCalls: number): AgentWorkResult {
  return {
    stageId: input.unit.stageId,
    itemId: input.unit.itemId,
    laneId: input.unit.laneId,
    status: "blocked",
    output,
    outputPath: input.unit.outputPath,
    attempts,
    agentCalls,
    retryCalls: retryAttemptCount(attempts),
    blockedReason,
    errorCode: typeof output.errorCode === "string" ? output.errorCode : blockedReason
  };
}

function retryHistory(attempts: AttemptIndexEntry[]): unknown[] {
  return attempts.map((attempt) => ({
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

async function writeUnitOutput(input: {
  cwd: string;
  runDir: string;
  runId: string;
  unit: AgentWorkUnit;
}, output: Record<string, unknown>, status: StageStatus, attemptId?: string): Promise<void> {
  await fs.mkdir(path.dirname(input.unit.outputPath), { recursive: true });
  await fs.writeFile(input.unit.outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  await appendEvent(input.cwd, input.runId, {
    type: "output_written",
    stageId: input.unit.stageId,
    itemId: input.unit.itemId,
    attemptId,
    outputPath: path.relative(input.runDir, input.unit.outputPath),
    status
  });
}

function runtimeDiagnostics(input: {
  unit: AgentWorkUnit;
}, requestId: string, turn: AgentTurnResult): Record<string, unknown> {
  return {
    stopReason: turn.stopReason,
    requestId,
    sessionKey: input.unit.sessionKey,
    agent: input.unit.actor.agent,
    actorMode: input.unit.actor.mode,
    runtimeDisposeInvoked: false,
    errorCode: turn.errorDetailCode ?? turn.errorCode,
    retryable: turn.retryable,
    rawTextPreview: previewText(turn.rawText)
  };
}

async function appendTurnEvent(cwd: string, runId: string, stageId: string, itemId: string | undefined, attemptId: string, event: AcpRuntimeEvent): Promise<void> {
  await appendEvent(cwd, runId, {
    type: "agent_event",
    stageId,
    itemId,
    attemptId,
    event
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringField(value: unknown, key: string): string | undefined {
  return value && typeof value === "object" && typeof (value as Record<string, unknown>)[key] === "string"
    ? (value as Record<string, string>)[key]
    : undefined;
}

async function writePromptAudit(runDir: string, id: string, prompt: string): Promise<void> {
  const filePath = path.join(runDir, "prompts", `${safeFileName(id)}.md`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, prompt, "utf8");
}

async function runCommandProgramStage(input: {
  cwd: string;
  stage: Extract<Stage, { kind: "task"; mode: "program" }>;
  workflowInput: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  let cwd = input.cwd;
  try {
    cwd = await resolveProgramCwd(input.cwd, input.stage.cwd);
    validateProgramCommandSafety(input.stage);
    const timeoutMs = input.stage.timeoutSeconds * 1000;
    const result = await execFileAsync(input.stage.command, input.stage.args, {
      cwd,
      timeout: timeoutMs,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      shell: false
    });
    return commandOutput("completed", input.stage, result.stdout, result.stderr, 0);
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; exitCode?: number; code?: string; killed?: boolean; signal?: string };
    if (typeof err.exitCode === "number") {
      return commandOutput("completed", input.stage, String(err.stdout ?? ""), String(err.stderr ?? ""), err.exitCode, err.signal);
    }
    const code = err.code === RuntimeErrorCodes.PROGRAM_COMMAND_CWD_INVALID
      ? RuntimeErrorCodes.PROGRAM_COMMAND_CWD_INVALID
      : err.code === RuntimeErrorCodes.PROGRAM_COMMAND_SAFETY_VIOLATION
        ? RuntimeErrorCodes.PROGRAM_COMMAND_SAFETY_VIOLATION
      : err.killed || err.code === "ETIMEDOUT" ? RuntimeErrorCodes.PROGRAM_COMMAND_TIMEOUT : RuntimeErrorCodes.PROGRAM_COMMAND_SPAWN_FAILED;
    return {
      status: "blocked",
      data: {
        operation: "command",
        command: input.stage.command,
        args: input.stage.args,
        cwd,
        error: err.message
      },
      blockedReason: code,
      errorCode: code
    };
  } finally {
    void input.workflowInput;
  }
}

const MUTATING_PROGRAM_COMMANDS = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "mkdir",
  "touch",
  "tee",
  "install",
  "patch"
]);

function validateProgramCommandSafety(stage: Extract<Stage, { kind: "task"; mode: "program" }>): void {
  if (stage.allowMutation) return;
  const command = path.basename(stage.command);
  if (!MUTATING_PROGRAM_COMMANDS.has(command)) return;
  throw Object.assign(new Error(`Program command ${stage.command} requires allowMutation: true.`), {
    code: RuntimeErrorCodes.PROGRAM_COMMAND_SAFETY_VIOLATION
  });
}

function programGate(stage: Extract<Stage, { kind: "gate" }>, outputs: Record<string, unknown>, workflowInput: Record<string, unknown>): Record<string, unknown> {
  const dependencies = stage.dependsOn ?? [];
  const upstreamOutputs = dependencies
    .map((id) => [id, outputs[id]] as const)
    .filter(([, output]) => output !== undefined);
  const data = gateData(upstreamOutputs);
  const singleUpstream = upstreamOutputs.length === 1 ? objectRecord(upstreamOutputs[0][1]) : undefined;
  const passed = stage.condition
    ? evaluateCondition(stage.condition, outputs, workflowInput)
    : upstreamOutputs.length > 0;
  const output: Record<string, unknown> = {
    status: passed ? "completed" : "blocked",
    summary: passed && typeof singleUpstream?.summary === "string" ? singleUpstream.summary : (passed ? "Gate condition passed." : "Gate condition failed."),
    verdict: passed ? "pass" : "failed",
    blockedReason: passed ? undefined : RuntimeErrorCodes.GATE_CONDITION_FAILED
  };
  if (data !== undefined) output.data = data;
  return output;
}

function gateData(upstreamOutputs: Array<readonly [string, unknown]>): unknown {
  if (upstreamOutputs.length === 0) return undefined;
  if (upstreamOutputs.length === 1) return upstreamOutputs[0][1];
  return Object.fromEntries(upstreamOutputs);
}

function evaluateRoute(stage: Extract<Stage, { kind: "route" }>, outputs: Record<string, unknown>, workflowInput: Record<string, unknown>): string | undefined {
  for (const rule of stage.rules) {
    if (evaluateCondition(rule.when, outputs, workflowInput)) return rule.to;
  }
  return undefined;
}

export function evaluateCondition(condition: ConditionNode, outputs: Record<string, unknown>, workflowInput: Record<string, unknown>, local: Record<string, unknown> = {}): boolean {
  if ("all" in condition) return Array.isArray(condition.all) && condition.all.every((item) => evaluateCondition(item, outputs, workflowInput, local));
  if ("any" in condition) return Array.isArray(condition.any) && condition.any.some((item) => evaluateCondition(item, outputs, workflowInput, local));
  if ("not" in condition) return condition.not ? !evaluateCondition(condition.not, outputs, workflowInput, local) : false;
  const value = condition.source ? resolveSource(condition.source, workflowInput, outputs, local) : undefined;
  switch (condition.op) {
    case "eq": return value === condition.value;
    case "neq": return value !== condition.value;
    case "gt": return Number(value) > Number(condition.value);
    case "gte": return Number(value) >= Number(condition.value);
    case "lt": return Number(value) < Number(condition.value);
    case "lte": return Number(value) <= Number(condition.value);
    case "in": return Array.isArray(condition.value) && condition.value.includes(value);
    case "exists": return value !== undefined && value !== null;
    case "empty": return value == null || value === "" || (Array.isArray(value) && value.length === 0);
    default: return false;
  }
}

export function evaluateFanoutLaneCondition(condition: ConditionNode, outputs: Record<string, unknown>, workflowInput: Record<string, unknown>, local: Record<string, unknown> = {}): boolean {
  if ("all" in condition) return Array.isArray(condition.all) && condition.all.every((item) => evaluateFanoutLaneCondition(item, outputs, workflowInput, local));
  if ("any" in condition) return Array.isArray(condition.any) && condition.any.some((item) => evaluateFanoutLaneCondition(item, outputs, workflowInput, local));
  if ("not" in condition) return condition.not ? !evaluateFanoutLaneCondition(condition.not, outputs, workflowInput, local) : false;
  if (!condition.source) return false;
  const value = resolveSource(condition.source, workflowInput, outputs, local);
  if (value === undefined) return false;
  return evaluateCondition(condition, outputs, workflowInput, local);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

async function resolveProgramCwd(projectCwd: string, requestedCwd: string | undefined): Promise<string> {
  const resolved = path.resolve(projectCwd, requestedCwd ?? ".");
  const [projectReal, targetReal] = await Promise.all([
    fs.realpath(projectCwd),
    fs.realpath(resolved).catch(() => resolved)
  ]);
  const relative = path.relative(projectReal, targetReal);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw Object.assign(new Error(`Program command cwd ${requestedCwd ?? "."} is outside the project.`), {
      code: RuntimeErrorCodes.PROGRAM_COMMAND_CWD_INVALID
    });
  }
  return targetReal;
}

function commandOutput(status: "completed" | "blocked", stage: Extract<Stage, { kind: "task"; mode: "program" }>, stdout: string, stderr: string, exitCode: number, signal?: string): Record<string, unknown> {
  const parsed = parseProgramJson(stdout);
  if (parsed) {
    return {
      status: parsed.status,
      data: {
        value: parsed.data,
        command: {
          operation: "command",
          command: stage.command,
          args: stage.args,
          exitCode,
          signal,
          stdout: truncate(stdout),
          stderr: truncate(stderr)
        }
      }
    };
  }
  return {
    status,
    data: {
      operation: "command",
      command: stage.command,
      args: stage.args,
      exitCode,
      signal,
      stdout: truncate(stdout),
      stderr: truncate(stderr)
    }
  };
}

function parseProgramJson(stdout: string): { status: "completed" | "blocked"; data: unknown } | undefined {
  try {
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    if ((parsed.status === "completed" || parsed.status === "blocked") && "data" in parsed) {
      return { status: parsed.status, data: parsed.data };
    }
  } catch {
    // stdout is ordinary command data.
  }
  return undefined;
}

function truncate(value: string): string {
  const limit = 64 * 1024;
  return value.length > limit ? `${value.slice(0, limit)}\n[truncated]` : value;
}

function hashShort(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}
