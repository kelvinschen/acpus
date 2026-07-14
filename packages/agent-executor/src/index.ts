import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

const FORCE_KILL_GRACE_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const TOOL_INPUT_PREVIEW_EDGE_BYTES = 4 * 1024;
const FINAL_TOOL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const TRACE_EXCLUDED_METHODS = new Set(["initialize", "authenticate", "logout", "$/cancel_request", "mcp/message"]);

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
  captureTrace?: boolean;
  onProgress?: (progress: AgentTurnProgress) => unknown;
};

export type AgentBackendFailureKind =
  | "config"
  | "spawn"
  | "provider_exit"
  | "timeout";

export type AgentJsonValue = null | boolean | number | string | AgentJsonValue[] | { [key: string]: AgentJsonValue };

export type AgentBackendFailure = {
  kind: AgentBackendFailureKind;
  message: string;
  upstream?: {
    source: "acpx";
    operation: "sessions.ensure" | "session.set_mode" | "prompt";
    exitCode?: number;
    code?: string;
    origin?: string;
    protocol?: {
      name: "json-rpc";
      code?: string | number;
      message?: string;
    };
    data?: AgentJsonValue;
  };
};

export type AgentToolInputPreview = {
  preview: string;
  truncated: boolean;
  originalBytes: number;
  headBytes: number;
  tailBytes?: number;
};

export type AgentContextSummary = {
  used: number;
  size: number;
  updatedAt: string;
};

export type AgentTokenUsageSummary = {
  source: "prompt_response" | "usage_update";
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
};

export type AgentTelemetryAvailability = {
  context: "available" | "unavailable";
  tokenUsage: "available" | "partial" | "unavailable";
};

export type AgentToolCallSummary = {
  toolCallId: string;
  title?: string;
  kind?: string;
  toolName?: string;
  status?: string;
  input?: AgentToolInputPreview;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type AgentToolsSummary = {
  totalToolCallCount: number;
  calls: AgentToolCallSummary[];
};

export type AgentTurnSummary = {
  eventCount: number;
  availability: AgentTelemetryAvailability;
  stopReason?: string;
  context?: AgentContextSummary;
  tokenUsage?: AgentTokenUsageSummary;
  tools: AgentToolsSummary;
  cwd?: string;
  acpxRecordId?: string;
};

export type AgentTurnProgress = {
  responseText: string;
  summary: AgentTurnSummary;
  updatedAt: string;
};

export type AgentTurnRawDebug = {
  stdout: string;
};

type AgentTraceEventBase = {
  schemaVersion: 1;
  sequence: number;
  observedAt: string;
  elapsedMs: number;
};

type AgentTraceEventPayload =
  | { type: "message"; channel: "assistant" | "thought"; content: AgentJsonValue; tag?: string }
  | {
      type: "tool";
      action: "call" | "update";
      toolCallId?: string;
      title?: string;
      kind?: string;
      toolName?: string;
      status?: string;
      rawInput?: AgentJsonValue;
      rawOutput?: AgentJsonValue;
      content?: AgentJsonValue;
      locations?: AgentJsonValue;
    }
  | { type: "usage"; context?: AgentJsonValue; tokenUsage?: AgentJsonValue }
  | { type: "plan"; value: AgentJsonValue }
  | { type: "unknown"; tag?: string; value: AgentJsonValue }
  | {
      type: "turn_end";
      status: "completed" | "failed" | "cancelled" | "timed_out";
      stopReason?: string;
      failure?: AgentJsonValue;
      message?: string;
    };

export type AgentTraceEvent = AgentTraceEventBase & AgentTraceEventPayload;

export type AgentTurnTrace = {
  startedAt: string;
  elapsedMs: number;
  events: AgentTraceEvent[];
};

export type AgentTurnTiming = {
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
};

type AgentTurnOutcome =
  | {
      status: "completed";
      responseText: string;
      stderr: string;
      summary: AgentTurnSummary;
      rawDebug?: AgentTurnRawDebug;
      trace?: AgentTurnTrace;
    }
  | {
      status: "failed";
      failure: AgentBackendFailure;
      responseText: string;
      stderr: string;
      summary: AgentTurnSummary;
      rawDebug?: AgentTurnRawDebug;
      trace?: AgentTurnTrace;
    }
  | {
      status: "cancelled";
      message: string;
      responseText: string;
      stderr: string;
      summary: AgentTurnSummary;
      rawDebug?: AgentTurnRawDebug;
      trace?: AgentTurnTrace;
    };

export type AgentTurnResult = AgentTurnOutcome & { timing: AgentTurnTiming };

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
  summary: AgentTurnSummary;
  malformedLine?: string;
  error?: JsonRpcFailure;
};

type JsonRpcFailure = {
  code?: string | number;
  message: string;
  data?: AgentJsonValue;
  acpxCode?: string;
  origin?: string;
};

type PromptSummaryOptions = {
  cwd: string;
  acpxRecordId?: string;
};

type PromptAccumulator = {
  responseText: string;
  eventCount: number;
  stopReason?: string;
  malformedLine?: string;
  error?: JsonRpcFailure;
  tools: Map<string, AgentToolCallSummary>;
  context?: AgentContextSummary;
  tokenUsage?: AgentTokenUsageSummary;
  options?: PromptSummaryOptions;
  trace?: TraceCapture;
};

type TurnClock = {
  startedAt: string;
  startedAtMonotonic: number;
};

type TraceCapture = TurnClock & {
  events: AgentTraceEvent[];
  failed: boolean;
};

type PromptObservation = {
  observedAt: string;
  elapsedMs: number;
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
  const clock = createTurnClock();
  let trace: TraceCapture | undefined;
  if (request.captureTrace) {
    try {
      trace = createTraceCapture(clock);
    } catch {}
  }
  const result = await executeAgentTurnInternal(request, trace);
  const end = traceObservation(clock);
  return withTiming(withTrace(result, trace, end), clock, end);
}

async function executeAgentTurnInternal(request: AgentTurnRequest, trace: TraceCapture | undefined): Promise<AgentTurnOutcome> {
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
    return failedControlResult("sessions.ensure", ensure, "provider_exit", request.timeoutMs);
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
      return failedControlResult("session.set_mode", setMode, "config", request.timeoutMs);
    }
  }

  const promptBudget = turnBudget(deadline, request.signal);
  if (promptBudget.type === "abort") return cancelledResult("Agent turn was aborted before dispatch.");
  if (promptBudget.type === "expired") return timeoutResult(request.timeoutMs);
  const acpxRecordId = extractAcpxRecordId(ensure.stdout);
  const accumulator = createPromptAccumulator({
    cwd: request.cwd,
    ...(acpxRecordId ? { acpxRecordId } : {}),
  }, trace);
  const prompt = await runAcpx({
    args: buildAcpxArgs(request, ["prompt", "-s", request.sessionName, "-f", "-"], promptBudget.timeoutMs),
    cancelArgs: timeoutMs => buildAcpxArgs(request, ["cancel", "-s", request.sessionName], timeoutMs),
    input: request.prompt,
    cwd: request.cwd,
    env,
    onStdoutLine: (line: string) => {
      if (!consumePromptLine(accumulator, line)) return;
      if (!request.onProgress) return;
      try {
        const observed = request.onProgress({
          responseText: accumulator.responseText,
          summary: turnSummaryFromAccumulator(accumulator),
          updatedAt: new Date().toISOString(),
        });
        if (observed) void Promise.resolve(observed).catch(() => {});
      } catch {}
    },
    ...(deadline === undefined ? {} : { deadline }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  const summary = promptSummaryFromAccumulator(accumulator);
  const promptRpc = summary.error ?? extractJsonRpcFailure(prompt.stderr);
  const rawDebug = request.captureRawDebug ? { stdout: prompt.stdout } : undefined;
  if (prompt.aborted) return withRawDebug({ status: "cancelled", message: "Agent turn was aborted.", responseText: summary.responseText, stderr: prompt.stderr, summary: summary.summary }, rawDebug);
  if (prompt.timedOut) return withRawDebug(failedTurn("timeout", timeoutMessage(request.timeoutMs), prompt, summary, "prompt"), rawDebug);
  if (prompt.spawnError) return withRawDebug(failedTurn("spawn", prompt.spawnError, prompt, summary, "prompt"), rawDebug);
  if (summary.malformedLine) return withRawDebug(failedTurn("provider_exit", `Malformed acpx JSON output: ${boundedTail(summary.malformedLine)}`, prompt, summary, "prompt"), rawDebug);
  if (promptRpc) return withRawDebug(failedTurn(failureKindForRpc(promptRpc, "provider_exit"), actionableRpcMessage(promptRpc), prompt, summary, "prompt", promptRpc), rawDebug);
  if (prompt.stdinError !== undefined || prompt.exitCode !== 0) return withRawDebug(failedTurn("provider_exit", failureMessage(prompt), prompt, summary, "prompt"), rawDebug);
  return withRawDebug({ status: "completed", responseText: summary.responseText, stderr: prompt.stderr, summary: summary.summary }, rawDebug);
}

function withRawDebug<T extends AgentTurnOutcome>(result: T, rawDebug: AgentTurnRawDebug | undefined): T {
  return rawDebug ? { ...result, rawDebug } : result;
}

function createTurnClock(): TurnClock {
  return {
    startedAt: new Date().toISOString(),
    startedAtMonotonic: globalThis.performance.now(),
  };
}

function createTraceCapture(clock: TurnClock): TraceCapture {
  return {
    ...clock,
    events: [],
    failed: false,
  };
}

function withTrace<T extends AgentTurnOutcome>(result: T, capture: TraceCapture | undefined, end: PromptObservation): T {
  if (!capture || capture.failed) return result;
  try {
    const status = result.status === "failed" && result.failure.kind === "timeout"
      ? "timed_out"
      : result.status;
    appendTraceEvent(capture, {
      type: "turn_end",
      status,
      ...(result.summary.stopReason ? { stopReason: result.summary.stopReason } : {}),
      ...(result.status === "failed" ? { failure: result.failure as unknown as AgentJsonValue, message: result.failure.message } : {}),
      ...(result.status === "cancelled" ? { message: result.message } : {}),
    }, end);
    return {
      ...result,
      trace: {
        startedAt: capture.startedAt,
        elapsedMs: end.elapsedMs,
        events: capture.events,
      },
    };
  } catch {
    return result;
  }
}

function withTiming<T extends AgentTurnOutcome>(
  result: T,
  clock: TurnClock,
  end: PromptObservation,
): T & { timing: AgentTurnTiming } {
  return {
    ...result,
    timing: {
      startedAt: clock.startedAt,
      finishedAt: end.observedAt,
      elapsedMs: end.elapsedMs,
    },
  };
}

function traceObservation(capture: Pick<TurnClock, "startedAtMonotonic"> | undefined): PromptObservation {
  const elapsedMs = capture ? globalThis.performance.now() - capture.startedAtMonotonic : 0;
  return {
    observedAt: new Date().toISOString(),
    elapsedMs: Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0,
  };
}

function appendTraceEvent(capture: TraceCapture, payload: AgentTraceEventPayload, observation: PromptObservation): void {
  capture.events.push({
    schemaVersion: 1,
    sequence: capture.events.length,
    observedAt: observation.observedAt,
    elapsedMs: observation.elapsedMs,
    ...payload,
  });
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
  return promptSummaryFromAccumulator(accumulator);
}

function createPromptAccumulator(options?: PromptSummaryOptions, trace?: TraceCapture): PromptAccumulator {
  return {
    responseText: "",
    eventCount: 0,
    tools: new Map(),
    ...(options ? { options } : {}),
    ...(trace ? { trace } : {}),
  };
}

function consumePromptLine(accumulator: PromptAccumulator, raw: string): boolean {
  const line = raw.trim();
  if (!line) return false;
  const observation = traceObservation(accumulator.trace);
  try {
    consumePromptLineEvent(accumulator, line, JSON.parse(line) as unknown, observation);
  } catch {
    consumePromptLineEvent(accumulator, line, undefined, observation);
  }
  return true;
}

function consumePromptLineEvent(accumulator: PromptAccumulator, line: string, event: unknown | undefined, observation = traceObservation(accumulator.trace)): void {
  if (event === undefined) {
    accumulator.malformedLine ??= line;
    return;
  }
  accumulator.eventCount += 1;
  const error = jsonRpcFailure(event);
  if (accumulator.error === undefined && error !== undefined) accumulator.error = error;
  accumulator.responseText += textFromEvent(event);
  const context = contextFromEvent(event, accumulator.context, observation.observedAt);
  if (context !== undefined) accumulator.context = context;
  const eventTokenUsage = tokenUsageFromEvent(event);
  if (eventTokenUsage !== undefined) accumulator.tokenUsage = eventTokenUsage;
  captureToolEvent(event, accumulator.tools, observation.observedAt);
  const result = isRecord(event) && isRecord(event.result) ? event.result : undefined;
  if (typeof result?.stopReason === "string") accumulator.stopReason = result.stopReason;
  const tokenUsage = tokenUsageFromResult(result);
  if (tokenUsage !== undefined) accumulator.tokenUsage = tokenUsage;
  if (accumulator.trace && !accumulator.trace.failed) {
    try {
      captureNormalizedTraceEvent(accumulator.trace, event, observation);
    } catch {
      accumulator.trace.failed = true;
    }
  }
}

function promptSummaryFromAccumulator(accumulator: PromptAccumulator): PromptSummary {
  return {
    responseText: accumulator.responseText,
    summary: turnSummaryFromAccumulator(accumulator),
    ...(accumulator.malformedLine ? { malformedLine: accumulator.malformedLine } : {}),
    ...(accumulator.error ? { error: accumulator.error } : {}),
  };
}

function captureNormalizedTraceEvent(capture: TraceCapture, event: unknown, observation: PromptObservation): void {
  if (!isAgentJsonValue(event)) return;
  if (isTraceExcludedProtocolFrame(event)) return;
  const update = eventUpdate(event);
  const tag = stringField(update, "sessionUpdate");
  if (update && (tag === "agent_message_chunk" || tag === "agent_thought_chunk")) {
    const content = jsonField(update, "content");
    if (content !== undefined) {
      appendTraceEvent(capture, {
        type: "message",
        channel: tag === "agent_message_chunk" ? "assistant" : "thought",
        content,
        tag,
      }, observation);
      return;
    }
  }
  if (update && (tag === "tool_call" || tag === "tool_call_update")) {
    const toolCallId = stringField(update, "toolCallId") ?? stringField(update, "id");
    const title = stringField(update, "title");
    const kind = stringField(update, "kind");
    const toolName = toolNameFromUpdate(update);
    const status = stringField(update, "status");
    const rawInput = jsonField(update, "rawInput");
    const rawOutput = jsonField(update, "rawOutput");
    const content = jsonField(update, "content");
    const locations = jsonField(update, "locations");
    appendTraceEvent(capture, {
      type: "tool",
      action: tag === "tool_call" ? "call" : "update",
      ...(toolCallId ? { toolCallId } : {}),
      ...(title ? { title } : {}),
      ...(kind ? { kind } : {}),
      ...(toolName ? { toolName } : {}),
      ...(status ? { status } : {}),
      ...(rawInput === undefined ? {} : { rawInput }),
      ...(rawOutput === undefined ? {} : { rawOutput }),
      ...(content === undefined ? {} : { content }),
      ...(locations === undefined ? {} : { locations }),
    }, observation);
    return;
  }
  if (update && tag === "usage_update") {
    const context = usageContextFromUpdate(update);
    const tokenUsage = usageValueFromUpdate(update);
    appendTraceEvent(capture, {
      type: "usage",
      ...(context === undefined ? {} : { context }),
      ...(tokenUsage === undefined ? {} : { tokenUsage }),
    }, observation);
    return;
  }
  if (update && tag === "plan") {
    appendTraceEvent(capture, {
      type: "plan",
      value: jsonField(update, "entries") ?? jsonField(update, "value") ?? update as AgentJsonValue,
    }, observation);
    return;
  }

  const eventRecord: Record<string, any> | undefined = isRecord(event) ? event as Record<string, any> : undefined;
  const result = isRecord(eventRecord?.result) ? eventRecord.result : undefined;
  if (result) {
    const tokenUsage = jsonField(result, "usage");
    if (tokenUsage !== undefined) appendTraceEvent(capture, { type: "usage", tokenUsage }, observation);
    return;
  }
  if (jsonRpcFailure(event)) return;
  appendTraceEvent(capture, {
    type: "unknown",
    ...(tag ? { tag } : {}),
    value: event,
  }, observation);
}

function isTraceExcludedProtocolFrame(event: AgentJsonValue): boolean {
  const method = stringField(agentJsonObject(event), "method");
  if (!method || method === "session/update" || method === "session/request_permission") return false;
  return TRACE_EXCLUDED_METHODS.has(method)
    || method.startsWith("providers/")
    || method.startsWith("nes/")
    || method.startsWith("document/")
    || method.startsWith("session/");
}

function usageContextFromUpdate(update: Record<string, any>): AgentJsonValue | undefined {
  const context = Object.fromEntries(["used", "size", "cost"]
    .flatMap(key => {
      const value = jsonField(update, key);
      return value === undefined ? [] : [[key, value]];
    }));
  return Object.keys(context).length === 0 ? undefined : context;
}

function usageValueFromUpdate(update: Record<string, any>): AgentJsonValue | undefined {
  const meta = isRecord(update._meta) ? update._meta : undefined;
  return jsonField(meta, "usage") ?? jsonField(update, "breakdown");
}

function jsonField(value: Record<string, any> | undefined, key: string): AgentJsonValue | undefined {
  const item = value?.[key];
  return isAgentJsonValue(item) ? item : undefined;
}

function turnSummaryFromAccumulator(accumulator: PromptAccumulator): AgentTurnSummary {
  return {
    eventCount: accumulator.eventCount,
    availability: telemetryAvailability(accumulator.context, accumulator.tokenUsage),
    ...(accumulator.stopReason ? { stopReason: accumulator.stopReason } : {}),
    ...(accumulator.context ? { context: accumulator.context } : {}),
    ...(accumulator.tokenUsage ? { tokenUsage: accumulator.tokenUsage } : {}),
    tools: { totalToolCallCount: accumulator.tools.size, calls: [...accumulator.tools.values()] },
    ...(accumulator.options ? {
      cwd: accumulator.options.cwd,
      ...(accumulator.options.acpxRecordId ? { acpxRecordId: accumulator.options.acpxRecordId } : {}),
    } : {}),
  };
}

function telemetryAvailability(
  context: AgentContextSummary | undefined,
  tokenUsage: AgentTokenUsageSummary | undefined,
): AgentTelemetryAvailability {
  return {
    context: context ? "available" : "unavailable",
    tokenUsage: tokenUsage?.totalTokens !== undefined ? "available" : tokenUsage ? "partial" : "unavailable",
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

function contextFromEvent(event: unknown, previous: AgentContextSummary | undefined, observedAt: string): AgentContextSummary | undefined {
  const update = eventUpdate(event);
  if (update?.sessionUpdate !== "usage_update") return previous;
  const used = numericField(update, "used");
  const size = numericField(update, "size");
  if (used === undefined && size === undefined) return previous;
  const nextUsed = used === 0 && previous && previous.used > 0 ? previous.used : used ?? previous?.used ?? 0;
  const nextSize = size ?? previous?.size ?? 0;
  return { used: nextUsed, size: nextSize, updatedAt: observedAt };
}

function captureToolEvent(event: unknown, tools: Map<string, AgentToolCallSummary>, observedAt: string): void {
  const update = eventUpdate(event);
  if (update?.sessionUpdate !== "tool_call" && update?.sessionUpdate !== "tool_call_update") return;
  const toolCallId = stringField(update, "toolCallId") ?? stringField(update, "id");
  if (!toolCallId) return;
  const previous = tools.get(toolCallId);
  const status = stringField(update, "status") ?? previous?.status;
  const next: AgentToolCallSummary = {
    toolCallId,
    startedAt: previous?.startedAt ?? observedAt,
    updatedAt: observedAt,
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
  if (FINAL_TOOL_STATUSES.has(status ?? "")) next.completedAt = previous?.completedAt ?? observedAt;
  else if (previous?.completedAt) next.completedAt = previous.completedAt;
  tools.set(toolCallId, next);
}

function eventUpdate(event: unknown): Record<string, any> | undefined {
  if (!isRecord(event)) return undefined;
  const params = isRecord(event.params) ? event.params : undefined;
  return isRecord(params?.update) ? params.update : undefined;
}

function tokenUsageFromResult(result: Record<string, any> | undefined): AgentTokenUsageSummary | undefined {
  const usage = isRecord(result?.usage) ? result.usage : undefined;
  return tokenUsageFromRecord(usage, "prompt_response");
}

function tokenUsageFromEvent(event: unknown): AgentTokenUsageSummary | undefined {
  const update = eventUpdate(event);
  if (update?.sessionUpdate !== "usage_update") return undefined;
  const meta = isRecord(update._meta) ? update._meta : undefined;
  const usage = isRecord(meta?.usage) ? meta.usage : isRecord(update.breakdown) ? update.breakdown : undefined;
  return tokenUsageFromRecord(usage, "usage_update");
}

function tokenUsageFromRecord(
  usage: Record<string, any> | undefined,
  source: AgentTokenUsageSummary["source"],
): AgentTokenUsageSummary | undefined {
  if (usage === undefined) return undefined;
  const tokenUsage: AgentTokenUsageSummary = { source };
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

function rawInputPreview(update: Record<string, any>): AgentToolInputPreview | undefined {
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

function truncatedJsonPreview(value: unknown): AgentToolInputPreview {
  return truncatedPreview(JSON.stringify(value), TOOL_INPUT_PREVIEW_EDGE_BYTES);
}

function truncatedPreview(value: string, edgeBytes: number): AgentToolInputPreview {
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

function emptySummary(): AgentTurnSummary {
  return {
    eventCount: 0,
    availability: { context: "unavailable", tokenUsage: "unavailable" },
    tools: { totalToolCallCount: 0, calls: [] },
  };
}

function failedControlResult(
  operation: NonNullable<AgentBackendFailure["upstream"]>["operation"],
  result: AcpxProcessResult,
  defaultKind: AgentBackendFailureKind = "provider_exit",
  timeoutMs: number | undefined = undefined,
): AgentTurnOutcome {
  if (result.aborted) return cancelledResult(`Agent ${operation} was aborted.`);
  const summary = summarizePromptOutput(result.stdout);
  const rpc = summary.error ?? extractJsonRpcFailure(result.stderr);
  if (result.timedOut) return failedTurn("timeout", timeoutMessage(timeoutMs), result, summary, operation, rpc);
  if (result.spawnError) return failedTurn("spawn", result.spawnError, result, summary, operation, rpc);
  const kind = rpc ? failureKindForRpc(rpc, defaultKind) : defaultKind;
  return failedTurn(kind, rpc ? actionableRpcMessage(rpc) : failureMessage(result), result, summary, operation, rpc);
}

function timeoutResult(timeoutMs: number | undefined): AgentTurnOutcome {
  return { status: "failed", failure: { kind: "timeout", message: timeoutMessage(timeoutMs) }, responseText: "", stderr: "", summary: emptySummary() };
}

function configResult(message: string): AgentTurnOutcome {
  return { status: "failed", failure: { kind: "config", message }, responseText: "", stderr: "", summary: emptySummary() };
}

function failedTurn(
  kind: AgentBackendFailureKind,
  message: string,
  result: AcpxProcessResult,
  summary: PromptSummary,
  operation: NonNullable<AgentBackendFailure["upstream"]>["operation"],
  rpc?: JsonRpcFailure,
): AgentTurnOutcome {
  const upstream: NonNullable<AgentBackendFailure["upstream"]> = {
    source: "acpx",
    operation,
    ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
    ...(rpc?.acpxCode ? { code: rpc.acpxCode } : {}),
    ...(rpc?.origin ? { origin: rpc.origin } : {}),
    ...(rpc ? {
      protocol: {
        name: "json-rpc",
        ...(rpc.code === undefined ? {} : { code: rpc.code }),
        message: rpc.message,
      },
      ...(rpc.data === undefined ? {} : { data: rpc.data }),
    } : {}),
  };
  return {
    status: "failed",
    failure: { kind, message, ...(rpc || result.exitCode !== null ? { upstream } : {}) },
    responseText: summary.responseText,
    stderr: result.stderr,
    summary: summary.summary,
  };
}

function cancelledResult(message: string): AgentTurnOutcome {
  return { status: "cancelled", message, responseText: "", stderr: "", summary: emptySummary() };
}

function failureKindForRpc(error: JsonRpcFailure, fallback: AgentBackendFailureKind): AgentBackendFailureKind {
  return error.code === -32602 || error.code === "-32602" ? "config" : fallback;
}

function failureMessage(result: AcpxProcessResult): string {
  const rpc = extractJsonRpcFailure(result.stdout) ?? extractJsonRpcFailure(result.stderr);
  return (rpc ? actionableRpcMessage(rpc) : nonJsonTail(result.stderr) || nonJsonTail(result.stdout) || result.stdinError || `acpx exited with ${result.exitCode ?? "unknown status"}`).trim();
}

function timeoutMessage(timeoutMs: number | undefined): string {
  return timeoutMs === undefined ? "Agent turn timed out." : `Agent turn timed out after ${timeoutMs}ms.`;
}

function boundedTail(value: string, max = 4000): string {
  return value.length > max ? value.slice(value.length - max) : value;
}

function extractJsonRpcFailure(value: string): JsonRpcFailure | undefined {
  for (const { event } of acpxJsonLines(value)) {
    const failure = jsonRpcFailure(event);
    if (failure) return failure;
  }
  return undefined;
}

function jsonRpcFailure(event: unknown): JsonRpcFailure | undefined {
  if (!isRecord(event)) return undefined;
  const error = isRecord(event.error) ? event.error : undefined;
  if (typeof error?.message !== "string") return undefined;
  const data = isAgentJsonValue(error.data) ? error.data : undefined;
  const fields = agentJsonObject(data);
  const code = typeof error.code === "string" || typeof error.code === "number" ? error.code : undefined;
  return {
    ...(code === undefined ? {} : { code }),
    message: error.message,
    ...(data === undefined ? {} : { data }),
    ...(typeof fields?.acpxCode === "string" ? { acpxCode: fields.acpxCode } : {}),
    ...(typeof fields?.origin === "string" ? { origin: fields.origin } : {}),
  };
}

function actionableRpcMessage(error: JsonRpcFailure): string {
  const fields = agentJsonObject(error.data);
  const details = typeof fields?.details === "string" ? fields.details.trim() : "";
  return boundedTail(details || error.message.trim());
}

function isAgentJsonValue(value: unknown): value is AgentJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isAgentJsonValue);
  return Boolean(value && typeof value === "object" && Object.values(value).every(isAgentJsonValue));
}

function agentJsonObject(value: AgentJsonValue | undefined): { [key: string]: AgentJsonValue } | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
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
