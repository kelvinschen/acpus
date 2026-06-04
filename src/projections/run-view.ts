import fs from "node:fs/promises";
import path from "node:path";
import type { OrchestratorIssue } from "../errors.js";
import type { WorkflowSpec } from "../schema/workflow-spec.js";
import { staticLimitOrDefault } from "../schema/limit-resolution.js";
import { runDir } from "../run-index/paths.js";
import type { RunIndex } from "../run-index/read-write.js";

export type RunViewStatus = "pending" | "running" | "completed" | "blocked" | "failed" | "cancelled";
export type RunViewOutputParse = {
  mode?: string;
  candidateCount?: number;
};
export type RunViewParseDiagnostics = {
  errorCode?: string;
  candidateCount?: number;
  bestCandidateId?: string;
  recoverability?: string;
  schemaErrors: Array<{ path?: string; message?: string }>;
};

export type RunView = {
  logicalRunId?: string;
  workflowName: string;
  status: RunViewStatus;
  gateVerdict?: "pass" | "pass_with_warnings" | "blocked" | "failed" | "unknown";
  blockedReason?: string;
  summary: string;
  finalWarnings: string[];
  risks: string[];
  warnings: OrchestratorIssue[];
  errors: OrchestratorIssue[];
  actors: Array<{ label: string; agent: string; mode: string }>;
  stages: Array<{
    id: string;
    kind: string;
    dependsOn: string[];
    status?: string;
    summary?: string;
    blockedReason?: string;
    outputParse?: RunViewOutputParse;
    parseDiagnostics?: RunViewParseDiagnostics;
  }>;
  attempts: Array<{
    id: string;
    stageId: string;
    itemId?: string;
    kind: string;
    status: string;
    blockedReason?: string;
    parseErrorCode?: string;
    path: string;
    isRetry?: boolean;
    retryReason?: string;
    retryOf?: string;
    retryOrdinal?: number;
    retryBudgetUsed?: number;
    retryBudgetLimit?: number;
    promptPolicy?: string;
    lastFailureCode?: string;
    retryMessage?: string;
  }>;
  fanout: Array<{ stageId: string; maxItems: number; laneUpperBound: number; estimatedWorkUnits: number }>;
  agentUsage: { planned: number; actual?: number; retryCalls?: number; retries?: { runtime: number; stale: number; continuation: number } };
  commands: Record<string, string>;
};

export function previewRunView(spec: WorkflowSpec, issues: OrchestratorIssue[] = [], commands: Record<string, string> = {}): RunView {
  const risks = previewRisks(spec);
  return {
    workflowName: spec.name,
    status: issues.some((entry) => entry.severity !== "warning") ? "blocked" : "pending",
    summary: spec.description || `Workflow ${spec.name}`,
    finalWarnings: issues.filter((entry) => entry.severity === "warning").map((entry) => `${entry.code}: ${entry.message}`),
    risks,
    warnings: issues.filter((entry) => entry.severity === "warning"),
    errors: issues.filter((entry) => entry.severity !== "warning"),
    actors: actorsForSpec(spec),
    stages: spec.stages.map((stage) => ({
      id: stage.id,
      kind: stage.kind,
      dependsOn: stage.dependsOn ?? []
    })),
    attempts: [],
    fanout: estimateFanoutWork(spec),
    agentUsage: {
      planned: estimateAgentCalls(spec)
    },
    commands
  };
}

export async function runViewFromIndex(cwd: string, spec: WorkflowSpec, index: RunIndex, issues: OrchestratorIssue[] = []): Promise<RunView> {
  const stageOutputs = await readStageOutputs(cwd, index.logicalRunId, spec);
  const gateStage = spec.stages.find((stage) => stage.kind === "gate")?.id;
  const finalOutput = gateStage ? stageOutputs[gateStage] : undefined;
  const final = objectRecord(finalOutput);
  const preview = previewRunView(spec, issues);
  return {
    ...preview,
    logicalRunId: index.logicalRunId,
    workflowName: index.workflowName,
    status: index.status,
    gateVerdict: index.gateVerdict ?? gateVerdict(final),
    blockedReason: index.blockedReason,
    summary: typeof final?.summary === "string" ? final.summary : (index.blockedReason ?? spec.description ?? ""),
    stages: spec.stages.map((stage) => {
      const output = objectRecord(stageOutputs[stage.id]);
      const indexed = index.stages[stage.id];
      return {
        id: stage.id,
        kind: stage.kind,
        dependsOn: stage.dependsOn ?? [],
        status: indexed?.status,
        summary: typeof output?.summary === "string" ? output.summary : undefined,
        blockedReason: typeof output?.blockedReason === "string" ? output.blockedReason : indexed?.blockedReason,
        outputParse: outputParseSummary(output),
        parseDiagnostics: parseDiagnosticsSummary(output)
      };
    }),
    attempts: Object.values(index.attempts).map((attempt) => ({
      id: attempt.id,
      stageId: attempt.stageId,
      itemId: attempt.itemId,
      kind: attempt.kind,
      status: attempt.status,
      blockedReason: attempt.blockedReason,
      parseErrorCode: attempt.parseErrorCode,
      path: attempt.path,
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
    agentUsage: {
      planned: index.agentUsage.planned,
      actual: index.agentUsage.actual,
      retryCalls: index.agentUsage.retryCalls,
      retries: index.agentUsage.retries
    }
  };
}

export function estimateAgentCalls(spec: WorkflowSpec): number {
  let baseCalls = 0;
  for (const stage of spec.stages) {
    if (stage.kind === "task" && stage.mode === "agent") baseCalls += 1;
    if (stage.kind === "gate" && stage.mode === "agent") baseCalls += 1;
    if (stage.kind === "route" && stage.mode === "agent") baseCalls += 1;
    if (stage.kind === "fanout") baseCalls += staticLimitOrDefault(stage.limits?.maxFanoutItems, 1) * fanoutLaneUpperBound(stage);
    if (stage.kind === "loop") baseCalls += stage.maxRounds * estimateLoopBodyAgentCalls(stage);
  }
  return baseCalls;
}

function estimateLoopBodyAgentCalls(stage: Extract<WorkflowSpec["stages"][number], { kind: "loop" }>): number {
  return stage.body.stages.reduce((total, bodyStage) => {
    if (bodyStage.kind === "task" && bodyStage.mode === "agent") return total + 1;
    if (bodyStage.kind === "route" && bodyStage.mode === "agent") return total + 1;
    if (bodyStage.kind === "fanout") {
      return total
        + staticLimitOrDefault(bodyStage.limits?.maxFanoutItems, 1) * fanoutLaneUpperBound(bodyStage)
        + (bodyStage.fanin.mode === "agent" ? 1 : 0);
    }
    return total;
  }, 0);
}

export function estimateFanoutWork(spec: WorkflowSpec): RunView["fanout"] {
  return spec.stages.filter((stage): stage is Extract<WorkflowSpec["stages"][number], { kind: "fanout" }> => stage.kind === "fanout").map((stage) => {
    const maxItems = staticLimitOrDefault(stage.limits?.maxFanoutItems, 1);
    const laneUpperBound = fanoutLaneUpperBound(stage);
    return {
      stageId: stage.id,
      maxItems,
      laneUpperBound,
      estimatedWorkUnits: maxItems * laneUpperBound
    };
  });
}

async function readStageOutputs(cwd: string, logicalRunId: string, spec: WorkflowSpec): Promise<Record<string, unknown>> {
  const outputs: Record<string, unknown> = {};
  const dir = path.join(runDir(logicalRunId, cwd), "outputs");
  for (const stage of spec.stages) {
    try {
      outputs[stage.id] = JSON.parse(await fs.readFile(path.join(dir, `${stage.id}.json`), "utf8"));
    } catch {
      // Missing output means the stage has not run or was skipped by routing.
    }
  }
  return outputs;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function outputParseSummary(output: Record<string, unknown> | undefined): RunViewOutputParse | undefined {
  const metadata = objectRecord(output?.metadata);
  const outputParse = objectRecord(metadata?.outputParse);
  if (!outputParse) return undefined;
  return {
    mode: typeof outputParse.mode === "string" ? outputParse.mode : undefined,
    candidateCount: typeof outputParse.candidateCount === "number" ? outputParse.candidateCount : undefined
  };
}

function parseDiagnosticsSummary(output: Record<string, unknown> | undefined): RunViewParseDiagnostics | undefined {
  const diagnostics = objectRecord(output?.parseDiagnostics);
  if (!diagnostics) return undefined;
  return {
    errorCode: typeof diagnostics.errorCode === "string" ? diagnostics.errorCode : undefined,
    candidateCount: typeof diagnostics.candidateCount === "number" ? diagnostics.candidateCount : undefined,
    bestCandidateId: typeof diagnostics.bestCandidateId === "string" ? diagnostics.bestCandidateId : undefined,
    recoverability: typeof diagnostics.recoverability === "string" ? diagnostics.recoverability : undefined,
    schemaErrors: schemaErrorsFromDiagnostics(diagnostics)
  };
}

function schemaErrorsFromDiagnostics(diagnostics: Record<string, unknown>): Array<{ path?: string; message?: string }> {
  const candidates = Array.isArray(diagnostics.candidates) ? diagnostics.candidates : [];
  const errors: Array<{ path?: string; message?: string }> = [];
  for (const candidate of candidates) {
    const record = objectRecord(candidate);
    const schemaErrors = Array.isArray(record?.schemaErrors) ? record.schemaErrors : [];
    for (const error of schemaErrors) {
      const entry = objectRecord(error);
      if (!entry) continue;
      errors.push({
        path: typeof entry.path === "string" ? entry.path : undefined,
        message: typeof entry.message === "string" ? entry.message : undefined
      });
    }
  }
  return errors.slice(0, 12);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function gateVerdict(output?: Record<string, unknown>): RunView["gateVerdict"] | undefined {
  const value = output?.verdict;
  if (value === "pass" || value === "pass_with_warnings" || value === "blocked" || value === "failed" || value === "unknown") return value;
  return undefined;
}

function previewRisks(spec: WorkflowSpec): string[] {
  const risks: string[] = [
    "Running this workflow does not save it for reuse; saving requires an explicit save command.",
    "Audit artifacts are written under .acpus/runs/<logicalRunId>/ with spec, execution plan, prompts, outputs, attempts, sessions, and events.",
    "Agent turns run through run-local ACPX runtime sessions; retry calls count toward actual usage."
  ];
  const editActors = actorsForSpec(spec).filter((actor) => actor.mode === "edit").map((actor) => actor.label);
  if (editActors.length > 0) risks.push(`Edit-capable actors may modify files: ${editActors.join(", ")}.`);
  const editFanout = spec.stages.filter((stage) => stage.kind === "fanout" && stage.lanes.some((lane) => lane.actor.mode === "edit")).map((stage) => stage.id);
  if (editFanout.length > 0) risks.push(`Edit fanout is high risk; independent item sessions run under stage-local fanout concurrency: ${editFanout.join(", ")}.`);
  const allowPartial = spec.stages.filter((stage) => stage.kind === "fanout" && stage.fanoutPolicy?.allowPartial).map((stage) => stage.id);
  if (allowPartial.length > 0) risks.push(`Partial fanout results are explicitly allowed for: ${allowPartial.join(", ")}.`);
  return risks;
}

function fanoutLaneUpperBound(stage: Extract<WorkflowSpec["stages"][number], { kind: "fanout" }>): number {
  const lanes = Math.max(1, stage.lanes.length);
  return lanes + (stage.fanin.mode === "agent" ? 1 : 0);
}

function actorsForSpec(spec: WorkflowSpec): RunView["actors"] {
  const actors = new Map<string, RunView["actors"][number]>();
  const add = (label: string, actor: { agent: string; mode: string }): void => {
    actors.set(label, { label, agent: actor.agent, mode: actor.mode });
  };
  for (const stage of spec.stages) {
    if (stage.kind === "task" && stage.mode === "agent") add(stage.actor.label ?? stage.id, stage.actor);
    if (stage.kind === "route" && stage.mode === "agent" && stage.actor) add(stage.actor.label ?? stage.id, stage.actor);
    if (stage.kind === "gate" && stage.mode === "agent" && stage.actor) add(stage.actor.label ?? stage.id, stage.actor);
    if (stage.kind === "fanout") {
      for (const lane of stage.lanes) add(lane.actor.label ?? `${stage.id}.${lane.id}`, lane.actor);
      if (stage.fanin.mode === "agent") add(stage.fanin.actor.label ?? `${stage.id}.fanin`, stage.fanin.actor);
    }
    if (stage.kind === "loop") {
      for (const bodyStage of stage.body.stages) {
        if (bodyStage.kind === "task" && bodyStage.mode === "agent") add(bodyStage.actor.label ?? `${stage.id}.${bodyStage.id}`, bodyStage.actor);
        if (bodyStage.kind === "route" && bodyStage.mode === "agent" && bodyStage.actor) add(bodyStage.actor.label ?? `${stage.id}.${bodyStage.id}`, bodyStage.actor);
        if (bodyStage.kind === "fanout") {
          for (const lane of bodyStage.lanes) add(lane.actor.label ?? `${stage.id}.${bodyStage.id}.${lane.id}`, lane.actor);
          if (bodyStage.fanin.mode === "agent") add(bodyStage.fanin.actor.label ?? `${stage.id}.${bodyStage.id}.fanin`, bodyStage.fanin.actor);
        }
      }
    }
  }
  return [...actors.values()];
}
