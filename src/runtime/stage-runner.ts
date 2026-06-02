import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { AcpRuntimeEvent } from "acpx/runtime";
import { getOutputContract, type OutputContractName } from "../contracts/output-contracts.js";
import type { ContractPlan, ExecutionPlan, ExecutionPlanStage, PromptPlan } from "../compiler/execution-plan.js";
import type { Role, Stage, WorkflowSpec, ConditionNode, Variable } from "../schema/workflow-spec.js";
import { applyTransforms } from "../transformers/builtins.js";
import { renderPrompt } from "../variables/interpolate.js";
import { appendEvent, RuntimeErrorCodes, type AttemptIndexEntry, type StageIndexEntry, type StageStatus } from "../run-index/read-write.js";
import { attemptDir, attemptId, previewText, safeFileName, writeAttemptFile } from "./attempts.js";
import type { AgentTurnResult, OrchestratorAgentRuntime } from "./agent-runtime.js";
import { formatRepairPrompt, isRepairableOutputFailure, repairFailedEnvelope } from "./repair.js";
import { parseWorkflowOutput } from "./output-parser.js";
import { recordSessionBinding } from "./session-bindings.js";
import {
  buildFanoutItemOutput,
  buildFanoutStageOutput,
  cascadeBlockFanoutItems,
  deriveFanoutSummary,
  expandFanoutItems,
  fanoutGroupStatus,
  fanoutItemStatus,
  type FanoutCoreItem,
  type FanoutCoreLaneResult,
  type FanoutCoreWorkUnit
} from "./fanout-core.js";

const execFileAsync = promisify(execFile);
const MAX_RUNTIME_RETRIES = 1;

export type AgentWorkUnit = {
  type: "stage" | "fanoutItem" | "loop" | "diagnostic";
  stageId: string;
  itemId?: string;
  itemIndex?: number;
  item?: unknown;
  groupId?: string;
  laneId?: string;
  roleName: string;
  role: Role;
  sessionKey: string;
  promptId: string;
  contract: ContractPlan;
  outputPath: string;
  cwd: string;
  timeoutMs: number;
  local?: Record<string, unknown>;
  runtimeRetryOf?: string;
  runtimeRetryOrdinal?: number;
};

export type AgentWorkResult = {
  stageId: string;
  itemId?: string;
  groupId?: string;
  laneId?: string;
  status: "completed" | "blocked" | "failed";
  output?: Record<string, unknown>;
  outputPath?: string;
  attempts: AttemptIndexEntry[];
  agentCalls: number;
  repairCalls: number;
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
} | ({ ok: false } & AgentWorkResult);

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
  if (stage.kind === "discover" && stage.method !== "agent") {
    const items = stage.method === "glob"
      ? await discoverGlob(input.workflowInput, stage.args ?? {})
      : await discoverGitChangedFiles(input.workflowInput, { ...(stage.args ?? {}), outputKey: stage.output });
    return {
      status: "completed",
      summary: `Program ${stage.method} discovery found ${items.length} item(s).`,
      artifacts: [],
      nextFocus: "fanout",
      [stage.output]: items
    };
  }
  if (stage.kind === "reduce" && stage.mode === "program") {
    return programReduce(stage, input.outputs);
  }
  if (stage.kind === "decisionGate" && stage.mode === "program") {
    const route = evaluateDecision(stage, input.outputs, input.workflowInput);
    return {
      status: route === "blocked" ? "blocked" : "completed",
      summary: `Decision route: ${route}`,
      artifacts: [],
      nextFocus: route,
      route,
      blockedReason: route === "blocked" ? "BLOCKED_ROUTE" : undefined
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
  groupId?: string;
  laneId?: string;
}): Promise<{ prompt: string } | { result: AgentWorkResult }> {
  try {
    return { prompt: renderPlannedPrompt(input) };
  } catch (error) {
    if (!(error instanceof VariableResolutionError)) throw error;
    const output = {
      status: "blocked",
      summary: error.message,
      artifacts: [],
      nextFocus: "diagnose",
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
      groupId: input.groupId,
      laneId: input.laneId,
      errorCode: RuntimeErrorCodes.VARIABLE_RESOLUTION_FAILED,
      variableName: error.variableName,
      source: error.source
    });
    return {
      result: {
        stageId: input.stageId,
        itemId: input.itemId,
        groupId: input.groupId,
        laneId: input.laneId,
        status: "blocked",
        output,
        outputPath: input.outputPath,
        attempts: [],
        agentCalls: 0,
        repairCalls: 0,
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
  else if (root === "loop") current = local.loop;
  else if (root === "run") current = run;
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
    groupId: input.unit.groupId,
    laneId: input.unit.laneId
  });
  if ("result" in rendered) return rendered.result;
  return executeAttemptWithRepair({
    ...input,
    prompt: rendered.prompt,
    contractName: input.unit.contract.name,
    contractOptions: input.unit.contract.options
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
  let repairCalls = 0;
  const rounds: Array<Record<string, unknown>> = [];
  let previous: Record<string, unknown> | undefined;

  for (let round = 1; round <= stage.loop.maxRounds; round += 1) {
    const roundResult = await runLoopRound({ ...input, planStage: stage, round, previous });
    attempts.push(...roundResult.attempts);
    agentCalls += roundResult.agentCalls;
    repairCalls += roundResult.repairCalls;
    rounds.push(roundResult.roundRecord);
    if (roundResult.status !== "completed") {
      const blocked = loopOutput(stage.id, stage.loop.body.output, round, rounds, roundResult.outputs, roundResult.bodyOutput, "blocked", roundResult.blockedReason ?? RuntimeErrorCodes.LOOP_BODY_STAGE_BLOCKED);
      await fs.mkdir(path.dirname(input.unit.outputPath), { recursive: true });
      await fs.writeFile(input.unit.outputPath, `${JSON.stringify(blocked, null, 2)}\n`, "utf8");
      return { stageId: input.unit.stageId, status: "blocked", output: blocked, outputPath: input.unit.outputPath, attempts, agentCalls, repairCalls, blockedReason: String(blocked.blockedReason) };
    }
    const current = { output: roundResult.bodyOutput, outputs: roundResult.outputs };
    const shouldContinue = evaluateCondition(stage.loop.continueWhen, input.outputs, input.workflowInput, { loop: { round, current, previous } });
    previous = current;
    if (!shouldContinue) {
      const output = loopOutput(stage.id, stage.loop.body.output, round, rounds, roundResult.outputs, roundResult.bodyOutput, "completed");
      await fs.mkdir(path.dirname(input.unit.outputPath), { recursive: true });
      await fs.writeFile(input.unit.outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
      return { stageId: input.unit.stageId, status: "completed", output, outputPath: input.unit.outputPath, attempts, agentCalls, repairCalls };
    }
  }

  const lastRound = rounds.at(-1);
  const outputs = objectRecord(lastRound?.outputs) ?? {};
  const bodyOutput = objectRecord(lastRound?.bodyOutput);
  const blocked = loopOutput(stage.id, stage.loop.body.output, stage.loop.maxRounds, rounds, outputs, bodyOutput, "blocked", RuntimeErrorCodes.LOOP_EXHAUSTED);
  await fs.mkdir(path.dirname(input.unit.outputPath), { recursive: true });
  await fs.writeFile(input.unit.outputPath, `${JSON.stringify(blocked, null, 2)}\n`, "utf8");
  return { stageId: input.unit.stageId, status: "blocked", output: blocked, outputPath: input.unit.outputPath, attempts, agentCalls, repairCalls, blockedReason: RuntimeErrorCodes.LOOP_EXHAUSTED };
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
  repairCalls: number;
  blockedReason?: string;
}> {
  const loop = input.planStage.loop;
  if (!loop) throw new Error(`Missing loop plan for ${input.planStage.id}`);
  const attempts: AttemptIndexEntry[] = [];
  let agentCalls = 0;
  let repairCalls = 0;
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
      return { status: "blocked", outputs, roundRecord, attempts, agentCalls, repairCalls, blockedReason: RuntimeErrorCodes.LOOP_BODY_STAGE_FAILED };
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
      repairCalls += fanout.repairCalls;
      stageStates[bodyStage.id] = {
        stageId: bodyStage.id,
        status: output.status === "blocked" ? "blocked" : "completed",
        attempts: fanout.attempts.map((attempt) => attempt.id),
        outputPath: path.relative(input.runDir, bodyOutputPath),
        blockedReason: typeof output.blockedReason === "string" ? output.blockedReason : undefined,
        completedAt: new Date().toISOString(),
        fanout: fanout.fanout
      };
    } else {
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
          blockedReason: typeof output.blockedReason === "string" ? output.blockedReason : undefined,
          completedAt: new Date().toISOString()
        };
      } else {
        const agent = await runLoopBodyAgentStage({ ...input, bodyStage, bodyStagePlan, outputs: visibleOutputs, previous: input.previous, outputPath: bodyOutputPath });
        output = agent.output;
        attempts.push(...agent.attempts);
        agentCalls += agent.agentCalls;
        repairCalls += agent.repairCalls;
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
    if (output?.status === "blocked") {
      const roundRecord = buildRoundRecord(input.round, "blocked", startedAt, outputs, loop.body.output, stageStates, RuntimeErrorCodes.LOOP_BODY_STAGE_BLOCKED);
      return { status: "blocked", outputs, bodyOutput: objectRecord(outputs[loop.body.output]), roundRecord, attempts, agentCalls, repairCalls, blockedReason: RuntimeErrorCodes.LOOP_BODY_STAGE_BLOCKED };
    }
  }

  const bodyOutput = objectRecord(outputs[loop.body.output]);
  if (!bodyOutput) {
    const roundRecord = buildRoundRecord(input.round, "blocked", startedAt, outputs, loop.body.output, stageStates, RuntimeErrorCodes.LOOP_BODY_OUTPUT_MISSING);
    return { status: "blocked", outputs, roundRecord, attempts, agentCalls, repairCalls, blockedReason: RuntimeErrorCodes.LOOP_BODY_OUTPUT_MISSING };
  }
  const roundRecord = buildRoundRecord(input.round, "completed", startedAt, outputs, loop.body.output, stageStates);
  return { status: "completed", outputs, bodyOutput, roundRecord, attempts, agentCalls, repairCalls };
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
  const roleName = stageRoleNameFromBody(input.bodyStage);
  if (!roleName || !input.bodyStagePlan.promptId) {
    return {
      stageId: input.unit.stageId,
      status: "blocked",
      output: blockedOutput(RuntimeErrorCodes.LOOP_BODY_STAGE_BLOCKED, `Loop body stage ${input.bodyStage.id} is not executable as an agent stage.`),
      outputPath: input.outputPath,
      attempts: [],
      agentCalls: 0,
      repairCalls: 0,
      blockedReason: RuntimeErrorCodes.LOOP_BODY_STAGE_BLOCKED
    };
  }
  const role = input.spec.roles[roleName];
  const prompt = input.plan.prompts[input.bodyStagePlan.promptId];
  if (!role || !prompt) throw new Error(`Missing loop body role or prompt for ${input.planStage.id}/${input.bodyStage.id}`);
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
  return executeAttemptWithRepair({
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
      roleName,
      role,
      sessionKey: `role:${roleName}:loop:${input.planStage.id}:round:${input.round}:stage:${input.bodyStage.id}`,
      promptId: input.bodyStagePlan.promptId,
      contract: input.bodyStagePlan.contract ?? { name: "base" },
      outputPath: input.outputPath,
      cwd: input.unit.cwd,
      timeoutMs: input.unit.timeoutMs,
      local: loopLocal
    },
    prompt: rendered.prompt,
    contractName: input.bodyStagePlan.contract?.name ?? "base",
    contractOptions: input.bodyStagePlan.contract?.options
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
}): Promise<{ output: Record<string, unknown>; attempts: AttemptIndexEntry[]; agentCalls: number; repairCalls: number; fanout: NonNullable<StageIndexEntry["fanout"]> }> {
  const plan = input.bodyStagePlan.fanout;
  if (!plan) throw new Error(`Missing loop fanout plan for ${input.bodyStage.id}`);
  const source = resolveSource(plan.itemsSource, input.workflowInput, input.outputs, loopLocalContext(input.round, input.outputs, input.previous, objectRecord(input.outputs[input.bodyStage.id])));
  const items = Array.isArray(source) ? source.slice(0, plan.maxItems) : [];
  const attempts: AttemptIndexEntry[] = [];
  let agentCalls = 0;
  let repairCalls = 0;
  const expanded = expandFanoutItems({
    plan,
    items,
    workflowInput: input.workflowInput,
    outputs: input.outputs,
    localForItem: (item) => ({ item, ...loopLocalContext(input.round, input.outputs, input.previous, objectRecord(input.outputs[input.bodyStage.id])) }),
    itemIdFor: stableItemId,
    evaluate: evaluateCondition
  });
  const fanoutItems = expanded.items;
  const laneResultsByItemIndex = new Map<number, FanoutCoreLaneResult[]>();
  const itemOutputsByIndex = new Map<number, Record<string, unknown>>(expanded.preExecutionItemOutputs);
  type LoopFanoutTask = FanoutCoreWorkUnit & {
    laneOutputPath: string;
    laneEntry: NonNullable<NonNullable<StageIndexEntry["fanout"]>["items"][number]["groups"]>[number]["lanes"][number];
  };
  const tasks: LoopFanoutTask[] = expanded.workUnits.flatMap((workUnit) => {
    const laneEntry = fanoutItems
      .find((item) => item.index === workUnit.itemIndex)
      ?.groups?.find((group) => group.id === workUnit.groupId)
      ?.lanes.find((lane) => lane.id === workUnit.laneId);
    if (!laneEntry) return [];
    return [{
      ...workUnit,
      laneOutputPath: loopFanoutLaneOutputPath(input.runDir, input.planStage.id, input.round, input.bodyStage.id, workUnit.itemId, workUnit.groupId, workUnit.laneId),
      laneEntry
    }];
  });

  let nextTask = 0;
  let fastStop = false;
  const workerCount = Math.min(Math.max(1, plan.maxConcurrency), tasks.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextTask < tasks.length) {
      if (fastStop) return;
      const task = tasks[nextTask];
      nextTask += 1;
      const result = await runLoopFanoutLaneTask(input, task);
      attempts.push(...result.attempts);
      agentCalls += result.agentCalls;
      repairCalls += result.repairCalls;
      const existing = laneResultsByItemIndex.get(task.itemIndex) ?? [];
      if (result.outputPath && result.output) {
        existing.push({
          itemId: task.itemId,
          itemIndex: task.itemIndex,
          groupId: task.groupId,
          laneId: task.laneId,
          roleName: task.roleName,
          status: result.status,
          output: result.output,
          outputPath: path.relative(input.runDir, result.outputPath),
          blockedReason: result.blockedReason,
          errorCode: result.errorCode
        });
      }
      laneResultsByItemIndex.set(task.itemIndex, existing);
      const settledItem = fanoutItems.find((item) => item.index === task.itemIndex);
      const settledGroup = settledItem?.groups?.find((group) => group.id === task.groupId);
      if (settledItem && settledGroup) {
        settledGroup.status = fanoutGroupStatus(settledGroup.lanes);
        settledItem.status = fanoutItemStatus(settledItem);
      }
      if (result.status !== "completed" && !plan.allowPartial) {
        fastStop = true;
      }
    }
  }));

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
      missingLaneOutput: (_item, group, lane) => ({
        itemId: item.id,
        itemIndex: item.index,
        groupId: group.id,
        laneId: lane.id,
        roleName: lane.roleName,
        status: "blocked",
        output: missingLoopFanoutLaneOutput(item.id, group.id, lane.id),
        outputPath: path.relative(input.runDir, loopFanoutLaneOutputPath(input.runDir, input.planStage.id, input.round, input.bodyStage.id, item.id, group.id, lane.id)),
        blockedReason: RuntimeErrorCodes.MISSING_FANOUT_ITEM_OUTPUT,
        errorCode: RuntimeErrorCodes.MISSING_FANOUT_ITEM_OUTPUT
      })
    });
    itemOutputsByIndex.set(item.index, itemOutput);
    item.status = itemOutput.status === "blocked" ? "blocked" : "completed";
    item.groups = Array.isArray(itemOutput.groups) ? itemOutput.groups as FanoutCoreItem["groups"] : item.groups;
    item.blockedReason = typeof itemOutput.blockedReason === "string" ? itemOutput.blockedReason : undefined;
    item.errorCode = typeof itemOutput.errorCode === "string" ? itemOutput.errorCode : item.blockedReason;
    item.outputPath = path.relative(input.runDir, loopFanoutItemOutputPath(input.runDir, input.planStage.id, input.round, input.bodyStage.id, item.id));
    item.completedAt = new Date().toISOString();
  }

  const itemOutputs = Array.from(itemOutputsByIndex.entries()).sort(([left], [right]) => left - right).map(([, output]) => output);
  for (const itemOutput of itemOutputs.filter((output) => output.status !== "skipped")) {
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

  const activeItemOutputs = itemOutputs.filter((item) => item.status !== "skipped");
  const skippedItems = fanoutItems.filter((item) => item.status === "skipped").map((item) => ({
    id: item.id,
    index: item.index,
    status: "skipped" as const,
    skippedReason: item.skippedReason
  }));
  const output = buildFanoutStageOutput({ plan, itemOutputs: activeItemOutputs, skippedItems });
  const outputPath = loopBodyOutputPath(input.runDir, input.planStage.id, input.round, input.bodyStage.id);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  const fanout = deriveFanoutSummary({ candidateItemCount: items.length, items: fanoutItems, allowPartial: plan.allowPartial });
  return { output, attempts, agentCalls, repairCalls, fanout };
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
    groupId: string;
    laneId: string;
    roleName: string;
    promptId: string;
    contract: ContractPlan;
    laneOutputPath: string;
    laneEntry: NonNullable<NonNullable<StageIndexEntry["fanout"]>["items"][number]["groups"]>[number]["lanes"][number];
  }
): Promise<AgentWorkResult> {
  const role = input.spec.roles[task.roleName];
  const prompt = input.plan.prompts[task.promptId];
  if (!role || !prompt) throw new Error(`Missing loop fanout lane role or prompt for ${input.bodyStage.id}/${task.groupId}/${task.laneId}`);
  const local = { item: task.item, ...loopLocalContext(input.round, input.outputs, input.previous, objectRecord(input.outputs[input.bodyStage.id])) };
  const unitBase = {
    type: "fanoutItem" as const,
    stageId: input.unit.stageId,
    itemId: `round-${input.round}__stage-${input.bodyStage.id}__item-${task.itemId}`,
    itemIndex: task.itemIndex,
    item: task.item,
    groupId: task.groupId,
    laneId: task.laneId,
    roleName: task.roleName,
    role,
    sessionKey: `role:${task.roleName}:loop:${input.planStage.id}:round:${input.round}:stage:${input.bodyStage.id}:item:${task.itemId}:group:${task.groupId}:lane:${task.laneId}`,
    promptId: task.promptId,
    contract: task.contract,
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
    groupId: task.groupId,
    laneId: task.laneId
  });
  if ("result" in rendered) {
    task.laneEntry.status = "blocked";
    task.laneEntry.outputPath = path.relative(input.runDir, task.laneOutputPath);
    task.laneEntry.blockedReason = RuntimeErrorCodes.VARIABLE_RESOLUTION_FAILED;
    task.laneEntry.completedAt = new Date().toISOString();
    task.laneEntry.errorCode = RuntimeErrorCodes.VARIABLE_RESOLUTION_FAILED;
    return rendered.result;
  }
  task.laneEntry.status = "running";
  task.laneEntry.startedAt = new Date().toISOString();
  const result = await executeAttemptWithRepair({
    cwd: input.cwd,
    runDir: input.runDir,
    runId: input.runId,
    workflowInput: input.workflowInput,
    outputs: input.outputs,
    plan: input.plan,
    runtime: input.runtime,
    unit: unitBase,
    prompt: rendered.prompt,
    contractName: task.contract.name,
    contractOptions: task.contract.options
  });
  const outputPath = path.relative(input.runDir, task.laneOutputPath);
  task.laneEntry.status = result.status;
  task.laneEntry.outputPath = outputPath;
  task.laneEntry.blockedReason = result.blockedReason;
  task.laneEntry.attemptId = result.attempts.at(-1)?.id;
  task.laneEntry.completedAt = new Date().toISOString();
  task.laneEntry.errorCode = result.errorCode;
  task.laneEntry.errorMessage = result.errorMessage;
  return result;
}

function missingLoopFanoutLaneOutput(itemId: string, groupId: string, laneId: string): Record<string, unknown> {
  return {
    status: "blocked",
    summary: `Missing fanout lane output ${itemId}/${groupId}/${laneId}.`,
    artifacts: [],
    nextFocus: "diagnose",
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
    artifacts: Array.isArray(bodyOutput?.artifacts) ? bodyOutput.artifacts : [],
    nextFocus: status === "completed" ? "gate" : "diagnose",
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

function loopFanoutLaneOutputPath(runDir: string, loopId: string, round: number, bodyStageId: string, itemId: string, groupId: string, laneId: string): string {
  return path.join(runDir, "outputs", loopId, `round-${round}`, safeFileName(bodyStageId), safeFileName(itemId), safeFileName(groupId), `${safeFileName(laneId)}.json`);
}

function stageRoleNameFromBody(stage: Stage): string | undefined {
  if (stage.kind === "agentTask") return stage.role;
  if (stage.kind === "discover" || stage.kind === "reduce" || stage.kind === "decisionGate") return stage.role;
  return undefined;
}

function blockedOutput(code: string, summary: string): Record<string, unknown> {
  return { status: "blocked", summary, artifacts: [], nextFocus: "diagnose", blockedReason: code, errorCode: code };
}

async function executeAttemptWithRepair(input: {
  cwd: string;
  runDir: string;
  runId: string;
  workflowInput: Record<string, unknown>;
  outputs: Record<string, unknown>;
  plan: ExecutionPlan;
  unit: AgentWorkUnit;
  runtime: OrchestratorAgentRuntime;
  prompt: string;
  contractName: OutputContractName;
  contractOptions?: ContractPlan["options"];
  attemptOrdinal?: number;
}): Promise<AgentWorkResult> {
  const ordinal = input.attemptOrdinal ?? 1;
  const execution = await executeRuntimeTurnWithRetry({
    ...input,
    kind: "attempt",
    ordinal,
    prompt: input.prompt,
    repair: false
  });
  if (!execution.ok) return execution;
  const { turn, attemptBase: attemptEntryBase, attemptDir: dir, attemptId: id } = execution;

  if (turn.status !== "completed") {
    const diagnostics = runtimeDiagnostics(input, id, turn);
    const output = {
      status: "blocked",
      summary: turn.error ?? `Agent turn ${turn.status}.`,
      artifacts: [],
      nextFocus: "diagnose",
      blockedReason: turn.status === "cancelled" ? RuntimeErrorCodes.AGENT_TURN_CANCELLED : RuntimeErrorCodes.AGENT_TURN_FAILED,
      errorCode: turn.status === "cancelled" ? RuntimeErrorCodes.AGENT_TURN_CANCELLED : RuntimeErrorCodes.AGENT_TURN_FAILED,
      runtimeDiagnostics: diagnostics
    };
    await writeAttemptFile(dir, "output.json", output);
    await writeUnitOutput(input, output, id);
    return {
      stageId: input.unit.stageId,
      itemId: input.unit.itemId,
      groupId: input.unit.groupId,
      laneId: input.unit.laneId,
      status: "blocked",
      output,
      outputPath: input.unit.outputPath,
      attempts: [...execution.attempts, {
        ...attemptEntryBase,
        status: "blocked",
        endedAt: new Date().toISOString(),
        blockedReason: String(output.blockedReason),
        rawPreview: previewText(turn.rawText),
        stopReason: turn.stopReason,
        runtimeErrorCode: turn.errorDetailCode ?? turn.errorCode ?? String(output.blockedReason)
      }],
      agentCalls: execution.agentCalls,
      repairCalls: 0,
      blockedReason: String(output.blockedReason)
    };
  }

  const parsed = parseWorkflowOutput(turn.rawText, input.contractName, {
    contractOptions: input.contractOptions
  });
  await writeAttemptFile(dir, "parse.json", parsed.diagnostics);
  if (parsed.ok) {
    const output = withOutputParseMetadata(parsed.value, parsed.outputParse);
    await writeAttemptFile(dir, "output.json", output);
    await writeUnitOutput(input, output, id);
    return {
      stageId: input.unit.stageId,
      itemId: input.unit.itemId,
      groupId: input.unit.groupId,
      laneId: input.unit.laneId,
      status: output.status === "blocked" ? "blocked" : "completed",
      output,
      outputPath: input.unit.outputPath,
      attempts: [...execution.attempts, { ...attemptEntryBase, status: output.status === "blocked" ? "blocked" : "completed", endedAt: new Date().toISOString(), blockedReason: typeof output.blockedReason === "string" ? output.blockedReason : undefined, parseErrorCode: parsed.diagnostics.errorCode, rawPreview: previewText(turn.rawText) }],
      agentCalls: execution.agentCalls,
      repairCalls: 0,
      blockedReason: typeof output.blockedReason === "string" ? output.blockedReason : undefined
    };
  }

  const blocked = {
    status: "blocked",
    summary: parsed.summary,
    artifacts: [],
    nextFocus: "Repair workflow output",
    blockedReason: parsed.errorCode,
    parseDiagnostics: parsed.diagnostics
  };
  await writeAttemptFile(dir, "output.json", blocked);
  if (!isRepairableOutputFailure(parsed.errorCode)) {
    await writeUnitOutput(input, blocked, id);
    return {
      stageId: input.unit.stageId,
      itemId: input.unit.itemId,
      groupId: input.unit.groupId,
      laneId: input.unit.laneId,
      status: "blocked",
      output: blocked,
      outputPath: input.unit.outputPath,
      attempts: [...execution.attempts, { ...attemptEntryBase, status: "blocked", endedAt: new Date().toISOString(), blockedReason: parsed.errorCode, parseErrorCode: parsed.errorCode, rawPreview: previewText(turn.rawText) }],
      agentCalls: execution.agentCalls,
      repairCalls: 0,
      blockedReason: parsed.errorCode
    };
  }

  const repairPrompt = formatRepairPrompt({
    contractName: input.contractName,
    contractOptions: input.contractOptions,
    failure: parsed
  });
  const repair = await executeRepairAttempt({
    ...input,
    originalAttempt: { ...attemptEntryBase, status: "repairing", endedAt: new Date().toISOString(), blockedReason: parsed.errorCode, parseErrorCode: parsed.errorCode, rawPreview: previewText(turn.rawText) },
    originalReason: parsed.errorCode,
    prompt: repairPrompt,
    ordinal
  });
  return {
    ...repair,
    attempts: [...execution.attempts, { ...attemptEntryBase, status: repair.status === "completed" ? "completed" : "blocked", endedAt: new Date().toISOString(), blockedReason: repair.status === "blocked" ? parsed.errorCode : undefined, parseErrorCode: parsed.errorCode, rawPreview: previewText(turn.rawText) }, ...repair.attempts],
    agentCalls: repair.agentCalls + execution.agentCalls,
    repairCalls: repair.repairCalls
  };
}

async function executeRepairAttempt(input: {
  cwd: string;
  runDir: string;
  runId: string;
  workflowInput: Record<string, unknown>;
  outputs: Record<string, unknown>;
  plan: ExecutionPlan;
  unit: AgentWorkUnit;
  runtime: OrchestratorAgentRuntime;
  prompt: string;
  contractName: OutputContractName;
  contractOptions?: ContractPlan["options"];
  originalAttempt: AttemptIndexEntry;
  originalReason: string;
  ordinal: number;
}): Promise<AgentWorkResult> {
  const execution = await executeRuntimeTurnWithRetry({
    ...input,
    kind: "repair",
    ordinal: input.ordinal,
    prompt: input.prompt,
    repair: true,
    originalReason: input.originalReason
  });
  if (!execution.ok) return {
    ...execution,
    attempts: [input.originalAttempt, ...execution.attempts],
    repairCalls: execution.agentCalls
  };
  const { turn, attemptBase: entryBase, attemptDir: dir, attemptId: id } = execution;
  const parsed = turn.status === "completed"
    ? parseWorkflowOutput(turn.rawText, input.contractName, {
        contractOptions: input.contractOptions
      })
    : undefined;
  await writeAttemptFile(dir, "parse.json", parsed?.diagnostics ?? { errorCode: RuntimeErrorCodes.AGENT_TURN_FAILED, summary: turn.error ?? turn.status });
  if (parsed?.ok) {
    const output = withOutputParseMetadata(parsed.value, {
      ...parsed.outputParse,
      repairedFromStageAttempt: input.originalAttempt.id
    });
    await writeAttemptFile(dir, "output.json", output);
    await writeUnitOutput(input, output, id);
    return {
      stageId: input.unit.stageId,
      itemId: input.unit.itemId,
      groupId: input.unit.groupId,
      laneId: input.unit.laneId,
      status: output.status === "blocked" ? "blocked" : "completed",
      output,
      outputPath: input.unit.outputPath,
      attempts: [...execution.attempts, { ...entryBase, status: output.status === "blocked" ? "blocked" : "completed", endedAt: new Date().toISOString(), parseErrorCode: parsed.diagnostics.errorCode, rawPreview: previewText(turn.rawText) }],
      agentCalls: execution.agentCalls,
      repairCalls: execution.agentCalls,
      blockedReason: typeof output.blockedReason === "string" ? output.blockedReason : undefined
    };
  }
  const output = repairFailedEnvelope({
    summary: parsed?.summary ?? (turn.error ?? "Repair turn failed."),
    originalReason: input.originalReason,
    repairDiagnostics: parsed?.diagnostics ?? { errorCode: RuntimeErrorCodes.AGENT_TURN_FAILED, summary: turn.error ?? turn.status }
  });
  await writeAttemptFile(dir, "output.json", output);
  await writeUnitOutput(input, output, id);
  return {
    stageId: input.unit.stageId,
    itemId: input.unit.itemId,
    groupId: input.unit.groupId,
    laneId: input.unit.laneId,
    status: "blocked",
    output,
    outputPath: input.unit.outputPath,
    attempts: [...execution.attempts, { ...entryBase, status: "blocked", endedAt: new Date().toISOString(), blockedReason: "OUTPUT_REPAIR_FAILED", parseErrorCode: parsed?.diagnostics.errorCode ?? RuntimeErrorCodes.AGENT_TURN_FAILED, rawPreview: previewText(turn.rawText) }],
    agentCalls: execution.agentCalls,
    repairCalls: execution.agentCalls,
    blockedReason: "OUTPUT_REPAIR_FAILED"
  };
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

async function executeRuntimeTurnWithRetry(input: {
  cwd: string;
  runDir: string;
  runId: string;
  unit: AgentWorkUnit;
  runtime: OrchestratorAgentRuntime;
  kind: "attempt" | "repair";
  ordinal: number;
  prompt: string;
  repair: boolean;
  originalReason?: string;
}): Promise<RuntimeTurnExecution> {
  if (!input.repair) {
    const promptAuditId = input.unit.itemId && input.unit.groupId && input.unit.laneId
      ? `${input.unit.stageId}__${input.unit.itemId}__${input.unit.groupId}__${input.unit.laneId}`
      : input.unit.itemId ? `${input.unit.stageId}__${input.unit.itemId}` : input.unit.stageId;
    await writePromptAudit(input.runDir, promptAuditId, input.prompt);
  }
  const priorAttempts: AttemptIndexEntry[] = [];
  let calls = 0;
  let runtimeRetryOf = input.unit.runtimeRetryOf;
  let runtimeRetryOrdinal = input.unit.runtimeRetryOrdinal;
  while (true) {
    const id = attemptId({
      stageId: input.unit.stageId,
      itemId: input.unit.itemId,
      groupId: input.unit.groupId,
      laneId: input.unit.laneId,
      kind: input.kind,
      ordinal: input.ordinal,
      runtimeRetryOrdinal
    });
    const dir = attemptDir(input.runDir, {
      stageId: input.unit.stageId,
      itemId: input.unit.itemId,
      groupId: input.unit.groupId,
      laneId: input.unit.laneId,
      kind: input.kind,
      ordinal: input.ordinal,
      runtimeRetryOrdinal
    });
    const promptPath = await writeAttemptFile(dir, "prompt.md", input.prompt);
    void promptPath;
    const startedAt = new Date().toISOString();
    const attemptBase: AttemptIndexEntry = {
      id,
      stageId: input.unit.stageId,
      itemId: input.unit.itemId,
      groupId: input.unit.groupId,
      laneId: input.unit.laneId,
      kind: input.kind,
      status: "running",
      path: path.relative(input.runDir, dir),
      startedAt,
      promptPreview: previewText(input.prompt),
      sessionKey: input.unit.sessionKey,
      requestId: id,
      agent: input.unit.role.agent,
      roleMode: input.unit.role.mode,
      runtimeDisposeInvoked: false,
      runtimeRetryOf,
      runtimeRetryOrdinal,
      runtimeRetryReason: runtimeRetryOf ? "Retrying a transient agent runtime failure." : undefined
    };
    if (runtimeRetryOrdinal) {
      await appendEvent(input.cwd, input.runId, {
        type: "runtime_retry_started",
        stageId: input.unit.stageId,
        itemId: input.unit.itemId,
        attemptId: id,
        runtimeRetryOf,
        runtimeRetryOrdinal,
        repair: input.repair
      });
    }
    await appendEvent(input.cwd, input.runId, { type: "attempt_created", stageId: input.unit.stageId, itemId: input.unit.itemId, attemptId: id, repair: input.repair, runtimeRetryOf, runtimeRetryOrdinal });
    if (input.repair) {
      await appendEvent(input.cwd, input.runId, { type: "repair_started", stageId: input.unit.stageId, itemId: input.unit.itemId, attemptId: id, originalReason: input.originalReason, runtimeRetryOf, runtimeRetryOrdinal });
    } else {
      await appendEvent(input.cwd, input.runId, { type: "attempt_started", stageId: input.unit.stageId, itemId: input.unit.itemId, attemptId: id, runtimeRetryOf, runtimeRetryOrdinal });
    }
    await appendEvent(input.cwd, input.runId, { type: "turn_started", stageId: input.unit.stageId, itemId: input.unit.itemId, attemptId: id, sessionKey: input.unit.sessionKey, agent: input.unit.role.agent, roleMode: input.unit.role.mode, repair: input.repair, runtimeRetryOf, runtimeRetryOrdinal });

    calls += 1;
    let turn: AgentTurnResult;
    try {
      turn = await input.runtime.runTurn({
        sessionKey: input.unit.sessionKey,
        roleName: input.unit.roleName,
        role: input.unit.role,
        cwd: input.unit.cwd,
        prompt: input.prompt,
        requestId: id,
        timeoutMs: input.unit.timeoutMs,
        repair: input.repair
      }, async (event) => appendTurnEvent(input.cwd, input.runId, input.unit.stageId, input.unit.itemId, id, event));
      await appendEvent(input.cwd, input.runId, { type: "turn_finished", stageId: input.unit.stageId, itemId: input.unit.itemId, attemptId: id, status: turn.status, stopReason: turn.stopReason, errorCode: turn.errorDetailCode ?? turn.errorCode, repair: input.repair, runtimeRetryOf, runtimeRetryOrdinal });
      await recordSessionBinding(input.runDir, {
        sessionKey: input.unit.sessionKey,
        roleName: input.unit.roleName,
        agent: input.unit.role.agent,
        cwd: input.unit.cwd,
        handle: turn.handle
      });
      await writeAttemptFile(dir, "raw.txt", turn.rawText);
    } catch (error) {
      const failure = runtimeFailureFromError(error, id);
      await appendEvent(input.cwd, input.runId, { type: "turn_finished", stageId: input.unit.stageId, itemId: input.unit.itemId, attemptId: id, status: "failed", error: failure.message, errorCode: failure.code, repair: input.repair, runtimeRetryOf, runtimeRetryOrdinal });
      if (canRetryRuntimeFailure(runtimeRetryOrdinal)) {
        priorAttempts.push(finalizeRuntimeFailedAttempt(attemptBase, failure));
        const nextRetryOrdinal = (runtimeRetryOrdinal ?? 0) + 1;
        const nextAttemptId = attemptId({ stageId: input.unit.stageId, itemId: input.unit.itemId, groupId: input.unit.groupId, laneId: input.unit.laneId, kind: input.kind, ordinal: input.ordinal, runtimeRetryOrdinal: nextRetryOrdinal });
        await appendEvent(input.cwd, input.runId, { type: "runtime_retry_scheduled", stageId: input.unit.stageId, itemId: input.unit.itemId, attemptId: id, retryAttemptId: nextAttemptId, runtimeRetryOrdinal: nextRetryOrdinal, errorCode: failure.code, errorMessage: failure.message, repair: input.repair });
        runtimeRetryOf = runtimeRetryOf ?? id;
        runtimeRetryOrdinal = nextRetryOrdinal;
        continue;
      }
      await appendEvent(input.cwd, input.runId, { type: "runtime_retry_exhausted", stageId: input.unit.stageId, itemId: input.unit.itemId, attemptId: id, runtimeRetryOf, runtimeRetryOrdinal, errorCode: failure.code, errorMessage: failure.message, repair: input.repair });
      return runtimeFailureAgentWorkResult({
        input,
        attempt: finalizeRuntimeFailedAttempt(attemptBase, failure),
        priorAttempts,
        attemptDir: dir,
        agentCalls: calls,
        failure,
        repairCalls: input.repair ? calls : 0
      });
    }

    const retryFailure = retryableRuntimeTurnFailure(turn, id);
    if (retryFailure) {
      if (canRetryRuntimeFailure(runtimeRetryOrdinal)) {
        priorAttempts.push(finalizeRuntimeFailedAttempt(attemptBase, retryFailure));
        const nextRetryOrdinal = (runtimeRetryOrdinal ?? 0) + 1;
        const nextAttemptId = attemptId({ stageId: input.unit.stageId, itemId: input.unit.itemId, groupId: input.unit.groupId, laneId: input.unit.laneId, kind: input.kind, ordinal: input.ordinal, runtimeRetryOrdinal: nextRetryOrdinal });
        await appendEvent(input.cwd, input.runId, { type: "runtime_retry_scheduled", stageId: input.unit.stageId, itemId: input.unit.itemId, attemptId: id, retryAttemptId: nextAttemptId, runtimeRetryOrdinal: nextRetryOrdinal, errorCode: retryFailure.code, errorMessage: retryFailure.message, repair: input.repair });
        runtimeRetryOf = runtimeRetryOf ?? id;
        runtimeRetryOrdinal = nextRetryOrdinal;
        continue;
      }
      await appendEvent(input.cwd, input.runId, { type: "runtime_retry_exhausted", stageId: input.unit.stageId, itemId: input.unit.itemId, attemptId: id, runtimeRetryOf, runtimeRetryOrdinal, errorCode: retryFailure.code, errorMessage: retryFailure.message, repair: input.repair });
      return runtimeFailureAgentWorkResult({
        input,
        attempt: finalizeRuntimeFailedAttempt(attemptBase, retryFailure),
        priorAttempts,
        attemptDir: dir,
        agentCalls: calls,
        failure: retryFailure,
        repairCalls: input.repair ? calls : 0
      });
    }

    return {
      ok: true,
      turn,
      attempts: priorAttempts,
      attemptBase,
      attemptId: id,
      attemptDir: dir,
      agentCalls: calls
    };
  }
}

function canRetryRuntimeFailure(runtimeRetryOrdinal: number | undefined): boolean {
  return (runtimeRetryOrdinal ?? 0) < MAX_RUNTIME_RETRIES;
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
    runtimeRetryReason: failure.message,
    rawPreview: previewText(failure.rawText ?? ""),
    stopReason: failure.stopReason
  };
}

async function runtimeFailureAgentWorkResult(input: {
  input: {
    cwd: string;
    runDir: string;
    runId: string;
    unit: AgentWorkUnit;
  };
  attempt: AttemptIndexEntry;
  priorAttempts: AttemptIndexEntry[];
  attemptDir: string;
  agentCalls: number;
  repairCalls?: number;
  failure: RuntimeFailureSummary;
}): Promise<{ ok: false } & AgentWorkResult>;
async function runtimeFailureAgentWorkResult(input: {
  input: {
    cwd: string;
    runDir: string;
    runId: string;
    unit: AgentWorkUnit;
  };
  attempt?: AttemptIndexEntry;
  priorAttempts?: AttemptIndexEntry[];
  attemptDir?: string;
  agentCalls?: number;
  repairCalls?: number;
  failure: RuntimeFailureSummary;
}): Promise<{ ok: false } & AgentWorkResult> {
  const unit = input.input.unit;
  const code = runtimeBlockedCodeForUnit(unit);
  const attempt = input.attempt!;
  const attempts = [...(input.priorAttempts ?? []), attempt];
  const dir = input.attemptDir!;
  const output = {
    status: "blocked",
    summary: input.failure.message,
    artifacts: [],
    nextFocus: "diagnose",
    blockedReason: code,
    errorCode: code,
    runtimeDiagnostics: {
      requestId: input.failure.requestId,
      sessionKey: unit.sessionKey,
      agent: unit.role.agent,
      roleMode: unit.role.mode,
      runtimeDisposeInvoked: false,
      errorCode: code,
      errorMessage: input.failure.message,
      retryable: input.failure.retryable,
      runtimeRetryOf: attempt.runtimeRetryOf,
      runtimeRetryOrdinal: attempt.runtimeRetryOrdinal
    }
  };
  await writeAttemptFile(dir, "output.json", output);
  await writeUnitOutput(input.input, output, attempt.id);
  return {
    ok: false,
    stageId: unit.stageId,
    itemId: unit.itemId,
    groupId: unit.groupId,
    laneId: unit.laneId,
    status: "blocked",
    output,
    outputPath: unit.outputPath,
    attempts,
    agentCalls: input.agentCalls ?? 1,
    repairCalls: input.repairCalls ?? 0,
    blockedReason: code,
    errorCode: code,
    errorMessage: input.failure.message
  };
}

function runtimeBlockedCodeForUnit(unit: AgentWorkUnit): string {
  return unit.type === "fanoutItem" ? RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR : RuntimeErrorCodes.AGENT_RUNTIME_ERROR;
}

async function writeUnitOutput(input: {
  cwd: string;
  runDir: string;
  runId: string;
  unit: AgentWorkUnit;
}, output: Record<string, unknown>, attemptId?: string): Promise<void> {
  await fs.mkdir(path.dirname(input.unit.outputPath), { recursive: true });
  await fs.writeFile(input.unit.outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  await appendEvent(input.cwd, input.runId, {
    type: "output_written",
    stageId: input.unit.stageId,
    itemId: input.unit.itemId,
    attemptId,
    outputPath: path.relative(input.runDir, input.unit.outputPath),
    status: output.status
  });
}

function runtimeDiagnostics(input: {
  unit: AgentWorkUnit;
}, requestId: string, turn: AgentTurnResult): Record<string, unknown> {
  return {
    stopReason: turn.stopReason,
    requestId,
    sessionKey: input.unit.sessionKey,
    agent: input.unit.role.agent,
    roleMode: input.unit.role.mode,
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

async function discoverGlob(workflowInput: Record<string, unknown>, args: Record<string, unknown>): Promise<Array<{ id: string; path: string }>> {
  const cwd = workflowCwd(workflowInput);
  const include = normalizePatternList(args.scope ?? args.include ?? args.patterns ?? args.pattern ?? ["**/*"]);
  const ignore = normalizePatternList(args.exclude ?? []);
  const files = await fg(include, {
    cwd,
    ignore,
    dot: true,
    onlyFiles: true,
    unique: true
  });
  return files.map((file, index) => ({ id: stableItemId({ path: file }, index), path: file }));
}

async function discoverGitChangedFiles(workflowInput: Record<string, unknown>, args: Record<string, unknown>): Promise<Array<{ id: string; path: string }>> {
  const cwd = workflowCwd(workflowInput);
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
    const include = normalizePatternList(args.scope ?? args.include ?? ["**/*"]);
    const exclude = normalizePatternList(args.exclude ?? []);
    return stdout.split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => normalizePath(line.slice(3).split(" -> ").at(-1) ?? ""))
      .filter((file) => file && matchesAny(file, include) && !matchesAny(file, exclude))
      .map((file, index) => ({ id: stableItemId({ path: file }, index), path: file }));
  } catch {
    const fallback = workflowInput[String(args.outputKey ?? "files")];
    return Array.isArray(fallback) ? fallback as Array<{ id: string; path: string }> : [];
  }
}

function programReduce(stage: Extract<Stage, { kind: "reduce" }>, outputs: Record<string, unknown>): Record<string, unknown> {
  const source = outputs[stage.from];
  const items = Array.isArray((source as Record<string, unknown> | undefined)?.items) ? (source as Record<string, unknown>).items as unknown[] : [];
  const operation = stage.operation ?? "mergeArrays";
  let data: unknown = items;
  if (operation === "severitySummary") data = severitySummary(items.flatMap((item) => Array.isArray((item as Record<string, unknown> | undefined)?.findings) ? (item as Record<string, unknown>).findings as unknown[] : []));
  if (operation === "dedupeFindings") data = dedupeFindings(items);
  if (operation === "sortBySeverity") data = dedupeFindings(items).sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  return {
    status: "completed",
    summary: `Program reduce ${operation} completed.`,
    artifacts: [],
    nextFocus: "gate",
    items: data,
    data: { operation, sourceStage: stage.from }
  };
}

function programGate(stage: Extract<Stage, { kind: "gate" }>, outputs: Record<string, unknown>, workflowInput: Record<string, unknown>): Record<string, unknown> {
  const dependencies = stage.dependsOn ?? [];
  const upstream = dependencies.length === 1 ? objectRecord(outputs[dependencies[0]]) : undefined;
  const passed = stage.condition
    ? evaluateCondition(stage.condition, outputs, workflowInput)
    : dependencies.length === 1 && outputs[dependencies[0]] != null;
  const passthrough = passed ? finalFieldPassthrough(upstream) : {};
  return {
    status: passed ? "completed" : "blocked",
    summary: passed && typeof upstream?.summary === "string" ? upstream.summary : (passed ? "Gate condition passed." : "Gate condition failed."),
    artifacts: Array.isArray(upstream?.artifacts) ? upstream.artifacts : [],
    nextFocus: "",
    verdict: passed ? "pass" : "blocked",
    blockedReason: passed ? undefined : RuntimeErrorCodes.GATE_CONDITION_FAILED,
    ...passthrough
  };
}

function finalFieldPassthrough(output: Record<string, unknown> | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {
    deliverables: [],
    changedFiles: [],
    checks: [],
    warnings: [],
    risks: [],
    nextActions: []
  };
  if (!output) return result;
  for (const key of Object.keys(result)) {
    const value = output[key];
    if (Array.isArray(value)) result[key] = value;
  }
  return result;
}

function evaluateDecision(stage: Extract<Stage, { kind: "decisionGate" }>, outputs: Record<string, unknown>, workflowInput: Record<string, unknown>): string {
  for (const rule of stage.rules) {
    if (evaluateCondition(rule.when, outputs, workflowInput)) return rule.to;
  }
  return stage.default;
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

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function workflowCwd(workflowInput: Record<string, unknown>): string {
  return path.resolve(typeof workflowInput.cwd === "string" ? workflowInput.cwd : process.cwd());
}

function normalizePatternList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return [value];
  return ["**/*"];
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => fg.isDynamicPattern(pattern) ? minimatchLike(file, pattern) : file === normalizePath(pattern));
}

function minimatchLike(file: string, pattern: string): boolean {
  let source = "^";
  const text = normalizePath(pattern);
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    const afterNext = text[index + 2];
    if (char === "*" && next === "*" && afterNext === "/") {
      source += "(?:.*/)?";
      index += 2;
    } else if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  source += "$";
  return new RegExp(source).test(file);
}

function severitySummary(items: unknown[]): Record<string, number> {
  const summary: Record<string, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const item of items) {
    const severity = item && typeof item === "object" ? String((item as Record<string, unknown>).severity ?? "") : "";
    if (severity in summary) summary[severity] += 1;
  }
  return summary;
}

function dedupeFindings(items: unknown[]): Array<Record<string, unknown>> {
  const findings = items.flatMap((item) => collectFindings(item));
  const seen = new Set<string>();
  const result: Array<Record<string, unknown>> = [];
  for (const finding of findings) {
    if (!finding || typeof finding !== "object") continue;
    const record = finding as Record<string, unknown>;
    const key = [record.severity ?? "", record.path ?? "", record.summary ?? ""].join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(record);
  }
  return result;
}

function collectFindings(value: unknown): unknown[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const direct = Array.isArray(record.findings) ? record.findings : [];
  const self = "severity" in record && "summary" in record ? [record] : [];
  const output = collectFindings(record.output);
  const laneOutputs = Array.isArray(record.laneOutputs) ? record.laneOutputs.flatMap(collectFindings) : [];
  const items = Array.isArray(record.items) ? record.items.flatMap(collectFindings) : [];
  return [...self, ...direct, ...output, ...laneOutputs, ...items];
}

function severityRank(value: unknown): number {
  return { P0: 0, P1: 1, P2: 2, P3: 3 }[String(value)] ?? 99;
}

function hashShort(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}
