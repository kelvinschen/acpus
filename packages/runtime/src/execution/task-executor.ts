import { isAbsolute, resolve } from "node:path";
import type { TaskNodeIR } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import { isArtifactRefCandidate, tryBindArtifactRef } from "../artifacts/access.js";
import { tryParsePersistedDeadline } from "../deadline.js";
import { tryNormalizeWorkflowData } from "../evaluation/admissible.js";
import { tryEvaluateExpr, type EvaluationScope } from "../evaluation/evaluator.js";
import { tryResolveDuration, tryResolveString, type ResolutionError } from "../evaluation/resolvable.js";
import type { RunFileToken } from "../store/run-file.js";
import type { RuntimeStore } from "../store/store.js";
import { throwSchedulerStoreResult } from "../scheduler/store-port.js";
import { runTaskAttempt, type TaskAttemptFailure } from "./task-process.js";

export type TaskExecutorOptions = {
  cwd: string;
  sourceRoot?: string;
  runId: string;
  store: Pick<RuntimeStore, "getRunDirectoryToken" | "writeExecutionMetadata" | "registerArtifact" | "getArtifact">;
  nodeKey?: string;
  attemptId: string;
  attemptNo: number;
  ownerEpoch: number;
  deadlineAt?: string;
  signal?: AbortSignal;
};

export type TaskNodeFailure = TaskAttemptFailure | {
  type: "resolution";
  error: ResolutionError;
  message: string;
};

export function executeTaskNode(node: TaskNodeIR, scope: EvaluationScope, options: TaskExecutorOptions): ResultAsync<JsonValue | undefined, TaskNodeFailure> {
  return new ResultAsync(executeTaskNodeResult(node, scope, options));
}

async function executeTaskNodeResult(node: TaskNodeIR, scope: EvaluationScope, options: TaskExecutorOptions): Promise<Result<JsonValue | undefined, TaskNodeFailure>> {
  const run = options.store.getRunDirectoryToken(options.runId);
  if (!run) throw new Error(`Run '${options.runId}' has no run directory.`);
  const workspaceDir = resolve(options.cwd);
  const input = evaluateTaskInput(node, scope);
  if (input.isErr()) return err(input.error);
  const artifactPaths = resolveTaskArtifactPaths(input.value, node.id, workspaceDir, options);
  if (artifactPaths.isErr()) return resolutionFailure(artifactPaths.error);
  const nodeKey = options.nodeKey ?? node.id;
  const authoredCwd = node.run.cwd ? tryResolveString(node.run.cwd, scope, `Task node '${node.id}' cwd`) : ok(workspaceDir);
  if (authoredCwd.isErr()) return resolutionFailure(authoredCwd.error);
  const cwd = isAbsolute(authoredCwd.value) ? authoredCwd.value : resolve(workspaceDir, authoredCwd.value);
  const evaluatedEnv = evaluateEnv(node.run.env, scope);
  if (evaluatedEnv.isErr()) return resolutionFailure(evaluatedEnv.error);
  const env: NodeJS.ProcessEnv = { ...process.env, ...evaluatedEnv.value };
  const defaultCommandTimeout = node.run.execution?.defaultCommandTimeout === undefined
    ? ok(undefined)
    : tryResolveDuration(node.run.execution.defaultCommandTimeout, scope, `Task node '${node.id}' defaultCommandTimeout`);
  if (defaultCommandTimeout.isErr()) return resolutionFailure(defaultCommandTimeout.error);
  const execution = defaultCommandTimeout.value === undefined ? undefined : { defaultCommandTimeout: defaultCommandTimeout.value.value };
  const timeoutMs = remainingTimeout(options.deadlineAt, node.id);
  if (timeoutMs.isErr()) return err(timeoutMs.error);
  const visibleAttempt = options.attemptNo;
  options.store.writeExecutionMetadata({
    runId: options.runId,
    attemptId: options.attemptId,
    kind: "task_attempt",
    metadata: {
      nodeId: node.id,
      nodeKey,
      attemptNo: visibleAttempt,
      input: input.value,
      cwd,
      env: evaluatedEnv.value,
      ...(timeoutMs.value === undefined ? {} : { timeoutMs: timeoutMs.value }),
      ...(defaultCommandTimeout.value === undefined ? {} : { defaultCommandTimeout: defaultCommandTimeout.value.value }),
    },
  });
  const runnerTimeoutMs = remainingTimeout(options.deadlineAt, node.id);
  if (runnerTimeoutMs.isErr()) return err(runnerTimeoutMs.error);

  return runTaskAttempt({
    nodeId: node.id,
    cwd,
    env,
    request: {
      target: node.run.target,
      input: input.value,
      workspaceDir,
      sourceRoot: options.sourceRoot ?? workspaceDir,
      ...(execution === undefined ? {} : { execution }),
      artifact: { run, nodeKey, attemptId: options.attemptId, attempt: visibleAttempt, ownerEpoch: options.ownerEpoch, paths: artifactPaths.value },
    },
    ...(runnerTimeoutMs.value === undefined ? {} : { timeoutMs: runnerTimeoutMs.value }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    registerArtifact: artifact => throwSchedulerStoreResult(options.store.registerArtifact(artifact)),
  });
}

function evaluateTaskInput(node: TaskNodeIR, scope: EvaluationScope): Result<JsonValue, TaskNodeFailure> {
  const field = `Task node '${node.id}' input`;
  const evaluated = tryEvaluateExpr(node.run.input, scope);
  if (evaluated.isErr()) {
    return resolutionFailure({
      type: "evaluation",
      field,
      message: evaluated.error.message,
    });
  }
  const normalized = tryNormalizeWorkflowData(evaluated.value, field);
  return normalized.isErr()
    ? resolutionFailure({ type: "evaluation", field, message: normalized.error.message })
    : ok(normalized.value as JsonValue);
}

function resolveTaskArtifactPaths(
  input: JsonValue,
  nodeId: string,
  cwd: string,
  options: TaskExecutorOptions,
): Result<Record<string, RunFileToken>, ResolutionError> {
  const paths: Record<string, RunFileToken> = {};
  const visit = (value: unknown): Result<void, ResolutionError> => {
    if (isArtifactRefCandidate(value)) {
      const resolved = tryBindArtifactRef(value, { cwd, runId: options.runId, store: options.store });
      if (resolved.isErr()) {
        return err({
          type: "evaluation",
          field: `Task node '${nodeId}' input`,
          message: resolved.error.message,
        });
      }
      paths[value.uri as string] = resolved.value;
      return ok(undefined);
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const visited = visit(item);
        if (visited.isErr()) return visited;
      }
      return ok(undefined);
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) {
        const visited = visit(item);
        if (visited.isErr()) return visited;
      }
    }
    return ok(undefined);
  };
  const visited = visit(input);
  return visited.isErr() ? err(visited.error) : ok(paths);
}

function evaluateEnv(env: TaskNodeIR["run"]["env"], scope: EvaluationScope): Result<Record<string, string>, ResolutionError> {
  if (!env) return ok({});
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const item = tryResolveString(value, scope, `Task env '${key}'`);
    if (item.isErr()) return err(item.error);
    resolved[key] = item.value;
  }
  return ok(resolved);
}

function remainingTimeout(deadlineAt: string | undefined, nodeId: string): Result<number | undefined, TaskAttemptFailure> {
  if (deadlineAt === undefined) return ok(undefined);
  const deadline = tryParsePersistedDeadline(deadlineAt);
  if (deadline.isErr()) {
    throw new Error(`Task node '${nodeId}' has invalid persisted deadline ${JSON.stringify(deadlineAt)}.`);
  }
  const remaining = deadline.value.getTime() - Date.now();
  if (!Number.isSafeInteger(remaining)) throw new Error(`Task node '${nodeId}' has an invalid remaining timeout.`);
  return remaining <= 0
    ? err({ type: "timed_out", message: `Task node '${nodeId}' exceeded its timeout.` })
    : ok(remaining);
}

function resolutionFailure(error: ResolutionError): Result<never, TaskNodeFailure> {
  return err({ type: "resolution", error, message: error.message });
}
