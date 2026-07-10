import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { TaskNodeIR } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";
import { evaluateExpr, type EvaluationScope } from "../evaluation/evaluator.js";
import type { RuntimeStore } from "../store/store.js";
import { parseDurationMs } from "./duration.js";
import { runTaskAttempt, taskAttemptFailureMessage, type TaskAttemptFailure, type TaskAttemptRunner } from "./task-process.js";

export type TaskExecutorOptions = {
  cwd: string;
  runId: string;
  store: RuntimeStore;
  nodeKey?: string;
  attemptId?: string;
  attemptNo?: number;
  signal?: AbortSignal;
  taskAttemptRunner?: TaskAttemptRunner;
};

export class TaskAttemptExecutionError extends Error {
  constructor(readonly failure: TaskAttemptFailure) {
    super(taskAttemptFailureMessage(failure));
  }
}

export async function executeTaskNode(node: TaskNodeIR, scope: EvaluationScope, options: TaskExecutorOptions): Promise<unknown> {
  validateExecutionOptions(node);
  const runDir = options.store.getRunDir(options.runId);
  if (!runDir) throw new Error(`Run '${options.runId}' has no run directory.`);
  const workspaceDir = resolve(options.cwd);
  const absoluteRunDir = resolve(workspaceDir, runDir);
  const input = Object.fromEntries(Object.entries(node.run.input).map(([key, expr]) => [key, evaluateExpr(expr, scope)])) as Record<string, JsonValue>;
  const nodeKey = options.nodeKey ?? node.id;
  const authoredCwd = node.run.cwd ? stringValue(evaluateExpr(node.run.cwd, scope), `Task node '${node.id}' cwd`) : workspaceDir;
  const cwd = isAbsolute(authoredCwd) ? authoredCwd : resolve(workspaceDir, authoredCwd);
  const env: NodeJS.ProcessEnv = { ...process.env, ...evaluateEnv(node.run.env, scope) };
  const visibleAttempt = options.attemptNo ?? 1;
  options.store.writeExecutionMetadata({
    runId: options.runId,
    ...(options.attemptId ? { attemptId: options.attemptId } : {}),
    kind: "task_attempt",
    metadata: { nodeId: node.id, nodeKey, attemptNo: visibleAttempt, input, cwd },
  });
  const attemptDir = `attempt-${visibleAttempt}`;
  await mkdir(join(absoluteRunDir, "outputs", nodeKey, attemptDir), { recursive: true });
  await mkdir(join(absoluteRunDir, "work", nodeKey, attemptDir), { recursive: true });

  const result = await (options.taskAttemptRunner ?? runTaskAttempt)({
    nodeId: node.id,
    cwd,
    env,
    request: {
      target: node.run.target,
      input,
      workspaceDir,
      ...(node.run.execution === undefined ? {} : { execution: node.run.execution }),
      artifact: { runId: options.runId, nodeKey, attempt: visibleAttempt, runDir: absoluteRunDir },
    },
    ...(node.timeout === undefined ? {} : { timeoutMs: parseDurationMs(node.timeout) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    registerArtifact: artifact => options.store.registerArtifact(artifact),
  });
  if (result.isErr()) throw new TaskAttemptExecutionError(result.error);
  return result.value;
}

function evaluateEnv(env: TaskNodeIR["run"]["env"], scope: EvaluationScope): Record<string, string> {
  if (!env) return {};
  return Object.fromEntries(Object.entries(env).map(([key, value]) => {
    if ("kind" in value && value.kind === "secret") throw new Error(`Task env '${key}' references an unresolved secret.`);
    return [key, stringValue(evaluateExpr(value, scope), `Task env '${key}'`)];
  }));
}

function validateExecutionOptions(node: TaskNodeIR): void {
  if (node.run.execution?.shell && node.run.execution.shell !== "bash") throw new Error(`Task node '${node.id}' execution shell '${node.run.execution.shell}' is not supported yet.`);
  if (node.run.execution?.commandRunner && node.run.execution.commandRunner !== "acpus-zx-core") throw new Error(`Task node '${node.id}' execution commandRunner '${node.run.execution.commandRunner}' is not supported yet.`);
}

function stringValue(value: unknown, label: string): string {
  if (typeof value === "string") return value;
  throw new Error(`${label} must evaluate to string.`);
}
