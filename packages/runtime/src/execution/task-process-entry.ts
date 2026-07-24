import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { importAuthoringModule } from "@acpus/loader";
import { task } from "@acpus/core";
import { createDollar, type ArtifactRef, type CommandBuilder, type Dollar, type TaskContext, type TaskFunction } from "@acpus/core/runtime";
import type { TaskExecutionTargetIR } from "@acpus/core/ir";
import { tryNormalizeWorkflowData } from "../evaluation/admissible.js";
import { loadInlineTaskFunction } from "./inline-task.js";
import type { TaskArtifactRegistration, TaskProcessChildMessage, TaskProcessParentMessage, TaskProcessRequest } from "./task-process-protocol.js";

const controller = new AbortController();
const artifactRequests = new Map<string, { resolve(): void; reject(error: Error): void }>();
let started = false;
let runtimeSystemFailure: TaskRuntimeSystemError | undefined;

class TaskRuntimeSystemError extends Error {
  readonly code?: string;

  constructor(message: string, cause: unknown) {
    super(`${message}: ${errorMessage(cause)}`, { cause });
    this.name = "TaskRuntimeSystemError";
    const code = cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
    if (typeof code === "string") this.code = code;
  }
}

process.on("message", (message: TaskProcessParentMessage) => {
  if (message.type === "abort") {
    controller.abort();
    return;
  }
  if (message.type === "artifact_result") {
    const pending = artifactRequests.get(message.requestId);
    if (!pending) return;
    artifactRequests.delete(message.requestId);
    if (message.ok) pending.resolve();
    else pending.reject(new Error(message.error));
    return;
  }
  if (started) return;
  started = true;
  void execute(message.request);
});

async function execute(request: TaskProcessRequest): Promise<void> {
  try {
    const fn = await loadTaskFunction(
      request.target,
      request.sourceRoot ?? request.workspaceDir,
      request.workspaceDir,
    );
    const output = await fn({
      input: request.input,
      $: createTaskDollar(request.execution, controller.signal),
      artifact: createArtifactApi(request.artifact, controller.signal),
      env: process.env,
      abortSignal: controller.signal,
    } satisfies TaskContext<typeof request.input>);
    if (runtimeSystemFailure) {
      await finish(systemRejection(runtimeSystemFailure));
      return;
    }
    const normalized = tryNormalizeWorkflowData(output, "Task output", { allowTopLevelUndefined: true });
    if (normalized.isErr()) {
      await finish({ type: "failed", message: normalized.error.message });
      return;
    }
    await finish(normalized.value === undefined
      ? { type: "completed", hasOutput: false }
      : { type: "completed", hasOutput: true, output: normalized.value });
  } catch (error) {
    const systemFailure = runtimeSystemFailure ?? (error instanceof TaskRuntimeSystemError ? error : undefined);
    await finish(systemFailure
      ? systemRejection(systemFailure)
      : { type: "failed", message: errorMessage(error) });
  }
}

async function loadTaskFunction(
  target: TaskExecutionTargetIR,
  sourceRoot: string,
  workspaceDir: string,
): Promise<TaskFunction<unknown, unknown>> {
  if (target.kind === "inline") return loadInlineTaskFunction(target.source);

  const parentURL = pathToFileURL(join(sourceRoot, target.referrer.path)).href;
  const mod = await importAuthoringModule(target.specifier, {
    parentURL,
    sourceRoot,
    dependencyRoot: workspaceDir,
  });
  const token = mod[target.exportName];
  if (!task.isToken(token)) throw new Error(`Reusable task module '${target.specifier}' export '${target.exportName}' is not an Acpus task.`);
  return token.fn as TaskFunction<unknown, unknown>;
}

function createTaskDollar(execution: TaskProcessRequest["execution"], signal: AbortSignal): Dollar {
  const timeout = execution?.defaultCommandTimeout;
  return timeout
    ? createDollar({ signal }, { timeout: timeout as NonNullable<Parameters<CommandBuilder["timeout"]>[0]> })
    : createDollar({ signal });
}

function createArtifactApi(args: TaskProcessRequest["artifact"], signal: AbortSignal) {
  const paths = new Map(Object.entries(args.paths));

  async function writeArtifact(name: string, bytes: Uint8Array, mediaType?: string): Promise<ArtifactRef> {
    if (signal.aborted) throw new Error(`Task node '${args.nodeKey}' attempt ${args.attempt} is aborted.`);
    const id = `artifact_${randomUUID()}`;
    const relativePath = join("artifacts", args.nodeKey, `attempt-${args.attempt}`, `${id}-${safeArtifactName(name)}`);
    const absolutePath = join(args.runDir, relativePath);
    try {
      await mkdir(join(args.runDir, "artifacts", args.nodeKey, `attempt-${args.attempt}`), { recursive: true, mode: 0o700 });
      await writeFile(absolutePath, bytes, { mode: 0o600 });
    } catch (cause) {
      throw rememberSystemFailure(`Task artifact write failed for node '${args.nodeKey}' attempt ${args.attempt}`, cause);
    }
    if (signal.aborted) {
      try {
        await rm(absolutePath, { force: true });
      } catch (cause) {
        throw rememberSystemFailure(`Task artifact cleanup failed for node '${args.nodeKey}' attempt ${args.attempt}`, cause);
      }
      throw new Error(`Task node '${args.nodeKey}' attempt ${args.attempt} is aborted.`);
    }
    try {
      await registerArtifact({
        id,
        runId: args.runId,
        nodeKey: args.nodeKey,
        attemptId: args.attemptId,
        attempt: args.attempt,
        ownerEpoch: args.ownerEpoch,
        ...(mediaType === undefined ? {} : { mediaType }),
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        size: bytes.byteLength,
        relativePath,
      });
    } catch (cause) {
      let failure = cause;
      try {
        await rm(absolutePath, { force: true });
      } catch (cleanupError) {
        failure = new AggregateError([cause, cleanupError], "Task artifact registration and cleanup both failed.");
      }
      throw rememberSystemFailure(`Task artifact registration failed for node '${args.nodeKey}' attempt ${args.attempt}`, failure);
    }
    const ref: ArtifactRef = mediaType === undefined
      ? { kind: "artifact", uri: `artifact://${args.runId}/${id}` }
      : { kind: "artifact", uri: `artifact://${args.runId}/${id}`, mediaType };
    paths.set(ref.uri, absolutePath);
    return ref;
  }

  return {
    async write(name: string, content: string | Uint8Array, options?: { mediaType?: string }) {
      if (typeof content === "string") {
        return writeArtifact(name, Buffer.from(content, "utf8"), options?.mediaType ?? "text/plain");
      }
      if (content instanceof Uint8Array) return writeArtifact(name, content, options?.mediaType);
      throw new TypeError("artifact.write(...) content must be a string or Uint8Array.");
    },
    path(ref: ArtifactRef) {
      if (!ref || ref.kind !== "artifact" || typeof ref.uri !== "string") {
        throw new TypeError("artifact.path(...) requires an ArtifactRef.");
      }
      const path = paths.get(ref.uri);
      if (!path) {
        throw new Error(`Artifact '${ref.uri}' is not available to this Task; bind it through Task input or use a ref returned by artifact.write(...).`);
      }
      return path;
    },
  };
}

function registerArtifact(artifact: TaskArtifactRegistration): Promise<void> {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    artifactRequests.set(requestId, { resolve, reject });
    void send({ type: "artifact_register", requestId, artifact }).catch(error => {
      artifactRequests.delete(requestId);
      reject(error);
    });
  });
}

function safeArtifactName(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "artifact";
}

function rememberSystemFailure(message: string, cause: unknown): TaskRuntimeSystemError {
  const failure = new TaskRuntimeSystemError(message, cause);
  runtimeSystemFailure ??= failure;
  return failure;
}

function systemRejection(error: TaskRuntimeSystemError): TaskProcessChildMessage {
  return {
    type: "system_rejected",
    error: {
      message: error.message,
      ...(error.code === undefined ? {} : { code: error.code }),
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function finish(message: TaskProcessChildMessage): Promise<void> {
  try {
    await send(message);
    process.disconnect?.();
    setImmediate(() => process.exit(0));
  } catch {
    process.exit(1);
  }
}

function send(message: TaskProcessChildMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) {
      reject(new Error("Task process IPC channel is unavailable."));
      return;
    }
    process.send(message, error => error ? reject(error) : resolve());
  });
}
