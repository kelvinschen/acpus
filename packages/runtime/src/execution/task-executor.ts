import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ArtifactRef } from "@acpus/core/schema";
import { createDollar, type CommandBuilder, type Dollar, type TaskContext, type TaskFunction } from "@acpus/core/runtime";
import type { TaskNodeIR } from "@acpus/core/ir";
import { evaluateExpr, type EvaluationScope } from "../evaluation/evaluator.js";
import type { RuntimeStore } from "../store/store.js";
import { parseDurationMs } from "./duration.js";

export type TaskExecutorOptions = {
  cwd: string;
  runId: string;
  store: RuntimeStore;
  nodeKey?: string;
  attemptNo?: number;
  signal?: AbortSignal;
};

export async function executeTaskNode(node: TaskNodeIR, scope: EvaluationScope, options: TaskExecutorOptions): Promise<unknown> {
  const runDir = options.store.getRunDir(options.runId);
  if (!runDir) throw new Error(`Run '${options.runId}' has no run directory.`);
  const absoluteRunDir = join(options.cwd, runDir);
  const bundlePath = join(absoluteRunDir, "task-bundles", `${node.run.bundleId}.mjs`);
  const mod = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}-${Math.random()}`);
  const fn = mod.default as TaskFunction<unknown, unknown>;
  if (typeof fn !== "function") throw new Error(`Task bundle '${node.run.bundleId}' does not export a default function.`);
  const input = Object.fromEntries(Object.entries(node.run.input).map(([key, expr]) => [key, evaluateExpr(expr, scope)]));
  const nodeKey = options.nodeKey ?? node.id;
  const cwd = node.run.cwd ? stringValue(evaluateExpr(node.run.cwd, scope), `Task node '${node.id}' cwd`) : options.cwd;
  const env = evaluateEnv(node.run.env, scope);
  const visibleAttempt = options.attemptNo ?? 1;
  const attemptDir = `attempt-${visibleAttempt}`;
  const outputDir = join(absoluteRunDir, "outputs", nodeKey, attemptDir);
  const workDir = join(absoluteRunDir, "work", nodeKey, attemptDir);
  await mkdir(outputDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  const controller = new AbortController();
  const abortFromScheduler = () => controller.abort();
  options.signal?.addEventListener("abort", abortFromScheduler, { once: true });
  if (options.signal?.aborted) controller.abort();
  let timeout: NodeJS.Timeout | undefined;
  try {
    const task = fn({
      input,
      $: createTaskDollar({ cwd, env }, node, controller.signal),
      artifact: createArtifactApi({
        runId: options.runId,
        nodeKey,
        runDir: absoluteRunDir,
        store: options.store,
        attempt: visibleAttempt,
        signal: controller.signal,
      }),
      env,
      abortSignal: controller.signal,
    } satisfies TaskContext<typeof input>);
    if (node.timeout === undefined) return await task;
    const timeoutMs = parseDurationMs(node.timeout);
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error(`Task node '${node.id}' timed out after ${node.timeout}.`));
      }, timeoutMs);
    });
    return await Promise.race([task, timeoutPromise]);
  } catch (error) {
    throw controller.signal.aborted && !options.signal?.aborted ? new Error(`Task node '${node.id}' timed out after ${node.timeout}.`) : error;
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromScheduler);
  }
}

function evaluateEnv(env: TaskNodeIR["run"]["env"], scope: EvaluationScope): Record<string, string> {
  if (!env) return {};
  return Object.fromEntries(Object.entries(env).map(([key, value]) => {
    if ("kind" in value && value.kind === "secret") throw new Error(`Task env '${key}' references an unresolved secret.`);
    return [key, stringValue(evaluateExpr(value, scope), `Task env '${key}'`)];
  }));
}

function createTaskDollar(options: Parameters<typeof createDollar>[0], node: TaskNodeIR, signal: AbortSignal): Dollar {
  validateExecutionOptions(node);
  const timeout = node.run.execution?.defaultCommandTimeout;
  const dollar = timeout
    ? createDollar(options, { timeout: timeout as NonNullable<Parameters<CommandBuilder["timeout"]>[0]> })
    : createDollar(options);
  return wrapDollar(dollar, signal);
}

function wrapDollar(dollar: Dollar, signal: AbortSignal): Dollar {
  return ((arg: TemplateStringsArray | Parameters<Dollar>[0], ...values: unknown[]) => {
    const result = (dollar as any)(arg, ...values);
    if (!Array.isArray(arg)) return wrapDollar(result as Dollar, signal);
    const command = result as CommandBuilder;
    if (signal.aborted) command.timeout(1, "SIGTERM");
    signal.addEventListener("abort", () => command.timeout(1, "SIGTERM"), { once: true });
    return command;
  }) as Dollar;
}

function validateExecutionOptions(node: TaskNodeIR): void {
  if (node.run.execution?.shell && node.run.execution.shell !== "bash") throw new Error(`Task node '${node.id}' execution shell '${node.run.execution.shell}' is not supported yet.`);
  if (node.run.execution?.commandRunner && node.run.execution.commandRunner !== "acpus-zx-core") throw new Error(`Task node '${node.id}' execution commandRunner '${node.run.execution.commandRunner}' is not supported yet.`);
}

function stringValue(value: unknown, label: string): string {
  if (typeof value === "string") return value;
  throw new Error(`${label} must evaluate to string.`);
}

function createArtifactApi(args: {
  runId: string;
  nodeKey: string;
  runDir: string;
  store: RuntimeStore;
  attempt: number;
  signal: AbortSignal;
}) {
  async function writeArtifact(name: string, bytes: Uint8Array, mediaType?: string): Promise<ArtifactRef> {
    if (args.signal.aborted) throw new Error(`Task node '${args.nodeKey}' attempt ${args.attempt} is aborted.`);
    const safeName = safeArtifactName(name);
    const id = `artifact_${randomUUID()}`;
    const attemptDir = `attempt-${args.attempt}`;
    const relativePath = join("artifacts", args.nodeKey, attemptDir, `${id}-${safeName}`);
    const absolutePath = join(args.runDir, relativePath);
    await mkdir(join(args.runDir, "artifacts", args.nodeKey, attemptDir), { recursive: true });
    await writeFile(absolutePath, bytes);
    if (args.signal.aborted) {
      await rm(absolutePath, { force: true });
      throw new Error(`Task node '${args.nodeKey}' attempt ${args.attempt} is aborted.`);
    }
    args.store.registerArtifact({
      id,
      runId: args.runId,
      nodeKey: args.nodeKey,
      attempt: args.attempt,
      ...(mediaType ? { mediaType } : {}),
      digest: digest(bytes),
      size: bytes.byteLength,
      relativePath,
    });
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
      const bytes = await readFile(path);
      return writeArtifact(options?.name ?? basename(path), bytes, options?.mediaType);
    },
  };
}

function safeArtifactName(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "artifact";
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
