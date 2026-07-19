import { spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import type { JsonValue } from "@acpus/expression/ir";
import { scheduleCancellableTimeout } from "../cancellable-timeout.js";
import type { TaskArtifactRegistration, TaskProcessChildMessage, TaskProcessParentMessage, TaskProcessRequest } from "./task-process-protocol.js";

const COOPERATIVE_ABORT_GRACE_MS = 1_000;
const FORCE_KILL_GRACE_MS = 5_000;
const OUTPUT_TAIL_LIMIT = 8 * 1024;

export type TaskAttemptFailure = {
  type: "failed" | "cancelled" | "timed_out";
  message: string;
};

type RunTaskAttemptInput = {
  nodeId: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  request: TaskProcessRequest;
  timeoutMs?: number;
  signal?: AbortSignal;
  registerArtifact(artifact: TaskArtifactRegistration): void;
};

export function runTaskAttempt(input: RunTaskAttemptInput): ResultAsync<JsonValue | undefined, TaskAttemptFailure> {
  return new ResultAsync(runTaskProcess(input));
}

function runTaskProcess(input: RunTaskAttemptInput): Promise<Result<JsonValue | undefined, TaskAttemptFailure>> {
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
  return new Promise((resolveResult, reject) => {
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
      resolveResult(err(failure));
      return;
    }

    let stdout = "";
    let stderr = "";
    let spawnError: NodeJS.ErrnoException | undefined;
    let terminal:
      | { type: "completed"; output?: JsonValue }
      | { type: "failed"; failure: TaskAttemptFailure }
      | { type: "system_rejected"; error: Error }
      | undefined;
    let termination: "cancelled" | "timed_out" | undefined;
    let settled = false;
    let cancelTimeout: (() => void) | undefined;
    let terminateTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let spawned = false;
    let abortSent = false;
    let artifactFailurePending = false;

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
        terminal = { type: "system_rejected", error: taskProcessSystemError({ message: `Task process IPC failed: ${error.message}` }) };
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
      if (termination) sendAbort();
      else send({ type: "start", request: input.request });
    });
    child.on("message", raw => {
      if (!isChildMessage(raw)) {
        if (enforceTimeout() || termination) return;
        terminal = { type: "failed", failure: { type: "failed", message: "Task process sent an invalid IPC message." } };
        killProcessTree(child.pid, "SIGTERM");
        return;
      }
      const message = raw;
      if (message.type === "artifact_register") {
        let error: string | undefined;
        let identityAccepted = false;
        try {
          assertArtifactIdentity(input.request, message.artifact);
          identityAccepted = true;
          if (enforceTimeout() || termination || terminal) throw new Error("Task attempt is no longer accepting artifacts.");
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
        if (error === undefined) {
          try {
            input.registerArtifact(message.artifact);
          } catch (cause) {
            artifactFailurePending = true;
            const messageText = cause instanceof Error ? cause.message : String(cause);
            void removeRejectedArtifact(input.request, message.artifact).then(
              () => cause,
              cleanupError => new AggregateError([cause, cleanupError], "Artifact registration failed and its unregistered file could not be removed."),
            ).then(failure => {
              send({ type: "artifact_result", requestId: message.requestId, ok: false, error: messageText });
              killProcessTree(child.pid, "SIGTERM");
              settle(() => reject(failure));
            });
            return;
          }
        }
        if (error === undefined) {
          send({ type: "artifact_result", requestId: message.requestId, ok: true });
        } else if (identityAccepted) {
          void removeRejectedArtifact(input.request, message.artifact)
            .then(
              () => send({ type: "artifact_result", requestId: message.requestId, ok: false, error }),
              cleanupError => {
                killProcessTree(child.pid, "SIGTERM");
                settle(() => reject(new AggregateError([
                  new Error(error),
                  cleanupError,
                ], "Artifact rejection and cleanup both failed.")));
              },
            );
        } else {
          send({ type: "artifact_result", requestId: message.requestId, ok: false, error });
        }
        return;
      }
      if (enforceTimeout() || terminal || termination) return;
      if (message.type === "completed") {
        terminal = message.hasOutput ? { type: "completed", output: message.output } : { type: "completed" };
      } else if (message.type === "failed") {
        terminal = {
          type: "failed",
          failure: {
            type: "failed",
            message: message.message,
          },
        };
      } else {
        terminal = { type: "system_rejected", error: taskProcessSystemError(message.error) };
      }
    });
    child.once("error", error => {
      if (!enforceTimeout()) spawnError = error;
    });
    child.once("close", (exitCode, signal) => {
      enforceTimeout();
      if (artifactFailurePending) return;
      if (termination) {
        const failure = termination === "timed_out"
          ? timeoutFailure()
          : cancellationFailure();
        settle(() => resolveResult(err(failure)));
        return;
      }
      if (spawnError) {
        settle(() => resolveResult(err(spawnFailure(input, spawnError!))));
        return;
      }
      if (terminal?.type === "completed") {
        const output = terminal.output;
        settle(() => resolveResult(ok(output)));
        return;
      }
      if (terminal?.type === "failed") {
        const failure = terminal.failure;
        settle(() => resolveResult(err(failure)));
        return;
      }
      if (terminal?.type === "system_rejected") {
        const error = terminal.error;
        settle(() => reject(error));
        return;
      }
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
      const message = `Task process for node '${input.nodeId}' exited without a result${exitCode === null ? "" : ` (code ${exitCode})`}${signal ? ` (${signal})` : ""}.${detail ? ` ${detail}` : ""}`;
      settle(() => resolveResult(err({
        type: "failed",
        message,
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
  const code = typeof nodeError.code === "string" && !detail.includes(nodeError.code) ? ` (${nodeError.code})` : "";
  return {
    type: "failed",
    message: `Task process for node '${input.nodeId}' could not start in '${input.cwd}': ${detail}${code}`,
  };
}

function assertArtifactIdentity(request: TaskProcessRequest, artifact: TaskArtifactRegistration): void {
  if (artifact.runId !== request.artifact.runId
    || artifact.nodeKey !== request.artifact.nodeKey
    || artifact.attemptId !== request.artifact.attemptId
    || artifact.attempt !== request.artifact.attempt
    || artifact.ownerEpoch !== request.artifact.ownerEpoch) {
    throw new Error("Task process artifact identity does not match its attempt.");
  }
}

async function removeRejectedArtifact(request: TaskProcessRequest, artifact: TaskArtifactRegistration): Promise<void> {
  const runDir = resolve(request.artifact.runDir);
  const path = resolve(runDir, artifact.relativePath);
  const fromRun = relative(runDir, path);
  if (fromRun === "" || fromRun === ".." || fromRun.startsWith(`..${sep}`) || isAbsolute(fromRun)) return;
  await rm(path, { force: true });
}

function appendTail(previous: string, chunk: unknown): string {
  const next = previous + Buffer.from(chunk as Uint8Array).toString("utf8");
  return next.length <= OUTPUT_TAIL_LIMIT ? next : next.slice(next.length - OUTPUT_TAIL_LIMIT);
}

function isChildMessage(value: unknown): value is TaskProcessChildMessage {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const message = value as Record<string, unknown>;
  if (message.type === "artifact_register") return typeof message.requestId === "string" && Boolean(message.artifact) && typeof message.artifact === "object";
  if (message.type === "completed") return typeof message.hasOutput === "boolean" && (!message.hasOutput || "output" in message);
  if (message.type === "failed") return typeof message.message === "string";
  if (message.type !== "system_rejected" || !message.error || typeof message.error !== "object") return false;
  const error = message.error as Record<string, unknown>;
  return typeof error.message === "string" && (error.code === undefined || typeof error.code === "string");
}

function taskProcessSystemError(input: { message: string; code?: string }): Error {
  const error = new Error(input.message);
  error.name = "TaskProcessSystemError";
  if (input.code !== undefined) Object.assign(error, { code: input.code });
  return error;
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
