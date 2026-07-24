import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentDefinitionIR, AgentNodeIR, WorkflowIR } from "@acpus/core/ir";
import { executeAgentTurn, type AgentBackendFailure, type AgentToolCallSummary, type AgentTraceEvent, type AgentTurnProgress, type AgentTurnRequest, type AgentTurnResult, type AgentTurnSummary, type AgentTurnTiming } from "@acpus/agent-executor";
import type { JsonValue } from "@acpus/expression/ir";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import { isArtifactRefCandidate, tryResolveArtifactPath, type ArtifactPathError } from "../artifacts/path.js";
import type { AgentHostPolicy } from "../configuration.js";
import { tryParsePersistedDeadline } from "../deadline.js";
import { type EvaluationScope } from "../evaluation/evaluator.js";
import { tryResolveString, type ResolutionError } from "../evaluation/resolvable.js";
import type { RuntimeStore, WriteNodeProgressInput } from "../store/store.js";
import type { NodeProgressWriter } from "../progress/writer.js";
import { throwSchedulerStoreResult } from "../scheduler/store-port.js";
import {
  buildAgentOutputPrompt,
  buildAgentOutputRepairPrompt,
  conformAgentOutput,
  type AgentOutputProcessing,
} from "./agent-output.js";

const CONTINUATION_PROMPT = "Continue the previous task from where you left off.";
const DEFAULT_REPAIR_DELAY_MS = 5_000;
const PROGRESS_FLUSH_INTERVAL_MS = 1_000;
const PROGRESS_OUTPUT_TAIL_BYTES = 16 * 1024;
const PROGRESS_TOOL_LIMIT = 3;

export type AgentNodeFailure =
  | {
      origin: "provider";
      code: string;
      message: string;
      upstream?: AgentBackendFailure["upstream"];
    }
  | {
      origin: "runtime";
      code: "invalid_agent_response_repair_max";
      message: string;
    };

export type AgentAttemptFailure =
  | { type: "resolution"; error: ResolutionError; message: string }
  | { type: "cancelled"; message: string }
  | { type: "timed_out"; failure: AgentNodeFailure; message: string }
  | { type: "failed"; failure: AgentNodeFailure; message: string };

export type AgentExecutorOptions = {
  cwd: string;
  runId?: string;
  agents: WorkflowIR["agents"];
  hostPolicy: AgentHostPolicy;
  nodeKey?: string;
  attemptId?: string;
  attemptNo?: number;
  ownerEpoch?: number;
  deadlineAt?: string;
  store?: RuntimeStore;
  progressWriter?: NodeProgressWriter;
  initialPromptKind?: "task" | "plain_continuation";
  signal?: AbortSignal;
};

type AgentTurnRecord = {
  turn: number;
  status: AgentTurnResult["status"];
  summary?: AgentTurnSummaryProjection;
  turnArtifact?: AgentArtifactRef;
  stderrArtifact?: AgentArtifactRef;
  rawAcpDebugArtifact?: AgentArtifactRef;
  traceArtifact?: AgentArtifactRef;
  outputProcessing?: AgentOutputProcessing;
  failure?: { kind: string; message: string; upstream?: AgentBackendFailure["upstream"] };
  message?: string;
};

export type AgentTurnArtifact = {
  schemaVersion: 1;
  runId: string;
  nodeId: string;
  nodeKey: string;
  attemptNo: number;
  turn: number;
  agentKey: string;
  sessionName: string;
  status: AgentTurnResult["status"];
  timing: AgentTurnTiming;
  prompt: string;
  response: string;
  summary: AgentTurnSummary;
  failure?: AgentBackendFailure;
  message?: string;
};

type AgentTraceRecordBase = {
  schemaVersion: 1;
  sequence: number;
  observedAt: string;
  elapsedMs: number;
};

type WithoutTraceBase<T> = T extends unknown ? Omit<T, keyof AgentTraceRecordBase> : never;

export type AgentTraceRecord = AgentTraceRecordBase & (
  | {
      type: "turn_start";
      runId: string;
      nodeId: string;
      nodeKey: string;
      attemptNo: number;
      turn: number;
      agentKey: string;
      sessionName: string;
      cwd: string;
      acpxRecordId?: string;
    }
  | WithoutTraceBase<AgentTraceEvent>
);

type AgentTurnSummaryProjection = Pick<AgentTurnSummary, "eventCount" | "availability" | "stopReason" | "context" | "tokenUsage"> & {
  tools: { totalToolCallCount: number };
  cwd?: string;
  acpxRecordId?: string;
};

type AgentArtifactRef = {
  artifactId: string;
  mediaType: string;
};

export function executeAgentNode(node: AgentNodeIR, scope: EvaluationScope, options: AgentExecutorOptions): ResultAsync<JsonValue, AgentAttemptFailure> {
  return new ResultAsync(executeAgentNodeResult(node, scope, options));
}

async function executeAgentNodeResult(node: AgentNodeIR, scope: EvaluationScope, options: AgentExecutorOptions): Promise<Result<JsonValue, AgentAttemptFailure>> {
  const turns: AgentTurnRecord[] = [];
  let sessionNameForMetadata: string | undefined;
  let explicitSessionKey: string | undefined;
  let responseRepairMax: number | null | undefined;
  let renderedPrompt: string | undefined;
  const writeTerminalState = async (
    status: "completed" | "failed" | "cancelled" | "timed_out",
    message?: string,
    result?: AgentTurnResult,
    turn?: number,
  ): Promise<void> => {
    if (result && turn !== undefined) writeAgentTerminalProgress(node, options, turn, result, status, message);
    await writeAgentAttemptMetadata(node, options, sessionNameForMetadata, explicitSessionKey, responseRepairMax, status, turns, message);
  };
  const finishFailure = async (
    failure: AgentAttemptFailure,
    result?: AgentTurnResult,
    turn?: number,
  ): Promise<Result<never, AgentAttemptFailure>> => {
    const status = failure.type === "cancelled" ? "cancelled" : failure.type === "timed_out" ? "timed_out" : "failed";
    try {
      await writeTerminalState(status, failure.message, result, turn);
    } catch (metadataError) {
      throw new AggregateError([failure, metadataError], `Agent node '${node.id}' failed and its terminal metadata could not be persisted.`);
    }
    return err(failure);
  };

    const definition = options.agents[node.run.agent];
    if (!definition) throw new Error(`Agent '${node.run.agent}' is not declared.`);
    if (node.outputSchema) {
      if (options.hostPolicy.responseRepair.type === "invalid") {
        const failure: AgentNodeFailure = {
          origin: "runtime",
          code: "invalid_agent_response_repair_max",
          message: options.hostPolicy.responseRepair.failure.message,
        };
        responseRepairMax = null;
        return finishFailure({ type: "failed", failure, message: failure.message });
      }
      responseRepairMax = options.hostPolicy.responseRepair.max;
    } else {
      responseRepairMax = 0;
    }
    const cwd = node.run.cwd ? tryResolveString(node.run.cwd, scope, "agent cwd") : ok(definition.cwd ?? options.cwd);
    if (cwd.isErr()) return finishFailure(resolutionFailure(cwd.error));
    const dynamic = dynamicEnv(node.run.env, scope);
    if (dynamic.isErr()) return finishFailure(resolutionFailure(dynamic.error));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...staticEnv(definition.env),
      ...dynamic.value,
    };
    applyRuntimeAgentEnv(env, node.id, options);
    const deadline = options.deadlineAt === undefined ? undefined : persistedDeadline(options.deadlineAt, node.id);
    const resolvedSessionKey = renderSessionKey(node, scope);
    if (resolvedSessionKey.isErr()) return finishFailure(resolutionFailure(resolvedSessionKey.error));
    explicitSessionKey = resolvedSessionKey.value;
    sessionNameForMetadata = sessionName(options.runId, options.nodeKey ?? node.id, explicitSessionKey);
    const effectiveModel = definition.config?.model ?? definition.model;
    const turnBase = {
      agent: agentSelector(definition),
      cwd: cwd.value,
      env,
      sessionName: sessionNameForMetadata,
      permissionMode: node.run.permissionMode ?? definition.permissionMode ?? "approve-all",
      ...(effectiveModel === undefined ? {} : { model: effectiveModel }),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(definition.trace === true ? { captureTrace: true } : {}),
    } satisfies Omit<AgentTurnRequest, "prompt" | "config">;
    const maxRepairTurns = responseRepairMax;
    const plainContinuation = options.initialPromptKind === "plain_continuation";
    const resolvedPrompt = plainContinuation
      ? ok(CONTINUATION_PROMPT)
      : renderAgentPrompt(node, scope, options);
    if (resolvedPrompt.isErr()) return finishFailure(resolutionFailure(resolvedPrompt.error));
    renderedPrompt = resolvedPrompt.value;
    let prompt = node.outputSchema
      ? buildAgentOutputPrompt(renderedPrompt, node.outputSchema)
      : renderedPrompt;
    const captureRawDebug = options.hostPolicy.captureRawAcpDebug;
    for (let turn = 0; turn <= maxRepairTurns; turn += 1) {
      const remaining = remainingTimeout(deadline, node.id);
      if (remaining.isErr()) return finishFailure(remaining.error);
      const onProgress = createAgentProgressReporter(node, options, turn + 1);
      const request = {
        ...turnBase,
        prompt,
        ...(remaining.value === undefined ? {} : { timeoutMs: remaining.value }),
        ...(turn === 0 && !plainContinuation && definition.config !== undefined ? { config: definition.config } : {}),
        ...(captureRawDebug ? { captureRawDebug: true } : {}),
        ...(onProgress ? { onProgress } : {}),
      } satisfies AgentTurnRequest;
      const result = await executeAgentTurn(request);
      if (result.status === "cancelled" && options.signal?.aborted) {
        return finishFailure({ type: "cancelled", message: result.message });
      }
      turns.push(await writeAgentTurnArtifacts(node, options, turn + 1, request, result, captureRawDebug));
      if (result.status === "cancelled") {
        return finishFailure({ type: "cancelled", message: result.message }, result, turn + 1);
      }
      if (result.status === "failed" && result.failure.kind === "timeout") {
        const failure = agentNodeFailure(result.failure);
        return finishFailure({ type: "timed_out", failure, message: failure.message }, result, turn + 1);
      }
      if (result.status === "failed") {
        const failure = agentNodeFailure(result.failure);
        return finishFailure({ type: "failed", failure, message: failure.message }, result, turn + 1);
      }
      if (!node.outputSchema) {
        await writeTerminalState("completed", undefined, result, turn + 1);
        return ok(result.responseText);
      }
      const conformed = conformAgentOutput(node.outputSchema, result.responseText, node.id);
      const outputProcessing = conformed.isOk() ? conformed.value.outputProcessing : conformed.error.outputProcessing;
      turns[turn] = { ...turns[turn]!, outputProcessing };
      if (conformed.isOk()) {
        await writeTerminalState("completed", undefined, result, turn + 1);
        return ok(conformed.value.output);
      }
      const rejected = conformed.error;
      turns[turn] = { ...turns[turn]!, failure: { kind: rejected.kind, message: rejected.message } };
      if (turn === maxRepairTurns) {
        const failure: AgentNodeFailure = { origin: "provider", code: rejected.kind, message: rejected.message };
        return finishFailure({ type: "failed", failure, message: failure.message }, result, turn + 1);
      }
      const delayed = await delay(DEFAULT_REPAIR_DELAY_MS, options.signal, deadline);
      if (delayed.isErr()) return finishFailure(delayed.error);
      prompt = buildAgentOutputRepairPrompt(node.outputSchema, rejected.phase);
    }
    throw new Error(`Agent node '${node.id}' exhausted response repair.`);
}

function agentNodeFailure(failure: AgentBackendFailure): AgentNodeFailure {
  return {
    origin: "provider",
    code: failure.kind,
    message: failure.message,
    ...(failure.upstream ? { upstream: failure.upstream } : {}),
  };
}

function resolutionFailure(error: ResolutionError): AgentAttemptFailure {
  return { type: "resolution", error, message: error.message };
}

function renderAgentPrompt(node: AgentNodeIR, scope: EvaluationScope, options: AgentExecutorOptions): Result<string, ResolutionError> {
  const field = `Agent node '${node.id}' prompt`;
  try {
    return tryResolveString(node.run.prompt, scope, field, {
      formatTemplateValue: value => {
        if (!isArtifactRefCandidate(value)) return undefined;
        if (!options.store || !options.runId) throw new Error("Agent ArtifactRef interpolation requires runtime store and run id.");
        const resolved = tryResolveArtifactPath(value, { cwd: options.cwd, runId: options.runId, store: options.store });
        if (resolved.isErr()) throw resolved.error;
        return resolved.value;
      },
    });
  } catch (error) {
    if (!isArtifactPathError(error)) throw error;
    return err({ type: "evaluation", field, message: error.message });
  }
}

function isArtifactPathError(error: unknown): error is ArtifactPathError {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { type?: unknown; message?: unknown };
  return typeof candidate.message === "string"
    && (candidate.type === "invalid-artifact-ref"
      || candidate.type === "artifact-run-mismatch"
      || candidate.type === "artifact-not-found"
      || candidate.type === "artifact-path-invalid");
}

function applyRuntimeAgentEnv(env: NodeJS.ProcessEnv, nodeId: string, options: AgentExecutorOptions): void {
  env.ACPUS_RUNTIME_NODE_ID = nodeId;
  setOptionalEnv(env, "ACPUS_RUNTIME_RUN_ID", options.runId);
  setOptionalEnv(env, "ACPUS_RUNTIME_NODE_KEY", options.nodeKey);
  setOptionalEnv(env, "ACPUS_RUNTIME_ATTEMPT", options.attemptNo === undefined ? undefined : String(options.attemptNo));
}

function setOptionalEnv(env: NodeJS.ProcessEnv, key: string, value: string | undefined): void {
  if (value === undefined) delete env[key];
  else env[key] = value;
}

function dynamicEnv(env: AgentNodeIR["run"]["env"], scope: EvaluationScope): Result<Record<string, string>, ResolutionError> {
  if (!env) return ok({});
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const item = tryResolveString(value, scope, `Agent env '${key}'`);
    if (item.isErr()) return err(item.error);
    resolved[key] = item.value;
  }
  return ok(resolved);
}

function staticEnv(env: AgentDefinitionIR["env"]): Record<string, string> {
  return env ? { ...env } : {};
}

function agentSelector(definition: AgentDefinitionIR): AgentTurnRequest["agent"] {
  return definition.kind === "agent_command"
    ? { kind: "command", command: definition.command }
    : { kind: "named", name: definition.use };
}

function renderSessionKey(node: AgentNodeIR, scope: EvaluationScope): Result<string | undefined, ResolutionError> {
  if (!node.run.sessionKey) return ok(undefined);
  const field = `Agent node '${node.id}' sessionKey`;
  const rendered = tryResolveString(node.run.sessionKey, scope, field);
  if (rendered.isErr()) return err(rendered.error);
  if (rendered.value.trim().length === 0) {
    return err({
      type: "constraint",
      field,
      expected: "non-empty string",
      message: `${field} must render to a non-empty string.`,
    });
  }
  return ok(rendered.value);
}

function sessionName(runId: string | undefined, nodeKey: string, explicitKey: string | undefined): string {
  const identity = explicitKey === undefined
    ? { runId: runId ?? "local", nodeKey }
    : { runId: runId ?? "local", key: explicitKey };
  return `acpus-${Buffer.from(JSON.stringify(identity)).toString("base64url")}`;
}

async function writeAgentTurnArtifacts(
  node: AgentNodeIR,
  options: AgentExecutorOptions,
  turn: number,
  request: AgentTurnRequest,
  result: AgentTurnResult,
  captureRawDebug: boolean,
): Promise<AgentTurnRecord> {
  const base = {
    turn,
    status: result.status,
    summary: summaryProjection(result.summary),
    ...(result.status === "failed" ? { failure: result.failure } : {}),
    ...(result.status === "cancelled" ? { message: result.message } : {}),
  } satisfies AgentTurnRecord;
  if (!options.store || !options.runId) return base;
  const turnArtifact: AgentTurnArtifact = {
    schemaVersion: 1,
    runId: options.runId,
    nodeId: node.id,
    nodeKey: options.nodeKey ?? node.id,
    attemptNo: options.attemptNo ?? 1,
    turn,
    agentKey: node.run.agent,
    sessionName: request.sessionName,
    status: result.status,
    timing: result.timing,
    prompt: request.prompt,
    response: result.responseText,
    summary: result.summary,
    ...(result.status === "failed" ? { failure: result.failure } : {}),
    ...(result.status === "cancelled" ? { message: result.message } : {}),
  };
  const record: AgentTurnRecord = {
    ...base,
    turnArtifact: await writeAgentArtifact(options, turn, "json", `${JSON.stringify(turnArtifact, null, 2)}\n`, "application/json"),
    ...(result.stderr ? { stderrArtifact: await writeAgentArtifact(options, turn, "stderr.log", result.stderr, "text/plain") } : {}),
    ...(captureRawDebug && result.rawDebug ? { rawAcpDebugArtifact: await writeAgentArtifact(options, turn, "raw-acp.jsonl", result.rawDebug.stdout, "application/x-ndjson") } : {}),
  };
  if (request.captureTrace) {
    record.traceArtifact = await writeAgentArtifact(
      options,
      turn,
      "trace.jsonl",
      serializeAgentTrace(node, options, turn, request, result),
      "application/x-ndjson",
    );
  }
  return record;
}

function serializeAgentTrace(
  node: AgentNodeIR,
  options: AgentExecutorOptions,
  turn: number,
  request: AgentTurnRequest,
  result: AgentTurnResult,
): string {
  if (!options.runId || !result.trace) throw new Error("Agent trace capture did not return a trace.");
  const records: AgentTraceRecord[] = [{
    schemaVersion: 1,
    sequence: 0,
    observedAt: result.trace.startedAt,
    elapsedMs: 0,
    type: "turn_start",
    runId: options.runId,
    nodeId: node.id,
    nodeKey: options.nodeKey ?? node.id,
    attemptNo: options.attemptNo ?? 1,
    turn,
    agentKey: node.run.agent,
    sessionName: request.sessionName,
    cwd: request.cwd,
    ...(result.summary.acpxRecordId ? { acpxRecordId: result.summary.acpxRecordId } : {}),
  }, ...result.trace.events.map((event, index) => ({ ...event, sequence: index + 1 }) as AgentTraceRecord)];
  return `${records.map(record => JSON.stringify(record)).join("\n")}\n`;
}

function summaryProjection(summary: AgentTurnSummary): AgentTurnSummaryProjection {
  return pruneUndefined({
    eventCount: summary.eventCount,
    availability: summary.availability,
    stopReason: summary.stopReason,
    context: summary.context,
    tokenUsage: summary.tokenUsage,
    tools: { totalToolCallCount: summary.tools.totalToolCallCount },
    cwd: summary.cwd,
    acpxRecordId: summary.acpxRecordId,
  }) as AgentTurnSummaryProjection;
}

function createAgentProgressReporter(node: AgentNodeIR, options: AgentExecutorOptions, turn: number): ((progress: AgentTurnProgress) => void) | undefined {
  const writer = progressTarget(options);
  if (!writer || !options.runId || !options.nodeKey || !options.attemptId || options.ownerEpoch === undefined) return undefined;
  let lastFlushAt: number | undefined;
  let lastSignature = "";
  return progress => {
    const snapshot = progressSnapshot(node, options, turn, progress);
    const signature = JSON.stringify([snapshot.context, snapshot.tokenUsage, snapshot.tools]);
    const now = Date.now();
    if (lastFlushAt !== undefined && signature === lastSignature && now - lastFlushAt < PROGRESS_FLUSH_INTERVAL_MS) return;
    lastFlushAt = now;
    lastSignature = signature;
    writer.writeNodeProgress(snapshot);
  };
}

function writeAgentTerminalProgress(node: AgentNodeIR, options: AgentExecutorOptions, turn: number, result: AgentTurnResult, status: "completed" | "failed" | "cancelled" | "timed_out", message?: string): void {
  const writer = progressTarget(options);
  if (!writer || !options.runId || !options.nodeKey || !options.attemptId || options.ownerEpoch === undefined) return;
  writer.writeNodeProgress(progressSnapshot(node, options, turn, {
    responseText: result.responseText,
    summary: result.summary,
    updatedAt: new Date().toISOString(),
  }, status, message ?? `turn ${turn} ${status}`));
}

function progressTarget(options: AgentExecutorOptions): NodeProgressWriter | undefined {
  return options.progressWriter ?? options.store;
}

function progressSnapshot(
  node: AgentNodeIR,
  options: AgentExecutorOptions,
  turn: number,
  progress: AgentTurnProgress,
  status = "running",
  message = `turn ${turn}`,
): WriteNodeProgressInput {
  if (!options.attemptId || options.ownerEpoch === undefined) throw new Error("Agent progress requires scheduler attempt ownership.");
  const output = outputTail(progress.responseText);
  return pruneUndefined({
    runId: options.runId,
    nodeKey: options.nodeKey ?? node.id,
    nodeId: node.id,
    attemptId: options.attemptId,
    attemptNo: options.attemptNo ?? 1,
    ownerEpoch: options.ownerEpoch,
    kind: "agent",
    status,
    message,
    output,
    context: progress.summary.context,
    tokenUsage: progress.summary.tokenUsage,
    tools: progressTools(progress.summary.tools, turn),
  }) as WriteNodeProgressInput;
}

function outputTail(value: string): NonNullable<WriteNodeProgressInput["output"]> | undefined {
  if (value.length === 0) return undefined;
  const totalBytes = Buffer.byteLength(value, "utf8");
  if (totalBytes <= PROGRESS_OUTPUT_TAIL_BYTES) return { tail: value, totalBytes, truncated: false };
  const chunks: string[] = [];
  let bytes = 0;
  for (let index = value.length; index > 0;) {
    let start = index - 1;
    const code = value.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff && start > 0) start -= 1;
    const char = value.slice(start, index);
    const nextBytes = Buffer.byteLength(char, "utf8");
    if (bytes + nextBytes > PROGRESS_OUTPUT_TAIL_BYTES) break;
    chunks.push(char);
    bytes += nextBytes;
    index = start;
  }
  return { tail: chunks.reverse().join(""), totalBytes, truncated: true };
}

function progressTools(tools: AgentTurnSummary["tools"], turn: number): JsonValue {
  return {
    turn,
    totalToolCallCount: tools.totalToolCallCount,
    lastCalls: tools.calls.slice(-PROGRESS_TOOL_LIMIT).map(progressToolCall),
  };
}

function progressToolCall(call: AgentToolCallSummary): JsonValue {
  return pruneUndefined({
    toolCallId: call.toolCallId,
    title: call.title,
    kind: call.kind,
    toolName: call.toolName,
    status: call.status,
    inputPreview: call.input?.preview,
    startedAt: call.startedAt,
    updatedAt: call.updatedAt,
    completedAt: call.completedAt,
  }) as JsonValue;
}

async function writeAgentArtifact(options: AgentExecutorOptions, turn: number, name: string, content: string, mediaType: string): Promise<AgentArtifactRef> {
  if (!options.store || !options.runId) throw new Error("Agent artifact storage requires runtime store and run id.");
  if (!options.attemptId || options.ownerEpoch === undefined) throw new Error("Agent artifact storage requires scheduler attempt ownership.");
  const runDir = options.store.getRunDir(options.runId);
  if (!runDir) throw new Error(`Run '${options.runId}' has no run directory.`);
  const nodeKey = options.nodeKey ?? "agent";
  const attempt = options.attemptNo ?? 1;
  const id = `artifact_${randomUUID()}`;
  const relativePath = join("artifacts", nodeKey, `attempt-${attempt}`, "agent", `turn-${String(turn).padStart(3, "0")}.${name}`);
  const absolutePath = join(runDir, relativePath);
  const bytes = Buffer.from(content, "utf8");
  await mkdir(join(runDir, "artifacts", nodeKey, `attempt-${attempt}`, "agent"), { recursive: true, mode: 0o700 });
  await writeFile(absolutePath, bytes, { mode: 0o600 });
  try {
    throwSchedulerStoreResult(options.store.registerArtifact({
      id,
      runId: options.runId,
      nodeKey,
      attemptId: options.attemptId,
      attempt,
      ownerEpoch: options.ownerEpoch,
      mediaType,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      size: bytes.byteLength,
      relativePath,
    }));
  } catch (error) {
    try {
      await rm(absolutePath, { force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Agent artifact '${id}' registration failed and its unregistered file could not be removed.`);
    }
    throw error;
  }
  return { artifactId: id, mediaType };
}

async function writeAgentAttemptMetadata(
  node: AgentNodeIR,
  options: AgentExecutorOptions,
  sessionName: string | undefined,
  explicitSessionKey: string | undefined,
  responseRepairMax: number | null | undefined,
  status: "completed" | "failed" | "cancelled" | "timed_out",
  turns: AgentTurnRecord[],
  message?: string,
): Promise<void> {
  if (!options.store || !options.runId) return;
  options.store.writeExecutionMetadata({
    runId: options.runId,
    ...(options.attemptId ? { attemptId: options.attemptId } : {}),
    kind: "agent_attempt",
    metadata: pruneUndefined({
      nodeId: node.id,
      nodeKey: options.nodeKey ?? node.id,
      attemptNo: options.attemptNo ?? 1,
      status,
      ...(sessionName ? { sessionName } : {}),
      ...(explicitSessionKey ? { sessionKey: explicitSessionKey } : {}),
      ...(options.deadlineAt ? { deadlineAt: options.deadlineAt } : {}),
      ...(responseRepairMax === undefined ? {} : { responseRepairMax }),
      turnCount: turns.length,
      turns: turns.map(turn => pruneUndefined(turn) as JsonValue),
      ...(message ? { message } : {}),
    }) as JsonValue,
  });
}

function pruneUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruneUndefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, pruneUndefined(item)]));
  }
  return value;
}

function delay(ms: number, signal: AbortSignal | undefined, deadline: number | undefined): Promise<Result<void, AgentAttemptFailure>> {
  if (ms <= 0) return Promise.resolve(ok(undefined));
  const remaining = remainingTimeout(deadline, "response repair");
  if (remaining.isErr()) return Promise.resolve(err(remaining.error));
  const delayMs = remaining.value === undefined ? ms : Math.min(ms, remaining.value);
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve(err({ type: "cancelled", message: "Agent response repair was aborted." }));
      return;
    }
    const abort = () => {
      clearTimeout(timeout);
      resolve(err({ type: "cancelled", message: "Agent response repair was aborted." }));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      if (remaining.value !== undefined && remaining.value <= ms) {
        resolve(err(timeoutFailure("Agent response repair timed out.")));
      } else {
        resolve(ok(undefined));
      }
    }, delayMs);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function remainingTimeout(deadline: number | undefined, nodeId: string): Result<number | undefined, AgentAttemptFailure> {
  if (deadline === undefined) return ok(undefined);
  const remaining = deadline - Date.now();
  return remaining <= 0
    ? err(timeoutFailure(`Agent node '${nodeId}' timed out.`))
    : ok(remaining);
}

function timeoutFailure(message: string): AgentAttemptFailure {
  return {
    type: "timed_out",
    failure: { origin: "provider", code: "timeout", message },
    message,
  };
}

function persistedDeadline(value: string, nodeId: string): number {
  const deadline = tryParsePersistedDeadline(value);
  if (deadline.isErr()) throw new Error(`Agent node '${nodeId}' has invalid persisted deadline ${JSON.stringify(value)}.`);
  return deadline.value.getTime();
}
