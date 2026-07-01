import { spawn } from "node:child_process";

const MAX_AGENT_OUTPUT_BYTES = 1_000_000;

export type AgentExecutionRequest =
  | { kind: "mock"; prompt: string; acceptOutput?: (output: unknown) => unknown }
  | {
      kind: "command";
      nodeId: string;
      command: string;
      prompt: string;
      cwd: string;
      env: NodeJS.ProcessEnv;
      maxAttempts: number;
      timeout?: string;
      signal?: AbortSignal;
      acceptOutput?: (output: unknown) => unknown;
    };

export class AgentProviderRequiredError extends Error {}

export async function executeAgentRequest(request: AgentExecutionRequest): Promise<unknown> {
  if (request.kind === "mock") return acceptOutput(request, parseAgentOutput(request.prompt));
  const maxAttempts = Math.max(1, request.maxAttempts);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (request.signal?.aborted) throw new Error(`Agent node '${request.nodeId}' was aborted.`);
    const result = await runShell(request.command, {
      cwd: request.cwd,
      env: {
        ...request.env,
        ACPUS_AGENT_PROMPT: request.prompt,
        ACPUS_AGENT_ATTEMPT: String(attempt),
      },
      ...(request.timeout ? { timeoutMs: parseDurationMs(request.timeout) } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (result.timedOut) {
      lastError = new Error(`Agent node '${request.nodeId}' timed out after ${request.timeout}.`);
    } else if (result.aborted) {
      lastError = new Error(`Agent node '${request.nodeId}' was aborted.`);
    } else if (result.overflowed) {
      lastError = new Error(`Agent command output exceeded ${MAX_AGENT_OUTPUT_BYTES} bytes.`);
    } else if (result.exitCode !== 0) {
      lastError = new Error(`Agent command exited with ${result.exitCode}: ${result.stderr || result.stdout}`);
    } else {
      try {
        return acceptOutput(request, parseAgentOutput(result.stdout));
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError;
}

export function getProviderCommandFromEnv(use: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const commands = parseProviderCommands(env.ACPUS_AGENT_PROVIDER_COMMANDS);
  return commands[use];
}

function parseAgentOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return { text: stdout };
  }
}

function acceptOutput(request: AgentExecutionRequest, output: unknown): unknown {
  return request.acceptOutput ? request.acceptOutput(output) : output;
}

function parseProviderCommands(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("ACPUS_AGENT_PROVIDER_COMMANDS must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("ACPUS_AGENT_PROVIDER_COMMANDS must be a JSON object.");
  return Object.fromEntries(Object.entries(parsed).map(([key, value]) => {
    if (typeof value !== "string" || value.length === 0) throw new Error(`Provider command '${key}' must be a non-empty string.`);
    return [key, value];
  }));
}

function runShell(command: string, options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal }): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; overflowed: boolean; aborted: boolean }> {
  return new Promise(resolve => {
    const child = spawn(command, { cwd: options.cwd, env: options.env, detached: true, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let termination: "timeout" | "overflow" | "abort" | undefined;
    let outputBytes = 0;
    let timeout: NodeJS.Timeout | undefined;
    let killTimeout: NodeJS.Timeout | undefined;
    function terminate(reason: "timeout" | "overflow" | "abort"): void {
      if (termination) return;
      termination = reason;
      if (timeout) clearTimeout(timeout);
      killTimeout = setTimeout(() => killProcessGroup(child.pid, "SIGKILL"), 100);
      killProcessGroup(child.pid);
    }
    timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      terminate("timeout");
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", () => terminate("abort"), { once: true });
    if (options.signal?.aborted) terminate("abort");
    function collect(target: Buffer[], chunk: unknown): void {
      if (termination) return;
      const bytes = Buffer.from(chunk as any);
      outputBytes += bytes.byteLength;
      if (outputBytes > MAX_AGENT_OUTPUT_BYTES) {
        terminate("overflow");
        return;
      }
      target.push(bytes);
    }
    child.stdout.on("data", chunk => collect(stdout, chunk));
    child.stderr.on("data", chunk => collect(stderr, chunk));
    child.on("close", exitCode => {
      if (timeout) clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
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
      if (timeout) clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
      resolve({ exitCode: null, stdout: "", stderr: error.message, timedOut: termination === "timeout", overflowed: termination === "overflow", aborted: termination === "abort" });
    });
  });
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
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
