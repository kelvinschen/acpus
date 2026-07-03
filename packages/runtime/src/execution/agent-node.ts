import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { schemaToJsonSchema } from "@acpus/core/schema";
import type { AgentDefinitionIR, AgentNodeIR, SchemaIR, WorkflowIR } from "@acpus/core/ir";
import { executeAgentTurn, type AgentTurnRequest, type AgentTurnResult, type AgentTurnTelemetry } from "@acpus/agent-executor";
import type { JsonValue } from "@acpus/expression/ir";
import { jsonrepair } from "jsonrepair";
import { evaluateExpr, renderTemplate, type EvaluationScope } from "../evaluation/evaluator.js";
import { normalizeValue } from "../evaluation/schema.js";
import type { RuntimeStore } from "../store/store.js";
import { parseDurationMs } from "./duration.js";

const CONTINUATION_PROMPT = "Continue the previous task from where you left off.";
const DEFAULT_REPAIR_DELAY_MS = 5_000;

export class AgentNodeCancelledError extends Error {}
export class AgentNodeTimeoutError extends Error {}

export type AgentExecutorOptions = {
  cwd: string;
  runId?: string;
  agents: WorkflowIR["agents"];
  nodeKey?: string;
  attemptId?: string;
  attemptNo?: number;
  store?: RuntimeStore;
  initialPromptKind?: "task" | "plain_continuation";
  signal?: AbortSignal;
  executeTurn?: (request: AgentTurnRequest) => Promise<AgentTurnResult>;
  repairDelayMs?: number;
};

type AgentTurnRecord = {
  turn: number;
  status: AgentTurnResult["status"];
  telemetry?: AgentTurnTelemetrySummary;
  promptArtifact?: AgentArtifactRef;
  responseArtifact?: AgentArtifactRef;
  stderrArtifact?: AgentArtifactRef;
  telemetryArtifact?: AgentArtifactRef;
  rawAcpDebugArtifact?: AgentArtifactRef;
  rawRecoveredOutputArtifact?: AgentArtifactRef;
  failureKind?: string;
  message?: string;
};

type AgentTurnTelemetrySummary = Pick<AgentTurnTelemetry, "eventCount" | "stopReason" | "context" | "tokenUsage"> & {
  tools: { totalToolCallCount: number };
  cwd?: string;
  acpxRecordId?: string;
};

type AgentArtifactRef = {
  artifactId: string;
  relativePath: string;
  mediaType: string;
};

export async function executeAgentNode(node: AgentNodeIR, scope: EvaluationScope, options: AgentExecutorOptions): Promise<unknown> {
  const turns: AgentTurnRecord[] = [];
  let sessionNameForMetadata: string | undefined;
  let explicitSessionKey: string | undefined;
  let metadataWritten = false;
  const writeTerminalMetadata = async (status: "completed" | "failed" | "cancelled" | "timed_out", message?: string): Promise<void> => {
    metadataWritten = true;
    await writeAgentAttemptMetadata(node, options, sessionNameForMetadata, explicitSessionKey, status, turns, message);
  };

  try {
    const definition = options.agents[node.run.agent];
    if (!definition) throw new Error(`Agent '${node.run.agent}' is not declared.`);
    const cwd = node.run.cwd ? stringValue(evaluateExpr(node.run.cwd, scope), "agent cwd") : definition.cwd ? stringValue(evaluateExpr(definition.cwd, scope), "agent cwd") : options.cwd;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...evaluateEnv(definition.env, scope),
      ...evaluateEnv(node.run.env, scope),
    };
    applyRuntimeAgentEnv(env, node.id, options);
    const deadline = node.timeout ? Date.now() + parseDurationMs(node.timeout) : undefined;
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
    } satisfies Omit<AgentTurnRequest, "prompt" | "agentMode">;
    const executeTurn = options.executeTurn ?? executeAgentTurn;
    const maxRepairTurns = node.outputSchema ? (node.retry?.max ?? 2) : 0;
    const plainContinuation = options.initialPromptKind === "plain_continuation";
    let prompt = plainContinuation ? CONTINUATION_PROMPT : buildAgentPrompt(renderTemplate(node.run.prompt, scope), node.outputSchema);
    for (let turn = 0; turn <= maxRepairTurns; turn += 1) {
      const remaining = remainingTimeout(deadline, node.id);
      const captureRawDebug = shouldCaptureRawAcpDebug();
      const request = {
        ...turnBase,
        prompt,
        ...(remaining === undefined ? {} : { timeout: `${remaining}ms` }),
        ...(turn === 0 && !plainContinuation && definition.agentMode ? { agentMode: definition.agentMode } : {}),
        ...(captureRawDebug ? { captureRawDebug: true } : {}),
      } satisfies AgentTurnRequest;
      const result = await executeTurn(request);
      turns.push(await writeAgentTurnArtifacts(node, options, turn + 1, request.prompt, result, captureRawDebug));
      if (result.status === "cancelled") {
        await writeTerminalMetadata("cancelled", result.message);
        throw new AgentNodeCancelledError(result.message);
      }
      if (result.status === "failed" && result.failureKind === "timeout") {
        await writeTerminalMetadata("timed_out", result.message);
        throw new AgentNodeTimeoutError(result.message);
      }
      if (result.status === "failed") {
        await writeTerminalMetadata("failed", `${result.failureKind}: ${result.message}`);
        throw new Error(`${result.failureKind}: ${result.message}`);
      }
      if (!node.outputSchema) {
        await writeTerminalMetadata("completed");
        return result.responseText;
      }
      const conformed = conformAgentOutput(node.outputSchema, result.responseText, node.id);
      if (conformed.rawRecoveredOutput !== undefined) {
        const rawRecoveredOutputArtifact = await writeAgentRawRecoveredOutputArtifact(node, options, turn + 1, conformed.rawRecoveredOutput);
        if (rawRecoveredOutputArtifact) turns[turn] = { ...turns[turn]!, rawRecoveredOutputArtifact };
      }
      if (conformed.ok) {
        await writeTerminalMetadata("completed");
        return conformed.output;
      }
      turns[turn] = { ...turns[turn]!, failureKind: conformed.kind, message: conformed.message };
      if (turn === maxRepairTurns) {
        await writeTerminalMetadata("failed", `${conformed.kind}: ${conformed.message}`);
        throw new Error(`${conformed.kind}: ${conformed.message}`);
      }
      await delay(options.repairDelayMs ?? DEFAULT_REPAIR_DELAY_MS, options.signal, deadline);
      prompt = buildAgentPrompt(CONTINUATION_PROMPT, node.outputSchema);
    }
    throw new Error(`Agent node '${node.id}' exhausted response repair.`);
  } catch (error) {
    if (!metadataWritten) {
      await writeTerminalMetadata(error instanceof AgentNodeCancelledError ? "cancelled" : error instanceof AgentNodeTimeoutError ? "timed_out" : "failed", error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
}

function shouldCaptureRawAcpDebug(): boolean {
  return process.env.ACPUS_AGENT_RAW_ACP_DEBUG === "1";
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

function evaluateEnv(env: Record<string, any> | undefined, scope: EvaluationScope): Record<string, string> {
  if (!env) return {};
  return Object.fromEntries(Object.entries(env).map(([key, value]) => {
    if (value && typeof value === "object" && value.kind === "secret") throw new Error(`Agent env '${key}' references an unresolved secret.`);
    return [key, stringValue(evaluateExpr(value, scope), `agent env ${key}`)];
  }));
}

function stringValue(value: unknown, label: string): string {
  if (typeof value === "string") return value;
  throw new Error(`${label} must evaluate to string.`);
}

function agentSelector(definition: AgentDefinitionIR): AgentTurnRequest["agent"] {
  return definition.kind === "agent_command"
    ? { kind: "command", command: definition.command }
    : { kind: "named", name: definition.use };
}

function renderSessionKey(node: AgentNodeIR, scope: EvaluationScope): string | undefined {
  if (!node.run.sessionKey) return undefined;
  const rendered = renderTemplate(node.run.sessionKey, scope);
  if (rendered.trim().length === 0) throw new Error(`Agent node '${node.id}' sessionKey must render to a non-empty string.`);
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
  const extraKeys = schema.kind === "object" ? " Extra keys are accepted but are not available to later workflow expressions." : "";
  return `${text}\n\n# OUTPUT SCHEMA\n**After completing the task, your final response MUST be exactly one JSON value that conforms to this schema, with no Markdown or prose.${extraKeys}**\n${JSON.stringify(schemaToJsonSchema(schema), null, 2)}`;
}

type ConformanceResult =
  | { ok: true; output: JsonValue; rawRecoveredOutput: JsonValue }
  | { ok: false; kind: "output_conformance" | "empty_response"; message: string; rawRecoveredOutput?: JsonValue };

function conformAgentOutput(schema: SchemaIR, text: string, nodeId: string): ConformanceResult {
  if (text.trim().length === 0) return { ok: false, kind: "empty_response", message: `Agent node '${nodeId}' returned an empty response.` };
  const recovered = recoverJson(text);
  if (recovered === undefined) return { ok: false, kind: "output_conformance", message: `Agent node '${nodeId}' response could not be recovered as JSON.` };
  try {
    return { ok: true, output: normalizeValue(schema, projectToSchema(schema, recovered), `Node '${nodeId}' output`), rawRecoveredOutput: recovered };
  } catch (error) {
    return { ok: false, kind: "output_conformance", message: error instanceof Error ? error.message : String(error), rawRecoveredOutput: recovered };
  }
}

function recoverJson(text: string): JsonValue | undefined {
  const trimmed = text.trim();
  try {
    return parsedJsonValue(JSON.parse(trimmed));
  } catch {}
  const candidates = balancedJsonCandidates(text);
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const candidate = candidates[i]!;
    try {
      return parsedJsonValue(JSON.parse(candidate));
    } catch {}
    if (/^[{[]/.test(candidate.trimStart())) {
      try {
        return parsedJsonValue(JSON.parse(jsonrepair(candidate)));
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
  prompt: string,
  result: AgentTurnResult,
  captureRawDebug: boolean,
): Promise<AgentTurnRecord> {
  const base = {
    turn,
    status: result.status,
    telemetry: telemetrySummary(result.telemetry),
    ...(result.status === "failed" ? { failureKind: result.failureKind, message: result.message } : {}),
    ...(result.status === "cancelled" ? { message: result.message } : {}),
  } satisfies AgentTurnRecord;
  if (!options.store || !options.runId) return base;
  const promptArtifact = await writeAgentArtifact(options, turn, "prompt.md", prompt, "text/markdown");
  const responseArtifact = await writeAgentArtifact(options, turn, "response.md", result.responseText, "text/markdown");
  const telemetry = telemetryWithArtifactRefs(result.telemetry, promptArtifact, responseArtifact);
  return {
    ...base,
    promptArtifact,
    responseArtifact,
    ...(result.stderr ? { stderrArtifact: await writeAgentArtifact(options, turn, "stderr.log", result.stderr, "text/plain") } : {}),
    ...(captureRawDebug && result.rawDebug ? { rawAcpDebugArtifact: await writeAgentArtifact(options, turn, "raw-acp.jsonl", result.rawDebug.stdout, "application/x-ndjson") } : {}),
    telemetryArtifact: await writeAgentArtifact(options, turn, "telemetry.json", `${JSON.stringify({
      status: result.status,
      nodeId: node.id,
      turn,
      telemetry,
      ...(result.status === "failed" ? { failureKind: result.failureKind, message: result.message } : {}),
      ...(result.status === "cancelled" ? { message: result.message } : {}),
    }, null, 2)}\n`, "application/json"),
  };
}

function telemetryWithArtifactRefs(telemetry: AgentTurnTelemetry, promptArtifact: AgentArtifactRef, responseArtifact: AgentArtifactRef): AgentTurnTelemetry {
  return {
    ...telemetry,
    ...(telemetry.input ? { input: { ...telemetry.input, artifactRef: promptArtifact.relativePath } } : {}),
    ...(telemetry.output ? { output: { ...telemetry.output, artifactRef: responseArtifact.relativePath } } : {}),
  };
}

function telemetrySummary(telemetry: AgentTurnTelemetry): AgentTurnTelemetrySummary {
  return pruneUndefined({
    eventCount: telemetry.eventCount,
    stopReason: telemetry.stopReason,
    context: telemetry.context,
    tokenUsage: telemetry.tokenUsage,
    tools: { totalToolCallCount: telemetry.tools.totalToolCallCount },
    cwd: telemetry.cwd,
    acpxRecordId: telemetry.acpxRecordId,
  }) as AgentTurnTelemetrySummary;
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
  return { artifactId: id, relativePath, mediaType };
}

async function writeAgentRawRecoveredOutputArtifact(node: AgentNodeIR, options: AgentExecutorOptions, turn: number, rawRecoveredOutput: JsonValue): Promise<AgentArtifactRef | undefined> {
  if (!options.store || !options.runId) return undefined;
  return writeAgentArtifact(options, turn, "raw-output.json", `${JSON.stringify({
    nodeId: node.id,
    turn,
    rawRecoveredOutput,
  }, null, 2)}\n`, "application/json");
}

async function writeAgentAttemptMetadata(
  node: AgentNodeIR,
  options: AgentExecutorOptions,
  sessionName: string | undefined,
  explicitSessionKey: string | undefined,
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
