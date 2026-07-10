import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

const FORCE_KILL_GRACE_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
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
  timeoutMs?: number;
  signal?: AbortSignal;
  captureRawDebug?: boolean;
  onProgress?: (progress: AgentTurnProgress) => unknown;
};

export type AgentBackendFailureKind =
  | "config"
  | "spawn"
  | "provider_exit"
  | "timeout";

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
  source: "prompt_response" | "usage_update";
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

export type AgentTurnProgress = {
  responseText: string;
  telemetry: AgentTurnTelemetry;
  updatedAt: string;
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
  deadline?: TurnDeadline;
  signal?: AbortSignal;
  cancelArgs?: (timeoutMs: number | undefined) => string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onStdoutLine?: (line: string) => void;
};

type AcpxProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  stdinError?: string;
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

type PromptAccumulator = {
  responseText: string;
  eventCount: number;
  stopReason?: string;
  malformedLine?: string;
  errorMessage?: string;
  tools: Map<string, AgentToolCallTelemetry>;
  context?: AgentContextTelemetry;
  tokenUsage?: AgentTokenUsageTelemetry;
  options?: PromptSummaryOptions;
};

type TurnDeadline = {
  timeoutMs: number;
  startedAt: number;
};

type RemainingTimeout =
  | { expired: true }
  | { expired: false; timeoutMs?: number };

type TurnBudget =
  | { type: "abort"; timeoutMs?: number }
  | { type: "expired" }
  | { type: "continue"; timeoutMs?: number };

export async function executeAgentTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
  if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 0)) {
    return configResult("Agent turn timeoutMs must be a non-negative safe integer.");
  }
  const deadline = turnDeadline(request.timeoutMs);
  const env = requestEnv(request);
  const ensureBudget = turnBudget(deadline, request.signal);
  if (ensureBudget.type === "abort") return cancelledResult("Agent turn was aborted before dispatch.");
  if (ensureBudget.type === "expired") return timeoutResult(request.timeoutMs);
  const ensure = await runAcpx({
    args: buildAcpxArgs(request, ["sessions", "ensure", "--name", request.sessionName], ensureBudget.timeoutMs),
    cwd: request.cwd,
    env,
    ...(deadline === undefined ? {} : { deadline }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  if (ensure.exitCode !== 0 || ensure.stdinError !== undefined || ensure.spawnError || ensure.timedOut || ensure.aborted) {
    return failedControlResult("sessions ensure", ensure, "provider_exit", request.timeoutMs);
  }

  if (request.agentMode) {
    // Current known adapter modes, for operators only: claude default/acceptEdits/dontAsk/bypassPermissions/auto/plan; codex read-only/agent.
    // Do not validate against this list; acpx and the selected agent own mode support.
    const setModeBudget = turnBudget(deadline, request.signal);
    if (setModeBudget.type === "abort") return cancelledResult("Agent turn was aborted before dispatch.");
    if (setModeBudget.type === "expired") return timeoutResult(request.timeoutMs);
    const setMode = await runAcpx({
      args: buildAcpxArgs(request, ["set-mode", request.agentMode, "-s", request.sessionName], setModeBudget.timeoutMs),
      cwd: request.cwd,
      env,
      ...(deadline === undefined ? {} : { deadline }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (setMode.exitCode !== 0 || setMode.stdinError !== undefined || setMode.spawnError || setMode.timedOut || setMode.aborted) {
      return failedControlResult("set-mode", setMode, "config", request.timeoutMs);
    }
  }

  const promptBudget = turnBudget(deadline, request.signal);
  if (promptBudget.type === "abort") return cancelledResult("Agent turn was aborted before dispatch.");
  if (promptBudget.type === "expired") return timeoutResult(request.timeoutMs);
  const acpxRecordId = extractAcpxRecordId(ensure.stdout);
  const accumulator = createPromptAccumulator({
    prompt: request.prompt,
    cwd: request.cwd,
    ...(acpxRecordId ? { acpxRecordId } : {}),
  });
  const prompt = await runAcpx({
    args: buildAcpxArgs(request, ["prompt", "-s", request.sessionName, "-f", "-"], promptBudget.timeoutMs),
    cancelArgs: timeoutMs => buildAcpxArgs(request, ["cancel", "-s", request.sessionName], timeoutMs),
    input: request.prompt,
    cwd: request.cwd,
    env,
    ...(request.onProgress ? { onStdoutLine: (line: string) => {
      if (!consumePromptLine(accumulator, line)) return;
      try {
        const observed = request.onProgress?.({
          responseText: accumulator.responseText,
          telemetry: telemetryFromAccumulator(accumulator),
          updatedAt: new Date().toISOString(),
        });
        if (observed) void Promise.resolve(observed).catch(() => {});
      } catch {}
    } } : {}),
    ...(deadline === undefined ? {} : { deadline }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  const summary = summarizePromptOutput(prompt.stdout, accumulator.options);
  const rawDebug = request.captureRawDebug ? { stdout: prompt.stdout } : undefined;
  if (prompt.aborted) return withRawDebug({ status: "cancelled", message: "Agent turn was aborted.", responseText: summary.responseText, stderr: prompt.stderr, telemetry: summary.telemetry }, rawDebug);
  if (prompt.timedOut) return withRawDebug({ status: "failed", failureKind: "timeout", message: timeoutMessage(request.timeoutMs), responseText: summary.responseText, stderr: prompt.stderr, telemetry: summary.telemetry }, rawDebug);
  if (prompt.spawnError) return withRawDebug({ status: "failed", failureKind: "spawn", message: prompt.spawnError, responseText: summary.responseText, stderr: prompt.stderr, telemetry: summary.telemetry }, rawDebug);
  if (summary.malformedLine) return withRawDebug({ status: "failed", failureKind: "provider_exit", message: `Malformed acpx JSON output: ${boundedTail(summary.malformedLine)}`, responseText: summary.responseText, stderr: prompt.stderr, telemetry: summary.telemetry }, rawDebug);
  if (summary.errorMessage) return withRawDebug({ status: "failed", failureKind: classifyFailureText(summary.errorMessage), message: summary.errorMessage, responseText: summary.responseText, stderr: prompt.stderr, telemetry: summary.telemetry }, rawDebug);
  if (prompt.stdinError !== undefined || prompt.exitCode !== 0) return withRawDebug({ status: "failed", failureKind: classifyProviderExit(prompt), message: failureMessage(prompt), responseText: summary.responseText, stderr: prompt.stderr, telemetry: summary.telemetry }, rawDebug);
  return withRawDebug({ status: "completed", responseText: summary.responseText, stderr: prompt.stderr, telemetry: summary.telemetry }, rawDebug);
}

function withRawDebug<T extends AgentTurnResult>(result: T, rawDebug: AgentTurnRawDebug | undefined): T {
  return rawDebug ? { ...result, rawDebug } : result;
}

function requestEnv(request: AgentTurnRequest): NodeJS.ProcessEnv {
  const env = { ...request.env };
  if (request.agent.kind === "named" && request.agent.name === "claude" && env.ACPX_CLAUDE_INCLUDE_USER_SETTINGS === undefined) {
    env.ACPX_CLAUDE_INCLUDE_USER_SETTINGS = "1";
  }
  return env;
}

function buildAcpxArgs(request: AgentTurnRequest, command: string[], timeoutMs: number | undefined): string[] {
  const args = [
    "--cwd",
    request.cwd,
    "--format",
    "json",
    "--json-strict",
    permissionFlag(request.permissionMode),
  ];
  if (request.model) args.push("--model", request.model);
  if (timeoutMs !== undefined) args.push("--timeout", acpxTimeoutSeconds(timeoutMs));
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
      const termination = boundaryTermination(invocation);
      resolve({
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: termination === "timeout",
        aborted: termination === "abort",
        ...(termination === undefined ? { spawnError: errorMessage(error) } : {}),
      });
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stdoutDecoder = invocation.onStdoutLine ? new StringDecoder("utf8") : undefined;
    let stdoutLineBuffer = "";
    let termination: "timeout" | "abort" | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let killTimeout: NodeJS.Timeout | undefined;
    let settled = false;
    let stdinError: string | undefined;
    const abort = () => checkBudget();
    const cleanup = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (killTimeout !== undefined) clearTimeout(killTimeout);
      invocation.signal?.removeEventListener("abort", abort);
    };

    const settle = (exitCode: number | null, error?: Error) => {
      if (settled) return;
      settled = true;
      termination ??= boundaryTermination(invocation);
      cleanup();
      if (invocation.onStdoutLine) {
        stdoutLineBuffer += stdoutDecoder?.end() ?? "";
        emitCompleteStdoutLines(invocation.onStdoutLine);
        if (stdoutLineBuffer.trim()) invocation.onStdoutLine(stdoutLineBuffer);
      }
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: error && !termination ? error.message : Buffer.concat(stderr).toString("utf8"),
        timedOut: termination === "timeout",
        aborted: termination === "abort",
        ...(stdinError === undefined ? {} : { stdinError }),
        ...(!termination && error ? { spawnError: error.message } : {}),
      });
    };

    const terminate = (reason: "timeout" | "abort", cancelTimeoutMs: number | undefined) => {
      if (termination || settled) return;
      termination = reason;
      if (timeout !== undefined) clearTimeout(timeout);
      if (invocation.cancelArgs) runDetachedAcpx(invocation.cancelArgs(cancelTimeoutMs), invocation.cwd, invocation.env);
      killTimeout = setTimeout(() => killProcess(child.pid, "SIGKILL"), FORCE_KILL_GRACE_MS);
      killProcess(child.pid);
    };

    const checkBudget = () => {
      const budget = turnBudget(invocation.deadline, invocation.signal);
      if (budget.type === "abort") {
        terminate("abort", budget.timeoutMs);
        return;
      }
      if (budget.type === "expired") {
        terminate("timeout", 0);
        return;
      }
      if (budget.timeoutMs !== undefined) {
        timeout = setTimeout(checkBudget, Math.min(budget.timeoutMs, MAX_TIMER_DELAY_MS));
      }
    };

    const collect = (target: Buffer[], chunk: unknown, onLine?: (line: string) => void) => {
      if (termination || settled) return;
      const buffer = Buffer.from(chunk as any);
      target.push(buffer);
      if (!onLine) return;
      stdoutLineBuffer += stdoutDecoder?.write(buffer) ?? buffer.toString("utf8");
      emitCompleteStdoutLines(onLine);
    };

    child.stdout.on("data", chunk => collect(stdout, chunk, invocation.onStdoutLine));
    child.stderr.on("data", chunk => collect(stderr, chunk));
    child.on("close", exitCode => settle(exitCode));
    child.on("error", error => {
      if (termination) killProcess(child.pid, "SIGKILL");
      settle(null, error);
    });
    child.stdin.on("error", error => {
      if (termination || settled) return;
      stdinError ??= error.message;
    });
    invocation.signal?.addEventListener("abort", abort, { once: true });
    checkBudget();
    if (!termination) {
      try {
        child.stdin.end(invocation.input ?? "");
      } catch (error) {
        stdinError ??= errorMessage(error);
      }
    }

    function emitCompleteStdoutLines(onLine: (line: string) => void): void {
      for (;;) {
        const newline = stdoutLineBuffer.search(/\r?\n/);
        if (newline < 0) return;
        const line = stdoutLineBuffer.slice(0, newline);
        stdoutLineBuffer = stdoutLineBuffer.slice(stdoutLineBuffer[newline] === "\r" ? newline + 2 : newline + 1);
        onLine(line);
      }
    }
  });
}

function resolveAcpxCli(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("acpx/package.json")), "dist", "cli.js");
}

function runDetachedAcpx(args: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  try {
    const child = spawn(process.execPath, [resolveAcpxCli(), ...args], { cwd, env, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

function summarizePromptOutput(stdout: string, options?: PromptSummaryOptions): PromptSummary {
  const accumulator = createPromptAccumulator(options);
  for (const { line, event } of acpxJsonLines(stdout)) {
    consumePromptLineEvent(accumulator, line, event);
  }
  return summaryFromAccumulator(accumulator);
}

function createPromptAccumulator(options?: PromptSummaryOptions): PromptAccumulator {
  return {
    responseText: "",
    eventCount: 0,
    tools: new Map(),
    ...(options ? { options } : {}),
  };
}

function consumePromptLine(accumulator: PromptAccumulator, raw: string): boolean {
  const line = raw.trim();
  if (!line) return false;
  try {
    consumePromptLineEvent(accumulator, line, JSON.parse(line) as unknown);
  } catch {
    consumePromptLineEvent(accumulator, line, undefined);
  }
  return true;
}

function consumePromptLineEvent(accumulator: PromptAccumulator, line: string, event: unknown | undefined): void {
  if (event === undefined) {
    accumulator.malformedLine ??= line;
    return;
  }
  accumulator.eventCount += 1;
  const errorMessage = jsonRpcErrorMessage(event);
  if (accumulator.errorMessage === undefined && errorMessage !== undefined) accumulator.errorMessage = errorMessage;
  accumulator.responseText += textFromEvent(event);
  const context = contextFromEvent(event, accumulator.context);
  if (context !== undefined) accumulator.context = context;
  const eventTokenUsage = tokenUsageFromEvent(event);
  if (eventTokenUsage !== undefined) accumulator.tokenUsage = eventTokenUsage;
  captureToolEvent(event, accumulator.tools);
  const result = isRecord(event) && isRecord(event.result) ? event.result : undefined;
  if (typeof result?.stopReason === "string") accumulator.stopReason = result.stopReason;
  const tokenUsage = tokenUsageFromResult(result);
  if (tokenUsage !== undefined) accumulator.tokenUsage = tokenUsage;
}

function summaryFromAccumulator(accumulator: PromptAccumulator): PromptSummary {
  return {
    responseText: accumulator.responseText,
    telemetry: telemetryFromAccumulator(accumulator),
    ...(accumulator.malformedLine ? { malformedLine: accumulator.malformedLine } : {}),
    ...(accumulator.errorMessage ? { errorMessage: accumulator.errorMessage } : {}),
  };
}

function telemetryFromAccumulator(accumulator: PromptAccumulator): AgentTurnTelemetry {
  return {
    eventCount: accumulator.eventCount,
    ...(accumulator.stopReason ? { stopReason: accumulator.stopReason } : {}),
    ...(accumulator.context ? { context: accumulator.context } : {}),
    ...(accumulator.tokenUsage ? { tokenUsage: accumulator.tokenUsage } : {}),
    tools: { totalToolCallCount: accumulator.tools.size, calls: [...accumulator.tools.values()] },
    ...(accumulator.options ? {
      input: fullPreview(accumulator.options.prompt),
      output: fullPreview(accumulator.responseText),
      cwd: accumulator.options.cwd,
      ...(accumulator.options.acpxRecordId ? { acpxRecordId: accumulator.options.acpxRecordId } : {}),
    } : {}),
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
  return tokenUsageFromRecord(usage, "prompt_response");
}

function tokenUsageFromEvent(event: unknown): AgentTokenUsageTelemetry | undefined {
  const update = eventUpdate(event);
  if (update?.sessionUpdate !== "usage_update") return undefined;
  const meta = isRecord(update._meta) ? update._meta : undefined;
  const usage = isRecord(meta?.usage) ? meta.usage : isRecord(update.breakdown) ? update.breakdown : undefined;
  return tokenUsageFromRecord(usage, "usage_update");
}

function tokenUsageFromRecord(
  usage: Record<string, any> | undefined,
  source: AgentTokenUsageTelemetry["source"],
): AgentTokenUsageTelemetry | undefined {
  if (usage === undefined) return undefined;
  const tokenUsage: AgentTokenUsageTelemetry = { source };
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
  for (const { event } of acpxJsonLines(stdout)) {
    if (isRecord(event) && typeof event.acpxRecordId === "string") return event.acpxRecordId;
    const result = isRecord(event) && isRecord(event.result) ? event.result : undefined;
    if (typeof result?.acpxRecordId === "string") return result.acpxRecordId;
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

function failedControlResult(command: string, result: AcpxProcessResult, defaultKind: AgentBackendFailureKind = "provider_exit", timeoutMs: number | undefined = undefined): AgentTurnResult {
  if (result.aborted) return cancelledResult(`Agent ${command} was aborted.`);
  if (result.timedOut) return failedResult("timeout", timeoutMessage(timeoutMs), result);
  if (result.spawnError) return failedResult("spawn", result.spawnError, result);
  const message = failureMessage(result);
  return failedResult(defaultKind === "provider_exit" ? classifyFailureText(message) : defaultKind, message, result);
}

function timeoutResult(timeoutMs: number | undefined): AgentTurnResult {
  return { status: "failed", failureKind: "timeout", message: timeoutMessage(timeoutMs), responseText: "", stderr: "", telemetry: emptyTelemetry() };
}

function configResult(message: string): AgentTurnResult {
  return { status: "failed", failureKind: "config", message, responseText: "", stderr: "", telemetry: emptyTelemetry() };
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
  return (extractHumanError(result.stdout) || extractHumanError(result.stderr) || nonJsonTail(result.stderr) || nonJsonTail(result.stdout) || result.stdinError || `acpx exited with ${result.exitCode ?? "unknown status"}`).trim();
}

function timeoutMessage(timeoutMs: number | undefined): string {
  return timeoutMs === undefined ? "Agent turn timed out." : `Agent turn timed out after ${timeoutMs}ms.`;
}

function boundedTail(value: string, max = 4000): string {
  return value.length > max ? value.slice(value.length - max) : value;
}

function extractHumanError(value: string): string {
  for (const { event } of acpxJsonLines(value)) {
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
  return boundedTail([...acpxJsonLines(value)].filter(line => line.event === undefined).map(line => line.raw).join("\n"));
}

function* acpxJsonLines(value: string): Generator<{ raw: string; line: string; event?: unknown }> {
  for (const raw of value.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      yield { raw, line, event: JSON.parse(line) as unknown };
    } catch {
      yield { raw, line };
    }
  }
}

function killProcess(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, signal);
  } catch {}
}

function turnDeadline(timeoutMs: number | undefined): TurnDeadline | undefined {
  return timeoutMs === undefined ? undefined : { timeoutMs, startedAt: globalThis.performance.now() };
}

function remainingTimeout(deadline: TurnDeadline | undefined): RemainingTimeout {
  if (!deadline) return { expired: false };
  const remaining = deadline.timeoutMs - (globalThis.performance.now() - deadline.startedAt);
  return remaining <= 0 ? { expired: true } : { expired: false, timeoutMs: remaining };
}

function turnBudget(deadline: TurnDeadline | undefined, signal: AbortSignal | undefined): TurnBudget {
  const remaining = remainingTimeout(deadline);
  if (signal?.aborted) {
    const timeoutMs = remaining.expired ? 0 : remaining.timeoutMs;
    return timeoutMs === undefined ? { type: "abort" } : { type: "abort", timeoutMs };
  }
  if (remaining.expired) return { type: "expired" };
  return remaining.timeoutMs === undefined ? { type: "continue" } : { type: "continue", timeoutMs: remaining.timeoutMs };
}

function boundaryTermination(invocation: Pick<AcpxInvocation, "deadline" | "signal">): "abort" | "timeout" | undefined {
  const budget = turnBudget(invocation.deadline, invocation.signal);
  return budget.type === "abort" ? "abort" : budget.type === "expired" ? "timeout" : undefined;
}

function acpxTimeoutSeconds(timeoutMs: number): string {
  return String(Math.max(1, Math.ceil(timeoutMs / 1000)));
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
