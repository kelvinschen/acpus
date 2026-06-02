import fs from "node:fs/promises";
import path from "node:path";
import type { OrchestratorIssue } from "../errors.js";
import type { WorkflowSpec } from "../schema/workflow-spec.js";
import { runDir } from "../run-index/paths.js";
import type { RunIndex } from "../run-index/read-write.js";

export type RunViewStatus = "pending" | "running" | "completed" | "blocked" | "diagnosed_blocked" | "failed" | "cancelled";
export type RunViewOutputParse = {
  mode?: string;
  repaired?: boolean;
  candidateCount?: number;
  warnings: string[];
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
  checks: Array<{ command?: string; name?: string; status?: string; summary?: string }>;
  finalWarnings: string[];
  risks: string[];
  warnings: OrchestratorIssue[];
  errors: OrchestratorIssue[];
  roles: Array<{ name: string; category: string; agent: string; mode: string }>;
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
  }>;
  fanout: Array<{ stageId: string; maxItems: number; laneUpperBound: number; estimatedWorkUnits: number }>;
  agentUsage: { planned: number; actual?: number; repairCalls?: number; recoveryCalls?: number };
  artifacts: Array<{ kind?: string; path?: string; label?: string }>;
  commands: Record<string, string>;
};

export function previewRunView(spec: WorkflowSpec, issues: OrchestratorIssue[] = [], commands: Record<string, string> = {}): RunView {
  const risks = previewRisks(spec);
  return {
    workflowName: spec.name,
    status: issues.some((entry) => entry.severity !== "warning") ? "blocked" : "pending",
    summary: spec.description || `Workflow ${spec.name}`,
    checks: [],
    finalWarnings: issues.filter((entry) => entry.severity === "warning").map((entry) => `${entry.code}: ${entry.message}`),
    risks,
    warnings: issues.filter((entry) => entry.severity === "warning"),
    errors: issues.filter((entry) => entry.severity !== "warning"),
    roles: Object.entries(spec.roles).map(([name, role]) => ({ name, ...role })),
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
    artifacts: [],
    commands
  };
}

export async function runViewFromIndex(cwd: string, spec: WorkflowSpec, index: RunIndex, issues: OrchestratorIssue[] = []): Promise<RunView> {
  const stageOutputs = await readStageOutputs(cwd, index.logicalRunId, spec);
  const gateStage = spec.stages.find((stage) => stage.kind === "gate")?.id;
  const finalOutput = gateStage ? stageOutputs[gateStage] : undefined;
  const final = objectRecord(finalOutput);
  const artifacts = Object.values(stageOutputs)
    .flatMap((output) => Array.isArray(objectRecord(output)?.artifacts) ? objectRecord(output)?.artifacts as Array<{ kind?: string; path?: string; label?: string }> : []);
  const finalWarnings = stringArray(final?.warnings);
  const outputRisks = stringArray(final?.risks);
  const checks = Array.isArray(final?.checks) ? final.checks as RunView["checks"] : [];
  const preview = previewRunView(spec, issues);
  return {
    ...preview,
    logicalRunId: index.logicalRunId,
    workflowName: index.workflowName,
    status: index.status,
    gateVerdict: index.gateVerdict ?? gateVerdict(final),
    blockedReason: index.blockedReason,
    summary: typeof final?.summary === "string" ? final.summary : (index.blockedReason ?? spec.description ?? ""),
    checks,
    finalWarnings,
    risks: [...preview.risks, ...outputRisks],
    stages: spec.stages.map((stage) => {
      const output = objectRecord(stageOutputs[stage.id]);
      const indexed = index.stages[stage.id];
      return {
        id: stage.id,
        kind: stage.kind,
        dependsOn: stage.dependsOn ?? [],
        status: typeof output?.status === "string" ? output.status : indexed?.status,
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
      path: attempt.path
    })),
    agentUsage: {
      planned: index.agentUsage.planned,
      actual: index.agentUsage.actual,
      repairCalls: index.agentUsage.repairCalls,
      recoveryCalls: index.agentUsage.recoveryCalls
    },
    artifacts: artifacts.filter((artifact) => artifact && typeof artifact === "object")
  };
}

export function estimateAgentCalls(spec: WorkflowSpec): number {
  let baseCalls = 0;
  for (const stage of spec.stages) {
    if (stage.kind === "agentTask") baseCalls += 1;
    if (stage.kind === "gate" && stage.mode === "agent") baseCalls += 1;
    if (stage.kind === "discover" && stage.method === "agent") baseCalls += 1;
    if (stage.kind === "reduce" && stage.mode === "agent") baseCalls += 1;
    if (stage.kind === "decisionGate" && stage.mode === "agent") baseCalls += 1;
    if (stage.kind === "fanout") baseCalls += (stage.limits?.maxFanoutItems ?? 1) * fanoutLaneUpperBound(stage);
    if (stage.kind === "loop") baseCalls += stage.maxRounds * estimateLoopBodyAgentCalls(stage);
  }
  return baseCalls;
}

function estimateLoopBodyAgentCalls(stage: Extract<WorkflowSpec["stages"][number], { kind: "loop" }>): number {
  return stage.body.stages.reduce((total, bodyStage) => {
    if (bodyStage.kind === "agentTask") return total + 1;
    if (bodyStage.kind === "discover" && bodyStage.method === "agent") return total + 1;
    if (bodyStage.kind === "reduce" && bodyStage.mode === "agent") return total + 1;
    if (bodyStage.kind === "decisionGate" && bodyStage.mode === "agent") return total + 1;
    if (bodyStage.kind === "fanout") return total + (bodyStage.limits?.maxFanoutItems ?? 1) * fanoutLaneUpperBound(bodyStage);
    return total;
  }, 0);
}

export function estimateFanoutWork(spec: WorkflowSpec): RunView["fanout"] {
  return spec.stages.filter((stage): stage is Extract<WorkflowSpec["stages"][number], { kind: "fanout" }> => stage.kind === "fanout").map((stage) => {
    const maxItems = stage.limits?.maxFanoutItems ?? 1;
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
    repaired: typeof outputParse.repaired === "boolean" ? outputParse.repaired : undefined,
    candidateCount: typeof outputParse.candidateCount === "number" ? outputParse.candidateCount : undefined,
    warnings: stringArray(outputParse.warnings)
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
    "Approval permits this run only; saving for reuse requires an explicit save command.",
    "Audit artifacts are written under .acpx-workflow-orchestrator/runs/<logicalRunId>/ with spec, execution plan, prompts, outputs, attempts, sessions, and events.",
    "Agent turns run through run-local ACPX runtime sessions; repair turns count toward actual usage."
  ];
  const editRoles = Object.entries(spec.roles).filter(([, role]) => role.mode === "edit").map(([name]) => name);
  if (editRoles.length > 0) risks.push(`Edit-capable roles may modify files: ${editRoles.join(", ")}.`);
  const editFanout = spec.stages.filter((stage) => stage.kind === "fanout" && stage.laneGroups.some((group) => group.lanes.some((lane) => spec.roles[lane.role]?.mode === "edit"))).map((stage) => stage.id);
  if (editFanout.length > 0) risks.push(`Edit fanout is high risk; independent item sessions run under stage-local fanout concurrency: ${editFanout.join(", ")}.`);
  const allowPartial = spec.stages.filter((stage) => stage.kind === "fanout" && stage.fanoutPolicy?.allowPartial).map((stage) => stage.id);
  if (allowPartial.length > 0) risks.push(`Partial fanout results are explicitly allowed for: ${allowPartial.join(", ")}.`);
  return risks;
}

function fanoutLaneUpperBound(stage: Extract<WorkflowSpec["stages"][number], { kind: "fanout" }>): number {
  return Math.max(1, stage.laneGroups.reduce((total, group) => total + (group.mode === "oneOf" ? 1 : group.lanes.length), 0));
}
