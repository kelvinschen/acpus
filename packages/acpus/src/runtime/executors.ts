import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentNodeIR, JsonObject, JsonValue, SecretRefIR, TaskNodeIR, WorkflowIR } from "@acpus/core";
import { createDollar, type CommandSpan, type TaskContext } from "@acpus/core";
import { evalExpr, renderTemplate, toJsonValue, type EvalRuntimeContext } from "./expr.js";
import { defaultValueForSchema, parseSchemaIR, validationMessage } from "./schema.js";
import { digestBytes, now, type RuntimeStore } from "./store.js";

export type ExecutionRuntime = {
  store: RuntimeStore;
  workspaceDir: string;
  runId: string;
  runDir: string;
  outputDir: string;
  agentStub: boolean;
};

export type NodeExecutionArgs = {
  nodeKey: string;
  attempt: number;
  evalContext: EvalRuntimeContext;
  runtime: ExecutionRuntime;
};

export type ExecutorResult = {
  output: JsonValue;
  metadata: JsonValue;
};

export class RuntimeExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: JsonValue = null,
  ) {
    super(message);
  }
}

export async function executeTask(node: TaskNodeIR, args: NodeExecutionArgs): Promise<ExecutorResult> {
  const input = toJsonValue(Object.fromEntries(Object.entries(node.inputs).map(([key, expr]) => [key, evalExpr(expr, args.evalContext)])));
  const cwd = node.cwd ? String(evalExpr(node.cwd, args.evalContext)) : args.runtime.workspaceDir;
  const env = resolveEnv(node.env, args.evalContext);
  const modulePath = join(args.runtime.runDir, "task-bundles", `${node.run.bundleId}.mjs`);
  const mod = await import(`${pathToFileURL(modulePath).href}?run=${args.runtime.runId}&node=${encodeURIComponent(args.nodeKey)}&attempt=${args.attempt}`);
  const fn = node.run.exportName === "default" ? mod.default : mod[node.run.exportName];
  if (typeof fn !== "function") {
    throw new RuntimeExecutionError("task_export", `Task bundle ${node.run.bundleId} does not export '${node.run.exportName}'.`);
  }

  const spans: CommandSpan[] = [];
  const logs: JsonValue[] = [];
  const artifact = createArtifactApi({ node, nodeKey: args.nodeKey, attempt: args.attempt, runtime: args.runtime });
  const mergedEnv = mergeEnv(process.env, env);
  const defaultCommandTimeout = node.execution?.defaultCommandTimeout ? parseDurationMs(node.execution.defaultCommandTimeout) : undefined;
  const dollar = createDollar({
    cwd: resolve(cwd),
    env: mergedEnv,
    onSpan: span => spans.push(span),
  }, defaultCommandTimeout ? { timeout: defaultCommandTimeout } : {});
  const controller = new AbortController();
  const taskContext: TaskContext<JsonValue, JsonObject> = {
    input,
    params: node.params ?? {},
    $: dollar,
    artifact,
    log: makeLogApi(args.runtime.store, args.runtime.runId, args.nodeKey, args.attempt, logs),
    env,
    runtime: {
      runId: args.runtime.runId,
      nodeId: node.id,
      nodeKey: args.nodeKey,
      attempt: args.attempt,
      workDir: resolve(cwd),
      outputDir: args.runtime.outputDir,
    },
    signal: controller.signal,
  };

  const output = await withTimeout(Promise.resolve(fn(taskContext)), node.timeout, controller);
  const parsed = parseSchemaIR(node.outputSchema, output, `nodes.${node.id}.output`);
  if (!parsed.ok) {
    throw new RuntimeExecutionError("output_schema", `Task '${node.id}' returned invalid output: ${validationMessage(parsed.issues)}`, { issues: parsed.issues as unknown as JsonValue });
  }
  return {
    output: parsed.value,
    metadata: toJsonValue({ commandSpans: spans, logs }),
  };
}

export async function executeAgent(node: AgentNodeIR, ir: WorkflowIR, args: NodeExecutionArgs): Promise<ExecutorResult> {
  const agentDefinition = ir.agents[node.run.agent];
  if (!agentDefinition) throw new RuntimeExecutionError("agent_definition", `Agent '${node.run.agent}' is not defined.`);
  const prompt = renderTemplate(node.run.prompt, args.evalContext);
  const cwdExpr = node.run.cwd ?? agentDefinition.cwd;
  const cwd = cwdExpr ? String(evalExpr(cwdExpr, args.evalContext)) : args.runtime.workspaceDir;
  const env = {
    ...resolveEnv(agentDefinition.env, args.evalContext),
    ...resolveEnv(node.run.env, args.evalContext),
  };
  const artifact = createArtifactApi({ node, nodeKey: args.nodeKey, attempt: args.attempt, runtime: args.runtime });

  const command = agentDefinition.kind === "agent_command"
    ? agentDefinition.command
    : process.env[agentCommandEnvKey(node.run.agent)] ?? process.env.ACPUS_AGENT_COMMAND;

  let output: unknown;
  let transcript = "";
  if (!command) {
    if (!args.runtime.agentStub) {
      throw new RuntimeExecutionError(
        "agent_runner",
        `Agent '${node.run.agent}' has no command runner. Define it as agent.command(...) or set ${agentCommandEnvKey(node.run.agent)} / ACPUS_AGENT_COMMAND.`,
      );
    }
    output = defaultValueForSchema(node.outputSchema);
    transcript = `# Agent stub\n\nPrompt:\n${prompt}\n`;
  } else {
    const payload = {
      runId: args.runtime.runId,
      nodeId: node.id,
      nodeKey: args.nodeKey,
      agent: node.run.agent,
      prompt,
      outputSchema: node.outputSchema ?? null,
      policy: node.run.policy ?? agentDefinition.policy ?? null,
    };
    const timeoutMs = node.timeout ? parseDurationMs(node.timeout) : undefined;
    const result = await runAgentCommand(command, JSON.stringify(payload, null, 2), {
      cwd: resolve(cwd),
      env: mergeEnv(process.env, env),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    transcript = [
      `# Agent ${node.run.agent}`,
      "",
      "## Prompt",
      prompt,
      "",
      "## Stdout",
      result.stdout,
      "",
      "## Stderr",
      result.stderr,
    ].join("\n");
    if (result.exitCode !== 0) {
      throw new RuntimeExecutionError("agent_exit", `Agent '${node.run.agent}' exited with ${result.exitCode}.`, { stderr: result.stderr });
    }
    try {
      output = result.stdout.trim() ? JSON.parse(result.stdout) : null;
    } catch (error) {
      throw new RuntimeExecutionError("agent_output_json", `Agent '${node.run.agent}' did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const transcriptRef = await artifact.writeText("transcript.md", transcript, { mediaType: "text/markdown" });
  const parsed = parseSchemaIR(node.outputSchema, output, `nodes.${node.id}.output`);
  if (!parsed.ok) {
    throw new RuntimeExecutionError("output_schema", `Agent '${node.id}' returned invalid output: ${validationMessage(parsed.issues)}`, { issues: parsed.issues as unknown as JsonValue });
  }
  return {
    output: parsed.value,
    metadata: toJsonValue({ transcript: transcriptRef }),
  };
}

export function resolveEnv(bindings: Record<string, unknown> | undefined, context: EvalRuntimeContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(bindings ?? {})) {
    if (isSecretRef(value)) {
      const secret = process.env[value.name];
      if (secret === undefined) throw new RuntimeExecutionError("secret_missing", `Secret '${value.name}' is not available in process.env.`);
      out[key] = secret;
    } else {
      const evaluated = evalExpr(value as never, context);
      if (evaluated !== undefined && evaluated !== null) out[key] = String(evaluated);
    }
  }
  return out;
}

function createArtifactApi(args: {
  node: { id: string; kind: string };
  nodeKey: string;
  attempt: number;
  runtime: ExecutionRuntime;
}) {
  const attemptDir = join(args.runtime.runDir, "artifacts", sanitizePath(args.nodeKey), `attempt-${args.attempt}`);
  return {
    async writeText(name: string, content: string, options?: { mediaType?: string | undefined }) {
      return writeArtifact(name, Buffer.from(content, "utf8"), options?.mediaType ?? "text/plain");
    },
    async writeJson(name: string, value: unknown) {
      return writeArtifact(name, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"), "application/json");
    },
    async writeBytes(name: string, value: Uint8Array, options?: { mediaType?: string | undefined }) {
      return writeArtifact(name, Buffer.from(value), options?.mediaType ?? "application/octet-stream");
    },
    async fromFile(path: string, options?: { name?: string | undefined; mediaType?: string | undefined }) {
      const source = resolve(path);
      const bytes = await readFile(source);
      return writeArtifact(options?.name ?? basename(source), bytes, options?.mediaType ?? "application/octet-stream");
    },
  };

  async function writeArtifact(name: string, bytes: Uint8Array, mediaType: string) {
    await mkdir(attemptDir, { recursive: true });
    const safeName = sanitizePath(basename(name || "artifact.bin"));
    const artifactId = `art_${randomUUID()}`;
    const filePath = join(attemptDir, `${artifactId}-${safeName}`);
    await writeFile(filePath, bytes);
    const relativePath = relative(args.runtime.runDir, filePath).replaceAll("\\", "/");
    const digest = digestBytes(bytes);
    args.runtime.store.insertArtifact({
      artifactId,
      runId: args.runtime.runId,
      nodeKey: args.nodeKey,
      nodeId: args.node.id,
      attempt: args.attempt,
      mediaType,
      digest,
      size: bytes.byteLength,
      relativePath,
    });
    return {
      kind: "artifact" as const,
      uri: `acpus://runs/${args.runtime.runId}/artifacts/${artifactId}`,
      mediaType,
    };
  }
}

function makeLogApi(store: RuntimeStore, runId: string, nodeKey: string, attempt: number, logs: JsonValue[]) {
  const write = (level: string, message: string, fields?: Record<string, unknown>) => {
    const entry = toJsonValue({ level, message, fields: fields ?? {}, ts: now() });
    logs.push(entry);
    store.appendEvent(runId, "node.log", entry, { nodeKey, attempt });
  };
  return {
    debug: (message: string, fields?: Record<string, unknown>) => write("debug", message, fields),
    info: (message: string, fields?: Record<string, unknown>) => write("info", message, fields),
    warn: (message: string, fields?: Record<string, unknown>) => write("warn", message, fields),
    error: (message: string, fields?: Record<string, unknown>) => write("error", message, fields),
  };
}

async function withTimeout<T>(promise: Promise<T>, duration: string | undefined, controller: AbortController): Promise<T> {
  if (!duration) return promise;
  const timeoutMs = parseDurationMs(duration);
  if (!timeoutMs) return promise;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new RuntimeExecutionError("timeout", `Execution timed out after ${duration}.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseDurationMs(duration: string): number | undefined {
  const trimmed = duration.trim();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(trimmed);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const factor = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  return amount * factor;
}

function runAgentCommand(command: string, stdin: string, options: { cwd: string; env: Record<string, string>; timeoutMs?: number | undefined }): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise(resolveProcess => {
    const child = spawn(command, [], { cwd: options.cwd, env: options.env, shell: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), options.timeoutMs) : undefined;
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.on("close", exitCode => {
      if (timer) clearTimeout(timer);
      resolveProcess({ exitCode, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    child.on("error", error => {
      if (timer) clearTimeout(timer);
      resolveProcess({ exitCode: null, stdout: "", stderr: error.message });
    });
    child.stdin.end(stdin);
  });
}

function mergeEnv(base: NodeJS.ProcessEnv, overlay: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) out[key] = value;
  for (const [key, value] of Object.entries(overlay)) out[key] = value;
  return out;
}

function sanitizePath(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "artifact";
}

function agentCommandEnvKey(agentName: string): string {
  return `ACPUS_AGENT_${agentName.replaceAll(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_COMMAND`;
}

function isSecretRef(value: unknown): value is SecretRefIR {
  return Boolean(value && typeof value === "object" && (value as { kind?: unknown }).kind === "secret" && typeof (value as { name?: unknown }).name === "string");
}
