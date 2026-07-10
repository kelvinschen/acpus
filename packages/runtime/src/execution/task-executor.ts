import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { TaskNodeIR } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";
import { tryParsePersistedDeadline } from "../deadline.js";
import { evaluateExpr, type EvaluationScope } from "../evaluation/evaluator.js";
import { resolveOrThrow, tryResolveDuration, tryResolveString } from "../evaluation/resolvable.js";
import type { RuntimeStore } from "../store/store.js";
import { runTaskAttempt, taskAttemptFailureMessage, type TaskAttemptFailure, type TaskAttemptRunner } from "./task-process.js";

export type TaskExecutorOptions = {
  cwd: string;
  runId: string;
  store: RuntimeStore;
  nodeKey?: string;
  attemptId?: string;
  attemptNo?: number;
  deadlineAt?: string;
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
  const authoredCwd = node.run.cwd
    ? resolveOrThrow(tryResolveString(node.run.cwd, scope, `Task node '${node.id}' cwd`))
    : workspaceDir;
  const cwd = isAbsolute(authoredCwd) ? authoredCwd : resolve(workspaceDir, authoredCwd);
  const env: NodeJS.ProcessEnv = { ...process.env, ...evaluateEnv(node.run.env, scope) };
  const defaultCommandTimeout = node.run.execution?.defaultCommandTimeout === undefined
    ? undefined
    : resolveOrThrow(tryResolveDuration(node.run.execution.defaultCommandTimeout, scope, `Task node '${node.id}' defaultCommandTimeout`));
  const execution = node.run.execution === undefined ? undefined : {
    ...(node.run.execution.shell === undefined ? {} : { shell: node.run.execution.shell }),
    ...(node.run.execution.commandRunner === undefined ? {} : { commandRunner: node.run.execution.commandRunner }),
    ...(defaultCommandTimeout === undefined ? {} : { defaultCommandTimeout: defaultCommandTimeout.value }),
  };
  const metadataTimeoutMs = remainingTimeout(options.deadlineAt, node.id);
  const visibleAttempt = options.attemptNo ?? 1;
  options.store.writeExecutionMetadata({
    runId: options.runId,
    ...(options.attemptId ? { attemptId: options.attemptId } : {}),
    kind: "task_attempt",
    metadata: {
      nodeId: node.id,
      nodeKey,
      attemptNo: visibleAttempt,
      input,
      cwd,
      ...(metadataTimeoutMs === undefined ? {} : { timeoutMs: metadataTimeoutMs }),
      ...(defaultCommandTimeout === undefined ? {} : { defaultCommandTimeout: defaultCommandTimeout.value }),
    },
  });
  const attemptDir = `attempt-${visibleAttempt}`;
  await mkdir(join(absoluteRunDir, "outputs", nodeKey, attemptDir), { recursive: true });
  await mkdir(join(absoluteRunDir, "work", nodeKey, attemptDir), { recursive: true });
  const timeoutMs = remainingTimeout(options.deadlineAt, node.id);

  const result = await (options.taskAttemptRunner ?? runTaskAttempt)({
    nodeId: node.id,
    cwd,
    env,
    request: {
      target: node.run.target,
      input,
      workspaceDir,
      ...(execution === undefined ? {} : { execution }),
      artifact: { runId: options.runId, nodeKey, attempt: visibleAttempt, runDir: absoluteRunDir },
    },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
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
    return [key, resolveOrThrow(tryResolveString(value, scope, `Task env '${key}'`))];
  }));
}

function validateExecutionOptions(node: TaskNodeIR): void {
  if (node.run.execution?.shell && node.run.execution.shell !== "bash") throw new Error(`Task node '${node.id}' execution shell '${node.run.execution.shell}' is not supported yet.`);
  if (node.run.execution?.commandRunner && node.run.execution.commandRunner !== "acpus-zx-core") throw new Error(`Task node '${node.id}' execution commandRunner '${node.run.execution.commandRunner}' is not supported yet.`);
}

function remainingTimeout(deadlineAt: string | undefined, nodeId: string): number | undefined {
  if (deadlineAt === undefined) return undefined;
  const deadline = tryParsePersistedDeadline(deadlineAt);
  if (deadline.isErr()) {
    throw new Error(`Task node '${nodeId}' has invalid persisted deadline ${JSON.stringify(deadlineAt)}.`);
  }
  const remaining = deadline.value.getTime() - Date.now();
  if (!Number.isSafeInteger(remaining)) throw new Error(`Task node '${nodeId}' has an invalid remaining timeout.`);
  if (remaining <= 0) throw new TaskAttemptExecutionError({ type: "timed_out", message: `Task node '${nodeId}' exceeded its timeout.` });
  return remaining;
}
