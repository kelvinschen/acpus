import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { importAuthoringModule } from "@acpus/loader";
import { task } from "@acpus/core";
import { createDollar, type ArtifactRef, type CommandBuilder, type Dollar, type TaskContext, type TaskFunction } from "@acpus/core/runtime";
import type { TaskExecutionTargetIR } from "@acpus/core/ir";
import { normalizeWorkflowData } from "../evaluation/admissible.js";
import { loadInlineTaskFunction } from "./inline-task.js";
import type { TaskArtifactRegistration, TaskProcessChildMessage, TaskProcessParentMessage, TaskProcessRequest } from "./task-process-protocol.js";

const controller = new AbortController();
const artifactRequests = new Map<string, { resolve(): void; reject(error: Error): void }>();
let started = false;

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
    validateExecutionOptions(request.execution);
    const fn = await loadTaskFunction(request.target, request.workspaceDir);
    const output = await fn({
      input: request.input,
      $: createTaskDollar(request.execution, controller.signal),
      artifact: createArtifactApi(request.artifact, controller.signal),
      env: process.env,
      abortSignal: controller.signal,
    } satisfies TaskContext<typeof request.input>);
    const normalized = normalizeWorkflowData(output, "Task output", { allowTopLevelUndefined: true });
    await finish(normalized === undefined
      ? { type: "completed", hasOutput: false }
      : { type: "completed", hasOutput: true, output: normalized });
  } catch (error) {
    await finish({ type: "failed", error: serializedError(error) });
  }
}

async function loadTaskFunction(target: TaskExecutionTargetIR, workspaceDir: string): Promise<TaskFunction<unknown, unknown>> {
  if (target.kind === "inline") return loadInlineTaskFunction(target.source);

  const parentURL = pathToFileURL(join(workspaceDir, target.referrer.path)).href;
  const mod = await importAuthoringModule(target.specifier, { parentURL });
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

function validateExecutionOptions(execution: TaskProcessRequest["execution"]): void {
  if (execution?.shell && execution.shell !== "bash") throw new Error(`Task execution shell '${execution.shell}' is not supported yet.`);
  if (execution?.commandRunner && execution.commandRunner !== "acpus-zx-core") throw new Error(`Task execution commandRunner '${execution.commandRunner}' is not supported yet.`);
}

function createArtifactApi(args: TaskProcessRequest["artifact"], signal: AbortSignal) {
  async function writeArtifact(name: string, bytes: Uint8Array, mediaType?: string): Promise<ArtifactRef> {
    if (signal.aborted) throw new Error(`Task node '${args.nodeKey}' attempt ${args.attempt} is aborted.`);
    const id = `artifact_${randomUUID()}`;
    const relativePath = join("artifacts", args.nodeKey, `attempt-${args.attempt}`, `${id}-${safeArtifactName(name)}`);
    const absolutePath = join(args.runDir, relativePath);
    await mkdir(join(args.runDir, "artifacts", args.nodeKey, `attempt-${args.attempt}`), { recursive: true });
    await writeFile(absolutePath, bytes);
    if (signal.aborted) {
      await rm(absolutePath, { force: true });
      throw new Error(`Task node '${args.nodeKey}' attempt ${args.attempt} is aborted.`);
    }
    try {
      await registerArtifact({
        id,
        runId: args.runId,
        nodeKey: args.nodeKey,
        attempt: args.attempt,
        ...(mediaType === undefined ? {} : { mediaType }),
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        size: bytes.byteLength,
        relativePath,
      });
    } catch (error) {
      await rm(absolutePath, { force: true });
      throw error;
    }
    return mediaType === undefined
      ? { kind: "artifact", uri: `artifact://${args.runId}/${id}` }
      : { kind: "artifact", uri: `artifact://${args.runId}/${id}`, mediaType };
  }

  return {
    writeText(name: string, content: string, options?: { mediaType?: string }) {
      return writeArtifact(name, Buffer.from(content, "utf8"), options?.mediaType ?? "text/plain");
    },
    writeJson(name: string, value: unknown) {
      return writeArtifact(name, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"), "application/json");
    },
    writeBytes(name: string, value: Uint8Array, options?: { mediaType?: string }) {
      return writeArtifact(name, value, options?.mediaType);
    },
    async fromFile(path: string, options?: { name?: string; mediaType?: string }) {
      return writeArtifact(options?.name ?? basename(path), await readFile(path), options?.mediaType);
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

function serializedError(error: unknown): { name: string; message: string; stack?: string } {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) };
  return { name: error.name, message: error.message, ...(error.stack ? { stack: error.stack } : {}) };
}
