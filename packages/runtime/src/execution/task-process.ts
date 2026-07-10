import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ResultAsync } from "neverthrow";
import type { JsonValue } from "@acpus/expression/ir";
import { scheduleCancellableTimeout } from "../cancellable-timeout.js";
import type { TaskArtifactRegistration, TaskProcessChildMessage, TaskProcessParentMessage, TaskProcessRequest } from "./task-process-protocol.js";

const COOPERATIVE_ABORT_GRACE_MS = 1_000;
const FORCE_KILL_GRACE_MS = 5_000;
const OUTPUT_TAIL_LIMIT = 8 * 1024;

export type TaskAttemptFailure =
  | { type: "spawn"; cwd: string; message: string; code?: string }
  | { type: "task"; message: string; name?: string; stack?: string }
  | { type: "cancelled"; message: string }
  | { type: "timed_out"; message: string }
  | { type: "unexpected_exit"; message: string; exitCode?: number; signal?: string };

export type RunTaskAttemptInput = {
  nodeId: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  request: TaskProcessRequest;
  timeoutMs?: number;
  signal?: AbortSignal;
  registerArtifact(artifact: TaskArtifactRegistration): void;
};

export type TaskAttemptRunner = (input: RunTaskAttemptInput) => ResultAsync<JsonValue | undefined, TaskAttemptFailure>;

export function runTaskAttempt(input: RunTaskAttemptInput): ResultAsync<JsonValue | undefined, TaskAttemptFailure> {
  return ResultAsync.fromPromise(runTaskProcess(input), error =>
    error instanceof TaskAttemptRejected
      ? error.failure
      : { type: "unexpected_exit", message: error instanceof Error ? error.message : String(error) },
  );
}

export function taskAttemptFailureMessage(failure: TaskAttemptFailure): string {
  return failure.message;
}

class TaskAttemptRejected extends Error {
  constructor(readonly failure: TaskAttemptFailure) {
    super(taskAttemptFailureMessage(failure));
  }
}

function runTaskProcess(input: RunTaskAttemptInput): Promise<JsonValue | undefined> {
  const timeoutStartedAt = input.timeoutMs === undefined ? undefined : globalThis.performance.now();
  const timeoutExpired = () => timeoutStartedAt !== undefined
    && input.timeoutMs !== undefined
    && Math.max(0, globalThis.performance.now() - timeoutStartedAt) >= input.timeoutMs;
  const timeoutFailure = (): TaskAttemptFailure => ({
    type: "timed_out",
    message: `Task node '${input.nodeId}' timed out after ${input.timeoutMs ?? 0}ms.`,
  });
  const cancellationFailure = (): TaskAttemptFailure => ({
    type: "cancelled",
    message: `Task node '${input.nodeId}' was cancelled.`,
  });
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, taskProcessEntryArgs(), {
        cwd: input.cwd,
        env: input.env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
    } catch (error) {
      const failure = input.signal?.aborted
        ? cancellationFailure()
        : timeoutExpired() ? timeoutFailure() : spawnFailure(input, error);
      reject(new TaskAttemptRejected(failure));
      return;
    }

    let stdout = "";
    let stderr = "";
    let spawnError: NodeJS.ErrnoException | undefined;
    let terminal: { ok: true; output?: JsonValue } | { ok: false; failure: TaskAttemptFailure } | undefined;
    let termination: "cancelled" | "timed_out" | undefined;
    let settled = false;
    let cancelTimeout: (() => void) | undefined;
    let terminateTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let spawned = false;
    let abortSent = false;

    const cleanup = () => {
      cancelTimeout?.();
      if (terminateTimer) clearTimeout(terminateTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.signal?.removeEventListener("abort", cancel);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const send = (message: TaskProcessParentMessage) => {
      if (!child.connected) return;
      child.send(message, error => {
        if (!error || settled || termination) return;
        if (enforceTimeout()) return;
        terminal = { ok: false, failure: { type: "unexpected_exit", message: `Task process IPC failed: ${error.message}` } };
        killProcessTree(child.pid, "SIGTERM");
      });
    };
    const sendAbort = () => {
      if (!spawned || abortSent) return;
      abortSent = true;
      send({ type: "abort" });
    };
    const beginTermination = (reason: "cancelled" | "timed_out") => {
      if (termination || settled) return;
      termination = reason;
      sendAbort();
      terminateTimer = setTimeout(() => {
        killProcessTree(child.pid, "SIGTERM");
        forceKillTimer = setTimeout(() => killProcessTree(child.pid, "SIGKILL"), FORCE_KILL_GRACE_MS);
      }, COOPERATIVE_ABORT_GRACE_MS);
    };
    const enforceTimeout = (): boolean => {
      if (!timeoutExpired()) return false;
      beginTermination("timed_out");
      return true;
    };
    const cancel = () => beginTermination("cancelled");

    child.stdout?.on("data", chunk => { stdout = appendTail(stdout, chunk); });
    child.stderr?.on("data", chunk => { stderr = appendTail(stderr, chunk); });
    child.once("spawn", () => {
      spawned = true;
      enforceTimeout();
      if (termination !== "timed_out") send({ type: "start", request: input.request });
      if (termination) sendAbort();
    });
    child.on("message", raw => {
      if (!isChildMessage(raw)) {
        if (enforceTimeout() || termination) return;
        terminal = { ok: false, failure: { type: "unexpected_exit", message: "Task process sent an invalid IPC message." } };
        killProcessTree(child.pid, "SIGTERM");
        return;
      }
      const message = raw;
      if (message.type === "artifact_register") {
        let error: string | undefined;
        try {
          if (enforceTimeout() || termination || terminal) throw new Error("Task attempt is no longer accepting artifacts.");
          assertArtifactIdentity(input.request, message.artifact);
          input.registerArtifact(message.artifact);
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
        send(error === undefined
          ? { type: "artifact_result", requestId: message.requestId, ok: true }
          : { type: "artifact_result", requestId: message.requestId, ok: false, error });
        return;
      }
      if (enforceTimeout() || terminal || termination) return;
      if (message.type === "completed") {
        terminal = message.hasOutput ? { ok: true, output: message.output } : { ok: true };
      } else {
        terminal = {
          ok: false,
          failure: {
            type: "task",
            message: message.error.message,
            ...(message.error.name ? { name: message.error.name } : {}),
            ...(message.error.stack ? { stack: message.error.stack } : {}),
          },
        };
      }
    });
    child.once("error", error => {
      if (!enforceTimeout()) spawnError = error;
    });
    child.once("close", (exitCode, signal) => {
      enforceTimeout();
      if (termination) {
        const failure = termination === "timed_out"
          ? timeoutFailure()
          : cancellationFailure();
        settle(() => reject(new TaskAttemptRejected(failure)));
        return;
      }
      if (spawnError) {
        settle(() => reject(new TaskAttemptRejected(spawnFailure(input, spawnError!))));
        return;
      }
      if (terminal?.ok) {
        const output = terminal.output;
        settle(() => resolve(output));
        return;
      }
      if (terminal && !terminal.ok) {
        const failure = terminal.failure;
        settle(() => reject(new TaskAttemptRejected(failure)));
        return;
      }
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
      const message = `Task process for node '${input.nodeId}' exited without a result${exitCode === null ? "" : ` (code ${exitCode})`}${signal ? ` (${signal})` : ""}.${detail ? ` ${detail}` : ""}`;
      settle(() => reject(new TaskAttemptRejected({
        type: "unexpected_exit",
        message,
        ...(exitCode === null ? {} : { exitCode }),
        ...(signal === null ? {} : { signal }),
      })));
    });

    input.signal?.addEventListener("abort", cancel, { once: true });
    if (input.signal?.aborted) cancel();
    if (input.timeoutMs !== undefined && timeoutStartedAt !== undefined) {
      const remainingTimeoutMs = input.timeoutMs - Math.max(0, globalThis.performance.now() - timeoutStartedAt);
      if (remainingTimeoutMs <= 0) enforceTimeout();
      else cancelTimeout = scheduleCancellableTimeout(remainingTimeoutMs, () => beginTermination("timed_out"));
    }
  });
}

function taskProcessEntryArgs(): string[] {
  const sourceMode = fileURLToPath(import.meta.url).endsWith(".ts");
  const entry = fileURLToPath(new URL(`./task-process-entry.${sourceMode ? "ts" : "js"}`, import.meta.url));
  return sourceMode
    ? ["--import", import.meta.resolve("tsx"), "--import", sourcePackageResolverImport(), entry]
    : [entry];
}

function sourcePackageResolverImport(): string {
  const entries = [
    ["@acpus/loader", new URL("../../../loader/src/index.ts", import.meta.url).href],
    ["@acpus/core", new URL("../../../core/src/index.ts", import.meta.url).href],
    ["@acpus/core/runtime", new URL("../../../core/src/runtime.ts", import.meta.url).href],
    ["@acpus/expression", new URL("../../../expression/src/index.ts", import.meta.url).href],
    ["@acpus/expression/ir", new URL("../../../expression/src/ir.ts", import.meta.url).href],
    ["@acpus/expression/validator", new URL("../../../expression/src/validator.ts", import.meta.url).href],
  ];
  const loader = `
const aliases = new Map(${JSON.stringify(entries)});
export function resolve(specifier, context, nextResolve) {
  const url = aliases.get(specifier);
  return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
}
`;
  const bootstrap = `import { register } from "node:module"; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)}, import.meta.url);`;
  return `data:text/javascript,${encodeURIComponent(bootstrap)}`;
}

function spawnFailure(input: RunTaskAttemptInput, error: unknown): TaskAttemptFailure {
  const nodeError = error as NodeJS.ErrnoException;
  const detail = error instanceof Error ? error.message : String(error);
  return {
    type: "spawn",
    cwd: input.cwd,
    message: `Task process for node '${input.nodeId}' could not start in '${input.cwd}': ${detail}`,
    ...(typeof nodeError.code === "string" ? { code: nodeError.code } : {}),
  };
}

function assertArtifactIdentity(request: TaskProcessRequest, artifact: TaskArtifactRegistration): void {
  if (artifact.runId !== request.artifact.runId || artifact.nodeKey !== request.artifact.nodeKey || artifact.attempt !== request.artifact.attempt) {
    throw new Error("Task process artifact identity does not match its attempt.");
  }
}

function appendTail(previous: string, chunk: unknown): string {
  const next = previous + Buffer.from(chunk as Uint8Array).toString("utf8");
  return next.length <= OUTPUT_TAIL_LIMIT ? next : next.slice(next.length - OUTPUT_TAIL_LIMIT);
}

function isChildMessage(value: unknown): value is TaskProcessChildMessage {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const type = (value as { type?: unknown }).type;
  return type === "artifact_register" || type === "completed" || type === "failed";
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
    } catch {}
  }
}
