import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { schemaToJsonSchema } from "@acpus/core/schema";
import type { AgentDefinitionIR, AgentNodeIR, SchemaIR, WorkflowIR } from "@acpus/core/ir";
import { executeAgentTurn, type AgentBackendFailure, type AgentToolCallSummary, type AgentTraceEvent, type AgentTurnProgress, type AgentTurnRequest, type AgentTurnResult, type AgentTurnSummary, type AgentTurnTiming } from "@acpus/agent-executor";
import type { JsonValue } from "@acpus/expression/ir";
import { jsonrepair } from "jsonrepair";
import { isArtifactRefCandidate, tryResolveArtifactPath } from "../artifacts/path.js";
import type { AgentHostPolicy } from "../configuration.js";
import { tryParsePersistedDeadline } from "../deadline.js";
import { type EvaluationScope } from "../evaluation/evaluator.js";
import { ResolutionException, resolveOrThrow, tryResolveString } from "../evaluation/resolvable.js";
import { normalizeValue } from "../evaluation/schema.js";
import type { RuntimeStore, WriteNodeProgressInput } from "../store/store.js";
import type { NodeProgressWriter } from "../progress/writer.js";

const CONTINUATION_PROMPT = "Continue the previous task from where you left off.";
const DEFAULT_REPAIR_DELAY_MS = 5_000;
const PROGRESS_FLUSH_INTERVAL_MS = 1_000;
const PROGRESS_OUTPUT_TAIL_BYTES = 16 * 1024;
const PROGRESS_TOOL_LIMIT = 3;

export class AgentNodeCancelledError extends Error {}
export class AgentNodeExecutionError extends Error {
  constructor(readonly failure: AgentNodeFailure) {
    super(`${failure.code}: ${failure.message}`);
  }
}
export class AgentNodeTimeoutError extends AgentNodeExecutionError {
  constructor(failure: AgentNodeFailure | string) {
    super(typeof failure === "string" ? { origin: "provider", code: "timeout", message: failure } : failure);
  }
}

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

export type AgentExecutorOptions = {
  cwd: string;
  runId?: string;
  agents: WorkflowIR["agents"];
  hostPolicy: AgentHostPolicy;
  nodeKey?: string;
  attemptId?: string;
  attemptNo?: number;
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
  traceCaptureError?: string;
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

export type AgentOutputProcessing =
  | { recovery: "empty" | "unrecoverable"; conformance: "rejected" }
  | {
      recovery: "direct" | "extracted" | "repaired";
      conformance: "accepted" | "rejected";
      projectionChanged: boolean;
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

type AgentTurnSummaryProjection = Pick<AgentTurnSummary, "eventCount" | "stopReason" | "context" | "tokenUsage"> & {
  tools: { totalToolCallCount: number };
  cwd?: string;
  acpxRecordId?: string;
};

type AgentArtifactRef = {
  artifactId: string;
  mediaType: string;
};

export async function executeAgentNode(node: AgentNodeIR, scope: EvaluationScope, options: AgentExecutorOptions): Promise<unknown> {
  const turns: AgentTurnRecord[] = [];
  let sessionNameForMetadata: string | undefined;
  let explicitSessionKey: string | undefined;
  let responseRepairMax: number | null | undefined;
  let renderedPrompt: string | undefined;
  let metadataWritten = false;
  const writeTerminalState = async (
    status: "completed" | "failed" | "cancelled" | "timed_out",
    message?: string,
    result?: AgentTurnResult,
    turn?: number,
  ): Promise<void> => {
    if (result && turn !== undefined) writeAgentTerminalProgress(node, options, turn, result, status, message);
    metadataWritten = true;
    await writeAgentAttemptMetadata(node, options, sessionNameForMetadata, explicitSessionKey, responseRepairMax, status, turns, message);
  };

  try {
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
        await writeTerminalState("failed", failure.message);
        throw new AgentNodeExecutionError(failure);
      }
      responseRepairMax = options.hostPolicy.responseRepair.max;
    } else {
      responseRepairMax = 0;
    }
    const cwd = node.run.cwd
      ? resolveOrThrow(tryResolveString(node.run.cwd, scope, "agent cwd"))
      : definition.cwd ?? options.cwd;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...staticEnv(definition.env),
      ...dynamicEnv(node.run.env, scope),
    };
    applyRuntimeAgentEnv(env, node.id, options);
    const deadline = options.deadlineAt === undefined ? undefined : persistedDeadline(options.deadlineAt, node.id);
    explicitSessionKey = renderSessionKey(node, scope);
    sessionNameForMetadata = sessionName(options.runId, options.nodeKey ?? node.id, explicitSessionKey);
    const turnBase = {
      agent: agentSelector(definition),
      cwd,
      env,
      sessionName: sessionNameForMetadata,
      permissionMode: node.run.permissionMode ?? definition.permissionMode ?? "approve-all",
      ...(definition.model ? { model: definition.model } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(definition.trace === true ? { captureTrace: true } : {}),
    } satisfies Omit<AgentTurnRequest, "prompt" | "agentMode">;
    const maxRepairTurns = responseRepairMax;
    const plainContinuation = options.initialPromptKind === "plain_continuation";
    renderedPrompt = plainContinuation
      ? CONTINUATION_PROMPT
      : resolveOrThrow(tryResolveString(node.run.prompt, scope, `Agent node '${node.id}' prompt`, {
          formatTemplateValue: value => {
            if (!isArtifactRefCandidate(value)) return undefined;
            if (!options.store || !options.runId) throw new Error("Agent ArtifactRef interpolation requires runtime store and run id.");
            const resolved = tryResolveArtifactPath(value, { cwd: options.cwd, runId: options.runId, store: options.store });
            if (resolved.isErr()) throw new Error(resolved.error.message);
            return resolved.value;
          },
        }));
    let prompt = plainContinuation
      ? renderedPrompt
      : buildAgentPrompt(renderedPrompt, node.outputSchema);
    const captureRawDebug = options.hostPolicy.captureRawAcpDebug;
    for (let turn = 0; turn <= maxRepairTurns; turn += 1) {
      const remaining = remainingTimeout(deadline, node.id);
      const onProgress = createAgentProgressReporter(node, options, turn + 1);
      const request = {
        ...turnBase,
        prompt,
        ...(remaining === undefined ? {} : { timeoutMs: remaining }),
        ...(turn === 0 && !plainContinuation && definition.agentMode ? { agentMode: definition.agentMode } : {}),
        ...(captureRawDebug ? { captureRawDebug: true } : {}),
        ...(onProgress ? { onProgress } : {}),
      } satisfies AgentTurnRequest;
      const result = await executeAgentTurn(request);
      turns.push(await writeAgentTurnArtifacts(node, options, turn + 1, request, result, captureRawDebug));
      if (result.status === "cancelled") {
        await writeTerminalState("cancelled", result.message, result, turn + 1);
        throw new AgentNodeCancelledError(result.message);
      }
      if (result.status === "failed" && result.failure.kind === "timeout") {
        const failure = agentNodeFailure(result.failure);
        await writeTerminalState("timed_out", failure.message, result, turn + 1);
        throw new AgentNodeTimeoutError(failure);
      }
      if (result.status === "failed") {
        const failure = agentNodeFailure(result.failure);
        await writeTerminalState("failed", failure.message, result, turn + 1);
        throw new AgentNodeExecutionError(failure);
      }
      if (!node.outputSchema) {
        await writeTerminalState("completed", undefined, result, turn + 1);
        return result.responseText;
      }
      const conformed = conformAgentOutput(node.outputSchema, result.responseText, node.id);
      turns[turn] = { ...turns[turn]!, outputProcessing: conformed.outputProcessing };
      if (conformed.ok) {
        await writeTerminalState("completed", undefined, result, turn + 1);
        return conformed.output;
      }
      turns[turn] = { ...turns[turn]!, failure: { kind: conformed.kind, message: conformed.message } };
      if (turn === maxRepairTurns) {
        const failure: AgentNodeFailure = { origin: "provider", code: conformed.kind, message: conformed.message };
        await writeTerminalState("failed", failure.message, result, turn + 1);
        throw new AgentNodeExecutionError(failure);
      }
      await delay(DEFAULT_REPAIR_DELAY_MS, options.signal, deadline);
      prompt = buildAgentPrompt(CONTINUATION_PROMPT, node.outputSchema);
    }
    throw new Error(`Agent node '${node.id}' exhausted response repair.`);
  } catch (error) {
    if (!metadataWritten) {
      await writeTerminalState(error instanceof AgentNodeCancelledError ? "cancelled" : error instanceof AgentNodeTimeoutError ? "timed_out" : "failed", error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
}

function agentNodeFailure(failure: AgentBackendFailure): AgentNodeFailure {
  return {
    origin: "provider",
    code: failure.kind,
    message: failure.message,
    ...(failure.upstream ? { upstream: failure.upstream } : {}),
  };
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

function dynamicEnv(env: AgentNodeIR["run"]["env"], scope: EvaluationScope): Record<string, string> {
  if (!env) return {};
  return Object.fromEntries(Object.entries(env).map(([key, value]) =>
    [key, resolveOrThrow(tryResolveString(value, scope, `Agent env '${key}'`))]));
}

function staticEnv(env: AgentDefinitionIR["env"]): Record<string, string> {
  return env ? { ...env } : {};
}

function agentSelector(definition: AgentDefinitionIR): AgentTurnRequest["agent"] {
  return definition.kind === "agent_command"
    ? { kind: "command", command: definition.command }
    : { kind: "named", name: definition.use };
}

function renderSessionKey(node: AgentNodeIR, scope: EvaluationScope): string | undefined {
  if (!node.run.sessionKey) return undefined;
  const field = `Agent node '${node.id}' sessionKey`;
  const rendered = resolveOrThrow(tryResolveString(node.run.sessionKey, scope, field));
  if (rendered.trim().length === 0) {
    throw new ResolutionException({
      type: "constraint",
      field,
      expected: "non-empty string",
      message: `${field} must render to a non-empty string.`,
    });
  }
  return rendered;
}

function sessionName(runId: string | undefined, nodeKey: string, explicitKey: string | undefined): string {
  const identity = explicitKey === undefined
    ? { runId: runId ?? "local", nodeKey }
    : { runId: runId ?? "local", key: explicitKey };
  return `acpus-${Buffer.from(JSON.stringify(identity)).toString("base64url")}`;
}

function buildAgentPrompt(text: string, schema: SchemaIR | undefined): string {
  if (!schema) return text;
  return `${text}\n\n# OUTPUT SCHEMA\n**After completing the task, your final response MUST be exactly one JSON value that conforms to this schema, with no Markdown or prose.**\n${JSON.stringify(schemaToJsonSchema(schema), null, 2)}`;
}

type ConformanceResult =
  | { ok: true; output: JsonValue; outputProcessing: AgentOutputProcessing }
  | { ok: false; kind: "output_conformance" | "empty_response"; message: string; outputProcessing: AgentOutputProcessing };

type RecoveredJson = {
  value: JsonValue;
  recovery: "direct" | "extracted" | "repaired";
};

export function conformAgentOutput(schema: SchemaIR, text: string, nodeId: string): ConformanceResult {
  if (text.trim().length === 0) return {
    ok: false,
    kind: "empty_response",
    message: `Agent node '${nodeId}' returned an empty response.`,
    outputProcessing: { recovery: "empty", conformance: "rejected" },
  };
  const recovered = recoverJson(text);
  if (recovered === undefined) return {
    ok: false,
    kind: "output_conformance",
    message: `Agent node '${nodeId}' response could not be recovered as JSON.`,
    outputProcessing: { recovery: "unrecoverable", conformance: "rejected" },
  };
  const projected = projectToSchema(schema, recovered.value);
  const projectionChanged = !isDeepStrictEqual(recovered.value, projected);
  try {
    return {
      ok: true,
      output: normalizeValue(schema, projected, `Node '${nodeId}' output`),
      outputProcessing: { recovery: recovered.recovery, conformance: "accepted", projectionChanged },
    };
  } catch (error) {
    return {
      ok: false,
      kind: "output_conformance",
      message: error instanceof Error ? error.message : String(error),
      outputProcessing: { recovery: recovered.recovery, conformance: "rejected", projectionChanged },
    };
  }
}

function recoverJson(text: string): RecoveredJson | undefined {
  const trimmed = text.trim();
  try {
    const value = parsedJsonValue(JSON.parse(trimmed));
    if (value !== undefined) return { value, recovery: "direct" };
  } catch {}
  const candidates = balancedJsonCandidates(text);
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const candidate = candidates[i]!;
    try {
      const value = parsedJsonValue(JSON.parse(candidate));
      if (value !== undefined) return { value, recovery: "extracted" };
    } catch {}
    if (/^[{[]/.test(candidate.trimStart())) {
      try {
        const value = parsedJsonValue(JSON.parse(jsonrepair(candidate)));
        if (value !== undefined) return { value, recovery: "repaired" };
      } catch {}
    }
  }
  return undefined;
}

function parsedJsonValue(value: unknown): JsonValue | undefined {
  return isJsonValue(value) ? value : undefined;
}

function balancedJsonCandidates(text: string): string[] {
  const candidates: Array<{ start: number; end: number; value: string }> = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{" && text[start] !== "[") continue;
    const end = balancedCandidateEnd(text, start);
    if (end !== undefined) candidates.push({ start, end, value: text.slice(start, end) });
  }
  return candidates
    .filter(candidate => !candidates.some(other => other !== candidate && other.start < candidate.start && candidate.end < other.end))
    .sort((a, b) => a.end - b.end || a.start - b.start)
    .map(candidate => candidate.value);
}

function balancedCandidateEnd(text: string, start: number): number | undefined {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    else if (char === "}" || char === "]") {
      if (stack.pop() !== char) return undefined;
      if (stack.length === 0) return index + 1;
    }
  }
  return undefined;
}

function projectToSchema(schema: SchemaIR, value: JsonValue): JsonValue {
  if (value === null) return value;
  if (schema.kind === "array" && Array.isArray(value)) return value.map(item => projectToSchema(schema.item as SchemaIR, item));
  if (schema.kind === "record" && isJsonObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, projectToSchema(schema.value as SchemaIR, item)]));
  if (schema.kind === "union") {
    for (const variant of schema.variants) {
      const projected = projectToSchema(variant as SchemaIR, value);
      try {
        normalizeValue(variant as SchemaIR, projected, "Agent union variant");
        return projected;
      } catch {}
    }
    return value;
  }
  if (schema.kind !== "object" || !isJsonObject(value)) return value;
  const projected: Record<string, JsonValue> = schema.additionalProperties ? { ...value } : {};
  for (const [key, field] of Object.entries(schema.fields)) {
    if (key in value) projected[key] = projectToSchema(field as SchemaIR, value[key]!);
  }
  return projected;
}

function isJsonObject(value: JsonValue): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return Boolean(value && typeof value === "object" && Object.values(value).every(isJsonValue));
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
    try {
      record.traceArtifact = await writeAgentArtifact(
        options,
        turn,
        "trace.jsonl",
        serializeAgentTrace(node, options, turn, request, result),
        "application/x-ndjson",
      );
    } catch (error) {
      record.traceCaptureError = error instanceof Error ? error.message : String(error);
    }
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
  if (!writer || !options.runId || !options.nodeKey) return undefined;
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
  if (!writer || !options.runId || !options.nodeKey) return;
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
  const output = outputTail(progress.responseText);
  return pruneUndefined({
    runId: options.runId,
    nodeKey: options.nodeKey ?? node.id,
    nodeId: node.id,
    attemptId: options.attemptId,
    attemptNo: options.attemptNo ?? 1,
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
  const runDir = options.store.getRunDir(options.runId);
  if (!runDir) throw new Error(`Run '${options.runId}' has no run directory.`);
  const nodeKey = options.nodeKey ?? "agent";
  const attempt = options.attemptNo ?? 1;
  const id = `artifact_${randomUUID()}`;
  const relativePath = join("artifacts", nodeKey, `attempt-${attempt}`, "agent", `turn-${String(turn).padStart(3, "0")}.${name}`);
  const bytes = Buffer.from(content, "utf8");
  await mkdir(join(options.cwd, runDir, "artifacts", nodeKey, `attempt-${attempt}`, "agent"), { recursive: true });
  await writeFile(join(options.cwd, runDir, relativePath), bytes);
  options.store.registerArtifact({
    id,
    runId: options.runId,
    nodeKey,
    attempt,
    mediaType,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    size: bytes.byteLength,
    relativePath,
  });
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

function delay(ms: number, signal: AbortSignal | undefined, deadline: number | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  const remaining = remainingTimeout(deadline, "response repair");
  const delayMs = remaining === undefined ? ms : Math.min(ms, remaining);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AgentNodeCancelledError("Agent response repair was aborted."));
      return;
    }
    const timeout = setTimeout(() => {
      if (remaining !== undefined && remaining <= ms) reject(new AgentNodeTimeoutError("Agent response repair timed out."));
      else resolve();
    }, delayMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new AgentNodeCancelledError("Agent response repair was aborted."));
    }, { once: true });
  });
}

function remainingTimeout(deadline: number | undefined, nodeId: string): number | undefined {
  if (deadline === undefined) return undefined;
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new AgentNodeTimeoutError(`Agent node '${nodeId}' timed out.`);
  return remaining;
}

function persistedDeadline(value: string, nodeId: string): number {
  const deadline = tryParsePersistedDeadline(value);
  if (deadline.isErr()) throw new Error(`Agent node '${nodeId}' has invalid persisted deadline ${JSON.stringify(value)}.`);
  return deadline.value.getTime();
}
