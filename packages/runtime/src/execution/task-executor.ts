import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { task } from "@acpus/core";
import type { ArtifactRef } from "@acpus/core/schema";
import { createDollar, type CommandBuilder, type Dollar, type TaskContext, type TaskFunction } from "@acpus/core/runtime";
import type { TaskExecutionTargetIR, TaskNodeIR } from "@acpus/core/ir";
import { tsImport } from "tsx/esm/api";
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
  const fn = await loadTaskFunction(node.run.target, options.cwd);
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

async function loadTaskFunction(target: TaskExecutionTargetIR, workspaceDir: string): Promise<TaskFunction<unknown, unknown>> {
  if (target.kind === "inline") {
    const mod = await import(`data:text/javascript,${encodeURIComponent(`export default ${target.source};`)}`);
    const fn = mod.default;
    if (typeof fn !== "function") throw new Error("Inline task source did not evaluate to a function.");
    return fn as TaskFunction<unknown, unknown>;
  }

  const parentURL = pathToFileURL(join(workspaceDir, target.referrer.path)).href;
  const mod = await importReusableModule(target.specifier, parentURL);
  const token = mod[target.exportName];
  if (!task.isToken(token)) {
    throw new Error(`Reusable task module '${target.specifier}' export '${target.exportName}' is not an Acpus task.`);
  }
  return token.fn as TaskFunction<unknown, unknown>;
}

async function importReusableModule(specifier: string, parentURL: string): Promise<Record<string, unknown>> {
  try {
    return await tsImport(specifier, { parentURL }) as Record<string, unknown>;
  } catch (error) {
    if (!isResolutionError(error)) throw error;
    const developmentURL = await developmentExportURL(specifier, parentURL);
    if (!developmentURL) throw error;
    return await tsImport(developmentURL, { parentURL }) as Record<string, unknown>;
  }
}

async function developmentExportURL(specifier: string, parentURL: string): Promise<string | undefined> {
  const parts = packageSpecifierParts(specifier);
  if (!parts) return undefined;
  const packageJson = await findPackageJson(parts.name, dirname(fileURLToPath(parentURL)));
  if (!packageJson) return undefined;
  const pkg = JSON.parse(await readFile(packageJson, "utf8")) as { exports?: unknown };
  const target = exportTarget(pkg.exports, parts.subpath);
  if (!target) return undefined;
  return pathToFileURL(resolve(dirname(packageJson), target)).href;
}

function packageSpecifierParts(specifier: string): { name: string; subpath: string } | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) return undefined;
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    if (parts.length < 2) return undefined;
    return { name: `${parts[0]}/${parts[1]}`, subpath: parts.length > 2 ? `./${parts.slice(2).join("/")}` : "." };
  }
  return { name: parts[0] ?? specifier, subpath: parts.length > 1 ? `./${parts.slice(1).join("/")}` : "." };
}

async function findPackageJson(name: string, fromDir: string): Promise<string | undefined> {
  let current = resolve(fromDir);
  while (true) {
    const candidate = join(current, "node_modules", name, "package.json");
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch {
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

function exportTarget(exports: unknown, subpath: string): string | undefined {
  const entry = subpath === "." ? exports : isRecord(exports) ? exports[subpath] : undefined;
  if (typeof entry === "string") return entry;
  if (!isRecord(entry)) return undefined;
  const development = entry.development;
  if (typeof development === "string") return development;
  if (isRecord(development) && typeof development.default === "string") return development.default;
  return undefined;
}

function isResolutionError(error: unknown): boolean {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
  return code === "ERR_MODULE_NOT_FOUND"
    || code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
    || code === "ERR_PACKAGE_IMPORT_NOT_DEFINED"
    || code === "ERR_UNSUPPORTED_DIR_IMPORT";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
