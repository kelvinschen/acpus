import fs from "node:fs/promises";
import path from "node:path";
import { runDir } from "../run-index/paths.js";
import { RuntimeErrorCodes, type AttemptIndexEntry, type RunIndex } from "../run-index/read-write.js";
import type { Stage, WorkflowSpec } from "../schema/workflow-spec.js";
import { runViewFromIndex, type RunView, type RunViewStatus } from "./run-view.js";

export const REPORT_VIEW_VERSION = "acpx-workflow-orchestrator.report/v1";
export const ReportDiagnosticCodes = {
  SCHEDULER_RECOVERY_SUCCEEDED_WITH_BLOCKED_VERDICT: "SCHEDULER_RECOVERY_SUCCEEDED_WITH_BLOCKED_VERDICT",
  OUTPUT_MAX_CHARS_EXCEEDED: "OUTPUT_MAX_CHARS_EXCEEDED"
} as const;

const DEFAULT_LIMITS = {
  promptPreviewChars: 2048,
  outputPreviewChars: 8192,
  rawPreviewChars: 2048,
  eventLimit: 200,
  fanoutItemLimit: 200
};

export type ReportMode = "snapshot" | "live";
export type ReportStageStatus = "pending" | "ready" | "running" | "completed" | "blocked" | "failed" | "skipped" | "unknown";

export type ReportPreview = {
  text: string;
  truncated: boolean;
  originalChars?: number;
  path?: string;
};

export type RunReportView = {
  version: typeof REPORT_VIEW_VERSION;
  generatedAt: string;
  mode: ReportMode;
  summary: RunView;
  run: {
    logicalRunId: string;
    workflowName: string;
    status: RunViewStatus;
    finalVerdict?: RunIndex["finalVerdict"];
    blockedReason?: string;
    createdAt: string;
    updatedAt: string;
    durationMs?: number;
    runDir: string;
    source?: RunIndex["source"];
  };
  metrics: {
    stagesTotal: number;
    stagesCompleted: number;
    stagesBlocked: number;
    stagesFailed: number;
    stagesRunning: number;
    stagesPending: number;
    attemptsTotal: number;
    attemptsRunning: number;
    attemptsCompleted: number;
    attemptsBlocked: number;
    attemptsFailed: number;
    agentCallsPlanned: number;
    agentCallsActual?: number;
    repairCalls?: number;
    recoveryCalls?: number;
  };
  graph: {
    nodes: ReportGraphNode[];
    edges: ReportGraphEdge[];
  };
  stages: ReportStageDetail[];
  attempts: ReportAttemptDetail[];
  events: ReportEvent[];
  artifacts: ReportArtifact[];
  diagnostics: ReportDiagnostic[];
};

export type ReportGraphNode = {
  id: string;
  label: string;
  kind: Stage["kind"];
  status: ReportStageStatus;
  detailRef: string;
  roleName?: string;
  agent?: string;
  mode?: string;
  badges: string[];
  metrics: Record<string, string | number | boolean>;
};

export type ReportGraphEdge = {
  id: string;
  source: string;
  target: string;
  relation: "dependency" | "decision-route";
  label?: string;
  active?: boolean;
};

export type ReportStageDetail = {
  id: string;
  kind: Stage["kind"];
  dependsOn: string[];
  status: ReportStageStatus;
  summary?: string;
  blockedReason?: string;
  roleName?: string;
  roleCategory?: string;
  agent?: string;
  mode?: "denyAll" | "readOnly" | "edit";
  prompt?: ReportPreview;
  output?: ReportPreview;
  outputPath?: string;
  outputShape?: {
    keys: string[];
    status?: string;
    verdict?: string;
    finalVerdict?: string;
    findingsCount?: number;
    checksCount?: number;
    artifactsCount?: number;
  };
  outputParse?: {
    mode?: string;
    repaired?: boolean;
    candidateCount?: number;
    warnings: string[];
  };
  parseDiagnostics?: {
    errorCode?: string;
    candidateCount?: number;
    bestCandidateId?: string;
    recoverability?: string;
    schemaErrors: Array<{ path?: string; message?: string }>;
  };
  fanout?: {
    totalItems?: number;
    completedItems?: number;
    blockedItems?: number;
    failedItems?: number;
    displayedItems: number;
    allowPartial?: boolean;
    items: Array<{
      id: string;
      status?: string;
      summary?: string;
      outputPath?: string;
      output?: ReportPreview;
      blockedReason?: string;
      errorCode?: string;
      errorMessage?: string;
    }>;
  };
  decision?: {
    matchedRoute?: string;
    defaultRoute?: string;
    routes: string[];
  };
  fixLoop?: {
    maxRounds: number;
    observedRounds?: number;
    finalValidatorStatus?: string;
  };
  relatedAttemptIds: string[];
  relatedEventIds: string[];
};

export type ReportAttemptDetail = {
  id: string;
  stageId: string;
  itemId?: string;
  kind: AttemptIndexEntry["kind"];
  status: AttemptIndexEntry["status"];
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  blockedReason?: string;
  parseErrorCode?: string;
  runtimeErrorCode?: string;
  runtimeRetryOf?: string;
  runtimeRetryOrdinal?: number;
  runtimeRetryReason?: string;
  path: string;
  prompt?: ReportPreview;
  raw?: ReportPreview;
  parse?: ReportPreview;
  output?: ReportPreview;
};

export type ReportEvent = {
  id: string;
  at?: string;
  type?: string;
  preview: ReportPreview;
  raw: Record<string, unknown>;
};

export type ReportArtifact = {
  stageId?: string;
  kind?: string;
  path?: string;
  url?: string;
  label?: string;
};

export type ReportDiagnostic = {
  id: string;
  path: string;
  code?: string;
  stageId?: string;
  itemId?: string;
  status?: string;
  summary?: string;
  raw?: Record<string, unknown>;
  preview: ReportPreview;
};

export type BuildRunReportOptions = {
  mode: ReportMode;
  limits?: Partial<typeof DEFAULT_LIMITS>;
};

export async function buildRunReportView(
  cwd: string,
  spec: WorkflowSpec,
  index: RunIndex,
  options: BuildRunReportOptions
): Promise<RunReportView> {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const dir = runDir(index.logicalRunId, cwd);
  const summary = await runViewFromIndex(cwd, spec, index);
  const events = await readEvents(dir, limits);
  const attempts = await buildAttemptDetails(dir, index, limits);
  const stages = await buildStageDetails(dir, spec, index, events, attempts, limits);
  const artifacts = await collectArtifacts(stages);
  const graph = buildGraph(spec, stages);
  const diagnostics = [
    ...await readDiagnostics(dir, limits),
    ...await buildOutputSizeDiagnostics(dir, spec, attempts, limits),
    ...await buildRuntimeDiagnostics(dir, index, events, limits)
  ];

  return {
    version: REPORT_VIEW_VERSION,
    generatedAt: new Date().toISOString(),
    mode: options.mode,
    summary,
    run: {
      logicalRunId: index.logicalRunId,
      workflowName: index.workflowName,
      status: index.status,
      finalVerdict: index.finalVerdict,
      blockedReason: index.blockedReason,
      createdAt: index.createdAt,
      updatedAt: index.updatedAt,
      durationMs: terminalStatus(index.status) ? positiveDuration(index.createdAt, index.updatedAt) : undefined,
      runDir: dir,
      source: index.source
    },
    metrics: buildMetrics(stages, attempts, index),
    graph,
    stages,
    attempts,
    events,
    artifacts,
    diagnostics
  };
}

export function makePreview(text: string, limit: number, filePath?: string): ReportPreview {
  const originalChars = text.length;
  const truncated = originalChars > limit;
  return {
    text: truncated ? text.slice(0, limit) : text,
    truncated,
    originalChars: truncated ? originalChars : undefined,
    path: filePath
  };
}

async function buildAttemptDetails(dir: string, index: RunIndex, limits: typeof DEFAULT_LIMITS): Promise<ReportAttemptDetail[]> {
  return Promise.all(Object.values(index.attempts).map(async (attempt) => {
    const absolute = path.join(dir, attempt.path);
    const [prompt, raw, parse, output] = await Promise.all([
      readPreviewIfExists(path.join(absolute, "prompt.md"), limits.promptPreviewChars),
      readPreviewIfExists(path.join(absolute, "raw.txt"), limits.rawPreviewChars),
      readPreviewIfExists(path.join(absolute, "parse.json"), limits.outputPreviewChars),
      readPreviewIfExists(path.join(absolute, "output.json"), limits.outputPreviewChars)
    ]);
    return {
      id: attempt.id,
      stageId: attempt.stageId,
      itemId: attempt.itemId,
      kind: attempt.kind,
      status: attempt.status,
      startedAt: attempt.startedAt,
      endedAt: attempt.endedAt,
      durationMs: attempt.startedAt && attempt.endedAt ? positiveDuration(attempt.startedAt, attempt.endedAt) : undefined,
      blockedReason: attempt.blockedReason,
      parseErrorCode: attempt.parseErrorCode,
      runtimeErrorCode: attempt.runtimeErrorCode,
      runtimeRetryOf: attempt.runtimeRetryOf,
      runtimeRetryOrdinal: attempt.runtimeRetryOrdinal,
      runtimeRetryReason: attempt.runtimeRetryReason,
      path: attempt.path,
      prompt,
      raw,
      parse,
      output
    };
  }));
}

async function buildStageDetails(
  dir: string,
  spec: WorkflowSpec,
  index: RunIndex,
  events: ReportEvent[],
  attempts: ReportAttemptDetail[],
  limits: typeof DEFAULT_LIMITS
): Promise<ReportStageDetail[]> {
  return Promise.all(spec.stages.map(async (stage) => {
    const state = index.stages[stage.id];
    const outputPath = path.join(dir, "outputs", `${stage.id}.json`);
    const output = await readJsonIfExists(outputPath);
    const promptPath = await findPromptPath(dir, stage.id);
    const prompt = promptPath ? makePreview(await fs.readFile(promptPath, "utf8"), limits.promptPreviewChars, promptPath) : undefined;
    const relatedAttemptIds = attempts.filter((attempt) => attempt.stageId === stage.id).map((attempt) => attempt.id);
    const relatedEventIds = events
      .filter((event) => event.preview.text.includes(stage.id) || event.raw.stageId === stage.id || event.raw.fanoutStageId === stage.id)
      .map((event) => event.id);
    const roleName = stageRoleName(stage);
    const role = roleName ? spec.roles[roleName] : undefined;

    return {
      id: stage.id,
      kind: stage.kind,
      dependsOn: stage.dependsOn ?? [],
      status: state?.status ?? statusFromOutput(output),
      summary: stringField(output, "summary"),
      blockedReason: stringField(output, "blockedReason") ?? state?.blockedReason,
      roleName,
      roleCategory: role?.category,
      agent: role?.agent,
      mode: role?.mode,
      prompt,
      output: output === undefined ? undefined : makePreview(JSON.stringify(output, null, 2), limits.outputPreviewChars, outputPath),
      outputPath: output === undefined ? undefined : outputPath,
      outputShape: outputShape(output),
      outputParse: outputParseSummary(output),
      parseDiagnostics: parseDiagnosticsSummary(output),
      fanout: stage.kind === "fanout" ? await buildFanoutDetail(dir, state, limits) : undefined,
      decision: stage.kind === "decisionGate" ? buildDecisionDetail(stage, output) : undefined,
      fixLoop: stage.kind === "fixLoop" ? buildFixLoopDetail(stage, relatedAttemptIds.length) : undefined,
      relatedAttemptIds,
      relatedEventIds
    };
  }));
}

function buildGraph(spec: WorkflowSpec, stages: ReportStageDetail[]): RunReportView["graph"] {
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const nodes = spec.stages.map((stage): ReportGraphNode => {
    const detail = stageById.get(stage.id);
    const badges: string[] = [stage.kind];
    if (detail?.mode) badges.push(detail.mode);
    if (detail?.fanout?.totalItems !== undefined) badges.push(`${detail.fanout.completedItems ?? 0}/${detail.fanout.totalItems} items`);
    return {
      id: stage.id,
      label: stage.id,
      kind: stage.kind,
      status: detail?.status ?? "unknown",
      detailRef: stage.id,
      roleName: detail?.roleName,
      agent: detail?.agent,
      mode: detail?.mode,
      badges,
      metrics: graphMetrics(detail)
    };
  });
  const dependencyEdges = spec.stages.flatMap((stage) =>
    (stage.dependsOn ?? []).map((source) => ({
      id: `${source}->${stage.id}`,
      source,
      target: stage.id,
      relation: "dependency" as const
    }))
  );
  const decisionEdges = spec.stages
    .filter((stage): stage is Extract<Stage, { kind: "decisionGate" }> => stage.kind === "decisionGate")
    .flatMap((stage) => {
      const routes = new Set([...(stage.routes ?? []), ...stage.rules.map((rule) => rule.to), stage.default]);
      const output = stageById.get(stage.id);
      return [...routes].map((route) => ({
        id: `${stage.id}=>${route}`,
        source: stage.id,
        target: route,
        relation: "decision-route" as const,
        label: route,
        active: output?.decision?.matchedRoute === route
      }));
    });
  return { nodes, edges: [...dependencyEdges, ...decisionEdges] };
}

function buildMetrics(stages: ReportStageDetail[], attempts: ReportAttemptDetail[], index: RunIndex): RunReportView["metrics"] {
  return {
    stagesTotal: stages.length,
    stagesCompleted: stages.filter((stage) => stage.status === "completed").length,
    stagesBlocked: stages.filter((stage) => stage.status === "blocked").length,
    stagesFailed: stages.filter((stage) => stage.status === "failed").length,
    stagesRunning: stages.filter((stage) => stage.status === "running").length,
    stagesPending: stages.filter((stage) => stage.status === "pending" || stage.status === "ready").length,
    attemptsTotal: attempts.length,
    attemptsRunning: attempts.filter((attempt) => attempt.status === "running" || attempt.status === "repairing").length,
    attemptsCompleted: attempts.filter((attempt) => attempt.status === "completed").length,
    attemptsBlocked: attempts.filter((attempt) => attempt.status === "blocked").length,
    attemptsFailed: attempts.filter((attempt) => attempt.status === "failed").length,
    agentCallsPlanned: index.agentUsage.planned,
    agentCallsActual: index.agentUsage.actual,
    repairCalls: index.agentUsage.repairCalls,
    recoveryCalls: index.agentUsage.recoveryCalls
  };
}

async function buildFanoutDetail(dir: string, state: RunIndex["stages"][string] | undefined, limits: typeof DEFAULT_LIMITS): Promise<ReportStageDetail["fanout"]> {
  if (!state?.fanout) return undefined;
  const items = await Promise.all(state.fanout.items.slice(0, limits.fanoutItemLimit).map(async (item) => {
    const outputPath = item.outputPath ? path.join(dir, item.outputPath) : undefined;
    const output = outputPath ? await readJsonIfExists(outputPath) : undefined;
    return {
      id: item.id,
      status: item.status,
      summary: stringField(output, "summary"),
      outputPath,
      output: output === undefined || !outputPath ? undefined : makePreview(JSON.stringify(output, null, 2), limits.outputPreviewChars, outputPath),
      blockedReason: item.blockedReason ?? stringField(output, "blockedReason"),
      errorCode: item.errorCode,
      errorMessage: item.errorMessage
    };
  }));
  return {
    totalItems: state.fanout.totalItems,
    completedItems: state.fanout.completedItems,
    blockedItems: state.fanout.blockedItems,
    failedItems: state.fanout.failedItems,
    displayedItems: items.length,
    allowPartial: state.fanout.allowPartial,
    items
  };
}

async function collectArtifacts(stages: ReportStageDetail[]): Promise<ReportArtifact[]> {
  const result: ReportArtifact[] = [];
  for (const stage of stages) {
    if (!stage.outputPath) continue;
    const output = await readJsonIfExists(stage.outputPath);
    const artifacts = Array.isArray(output?.artifacts) ? output.artifacts as ReportArtifact[] : [];
    result.push(...artifacts.map((artifact) => ({ ...artifact, stageId: stage.id })));
  }
  return result;
}

async function readEvents(dir: string, limits: typeof DEFAULT_LIMITS): Promise<ReportEvent[]> {
  try {
    const text = await fs.readFile(path.join(dir, "events.ndjson"), "utf8");
    return text.trim().split("\n").filter(Boolean).slice(-limits.eventLimit).map((line, index) => {
      const raw = safeJson(line) as Record<string, unknown>;
      return {
        id: `event-${index + 1}`,
        at: typeof raw.at === "string" ? raw.at : undefined,
        type: typeof raw.type === "string" ? raw.type : undefined,
        preview: makePreview(JSON.stringify(raw, null, 2), limits.outputPreviewChars),
        raw
      };
    });
  } catch {
    return [];
  }
}

async function readDiagnostics(dir: string, limits: typeof DEFAULT_LIMITS): Promise<ReportDiagnostic[]> {
  try {
    const diagnosticDir = path.join(dir, "diagnostics");
    const entries = await fs.readdir(diagnosticDir);
    return Promise.all(entries.filter((entry) => entry.endsWith(".json")).map(async (entry) => {
      const filePath = path.join(diagnosticDir, entry);
      const text = await fs.readFile(filePath, "utf8");
      const parsed = safeJson(text) as Record<string, unknown>;
      return {
        id: path.basename(entry, ".json"),
        path: filePath,
        status: stringField(parsed, "status"),
        summary: stringField(parsed, "summary"),
        preview: makePreview(text, limits.outputPreviewChars, filePath)
      };
    }));
  } catch {
    return [];
  }
}

async function buildRuntimeDiagnostics(dir: string, index: RunIndex, events: ReportEvent[], limits: typeof DEFAULT_LIMITS): Promise<ReportDiagnostic[]> {
  const diagnostics: ReportDiagnostic[] = [];
  if (index.blockedReason && isRunLevelRuntimeCode(index.blockedReason)) {
    diagnostics.push(runtimeDiagnostic({
      code: index.blockedReason,
      path: path.join(dir, "run.json"),
      summary: runLevelBlockedSummary(index),
      limits
    }));
  }
  for (const stage of Object.values(index.stages)) {
    if (!stage.fanout && stage.blockedReason === RuntimeErrorCodes.AGENT_RUNTIME_ERROR) {
      const outputPath = stage.outputPath ? path.join(dir, stage.outputPath) : path.join(dir, "outputs", `${stage.stageId}.json`);
      diagnostics.push(runtimeDiagnostic({
        code: RuntimeErrorCodes.AGENT_RUNTIME_ERROR,
        stageId: stage.stageId,
        path: outputPath,
        summary: "Agent runtime failed after one retry.",
        limits
      }));
    }
    if (!stage.fanout) continue;
    const hasRunningItems = stage.fanout.items.some((item) => item.status === "running");
    const queuedItems = stage.fanout.items.filter((item) => item.status === "pending" || item.status === "ready");
    if (stage.status === "running" && !hasRunningItems && queuedItems.length > 0) {
      diagnostics.push(runtimeDiagnostic({
        code: RuntimeErrorCodes.FANOUT_STAGE_STUCK_PENDING_BATCH,
        stageId: stage.stageId,
        path: path.join(dir, "run.json"),
        summary: `Fanout stage ${stage.stageId} is running with no running items and ${queuedItems.length} queued item(s).`,
        limits
      }));
    }
    for (const item of stage.fanout.items) {
      const outputPath = item.outputPath ? path.join(dir, item.outputPath) : path.join(dir, "outputs", stage.stageId, `${safeFileName(item.id)}.json`);
      const outputExists = await fileExists(outputPath);
      if (item.status === "running" && outputExists) {
        diagnostics.push(runtimeDiagnostic({
          code: RuntimeErrorCodes.RUN_INDEX_OUTPUT_MISMATCH,
          stageId: stage.stageId,
          itemId: item.id,
          path: outputPath,
          summary: `Fanout item ${stage.stageId}/${item.id} is running in run.json but has an output file.`,
          limits
        }));
      }
      if (item.errorCode) {
        diagnostics.push(runtimeDiagnostic({
          code: item.errorCode,
          stageId: stage.stageId,
          itemId: item.id,
          path: outputPath,
          summary: item.errorMessage ?? item.blockedReason ?? item.errorCode,
          limits
        }));
      }
    }
  }

  const recoveryVerdictDiagnostic = buildRecoverySucceededWithBlockedVerdictDiagnostic(dir, index, limits);
  if (recoveryVerdictDiagnostic) diagnostics.push(recoveryVerdictDiagnostic);

  for (const event of events) {
    const text = event.preview.text;
    const rawCode = typeof event.raw.code === "string" ? event.raw.code : undefined;
    const rawErrorCode = typeof event.raw.errorCode === "string" ? event.raw.errorCode : undefined;
    const lockContention = text.includes("Lock file is already being held")
      || rawCode === RuntimeErrorCodes.RUN_INDEX_LOCK_TIMEOUT
      || rawCode === RuntimeErrorCodes.EVENT_APPEND_LOCK_TIMEOUT
      || rawErrorCode === RuntimeErrorCodes.RUN_INDEX_LOCK_TIMEOUT
      || rawErrorCode === RuntimeErrorCodes.EVENT_APPEND_LOCK_TIMEOUT;
    if (!lockContention) continue;
    diagnostics.push(runtimeDiagnostic({
      code: rawCode ?? rawErrorCode ?? "LOCK_CONTENTION",
      stageId: typeof event.raw.stageId === "string" ? event.raw.stageId : undefined,
      itemId: typeof event.raw.itemId === "string" ? event.raw.itemId : undefined,
      path: path.join(dir, "events.ndjson"),
      summary: "Runtime lock contention was observed in events.",
      limits,
      raw: event.raw
    }));
  }
  return diagnostics;
}

async function buildOutputSizeDiagnostics(
  dir: string,
  spec: WorkflowSpec,
  attempts: ReportAttemptDetail[],
  limits: typeof DEFAULT_LIMITS
): Promise<ReportDiagnostic[]> {
  const stageById = new Map(spec.stages.map((stage) => [stage.id, stage]));
  const byStage = new Map<string, Array<{ id: string; kind: string; rawChars: number; rawPath: string }>>();
  const stageLimits = new Map<string, number>();
  for (const attempt of attempts) {
    if (attempt.parseErrorCode !== "OUTPUT_PARSE_FAILED") continue;
    const stage = stageById.get(attempt.stageId);
    const effectiveMaxOutputChars = effectiveMaxOutputCharsForStage(spec, stage);
    if (effectiveMaxOutputChars === undefined) continue;
    const rawPath = path.join(dir, attempt.path, "raw.txt");
    const rawChars = await readTextLengthIfExists(rawPath);
    if (rawChars === undefined || rawChars <= effectiveMaxOutputChars) continue;
    const entries = byStage.get(attempt.stageId) ?? [];
    entries.push({ id: attempt.id, kind: attempt.kind, rawChars, rawPath });
    byStage.set(attempt.stageId, entries);
    stageLimits.set(attempt.stageId, effectiveMaxOutputChars);
  }
  return [...byStage.entries()].map(([stageId, attemptEntries]) => {
    const effectiveMaxOutputChars = stageLimits.get(stageId);
    const summary = `Stage ${stageId} output exceeded effective maxOutputChars (${effectiveMaxOutputChars}).`;
    const raw = {
      code: ReportDiagnosticCodes.OUTPUT_MAX_CHARS_EXCEEDED,
      stageId,
      effectiveMaxOutputChars,
      attempts: attemptEntries
    };
    return {
      id: `runtime-${ReportDiagnosticCodes.OUTPUT_MAX_CHARS_EXCEEDED}-${stageId}`,
      path: attemptEntries[0]?.rawPath ?? path.join(dir, "attempts", stageId),
      code: ReportDiagnosticCodes.OUTPUT_MAX_CHARS_EXCEEDED,
      stageId,
      status: "blocked",
      summary,
      raw,
      preview: makePreview(JSON.stringify(raw, null, 2), limits.outputPreviewChars, attemptEntries[0]?.rawPath)
    };
  });
}

function buildRecoverySucceededWithBlockedVerdictDiagnostic(
  dir: string,
  index: RunIndex,
  limits: typeof DEFAULT_LIMITS
): ReportDiagnostic | undefined {
  if (!isBlockedFinalVerdictCode(index.blockedReason) || !index.finalVerdict) return undefined;
  const recoveredFanoutStages = Object.values(index.stages).filter((stage) => {
    if (!stage.fanout) return false;
    if (stage.fanout.items.some((item) => item.status === "running" || item.status === "pending" || item.status === "ready")) return false;
    return stage.fanout.items.some((item) =>
      item.errorCode === RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR
      || item.errorCode === RuntimeErrorCodes.FANOUT_ITEM_UNSTARTED_TIMEOUT
      || item.errorCode === RuntimeErrorCodes.RUN_INDEX_OUTPUT_MISMATCH
    );
  });
  if (recoveredFanoutStages.length === 0) return undefined;
  const stageIds = recoveredFanoutStages.map((stage) => stage.stageId);
  const summary = `Scheduler recovery completed for fanout stage(s) ${stageIds.join(", ")}, but workflow verdict remains ${index.finalVerdict}.`;
  const raw = {
    code: ReportDiagnosticCodes.SCHEDULER_RECOVERY_SUCCEEDED_WITH_BLOCKED_VERDICT,
    finalVerdict: index.finalVerdict,
    blockedReason: index.blockedReason,
    recoveredFanoutStages: stageIds
  };
  return {
    id: `runtime-${ReportDiagnosticCodes.SCHEDULER_RECOVERY_SUCCEEDED_WITH_BLOCKED_VERDICT}-run-all`,
    path: path.join(dir, "run.json"),
    code: ReportDiagnosticCodes.SCHEDULER_RECOVERY_SUCCEEDED_WITH_BLOCKED_VERDICT,
    status: "completed",
    summary,
    raw,
    preview: makePreview(JSON.stringify(raw, null, 2), limits.outputPreviewChars, path.join(dir, "run.json"))
  };
}

function effectiveMaxOutputCharsForStage(spec: WorkflowSpec, stage: Stage | undefined): number | undefined {
  return stage?.limits?.maxOutputChars ?? spec.limits.maxOutputChars;
}

async function readTextLengthIfExists(filePath: string): Promise<number | undefined> {
  try {
    return (await fs.readFile(filePath, "utf8")).length;
  } catch {
    return undefined;
  }
}

function isRunLevelRuntimeCode(value: string): boolean {
  return value === RuntimeErrorCodes.FINAL_VERDICT_BLOCKED
    || value === RuntimeErrorCodes.FINAL_VERDICT_FAILED
    || value === RuntimeErrorCodes.FINAL_VERDICT_UNKNOWN
    || value === RuntimeErrorCodes.LIMIT_AGENT_BUDGET_EXHAUSTED
    || value === RuntimeErrorCodes.AGENT_RUNTIME_ERROR;
}

function isBlockedFinalVerdictCode(value: string | undefined): boolean {
  return value === RuntimeErrorCodes.FINAL_VERDICT_BLOCKED
    || value === RuntimeErrorCodes.FINAL_VERDICT_FAILED
    || value === RuntimeErrorCodes.FINAL_VERDICT_UNKNOWN;
}

function runLevelBlockedSummary(index: RunIndex): string {
  if (index.blockedReason === RuntimeErrorCodes.LIMIT_AGENT_BUDGET_EXHAUSTED) {
    return `Ready agent work could not start because actual agent calls reached limits.maxAgents (${index.agentUsage.actual}/${index.agentUsage.planned}).`;
  }
  if (index.blockedReason === RuntimeErrorCodes.AGENT_RUNTIME_ERROR) return "Agent runtime failed after one retry.";
  if (index.finalVerdict === "blocked") return "Summarizer returned finalVerdict=blocked.";
  if (index.finalVerdict === "failed") return "Summarizer returned finalVerdict=failed.";
  return "Summarizer returned finalVerdict=unknown.";
}

function runtimeDiagnostic(input: {
  code: string;
  path: string;
  summary: string;
  limits: typeof DEFAULT_LIMITS;
  stageId?: string;
  itemId?: string;
  raw?: Record<string, unknown>;
}): ReportDiagnostic {
  const body = input.raw ?? {
    code: input.code,
    stageId: input.stageId,
    itemId: input.itemId,
    summary: input.summary,
    path: input.path
  };
  return {
    id: `runtime-${input.code}-${input.stageId ?? "run"}-${input.itemId ?? "all"}`,
    path: input.path,
    code: input.code,
    stageId: input.stageId,
    itemId: input.itemId,
    status: "blocked",
    summary: input.summary,
    raw: body,
    preview: makePreview(JSON.stringify(body, null, 2), input.limits.outputPreviewChars, input.path)
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readPreviewIfExists(filePath: string, limit: number): Promise<ReportPreview | undefined> {
  try {
    return makePreview(await fs.readFile(filePath, "utf8"), limit, filePath);
  } catch {
    return undefined;
  }
}

async function findPromptPath(dir: string, stageId: string): Promise<string | undefined> {
  const direct = path.join(dir, "prompts", `${stageId}.md`);
  try {
    await fs.access(direct);
    return direct;
  } catch {
    return undefined;
  }
}

async function readJsonIfExists(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function stageRoleName(stage: Stage): string | undefined {
  if (stage.kind === "agentTask" || stage.kind === "fanout" || stage.kind === "summarize") return stage.role;
  if (stage.kind === "discover" || stage.kind === "reduce" || stage.kind === "decisionGate") return stage.role;
  if (stage.kind === "fixLoop") return stage.validator.role;
  return undefined;
}

function statusFromOutput(output: Record<string, unknown> | undefined): ReportStageStatus {
  const status = output?.status;
  if (status === "completed" || status === "blocked" || status === "failed" || status === "running" || status === "pending" || status === "skipped") return status;
  return "pending";
}

function outputShape(output: Record<string, unknown> | undefined): ReportStageDetail["outputShape"] {
  if (!output) return undefined;
  return {
    keys: Object.keys(output),
    status: stringField(output, "status"),
    verdict: stringField(output, "verdict"),
    finalVerdict: stringField(output, "finalVerdict"),
    findingsCount: Array.isArray(output.findings) ? output.findings.length : undefined,
    checksCount: Array.isArray(output.checks) ? output.checks.length : undefined,
    artifactsCount: Array.isArray(output.artifacts) ? output.artifacts.length : undefined
  };
}

function outputParseSummary(output: Record<string, unknown> | undefined): ReportStageDetail["outputParse"] {
  const outputParse = objectRecord(objectRecord(output?.metadata)?.outputParse);
  if (!outputParse) return undefined;
  return {
    mode: stringField(outputParse, "mode"),
    repaired: typeof outputParse.repaired === "boolean" ? outputParse.repaired : undefined,
    candidateCount: typeof outputParse.candidateCount === "number" ? outputParse.candidateCount : undefined,
    warnings: stringArray(outputParse.warnings)
  };
}

function parseDiagnosticsSummary(output: Record<string, unknown> | undefined): ReportStageDetail["parseDiagnostics"] {
  const diagnostics = objectRecord(output?.parseDiagnostics);
  if (!diagnostics) return undefined;
  return {
    errorCode: stringField(diagnostics, "errorCode"),
    candidateCount: typeof diagnostics.candidateCount === "number" ? diagnostics.candidateCount : undefined,
    bestCandidateId: stringField(diagnostics, "bestCandidateId"),
    recoverability: stringField(diagnostics, "recoverability"),
    schemaErrors: schemaErrorsFromDiagnostics(diagnostics)
  };
}

function schemaErrorsFromDiagnostics(diagnostics: Record<string, unknown>): Array<{ path?: string; message?: string }> {
  const candidates = Array.isArray(diagnostics.candidates) ? diagnostics.candidates : [];
  return candidates.flatMap((candidate) => {
    const schemaErrors = Array.isArray(objectRecord(candidate)?.schemaErrors) ? objectRecord(candidate)?.schemaErrors as unknown[] : [];
    return schemaErrors.map((error) => ({
      path: stringField(objectRecord(error), "path"),
      message: stringField(objectRecord(error), "message")
    }));
  }).slice(0, 12);
}

function buildDecisionDetail(stage: Extract<Stage, { kind: "decisionGate" }>, output: Record<string, unknown> | undefined): ReportStageDetail["decision"] {
  const routes = [...new Set([...(stage.routes ?? []), ...stage.rules.map((rule) => rule.to), stage.default])];
  return {
    matchedRoute: stringField(output, "route"),
    defaultRoute: stage.default,
    routes
  };
}

function buildFixLoopDetail(stage: Extract<Stage, { kind: "fixLoop" }>, attemptCount: number): ReportStageDetail["fixLoop"] {
  return {
    maxRounds: stage.maxRounds,
    observedRounds: attemptCount
  };
}

function graphMetrics(detail: ReportStageDetail | undefined): Record<string, string | number | boolean> {
  const metrics: Record<string, string | number | boolean> = {};
  if (detail?.outputParse?.candidateCount !== undefined) metrics.parseCandidates = detail.outputParse.candidateCount;
  if (detail?.fanout?.totalItems !== undefined) metrics.totalItems = detail.fanout.totalItems;
  if (detail?.relatedAttemptIds.length) metrics.attempts = detail.relatedAttemptIds.length;
  return metrics;
}

function terminalStatus(status: RunViewStatus): boolean {
  return status === "completed" || status === "blocked" || status === "diagnosed_blocked" || status === "failed" || status === "cancelled";
}

function positiveDuration(start: string, end: string): number | undefined {
  const duration = Date.parse(end) - Date.parse(start);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" ? field : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function safeFileName(value: string): string {
  return String(value || "item").replace(/[^A-Za-z0-9_.-]/g, "_");
}
