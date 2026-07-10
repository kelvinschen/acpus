import { spawn } from "node:child_process";
import { tryParseDurationMs } from "@acpus/core/ir";
import { scheduleCancellableTimeout } from "../cancellable-timeout.js";
import type { HookEvent, HookMatch, LoadedHookConfig } from "./config.js";
import type { HookContext } from "./context.js";
import type { HookJournalEntry } from "./journal.js";

export type HookRunner = {
  trigger(event: HookEvent, context: HookContext): void;
  drain(): Promise<void>;
  activeCount(): number;
};

export type HookJournalWriter = {
  writeHookJournal(entry: HookJournalEntry): void;
};

const defaultTimeout = "30s";
const outputLimit = 4 * 1024;

export function createHookRunner(
  hooks: readonly LoadedHookConfig[],
  journal: HookJournalWriter,
  options: { now?: () => Date } = {},
): HookRunner {
  const now = options.now ?? (() => new Date());
  const active = new Set<Promise<void>>();
  let nextTriggerOrder = 1;

  function trigger(event: HookEvent, context: HookContext): void {
    for (const hook of hooks) {
      if (hook.event !== event || !matches(hook.match, context)) continue;
      const startedAt = now();
      const triggerOrder = nextTriggerOrder++;
      const running = spawnHook(hook, context, startedAt, triggerOrder, journal)
        .catch(() => undefined)
        .finally(() => active.delete(running));
      active.add(running);
    }
  }

  return {
    trigger,
    async drain() {
      await Promise.all([...active]);
    },
    activeCount() {
      return active.size;
    },
  };
}

function matches(match: HookMatch | undefined, context: HookContext): boolean {
  if (!match) return true;
  return matchesField(match.workflow, context.run.workflowName)
    && matchesField(match.nodeId, context.node?.id)
    && matchesField(match.nodeKey, context.node?.key)
    && matchesField(match.kind, context.node?.kind);
}

function matchesField(regex: string | undefined, value: string | undefined): boolean {
  return regex === undefined || (value !== undefined && new RegExp(regex).test(value));
}

async function spawnHook(hook: LoadedHookConfig, context: HookContext, startedAt: Date, triggerOrder: number, journal: HookJournalWriter): Promise<void> {
  const timeout = tryParseDurationMs(hook.timeout ?? defaultTimeout);
  if (timeout.isErr()) throw new Error(`Invalid hook timeout '${hook.timeout ?? defaultTimeout}'.`);
  const startedMs = startedAt.getTime();
  const result = await runShellCommand(hook.command, context, timeout.value);
  writeJournal(journal, journalEntry(hook, context, triggerOrder, {
    ...result,
    durationMs: Math.max(0, Date.now() - startedMs),
    triggeredAt: startedAt.toISOString(),
  }));
}

function runShellCommand(command: string, context: HookContext, timeoutMs: number): Promise<{
  status: HookJournalEntry["status"];
  exitCode?: number;
  stdout: string;
  stderr: string;
  error?: string;
}> {
  const timeoutStartedAt = globalThis.performance.now();
  return new Promise(resolve => {
    const stdout = new OutputCollector(outputLimit);
    const stderr = new OutputCollector(outputLimit);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, { shell: true, cwd: context.run.workspaceDir, detached: process.platform !== "win32" });
    } catch (error) {
      const timedOut = Math.max(0, globalThis.performance.now() - timeoutStartedAt) >= timeoutMs;
      resolve({
        status: timedOut ? "timed_out" : "failed",
        stdout: "",
        stderr: "",
        error: timedOut ? "timeout" : error instanceof Error ? error.message : String(error),
      });
      return;
    }
    let timedOut = false;
    let settled = false;
    let cancelTimeout: (() => void) | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const markTimedOut = () => {
      if (timedOut || settled) return;
      timedOut = true;
      killProcessTree(child.pid, "SIGTERM");
      killTimer = setTimeout(() => killProcessTree(child.pid, "SIGKILL"), 2_000);
    };
    const enforceTimeout = (): boolean => {
      if (Math.max(0, globalThis.performance.now() - timeoutStartedAt) < timeoutMs) return timedOut;
      markTimedOut();
      return true;
    };
    const remainingTimeoutMs = timeoutMs - Math.max(0, globalThis.performance.now() - timeoutStartedAt);
    if (remainingTimeoutMs <= 0) markTimedOut();
    else cancelTimeout = scheduleCancellableTimeout(remainingTimeoutMs, markTimedOut);

    child.stdout?.on("data", chunk => stdout.append(Buffer.from(chunk as Buffer)));
    child.stderr?.on("data", chunk => stderr.append(Buffer.from(chunk as Buffer)));
    child.stdin?.on("error", () => {
      // Hooks are non-interfering; a command that exits before reading stdin
      // should be recorded from process close/error, not crash the daemon.
    });
    child.on("error", error => finish({
      status: enforceTimeout() ? "timed_out" : "failed",
      stdout: stdout.toString(),
      stderr: stderr.toString(),
      error: timedOut ? "timeout" : error.message,
    }));
    child.on("close", code => {
      enforceTimeout();
      finish({
        status: timedOut ? "timed_out" : code === 0 ? "completed" : "failed",
        ...(timedOut || code === null ? {} : { exitCode: code }),
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        ...(timedOut ? { error: "timeout" } : code === 0 ? {} : { error: `exit_code_${code ?? "null"}` }),
      });
    });
    child.stdin?.end(JSON.stringify(context));

    function finish(result: {
      status: HookJournalEntry["status"];
      exitCode?: number;
      stdout: string;
      stderr: string;
      error?: string;
    }): void {
      if (settled) return;
      settled = true;
      cancelTimeout?.();
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    }
  });
}

function journalEntry(
  hook: LoadedHookConfig,
  context: HookContext,
  triggerOrder: number,
  result: {
    status: HookJournalEntry["status"];
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    durationMs?: number;
    error?: string;
    triggeredAt: string;
  },
): HookJournalEntry {
  return {
    runId: context.run.id,
    eventSequence: context.eventSequence,
    triggerOrder,
    event: context.event,
    source: hook.source,
    sourcePath: hook.sourcePath,
    handlerId: hook.id ?? hook.effectiveId,
    definitionHash: hook.definitionHash,
    ...(context.node?.key === undefined ? {} : { nodeKey: context.node.key }),
    status: result.status,
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    ...(result.stdout === undefined ? {} : { stdout: result.stdout }),
    ...(result.stderr === undefined ? {} : { stderr: result.stderr }),
    ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
    ...(result.error === undefined ? {} : { error: result.error }),
    triggeredAt: result.triggeredAt,
  };
}

function writeJournal(journal: HookJournalWriter, entry: HookJournalEntry): void {
  try {
    journal.writeHookJournal(entry);
  } catch {
    // Hooks are non-interfering; journal failures must not affect workflow execution.
  }
}

function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", signal === "SIGKILL" ? "/F" : ""].filter(Boolean), { stdio: "ignore" }).unref();
      return;
    }
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Best effort; hook timeout is non-interfering.
    }
  }
}

class OutputCollector {
  private full: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private head: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private total = 0;
  private truncated = false;

  constructor(private readonly limit: number) {}

  append(chunk: Buffer): void {
    const nextTotal = this.total + chunk.length;
    if (!this.truncated && nextTotal <= this.limit * 2) {
      this.full = Buffer.concat([this.full, chunk]);
      this.total = nextTotal;
      return;
    }

    if (!this.truncated) {
      this.head = this.full.length >= this.limit
        ? this.full.subarray(0, this.limit)
        : Buffer.concat([this.full, chunk.subarray(0, this.limit - this.full.length)]);
      this.tail = lastBytes(this.full.subarray(Math.max(0, this.full.length - this.limit)), chunk, this.limit);
      this.full = Buffer.alloc(0);
      this.truncated = true;
      this.total = nextTotal;
      return;
    }

    this.total += chunk.length;
    this.tail = lastBytes(this.tail, chunk, this.limit);
  }

  toString(): string {
    return boundedUtf8(this.truncated ? Buffer.concat([this.head, this.tail]) : this.full, this.limit * 2);
  }
}

function lastBytes(previousTail: Buffer, chunk: Buffer, limit: number): Buffer {
  if (chunk.length >= limit) return chunk.subarray(chunk.length - limit);
  const combined = Buffer.concat([previousTail, chunk]);
  return combined.length <= limit ? combined : combined.subarray(combined.length - limit);
}

function boundedUtf8(buffer: Buffer, maxBytes: number): string {
  let end = Math.min(buffer.length, maxBytes);
  while (end >= 0) {
    const value = buffer.subarray(0, end).toString("utf8");
    if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
    end -= 1;
  }
  return "";
}
