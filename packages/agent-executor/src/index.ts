import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

const MAX_AGENT_OUTPUT_BYTES = 1_000_000;
const FORCE_KILL_GRACE_MS = 5_000;
const TOOL_INPUT_PREVIEW_EDGE_BYTES = 4 * 1024;
const FINAL_TOOL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export type AgentPermissionMode = "approve-reads" | "approve-all" | "deny-all";

export type AgentSelector =
  | { kind: "named"; name: string }
  | { kind: "command"; command: string };

export type AgentTurnRequest = {
  agent: AgentSelector;
  prompt: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  sessionName: string;
  permissionMode: AgentPermissionMode;
  model?: string;
  agentMode?: string;
  timeout?: string;
  signal?: AbortSignal;
  captureRawDebug?: boolean;
};

export type AgentBackendFailureKind =
  | "config"
  | "spawn"
  | "provider_exit"
  | "timeout"
  | "output_overflow";

export type AgentIoPreview = {
  preview: string;
  truncated: boolean;
  originalBytes: number;
  headBytes: number;
  tailBytes?: number;
  artifactRef?: string;
};

export type AgentContextTelemetry = {
  used: number;
  size: number;
  updatedAt: string;
};

export type AgentTokenUsageTelemetry = {
  source: "prompt_response";
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
};

export type AgentToolCallTelemetry = {
  toolCallId: string;
  title?: string;
  kind?: string;
  toolName?: string;
  status?: string;
  input?: AgentIoPreview;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type AgentToolsTelemetry = {
  totalToolCallCount: number;
  calls: AgentToolCallTelemetry[];
};

export type AgentTurnTelemetry = {
  eventCount: number;
  stopReason?: string;
  context?: AgentContextTelemetry;
  tokenUsage?: AgentTokenUsageTelemetry;
  tools: AgentToolsTelemetry;
  input?: AgentIoPreview;
  output?: AgentIoPreview;
  cwd?: string;
  acpxRecordId?: string;
};

export type AgentTurnRawDebug = {
  stdout: string;
};

export type AgentTurnResult =
  | {
      status: "completed";
      responseText: string;
      stderr: string;
      telemetry: AgentTurnTelemetry;
      rawDebug?: AgentTurnRawDebug;
    }
  | {
      status: "failed";
      failureKind: AgentBackendFailureKind;
      message: string;
      responseText: string;
      stderr: string;
      telemetry: AgentTurnTelemetry;
      rawDebug?: AgentTurnRawDebug;
    }
  | {
      status: "cancelled";
      message: string;
      responseText: string;
      stderr: string;
      telemetry: AgentTurnTelemetry;
      rawDebug?: AgentTurnRawDebug;
    };

type AcpxInvocation = {
  args: string[];
  input?: string;
  timeout?: string;
  signal?: AbortSignal;
  cancelArgs?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

type AcpxProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  overflowed: boolean;
  aborted: boolean;
  spawnError?: string;
};

type PromptSummary = {
  responseText: string;
  telemetry: AgentTurnTelemetry;
  malformedLine?: string;
  errorMessage?: string;
};

type PromptSummaryOptions = {
  prompt: string;
  cwd: string;
  acpxRecordId?: string;
};

type TurnDeadline = {
  timeout: string;
  expiresAt: number;
};

type RemainingTimeout =
  | { expired: true }
  | { expired: false; timeout?: string };

export async function executeAgentTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
  if (request.signal?.aborted) {
    return cancelledResult("Agent turn was aborted before dispatch.");
  }

  const deadline = turnDeadline(request.timeout);
  const ensureTimeout = remainingTimeout(deadline);
  if (ensureTimeout.expired) return timeoutResult(request.timeout);
  const ensure = await runAcpx({
    args: buildAcpxArgs(request, ["sessions", "ensure", "--name", request.sessionName], ensureTimeout.timeout),
    cwd: request.cwd,
    env: request.env,
    ...(ensureTimeout.timeout === undefined ? {} : { timeout: ensureTimeout.timeout }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  if (ensure.exitCode !== 0 || ensure.spawnError || ensure.timedOut || ensure.overflowed || ensure.aborted) {
    return failedControlResult("sessions ensure", ensure, "provider_exit", request.timeout);
  }

  if (request.agentMode) {
    // Current known adapter modes, for operators only: claude default/acceptEdits/dontAsk/bypassPermissions/auto/plan; codex read-only/agent.
    // Do not validate against this list; acpx and the selected agent own mode support.
    const setModeTimeout = remainingTimeout(deadline);
    if (setModeTimeout.expired) return timeoutResult(request.timeout);
    const setMode = await runAcpx({
      args: buildAcpxArgs(request, ["set-mode", request.agentMode, "-s", request.sessionName], setModeTimeout.timeout),
      cwd: request.cwd,
      env: request.env,
      ...(setModeTimeout.timeout === undefined ? {} : { timeout: setModeTimeout.timeout }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (setMode.exitCode !== 0 || setMode.spawnError || setMode.timedOut || setMode.overflowed || setMode.aborted) {
      return failedControlResult("set-mode", setMode, "config", request.timeout);
    }
  }

  const promptTimeout = remainingTimeout(deadline);
  if (promptTimeout.expired) return timeoutResult(request.timeout);
  const prompt = await runAcpx({
    args: buildAcpxArgs(request, ["prompt", "-s", request.sessionName, "-f", "-"], promptTimeout.timeout),
    cancelArgs: buildAcpxArgs(request, ["cancel", "-s", request.sessionName]),
    input: request.prompt,
    cwd: request.cwd,
    env: request.env,
    ...(promptTimeout.timeout === undefined ? {} : { timeout: promptTimeout.timeout }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  const acpxRecordId = extractAcpxRecordId(ensure.stdout);
  const summary = summarizePromptOutput(prompt.stdout, {
    prompt: request.prompt,
    cwd: request.cwd,
    ...(acpxRecordId ? { acpxRecordId } : {}),
  });
  const rawDebug = request.captureRawDebug ? { stdout: prompt.stdout } : undefined;
  if (prompt.aborted) return withRawDebug({ status: "cancelled", message: "Agent turn was aborted.", responseText: summary.responseText, stderr: prompt.stderr, telemetry: summary.telemetry }, rawDebug);
  if (prompt.timedOut) return withRawDebug({ status: "failed", failureKind: "timeout", message: timeoutMessage(request.timeout), responseText: summary.responseText, stderr: prompt.stderr, telemetry: summary.telemetry }, rawDebug);
  if (prompt.overflowed) return withRawDebug({ status: "failed", failureKind: "output_overflow", message: `Agent output exceeded ${MAX_AGENT_OUTPUT_BYTES} bytes.`, responseText: summary.responseText, stderr: prompt.stderr, telemetry: summary.telemetry }, rawDebug);
  if (prompt.spawnError) return withRawDebug({ status: "failed", failureKind: "spawn", message: prompt.spawnError, responseText: summary.responseText, stderr: prompt.stderr, telemetry: summary.telemetry }, rawDebug);
  if (summary.malformedLine) return withRawDebug({ status: "failed", failureKind: "provider_exit", message: `Malformed acpx JSON output: ${boundedTail(summary.malformedLine)}`, responseText: summary.responseText, stderr: prompt.stderr, telemetry: summary.telemetry }, rawDebug);
  if (summary.errorMessage) return withRawDebug({ status: "failed", failureKind: classifyFailureText(summary.errorMessage), message: summary.errorMessage, responseText: summary.responseText, stderr: prompt.stderr, telemetry: summary.telemetry }, rawDebug);
  if (prompt.exitCode !== 0) return withRawDebug({ status: "failed", failureKind: classifyProviderExit(prompt), message: failureMessage(prompt), responseText: summary.responseText, stderr: prompt.stderr, telemetry: summary.telemetry }, rawDebug);
  return withRawDebug({ status: "completed", responseText: summary.responseText, stderr: prompt.stderr, telemetry: summary.telemetry }, rawDebug);
}

function withRawDebug<T extends AgentTurnResult>(result: T, rawDebug: AgentTurnRawDebug | undefined): T {
  return rawDebug ? { ...result, rawDebug } : result;
}

function buildAcpxArgs(request: AgentTurnRequest, command: string[], timeout = request.timeout): string[] {
  const args = [
    "--cwd",
    request.cwd,
    "--format",
    "json",
    "--json-strict",
    permissionFlag(request.permissionMode),
  ];
  if (request.model) args.push("--model", request.model);
  if (timeout) args.push("--timeout", acpxTimeoutSeconds(timeout));
  if (request.agent.kind === "command") args.push("--agent", request.agent.command);
  else args.push(request.agent.name);
  args.push(...command);
  return args;
}

function permissionFlag(mode: AgentPermissionMode): string {
  if (mode === "approve-all") return "--approve-all";
  if (mode === "approve-reads") return "--approve-reads";
  return "--deny-all";
}

function runAcpx(invocation: AcpxInvocation): Promise<AcpxProcessResult> {
  return new Promise(resolve => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(process.execPath, [resolveAcpxCli(), ...invocation.args], {
        cwd: invocation.cwd,
        env: invocation.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ exitCode: null, stdout: "", stderr: "", timedOut: false, overflowed: false, aborted: false, spawnError: errorMessage(error) });
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let termination: "timeout" | "overflow" | "abort" | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let killTimeout: NodeJS.Timeout | undefined;
    const abort = () => terminate("abort");
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
      invocation.signal?.removeEventListener("abort", abort);
    };

    const terminate = (reason: "timeout" | "overflow" | "abort") => {
      if (termination) return;
      termination = reason;
      if (timeout) clearTimeout(timeout);
      if (invocation.cancelArgs) runDetachedAcpx(invocation.cancelArgs, invocation.cwd, invocation.env);
      killTimeout = setTimeout(() => killProcess(child.pid, "SIGKILL"), FORCE_KILL_GRACE_MS);
      killProcess(child.pid);
    };

    if (invocation.timeout) {
      timeout = setTimeout(() => terminate("timeout"), parseDurationMs(invocation.timeout));
    }
    invocation.signal?.addEventListener("abort", abort, { once: true });
    if (invocation.signal?.aborted) terminate("abort");

    const collect = (target: Buffer[], chunk: unknown) => {
      if (termination) return;
      const bytes = Buffer.from(chunk as any);
      outputBytes += bytes.byteLength;
      if (outputBytes > MAX_AGENT_OUTPUT_BYTES) {
        terminate("overflow");
        return;
      }
      target.push(bytes);
    };

    child.stdout.on("data", chunk => collect(stdout, chunk));
    child.stderr.on("data", chunk => collect(stderr, chunk));
    child.on("close", exitCode => {
      cleanup();
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut: termination === "timeout",
        overflowed: termination === "overflow",
        aborted: termination === "abort",
      });
    });
    child.on("error", error => {
      cleanup();
      resolve({ exitCode: null, stdout: "", stderr: error.message, timedOut: false, overflowed: false, aborted: false, spawnError: error.message });
    });
    child.stdin.end(invocation.input ?? "");
  });
}

function resolveAcpxCli(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("acpx/package.json")), "dist", "cli.js");
}

function runDetachedAcpx(args: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  try {
    const child = spawn(process.execPath, [resolveAcpxCli(), ...args], { cwd, env, stdio: "ignore" });
    child.unref();
  } catch {}
}

function summarizePromptOutput(stdout: string, options?: PromptSummaryOptions): PromptSummary {
  let responseText = "";
  let eventCount = 0;
  let stopReason: string | undefined;
  let malformedLine: string | undefined;
  let errorMessage: string | undefined;
  const tools = new Map<string, AgentToolCallTelemetry>();
  let context: AgentContextTelemetry | undefined;
  let tokenUsage: AgentTokenUsageTelemetry | undefined;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      malformedLine ??= line;
      continue;
    }
    eventCount += 1;
    errorMessage ??= jsonRpcErrorMessage(event);
    responseText += textFromEvent(event);
    context = contextFromEvent(event, context);
    captureToolEvent(event, tools);
    const result = isRecord(event) && isRecord(event.result) ? event.result : undefined;
    if (typeof result?.stopReason === "string") stopReason = result.stopReason;
    tokenUsage ??= tokenUsageFromResult(result);
  }
  return {
    responseText,
    telemetry: {
      eventCount,
      ...(stopReason ? { stopReason } : {}),
      ...(context ? { context } : {}),
      ...(tokenUsage ? { tokenUsage } : {}),
      tools: { totalToolCallCount: tools.size, calls: [...tools.values()] },
      ...(options ? {
        input: fullPreview(options.prompt),
        output: fullPreview(responseText),
        cwd: options.cwd,
        ...(options.acpxRecordId ? { acpxRecordId: options.acpxRecordId } : {}),
      } : {}),
    },
    ...(malformedLine ? { malformedLine } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function textFromEvent(event: unknown): string {
  if (!isRecord(event)) return "";
  const params = isRecord(event.params) ? event.params : undefined;
  const update = isRecord(params?.update) ? params.update : undefined;
  if (update?.sessionUpdate !== "agent_message_chunk") return "";
  const content = isRecord(update.content) ? update.content : undefined;
  if (content?.type === "text" && typeof content.text === "string") return content.text;
  return "";
}

function contextFromEvent(event: unknown, previous: AgentContextTelemetry | undefined): AgentContextTelemetry | undefined {
  const update = eventUpdate(event);
  if (update?.sessionUpdate !== "usage_update") return previous;
  const used = numericField(update, "used");
  const size = numericField(update, "size");
  if (used === undefined && size === undefined) return previous;
  const nextUsed = used === 0 && previous && previous.used > 0 ? previous.used : used ?? previous?.used ?? 0;
  const nextSize = size ?? previous?.size ?? 0;
  return { used: nextUsed, size: nextSize, updatedAt: new Date().toISOString() };
}

function captureToolEvent(event: unknown, tools: Map<string, AgentToolCallTelemetry>): void {
  const update = eventUpdate(event);
  if (update?.sessionUpdate !== "tool_call" && update?.sessionUpdate !== "tool_call_update") return;
  const toolCallId = stringField(update, "toolCallId") ?? stringField(update, "id");
  if (!toolCallId) return;
  const now = new Date().toISOString();
  const previous = tools.get(toolCallId);
  const status = stringField(update, "status") ?? previous?.status;
  const next: AgentToolCallTelemetry = {
    toolCallId,
    startedAt: previous?.startedAt ?? now,
    updatedAt: now,
  };
  const title = stringField(update, "title") ?? previous?.title;
  const kind = stringField(update, "kind") ?? previous?.kind;
  const toolName = toolNameFromUpdate(update) ?? previous?.toolName;
  const input = rawInputPreview(update) ?? previous?.input;
  if (title) next.title = title;
  if (kind) next.kind = kind;
  if (toolName) next.toolName = toolName;
  if (status) next.status = status;
  if (input) next.input = input;
  if (FINAL_TOOL_STATUSES.has(status ?? "")) next.completedAt = previous?.completedAt ?? now;
  else if (previous?.completedAt) next.completedAt = previous.completedAt;
  tools.set(toolCallId, next);
}

function eventUpdate(event: unknown): Record<string, any> | undefined {
  if (!isRecord(event)) return undefined;
  const params = isRecord(event.params) ? event.params : undefined;
  return isRecord(params?.update) ? params.update : undefined;
}

function tokenUsageFromResult(result: Record<string, any> | undefined): AgentTokenUsageTelemetry | undefined {
  const usage = isRecord(result?.usage) ? result.usage : undefined;
  if (!usage) return undefined;
  const tokenUsage: AgentTokenUsageTelemetry = { source: "prompt_response" };
  const inputTokens = firstNumber(usage, ["inputTokens", "input_tokens"]);
  const outputTokens = firstNumber(usage, ["outputTokens", "output_tokens"]);
  const cachedReadTokens = firstNumber(usage, ["cachedReadTokens", "cacheReadInputTokens", "cache_read_input_tokens"]);
  const cachedWriteTokens = firstNumber(usage, ["cachedWriteTokens", "cacheCreationInputTokens", "cache_creation_input_tokens"]);
  const thoughtTokens = firstNumber(usage, ["thoughtTokens", "thought_tokens"]);
  const totalTokens = firstNumber(usage, ["totalTokens", "total_tokens"]);
  if (inputTokens !== undefined) tokenUsage.inputTokens = inputTokens;
  if (outputTokens !== undefined) tokenUsage.outputTokens = outputTokens;
  if (cachedReadTokens !== undefined) tokenUsage.cachedReadTokens = cachedReadTokens;
  if (cachedWriteTokens !== undefined) tokenUsage.cachedWriteTokens = cachedWriteTokens;
  if (thoughtTokens !== undefined) tokenUsage.thoughtTokens = thoughtTokens;
  if (totalTokens !== undefined) tokenUsage.totalTokens = totalTokens;
  return Object.keys(tokenUsage).length === 1 ? undefined : tokenUsage;
}

function toolNameFromUpdate(update: Record<string, any>): string | undefined {
  const meta = isRecord(update._meta) ? update._meta : undefined;
  const claudeCode = isRecord(meta?.claudeCode) ? meta.claudeCode : undefined;
  return stringField(claudeCode, "toolName");
}

function rawInputPreview(update: Record<string, any>): AgentIoPreview | undefined {
  if (!Object.prototype.hasOwnProperty.call(update, "rawInput")) return undefined;
  return truncatedJsonPreview(update.rawInput);
}

function extractAcpxRecordId(stdout: string): string | undefined {
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line) as unknown;
      if (isRecord(event) && typeof event.acpxRecordId === "string") return event.acpxRecordId;
      const result = isRecord(event) && isRecord(event.result) ? event.result : undefined;
      if (typeof result?.acpxRecordId === "string") return result.acpxRecordId;
    } catch {}
  }
  return undefined;
}

function fullPreview(value: string): AgentIoPreview {
  const originalBytes = Buffer.byteLength(value, "utf8");
  return { preview: value, truncated: false, originalBytes, headBytes: originalBytes };
}

function truncatedJsonPreview(value: unknown): AgentIoPreview {
  return truncatedPreview(JSON.stringify(value), TOOL_INPUT_PREVIEW_EDGE_BYTES);
}

function truncatedPreview(value: string, edgeBytes: number): AgentIoPreview {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= edgeBytes * 2) {
    return { preview: value, truncated: false, originalBytes: buffer.byteLength, headBytes: buffer.byteLength };
  }
  const head = buffer.subarray(0, edgeBytes).toString("utf8");
  const tail = buffer.subarray(buffer.byteLength - edgeBytes).toString("utf8");
  return {
    preview: `${head}\n[acpus truncated ${buffer.byteLength} bytes]\n${tail}`,
    truncated: true,
    originalBytes: buffer.byteLength,
    headBytes: edgeBytes,
    tailBytes: edgeBytes,
  };
}

function emptyTelemetry(): AgentTurnTelemetry {
  return { eventCount: 0, tools: { totalToolCallCount: 0, calls: [] } };
}

function failedControlResult(command: string, result: AcpxProcessResult, defaultKind: AgentBackendFailureKind = "provider_exit", timeout: string | undefined = undefined): AgentTurnResult {
  if (result.aborted) return cancelledResult(`Agent ${command} was aborted.`);
  if (result.timedOut) return failedResult("timeout", timeoutMessage(timeout), result);
  if (result.overflowed) return failedResult("output_overflow", `Agent output exceeded ${MAX_AGENT_OUTPUT_BYTES} bytes.`, result);
  if (result.spawnError) return failedResult("spawn", result.spawnError, result);
  const message = failureMessage(result);
  return failedResult(defaultKind === "provider_exit" ? classifyFailureText(message) : defaultKind, message, result);
}

function timeoutResult(timeout: string | undefined): AgentTurnResult {
  return { status: "failed", failureKind: "timeout", message: timeoutMessage(timeout), responseText: "", stderr: "", telemetry: emptyTelemetry() };
}

function failedResult(kind: AgentBackendFailureKind, message: string, result: AcpxProcessResult): AgentTurnResult {
  const summary = summarizePromptOutput(result.stdout);
  return { status: "failed", failureKind: kind, message, responseText: summary.responseText, stderr: result.stderr, telemetry: summary.telemetry };
}

function cancelledResult(message: string): AgentTurnResult {
  return { status: "cancelled", message, responseText: "", stderr: "", telemetry: emptyTelemetry() };
}

function classifyProviderExit(result: AcpxProcessResult): AgentBackendFailureKind {
  return classifyFailureText(failureMessage(result));
}

function classifyFailureText(text: string): AgentBackendFailureKind {
  return /invalid params|unsupported|capability|model|set.?mode/i.test(text) ? "config" : "provider_exit";
}

function failureMessage(result: AcpxProcessResult): string {
  return (extractHumanError(result.stdout) || extractHumanError(result.stderr) || nonJsonTail(result.stderr) || nonJsonTail(result.stdout) || `acpx exited with ${result.exitCode ?? "unknown status"}`).trim();
}

function timeoutMessage(timeout: string | undefined): string {
  return timeout ? `Agent turn timed out after ${timeout}.` : "Agent turn timed out.";
}

function boundedTail(value: string, max = 4000): string {
  return value.length > max ? value.slice(value.length - max) : value;
}

function extractHumanError(value: string): string {
  for (const raw of value.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    const message = jsonRpcErrorMessage(event);
    if (message) return boundedTail(message);
  }
  return "";
}

function jsonRpcErrorMessage(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  const error = isRecord(event.error) ? event.error : undefined;
  if (typeof error?.message === "string") return error.message;
  return undefined;
}

function nonJsonTail(value: string): string {
  return boundedTail(value.split(/\r?\n/).filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    try {
      JSON.parse(trimmed);
      return false;
    } catch {
      return true;
    }
  }).join("\n"));
}

function killProcess(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, signal);
  } catch {}
}

function parseDurationMs(value: string): number {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(value);
  if (!match) throw new Error(`Invalid duration '${value}'.`);
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  if (unit === "ms") return amount;
  if (unit === "s") return amount * 1000;
  if (unit === "m") return amount * 60_000;
  return amount * 3_600_000;
}

function turnDeadline(timeout: string | undefined): TurnDeadline | undefined {
  return timeout === undefined ? undefined : { timeout, expiresAt: Date.now() + parseDurationMs(timeout) };
}

function remainingTimeout(deadline: TurnDeadline | undefined): RemainingTimeout {
  if (!deadline) return { expired: false };
  const remaining = deadline.expiresAt - Date.now();
  return remaining <= 0 ? { expired: true } : { expired: false, timeout: `${remaining}ms` };
}

function acpxTimeoutSeconds(value: string): string {
  return String(Math.max(1, Math.ceil(parseDurationMs(value) / 1000)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringField(value: Record<string, any> | undefined, key: string): string | undefined {
  return typeof value?.[key] === "string" ? value[key] : undefined;
}

function numericField(value: Record<string, any>, key: string): number | undefined {
  const item = value[key];
  return typeof item === "number" && Number.isFinite(item) ? item : undefined;
}

function firstNumber(value: Record<string, any>, keys: string[]): number | undefined {
  for (const key of keys) {
    const item = numericField(value, key);
    if (item !== undefined) return item;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
