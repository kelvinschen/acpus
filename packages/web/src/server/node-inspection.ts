import type { ArtifactRecord, RunInspection } from "@acpus/runtime";
import type { ExprIR, JsonValue, TemplateIR } from "@acpus/expression/ir";

export type NodeInspectionTarget = {
  kind: "static-node" | "dynamic-node" | "frame" | "attempt" | "unknown";
  id: string;
};

export type NodeInspectionContext = Array<{
  nodeId: string;
  kind: "fanout" | "loop";
  itemKey?: string;
  itemIndex?: number;
  iteration?: number;
}>;

export type NodeInspectionResponse = {
  target: NodeInspectionTarget;
  staticNode?: RunInspection["staticNodes"][number];
  summary: NodeInspectionSummary;
  instances: NonNullable<RunInspection["run"]["dynamic"]>["nodeInstances"];
  frames: NonNullable<RunInspection["run"]["dynamic"]>["frames"];
  attempts: NonNullable<RunInspection["run"]["dynamic"]>["attempts"];
  signalWaits: NonNullable<RunInspection["run"]["dynamic"]>["signalWaits"];
  executionMetadata: NonNullable<RunInspection["run"]["dynamic"]>["executionMetadata"];
  artifacts: ArtifactRecord[];
};

export type NodeInspectionSummary = {
  targetKind: NodeInspectionTarget["kind"];
  targetId: string;
  runStatus: string;
  runStartedAt?: string;
  runFinishedAt?: string;
  runDurationMs?: number;
  nodeId?: string;
  nodeKey?: string;
  frameKey?: string;
  nodeStatus?: string;
  staticKind?: string;
  staticOrder?: number;
  input?: {
    kind: "runtime" | "authored";
    value: unknown;
  };
  output?: unknown;
  error?: unknown;
  prompt?: {
    kind: "signal" | "artifact" | "authored";
    text?: string;
    artifactId?: string;
    relativePath?: string;
    mediaType?: string;
  };
  latestAttempt?: {
    attemptId: string;
    attemptNo: number;
    status: string;
    startedAt: string;
    finishedAt?: string;
    error?: unknown;
    result?: unknown;
  };
  loopProgress?: {
    frameKey: string;
    index: number;
    round: number;
    state?: unknown;
    stop?: boolean;
    transition?: unknown;
    activeIterationFrameKey?: string;
    activeChildNodeKeys: string[];
  };
  artifacts: ArtifactRecord[];
};

export type NodeExecutionInspection = {
  target: NodeInspectionTarget;
  nodeId?: string;
  nodeKey?: string;
  attemptId?: string;
  available: boolean;
  reason?: string;
  summary: {
    status?: string;
    sessionName?: string;
    turnCount?: number;
    message?: string;
  };
  lastActiveAt?: string;
  contextWindow?: {
    used?: number;
    size?: number;
    percent?: number;
    updatedAt?: string;
  };
  tokenUsage?: {
    source?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  output?: {
    tail: string;
    totalBytes: number;
    truncated: boolean;
  };
  toolCallCount?: number;
  lastToolCalls: Array<{
    turn: number;
    toolCallId?: string;
    toolName?: string;
    status?: string;
    startedAt?: string;
    updatedAt?: string;
    completedAt?: string;
    durationMs?: number;
    inputPreview?: string;
    outputPreview?: string;
  }>;
};

export function inspectNode(inspection: RunInspection, target: string, artifacts: ArtifactRecord[], context: NodeInspectionContext = []): NodeInspectionResponse {
  const dynamic = inspection.run.dynamic;
  const staticNode = inspection.staticNodes.find(node => node.nodeId === target);
  const scoped = context.length > 0;

  const instances = (dynamic?.nodeInstances.filter(
    instance => (instance.nodeKey === target || instance.nodeId === target) && (!scoped || pathMatchesContext(instance.instancePath, context)),
  ) ?? []);
  const instanceKeys = new Set(instances.map(instance => instance.nodeKey));

  const frames = dynamic?.frames.filter(
    frame => (frame.frameKey === target || frame.nodeKey === target || frame.nodeId === target)
      && (!scoped || pathMatchesContext(frame.instancePath, context)),
  ) ?? [];
  const frameKeys = new Set(frames.map(frame => frame.frameKey));

  const attempts = dynamic?.attempts.filter(attempt => {
    const matchesTarget = attempt.attemptId === target || attempt.nodeKey === target || attempt.nodeId === target || instanceKeys.has(attempt.nodeKey);
    if (!matchesTarget) return false;
    return !scoped || instanceKeys.has(attempt.nodeKey);
  }) ?? [];

  const signalWaits = dynamic?.signalWaits.filter(
    wait => (wait.nodeKey === target || wait.nodeId === target || instanceKeys.has(wait.nodeKey))
      && (!scoped || instanceKeys.has(wait.nodeKey)),
  ) ?? [];

  const executionMetadata = dynamic?.executionMetadata.filter(
    item => itemMatchesAttempt(item, attempts.map(a => a.attemptId)),
  ) ?? [];

  const targetKeys = new Set([
    target,
    ...instances.map(instance => instance.nodeKey),
    ...attempts.map(attempt => attempt.nodeKey),
    ...signalWaits.map(wait => wait.nodeKey),
    ...frameKeys,
  ]);
  const filteredArtifacts = artifacts.filter(a => targetKeys.has(a.nodeKey));
  const classifiedTarget = classifyTarget({
    target,
    staticNode: Boolean(staticNode),
    dynamicNode: instances.some(i => i.nodeKey === target),
    frame: frames.some(f => f.frameKey === target),
    attempt: attempts.some(a => a.attemptId === target),
  });
  const leafArtifacts = staticNode === undefined || isLeafKind(staticNode.kind) ? filteredArtifacts : [];

  return {
    target: classifiedTarget,
    ...(staticNode === undefined ? {} : { staticNode }),
    summary: summarizeNode({
      target: classifiedTarget,
      run: inspection.run,
      staticNode,
      instances,
      frames,
      attempts,
      signalWaits,
      executionMetadata,
      artifacts: leafArtifacts,
    }),
    instances,
    frames,
    attempts,
    signalWaits,
    executionMetadata,
    artifacts: filteredArtifacts,
  };
}

export async function inspectNodeExecution(
  inspection: RunInspection,
  target: string,
  context: NodeInspectionContext = [],
  loadTelemetryArtifact?: (artifactRef: unknown) => Promise<unknown | undefined>,
): Promise<NodeExecutionInspection> {
  const response = inspectNode(inspection, target, [], context);
  const progress = latestAgentProgress(inspection, response, target, context.length > 0);
  const agentEntries = response.executionMetadata.filter(item => item.kind === "agent_attempt");
  const agentEntry = latestBy(progress?.attemptId ? agentEntries.filter(item => item.attemptId === progress.attemptId) : agentEntries, item => item.createdAt);
  const metadata = agentEntry?.metadata;
  const turns = agentTurns(metadata);
  const progressToolCalls = toolCallsFromProgress(progress);
  const metadataToolCalls = loadTelemetryArtifact && turns.length > 0
    ? (await Promise.all(turns.map(turn => toolCallsForTurn(turn, loadTelemetryArtifact)))).flat().slice(-3)
    : undefined;
  const lastToolCalls = metadataToolCalls ?? progressToolCalls ?? [];
  const contextWindow = contextWindowFromProgress(progress) ?? latestContextWindow(turns);
  const tokenUsage = aggregateTokenUsage(turns) ?? tokenUsageFromProgress(progress);
  const toolCallCount = totalToolCallCount(turns) ?? toolCallCountFromProgress(progress);
  const available = progress !== undefined || agentEntry !== undefined;
  const attemptId = progress?.attemptId ?? agentEntry?.attemptId;
  return {
    target: response.target,
    ...(response.summary.nodeId ? { nodeId: response.summary.nodeId } : {}),
    ...(response.summary.nodeKey ? { nodeKey: response.summary.nodeKey } : {}),
    ...(attemptId ? { attemptId } : {}),
    available,
    ...(available ? {} : { reason: "No agent execution metadata exists for the selected scope." }),
    summary: { ...agentExecutionSummary(metadata), ...agentProgressSummary(progress) },
    ...(progress?.updatedAt ? { lastActiveAt: progress.updatedAt } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
    ...(progress?.output ? { output: progress.output } : {}),
    ...(toolCallCount === undefined ? {} : { toolCallCount }),
    lastToolCalls,
  };
}

function summarizeNode(input: {
  target: NodeInspectionTarget;
  run: RunInspection["run"];
  staticNode: RunInspection["staticNodes"][number] | undefined;
  instances: NodeInspectionResponse["instances"];
  frames: NodeInspectionResponse["frames"];
  attempts: NodeInspectionResponse["attempts"];
  signalWaits: NodeInspectionResponse["signalWaits"];
  executionMetadata: NodeInspectionResponse["executionMetadata"];
  artifacts: ArtifactRecord[];
}): NodeInspectionSummary {
  const latestAttempt = latestBy(input.attempts, attempt => attempt.startedAt);
  const latestInstance = latestBy(input.instances, instance => instance.updatedAt);
  const latestFrame = latestBy(input.frames, frame => frame.updatedAt);
  const loopProgress = summarizeLoopProgress(input.frames);
  const signalWait = latestBy(input.signalWaits, wait => wait.updatedAt ?? wait.createdAt);
  const promptArtifact = input.artifacts.find(artifact => artifact.relativePath.endsWith("prompt.md"))
    ?? input.artifacts.find(artifact => artifact.relativePath.includes("/prompt."));
  const authoredPrompt = input.staticNode?.prompt ? renderTemplate(input.staticNode.prompt) : undefined;
  const taskMetadata = latestBy(input.executionMetadata.filter(item => item.kind === "task_attempt"), item => item.createdAt)?.metadata;
  const taskInput = metadataRecord(taskMetadata)?.input;
  const authoredInput = input.staticNode?.kind === "task" && input.staticNode.input
    ? Object.fromEntries(Object.entries(input.staticNode.input).map(([key, expr]) => [key, renderExpr(expr)]))
    : undefined;
  const nodeId = latestInstance?.nodeId ?? latestAttempt?.nodeId ?? latestFrame?.nodeId ?? input.staticNode?.nodeId;
  const nodeKey = latestInstance?.nodeKey ?? latestAttempt?.nodeKey;
  const nodeStatus = latestInstance?.status ?? latestAttempt?.status ?? latestFrame?.status ?? (input.staticNode ? "not_started" : undefined);
  const runDuration = durationMs(input.run.createdAt, input.run.updatedAt);
  return {
    targetKind: input.target.kind,
    targetId: input.target.id,
    runStatus: input.run.status,
    runStartedAt: input.run.createdAt,
    ...(isTerminalRunStatus(input.run.status) ? {
      runFinishedAt: input.run.updatedAt,
      ...(runDuration === undefined ? {} : { runDurationMs: runDuration }),
    } : {}),
    ...(input.staticNode ? { staticKind: input.staticNode.kind, staticOrder: input.staticNode.order } : {}),
    ...(nodeId !== undefined ? { nodeId } : {}),
    ...(nodeKey !== undefined ? { nodeKey } : {}),
    ...(latestFrame?.frameKey ? { frameKey: latestFrame.frameKey } : {}),
    ...(nodeStatus !== undefined ? { nodeStatus } : {}),
    ...(taskInput !== undefined ? { input: { kind: "runtime", value: taskInput } } : authoredInput !== undefined ? { input: { kind: "authored", value: authoredInput } } : {}),
    ...(latestInstance?.output !== undefined ? { output: latestInstance.output } : latestAttempt?.result !== undefined ? { output: latestAttempt.result } : latestFrame?.result !== undefined ? { output: latestFrame.result } : {}),
    ...(latestInstance?.error !== undefined ? { error: latestInstance.error } : latestAttempt?.error !== undefined ? { error: latestAttempt.error } : latestFrame?.error !== undefined ? { error: latestFrame.error } : {}),
    ...(signalWait?.renderedPrompt
      ? { prompt: { kind: "signal", text: signalWait.renderedPrompt } }
      : promptArtifact
        ? { prompt: { kind: "artifact", artifactId: promptArtifact.id, relativePath: promptArtifact.relativePath, ...(promptArtifact.mediaType !== undefined ? { mediaType: promptArtifact.mediaType } : {}) } }
        : authoredPrompt !== undefined
          ? { prompt: { kind: input.staticNode?.kind === "signal" ? "signal" : "authored", text: authoredPrompt } }
        : {}),
    ...(latestAttempt ? {
      latestAttempt: {
        attemptId: latestAttempt.attemptId,
        attemptNo: latestAttempt.attemptNo,
        status: latestAttempt.status,
        startedAt: latestAttempt.startedAt,
        ...(latestAttempt.finishedAt ? { finishedAt: latestAttempt.finishedAt } : {}),
        ...(latestAttempt.error !== undefined ? { error: latestAttempt.error } : {}),
        ...(latestAttempt.result !== undefined ? { result: latestAttempt.result } : {}),
      },
    } : {}),
    ...(loopProgress === undefined ? {} : { loopProgress }),
    artifacts: input.artifacts,
  };
}

function summarizeLoopProgress(frames: NodeInspectionResponse["frames"]): NodeInspectionSummary["loopProgress"] | undefined {
  const loopFrame = latestBy(frames.filter(frame => frame.frameKind === "loop" && loopRecord(frame.loop)), frame => frame.updatedAt);
  const loop = loopRecord(loopFrame?.loop);
  if (!loopFrame || !loop) return undefined;
  const activeIterationFrame = frames.find(frame =>
    frame.frameKind === "loop_iteration"
      && frame.instancePath !== undefined
      && pathMatchesContext(frame.instancePath, [{ nodeId: loopFrame.nodeId ?? "", kind: "loop", iteration: loop.index }]));
  const activeChildNodeKeys = Object.values(scopeRecord(activeIterationFrame?.scope) ?? {}).filter((value): value is string => typeof value === "string").sort();
  const stop = transitionStop(loop.transition);
  return {
    frameKey: loopFrame.frameKey,
    index: loop.index,
    round: loop.round,
    ...(loop.state === undefined ? {} : { state: loop.state }),
    ...(stop === undefined ? {} : { stop }),
    ...(loop.transition === undefined ? {} : { transition: loop.transition }),
    ...(activeIterationFrame?.frameKey === undefined ? {} : { activeIterationFrameKey: activeIterationFrame.frameKey }),
    activeChildNodeKeys,
  };
}

function loopRecord(value: unknown): { index: number; round: number; state?: unknown; transition?: unknown } | undefined {
  const record = metadataRecord(value);
  if (!record || typeof record.index !== "number" || typeof record.round !== "number") return undefined;
  return {
    index: record.index,
    round: record.round,
    ...(record.state === undefined ? {} : { state: record.state }),
    ...(record.transition === undefined ? {} : { transition: record.transition }),
  };
}

function scopeRecord(value: unknown): Record<string, unknown> | undefined {
  return metadataRecord(value);
}

function transitionStop(value: unknown): boolean | undefined {
  const record = metadataRecord(value);
  return typeof record?.stop === "boolean" ? record.stop : undefined;
}

function classifyTarget(input: {
  target: string;
  staticNode: boolean;
  dynamicNode: boolean;
  frame: boolean;
  attempt: boolean;
}): NodeInspectionTarget {
  if (input.attempt) return { kind: "attempt", id: input.target };
  if (input.dynamicNode) return { kind: "dynamic-node", id: input.target };
  if (input.frame) return { kind: "frame", id: input.target };
  if (input.staticNode) return { kind: "static-node", id: input.target };
  return { kind: "unknown", id: input.target };
}

function itemMatchesAttempt(item: { attemptId?: string }, attemptIds: string[]): boolean {
  return item.attemptId !== undefined && attemptIds.includes(item.attemptId);
}

function pathMatchesContext(path: unknown, context: NodeInspectionContext): boolean {
  if (!Array.isArray(path)) return context.length === 0;
  return context.every(selection => path.some(segment => segmentMatchesSelection(segment, selection)));
}

function segmentMatchesSelection(segment: unknown, selection: NodeInspectionContext[number]): boolean {
  if (!segment || typeof segment !== "object") return false;
  const record = segment as Record<string, unknown>;
  if (selection.kind === "fanout") {
    return record.kind === "fanout"
      && record.nodeId === selection.nodeId
      && (selection.itemIndex === undefined || record.itemIndex === selection.itemIndex)
      && (selection.itemKey === undefined || String(record.itemKey) === String(selection.itemKey));
  }
  return record.kind === "loop"
    && record.nodeId === selection.nodeId
    && record.iter === selection.iteration;
}

function metadataRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function agentTurns(metadata: unknown): Record<string, unknown>[] {
  const turns = metadataRecord(metadata)?.turns;
  if (!Array.isArray(turns)) return [];
  return turns.flatMap(turn => {
    const record = metadataRecord(turn);
    return record ? [record] : [];
  });
}

function agentExecutionSummary(metadata: unknown): NodeExecutionInspection["summary"] {
  const record = metadataRecord(metadata);
  if (!record) return {};
  return {
    ...(typeof record.status === "string" ? { status: record.status } : {}),
    ...(typeof record.sessionName === "string" ? { sessionName: record.sessionName } : {}),
    ...(typeof record.turnCount === "number" ? { turnCount: record.turnCount } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
  };
}

type NodeProgress = NonNullable<RunInspection["run"]["dynamic"]>["progress"][number];

function latestAgentProgress(inspection: RunInspection, response: NodeInspectionResponse, target: string, scoped: boolean): NodeProgress | undefined {
  const attemptIds = new Set(response.attempts.map(attempt => attempt.attemptId));
  const attemptScoped = scoped || response.target.kind === "attempt";
  const nodeKeys = new Set([
    ...response.instances.map(instance => instance.nodeKey),
    ...response.attempts.map(attempt => attempt.nodeKey),
    response.summary.nodeKey,
  ].filter((value): value is string => typeof value === "string"));
  return latestBy((inspection.run.dynamic?.progress ?? []).filter(progress => {
    if (progress.kind !== "agent") return false;
    if (progress.attemptId !== undefined) {
      if (attemptIds.has(progress.attemptId)) return true;
      if (attemptScoped) return false;
    }
    if (attemptScoped) return false;
    if (nodeKeys.has(progress.nodeKey)) return true;
    if (scoped) return false;
    return progress.nodeKey === target || progress.nodeId === target;
  }), progress => progress.updatedAt);
}

function agentProgressSummary(progress: NodeProgress | undefined): NodeExecutionInspection["summary"] {
  if (!progress) return {};
  return {
    status: progress.status,
    ...(progress.message ? { message: progress.message } : {}),
  };
}

function contextWindowFromProgress(progress: NodeProgress | undefined): NodeExecutionInspection["contextWindow"] | undefined {
  const context = metadataRecord(progress?.context);
  if (!context) return undefined;
  return contextWindowFromRecord(context);
}

function latestContextWindow(turns: Record<string, unknown>[]): NodeExecutionInspection["contextWindow"] | undefined {
  const context = [...turns].reverse()
    .map(turn => metadataRecord(metadataRecord(turn.telemetry)?.context))
    .find(Boolean);
  if (!context) return undefined;
  return contextWindowFromRecord(context);
}

function contextWindowFromRecord(context: Record<string, unknown>): NodeExecutionInspection["contextWindow"] | undefined {
  const used = numberField(context.used);
  const size = numberField(context.size);
  const updatedAt = stringField(context.updatedAt);
  if (used === undefined && size === undefined && updatedAt === undefined) return undefined;
  return {
    ...(used === undefined ? {} : { used }),
    ...(size === undefined ? {} : { size }),
    ...(used !== undefined && size !== undefined && size > 0 ? { percent: Math.round((used / size) * 100) } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function tokenUsageFromProgress(progress: NodeProgress | undefined): NodeExecutionInspection["tokenUsage"] | undefined {
  const usage = metadataRecord(progress?.tokenUsage);
  if (!usage) return undefined;
  return tokenUsageFromRecord(usage);
}

function aggregateTokenUsage(turns: Record<string, unknown>[]): NodeExecutionInspection["tokenUsage"] | undefined {
  let source: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let hasUsage = false;
  for (const turn of turns) {
    const usage = metadataRecord(metadataRecord(turn.telemetry)?.tokenUsage);
    if (!usage) continue;
    hasUsage = true;
    if (typeof usage.source === "string") source = usage.source;
    inputTokens += numberField(usage.inputTokens) ?? 0;
    outputTokens += numberField(usage.outputTokens) ?? 0;
    totalTokens += numberField(usage.totalTokens) ?? 0;
  }
  return hasUsage ? {
    ...(source ? { source } : {}),
    inputTokens,
    outputTokens,
    totalTokens,
  } : undefined;
}

function tokenUsageFromRecord(usage: Record<string, unknown>): NodeExecutionInspection["tokenUsage"] {
  const source = stringField(usage.source);
  const inputTokens = numberField(usage.inputTokens);
  const outputTokens = numberField(usage.outputTokens);
  const totalTokens = numberField(usage.totalTokens);
  if (source === undefined && inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return {
    ...(source ? { source } : {}),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function toolCallCountFromProgress(progress: NodeProgress | undefined): number | undefined {
  return numberField(metadataRecord(progress?.tools)?.totalToolCallCount);
}

function totalToolCallCount(turns: Record<string, unknown>[]): number | undefined {
  let total = 0;
  let hasTools = false;
  for (const turn of turns) {
    const count = numberField(metadataRecord(metadataRecord(turn.telemetry)?.tools)?.totalToolCallCount);
    if (count === undefined) continue;
    hasTools = true;
    total += count;
  }
  return hasTools ? total : undefined;
}

function toolCallsFromProgress(progress: NodeProgress | undefined): NodeExecutionInspection["lastToolCalls"] | undefined {
  const tools = metadataRecord(progress?.tools);
  const calls = tools?.lastCalls;
  if (!tools || !Array.isArray(calls)) return undefined;
  const turn = numberField(tools.turn) ?? 0;
  return calls.flatMap(call => {
    const record = metadataRecord(call);
    if (!record) return [];
    return [toolCallFromRecord(record, turn, "progress")];
  });
}

async function toolCallsForTurn(
  turn: Record<string, unknown>,
  loadTelemetryArtifact: (artifactRef: unknown) => Promise<unknown | undefined>,
): Promise<NodeExecutionInspection["lastToolCalls"]> {
  const turnNo = numberField(turn.turn) ?? 0;
  const telemetry = metadataRecord(await loadTelemetryArtifact(turn.telemetryArtifact));
  const calls = metadataRecord(metadataRecord(telemetry?.telemetry)?.tools)?.calls;
  if (!Array.isArray(calls)) return [];
  return calls.flatMap(call => {
    const record = metadataRecord(call);
    if (!record) return [];
    return [toolCallFromRecord(record, turnNo, "artifact")];
  });
}

function toolCallFromRecord(record: Record<string, unknown>, turn: number, previewMode: "progress" | "artifact"): NodeExecutionInspection["lastToolCalls"][number] {
  const startedAt = stringField(record.startedAt);
  const updatedAt = stringField(record.updatedAt);
  const completedAt = stringField(record.completedAt);
  const toolCallId = stringField(record.toolCallId);
  const toolName = stringField(record.toolName);
  const status = stringField(record.status);
  const inputPreview = previewMode === "progress" ? stringField(record.inputPreview) : previewField(record.input);
  const outputPreview = previewMode === "artifact" ? previewField(record.output) : undefined;
  const duration = durationMs(startedAt, completedAt ?? "");
  return {
    turn,
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolName ? { toolName } : {}),
    ...(status ? { status } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(duration === undefined ? {} : { durationMs: duration }),
    ...(inputPreview ? { inputPreview } : {}),
    ...(outputPreview ? { outputPreview } : {}),
  };
}

function previewField(value: unknown): string | undefined {
  const record = metadataRecord(value);
  if (!record) return undefined;
  return typeof record.preview === "string" ? record.preview : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function durationMs(startedAt: string | undefined, finishedAt: string): number | undefined {
  if (!startedAt) return undefined;
  const value = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isTerminalRunStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

function latestBy<T>(items: T[], getValue: (item: T) => string | undefined): T | undefined {
  return [...items].sort((left, right) => (getValue(right) ?? "").localeCompare(getValue(left) ?? ""))[0];
}

function isLeafKind(kind: string): boolean {
  return kind === "task" || kind === "agent" || kind === "signal" || kind === "assert";
}

function renderTemplate(template: TemplateIR): string {
  return template.parts
    .map(part => (part.kind === "text" ? part.value : `\${${renderExpr(part.expr)}}`))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function renderExpr(expr: ExprIR): string {
  switch (expr.kind) {
    case "literal":
      return renderLiteral(expr.value);
    case "ref":
      return expr.path.join(".");
    case "var":
      return [expr.id, ...expr.path].join(".");
    case "array":
      return `[${expr.items.map(renderExpr).join(", ")}]`;
    case "object":
      return `{ ${Object.entries(expr.fields).map(([key, value]) => `${key}: ${renderExpr(value)}`).join(", ")} }`;
    case "template":
      return `\`${renderTemplate(expr.template)}\``;
    case "lambda":
      return `${expr.params.map(param => param.id).join(", ")} => ${renderExpr(expr.body)}`;
    case "call":
      return `${expr.fn}(${expr.args.map(renderExpr).join(", ")})`;
  }
}

function renderLiteral(value: JsonValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(renderLiteral).join(", ")}]`;
  if (typeof value === "object") return `{ ${Object.entries(value).map(([key, item]) => `${key}: ${renderLiteral(item)}`).join(", ")} }`;
  return String(value);
}
