import type { Dollar, TaskContext } from "@acpus/core/runtime";
import type { JsonValue } from "@acpus/expression/ir";
import { ResultAsync } from "neverthrow";
import { normalizeWorkflowData } from "../../src/evaluation/admissible.js";
import { loadInlineTaskFunction } from "../../src/execution/inline-task.js";
import type { RunTaskAttemptInput, TaskAttemptFailure, TaskAttemptRunner } from "../../src/execution/task-process.js";

export type InlineTaskAttemptCall = {
  nodeId: string;
  nodeKey: string;
  attempt: number;
  input: Record<string, JsonValue>;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export function createInlineTaskAttemptHarness(): {
  runAttempt: TaskAttemptRunner;
  calls: InlineTaskAttemptCall[];
} {
  const calls: InlineTaskAttemptCall[] = [];
  const runAttempt: TaskAttemptRunner = input => {
    calls.push({
      nodeId: input.nodeId,
      nodeKey: input.request.artifact.nodeKey,
      attempt: input.request.artifact.attempt,
      input: structuredClone(input.request.input),
      cwd: input.cwd,
      env: { ...input.env },
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    assertHarnessTarget(input);
    return ResultAsync.fromPromise(executeInlineTask(input), error => {
      if (error instanceof InlineTaskAttemptHarnessMisuseError) throw error;
      return input.signal?.aborted ? cancelledFailure(input.nodeId) : taskFailure(error);
    });
  };
  return { runAttempt, calls };
}

async function executeInlineTask(input: RunTaskAttemptInput): Promise<JsonValue | undefined> {
  assertNotAborted(input);
  const target = input.request.target;
  if (target.kind !== "inline") throw new InlineTaskAttemptHarnessMisuseError("module task targets");
  const fn = await loadInlineTaskFunction(target.source);
  assertNotAborted(input);
  const output = await fn({
    input: input.request.input,
    $: unsupported<Dollar>("the Task $ command runner"),
    artifact: unsupported<TaskContext<unknown>["artifact"]>("the Task artifact API"),
    env: input.env,
    abortSignal: input.signal ?? new AbortController().signal,
  } satisfies TaskContext<typeof input.request.input>);
  assertNotAborted(input);
  const normalized = normalizeWorkflowData(output, "Task output", { allowTopLevelUndefined: true });
  assertNotAborted(input);
  return normalized;
}

function assertHarnessTarget(input: RunTaskAttemptInput): void {
  const target = input.request.target;
  if (target.kind !== "inline") throw new InlineTaskAttemptHarnessMisuseError("module task targets");
  if (/\bprocess\b/.test(target.source)) throw new InlineTaskAttemptHarnessMisuseError("process.cwd/process.env semantics");
}

function assertNotAborted(input: RunTaskAttemptInput): void {
  if (input.signal?.aborted) throw new TaskAttemptHarnessCancelledError();
}

function unsupported<T>(feature: string): T {
  const fail = () => { throw new InlineTaskAttemptHarnessMisuseError(feature); };
  return new Proxy(fail, { apply: fail, get: fail }) as T;
}

function cancelledFailure(nodeId: string): TaskAttemptFailure {
  return { type: "cancelled", message: `Task node '${nodeId}' was cancelled.` };
}

function taskFailure(error: unknown): TaskAttemptFailure {
  if (!(error instanceof Error)) return { type: "task", name: "Error", message: String(error) };
  return {
    type: "task",
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
  };
}

class InlineTaskAttemptHarnessMisuseError extends Error {
  constructor(feature: string) {
    super(`Inline task attempt harness cannot exercise ${feature}; use a real-process integration test.`);
  }
}

class TaskAttemptHarnessCancelledError extends Error {}
