import { isAbsolute, resolve } from "node:path";
import type { TaskNodeIR } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";
import type { ProcessHostShape } from "@acpus/owned-process";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { isArtifactRefCandidate } from "../artifacts/access.js";
import { tryParsePersistedDeadline } from "../deadline.js";
import { tryNormalizeWorkflowData } from "../evaluation/admissible.js";
import { tryEvaluateExpr, type EvaluationScope } from "../evaluation/evaluator.js";
import { tryResolveDuration, tryResolveString, type ResolutionError } from "../evaluation/resolvable.js";
import type { RunFileToken } from "../store/run-file.js";
import type { RuntimeStoreBusy, RuntimeStoreShape } from "../store/service.js";
import type { SchedulerStoreError } from "../scheduler/store-port.js";
import { runTaskAttempt, type TaskAttemptFailure } from "./task-process.js";

export type TaskExecutorOptions = {
  cwd: string;
  sourceRoot?: string;
  runId: string;
  store: Pick<RuntimeStoreShape, "getRunDirectoryToken" | "writeExecutionMetadata" | "registerArtifact" | "resolveArtifactRef">;
  processes: ProcessHostShape;
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

type TaskExecutorStoreFailure = RuntimeStoreBusy | SchedulerStoreError;

export function executeTaskNode(
  node: TaskNodeIR,
  scope: EvaluationScope,
  options: TaskExecutorOptions,
): Effect.Effect<Result.Result<JsonValue | undefined, TaskNodeFailure>, TaskExecutorStoreFailure> {
  const execution = executeTaskNodeResult(node, scope, options);
  return options.signal === undefined
    ? execution
    : Effect.raceFirst(execution, externalCancellation(options.signal, node.id));
}

function executeTaskNodeResult(
  node: TaskNodeIR,
  scope: EvaluationScope,
  options: TaskExecutorOptions,
): Effect.Effect<Result.Result<JsonValue | undefined, TaskNodeFailure>, TaskExecutorStoreFailure> {
  return Effect.gen(function* () {
  const run = yield* options.store.getRunDirectoryToken(options.runId);
  if (!run) throw new Error(`Run '${options.runId}' has no run directory.`);
  const workspaceDir = resolve(options.cwd);
  const input = evaluateTaskInput(node, scope);
  if (Result.isFailure(input)) return Result.fail(input.failure);
  const artifactPaths = yield* resolveTaskArtifactPaths(input.success, node.id, options);
  if (Result.isFailure(artifactPaths)) return resolutionFailure(artifactPaths.failure);
  const nodeKey = options.nodeKey ?? node.id;
  const authoredCwd = node.run.cwd ? tryResolveString(node.run.cwd, scope, `Task node '${node.id}' cwd`) : Result.succeed(workspaceDir);
  if (Result.isFailure(authoredCwd)) return resolutionFailure(authoredCwd.failure);
  const cwd = isAbsolute(authoredCwd.success) ? authoredCwd.success : resolve(workspaceDir, authoredCwd.success);
  const evaluatedEnv = evaluateEnv(node.run.env, scope);
  if (Result.isFailure(evaluatedEnv)) return resolutionFailure(evaluatedEnv.failure);
  const env: NodeJS.ProcessEnv = { ...process.env, ...evaluatedEnv.success };
  const defaultCommandTimeout = node.run.execution?.defaultCommandTimeout === undefined
    ? Result.succeed(undefined)
    : tryResolveDuration(node.run.execution.defaultCommandTimeout, scope, `Task node '${node.id}' defaultCommandTimeout`);
  if (Result.isFailure(defaultCommandTimeout)) return resolutionFailure(defaultCommandTimeout.failure);
  const execution = defaultCommandTimeout.success === undefined ? undefined : { defaultCommandTimeout: defaultCommandTimeout.success.value };
  const timeoutMs = remainingTimeout(options.deadlineAt, node.id, yield* Clock.currentTimeMillis);
  if (Result.isFailure(timeoutMs)) return Result.fail(timeoutMs.failure);
  const visibleAttempt = options.attemptNo;
  yield* options.store.writeExecutionMetadata({
    runId: options.runId,
    attemptId: options.attemptId,
    ownerEpoch: options.ownerEpoch,
    kind: "task_attempt",
    metadata: {
      nodeId: node.id,
      nodeKey,
      attemptNo: visibleAttempt,
      input: input.success,
      cwd,
      env: evaluatedEnv.success,
      ...(timeoutMs.success === undefined ? {} : { timeoutMs: timeoutMs.success }),
      ...(defaultCommandTimeout.success === undefined ? {} : { defaultCommandTimeout: defaultCommandTimeout.success.value }),
    },
  });
  const runnerTimeoutMs = remainingTimeout(options.deadlineAt, node.id, yield* Clock.currentTimeMillis);
  if (Result.isFailure(runnerTimeoutMs)) return Result.fail(runnerTimeoutMs.failure);

  return yield* runTaskAttempt({
    nodeId: node.id,
    cwd,
    env,
    request: {
      target: node.run.target,
      input: input.success,
      workspaceDir,
      sourceRoot: options.sourceRoot ?? workspaceDir,
      ...(execution === undefined ? {} : { execution }),
      artifact: { run, nodeKey, attemptId: options.attemptId, attempt: visibleAttempt, ownerEpoch: options.ownerEpoch, paths: artifactPaths.success },
    },
    ...(runnerTimeoutMs.success === undefined ? {} : { timeoutMs: runnerTimeoutMs.success }),
    processes: options.processes,
    store: options.store,
  });
  });
}

function evaluateTaskInput(node: TaskNodeIR, scope: EvaluationScope): Result.Result<JsonValue, TaskNodeFailure> {
  const field = `Task node '${node.id}' input`;
  const evaluated = tryEvaluateExpr(node.run.input, scope);
  if (Result.isFailure(evaluated)) {
    return resolutionFailure({
      type: "evaluation",
      field,
      message: evaluated.failure.message,
    });
  }
  const normalized = tryNormalizeWorkflowData(evaluated.success, field);
  return Result.isFailure(normalized)
    ? resolutionFailure({ type: "evaluation", field, message: normalized.failure.message })
    : Result.succeed(normalized.success as JsonValue);
}

function resolveTaskArtifactPaths(
  input: JsonValue,
  nodeId: string,
  options: TaskExecutorOptions,
): Effect.Effect<Result.Result<Record<string, RunFileToken>, ResolutionError>, RuntimeStoreBusy> {
  const paths: Record<string, RunFileToken> = {};
  const visit = (value: unknown): Effect.Effect<Result.Result<void, ResolutionError>, RuntimeStoreBusy> => Effect.gen(function* () {
    if (isArtifactRefCandidate(value)) {
      const resolved = yield* Effect.result(options.store.resolveArtifactRef(value, options.runId));
      if (Result.isFailure(resolved) && resolved.failure.type === "runtime-store-busy") {
        return yield* Effect.fail(resolved.failure);
      }
      if (Result.isFailure(resolved)) {
        return Result.fail({
          type: "evaluation",
          field: `Task node '${nodeId}' input`,
          message: resolved.failure.message,
        });
      }
      paths[value.uri as string] = resolved.success.file;
      return Result.succeed(undefined);
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const visited = yield* visit(item);
        if (Result.isFailure(visited)) return visited;
      }
      return Result.succeed(undefined);
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) {
        const visited = yield* visit(item);
        if (Result.isFailure(visited)) return visited;
      }
    }
    return Result.succeed(undefined);
  });
  return Effect.gen(function* () {
    const visited = yield* visit(input);
    return Result.isFailure(visited) ? Result.fail(visited.failure) : Result.succeed(paths);
  });
}

function evaluateEnv(env: TaskNodeIR["run"]["env"], scope: EvaluationScope): Result.Result<Record<string, string>, ResolutionError> {
  if (!env) return Result.succeed({});
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const item = tryResolveString(value, scope, `Task env '${key}'`);
    if (Result.isFailure(item)) return Result.fail(item.failure);
    resolved[key] = item.success;
  }
  return Result.succeed(resolved);
}

function remainingTimeout(deadlineAt: string | undefined, nodeId: string, now: number): Result.Result<number | undefined, TaskAttemptFailure> {
  if (deadlineAt === undefined) return Result.succeed(undefined);
  const deadline = tryParsePersistedDeadline(deadlineAt);
  if (Result.isFailure(deadline)) {
    throw new Error(`Task node '${nodeId}' has invalid persisted deadline ${JSON.stringify(deadlineAt)}.`);
  }
  const remaining = deadline.success.getTime() - now;
  if (!Number.isSafeInteger(remaining)) throw new Error(`Task node '${nodeId}' has an invalid remaining timeout.`);
  return remaining <= 0
    ? Result.fail({ type: "timed_out", message: `Task node '${nodeId}' exceeded its timeout.` })
    : Result.succeed(remaining);
}

function resolutionFailure(error: ResolutionError): Result.Result<never, TaskNodeFailure> {
  return Result.fail({ type: "resolution", error, message: error.message });
}

function externalCancellation(
  signal: AbortSignal,
  nodeId: string,
): Effect.Effect<Result.Result<never, TaskNodeFailure>> {
  return Effect.callback(resume => {
    const cancel = () => resume(Effect.succeed(Result.fail({
      type: "cancelled",
      message: `Task node '${nodeId}' was cancelled.`,
    })));
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", cancel));
  });
}
