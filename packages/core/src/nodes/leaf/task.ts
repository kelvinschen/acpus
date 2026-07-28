import { TASK } from "../../internal/symbols.js";
import type { Simplify } from "../../internal/type-utils.js";
import { envToIR, bindingsToIR, stripUndefined } from "../../graph/lowering.js";
import { valueToExprIR } from "@acpus/expression/ir";
import type { z } from "zod";
import { type Schema } from "../../schema/index.js";
import type { Resolvable } from "@acpus/expression";
import type { TaskExecutionTargetIR, TaskNodeIR } from "../../ir/types.js";
import type { TaskFunction } from "../../runtime/task-context.js";
import type { EnvInput, RuntimeInput, StepInput } from "./shared.js";
import type { TaskOutputCheck } from "../../graph/scope.js";
import { isRootedPath } from "../../internal/path.js";

type BaseTaskToken<Input, Output> = {
  readonly [TASK]: true;
  readonly fn: TaskFunction<Input, Output>;
};

type InlineTaskToken<Input, Output> = BaseTaskToken<Input, Output> & {
  readonly kind: "inline";
  readonly source: string;
  readonly outputSchema?: undefined;
};

export type ReusableTaskToken<Input, Output> = BaseTaskToken<Input, Output> & {
  readonly kind: "external";
};

export type TaskToken<Input, Output> =
  | InlineTaskToken<Input, Output>
  | ReusableTaskToken<Input, Output>;

export type ReusableTaskLink = Readonly<{
  specifier: string;
  exportName: string;
}>;

export type ReusableTaskLinkPlan = Readonly<{
  referrerPath: string;
  targets: ReadonlyMap<string, ReusableTaskLink>;
}>;

export type TaskCompilationFailure =
  | {
      type: "invalid-task-spec";
      nodeId: string;
      message: string;
    }
  | {
      type: "reusable-task-target-missing";
      nodeId: string;
      message: string;
    }
  | {
      type: "reusable-task-target-invalid";
      nodeId: string;
      field: "specifier" | "exportName" | "referrerPath";
      message: string;
    };

export class TaskCompilationAbort extends Error {
  constructor(readonly failure: TaskCompilationFailure) {
    super(failure.message);
  }
}

type TaskStepOptions = {
  cwd?: Resolvable<string>;
  env?: EnvInput;
  execution?: {
    defaultCommandTimeout?: Resolvable<string>;
  };
};

type TaskNodeOptions = {
  timeout?: Resolvable<string>;
};

export type InlineTaskStepSpec<
  Input extends StepInput,
  Exec extends TaskFunction<RuntimeInput<Input>, any> = TaskFunction<RuntimeInput<Input>, any>,
> = Simplify<TaskNodeOptions & TaskStepOptions & {
  outputSchema?: never;
  input: Input;
  exec: Exec & TaskOutputCheck<TaskResult<NoInfer<Exec>>>;
  task?: never;
}>;

export type TaskResult<Exec extends (...args: any[]) => any> =
  0 extends (1 & Awaited<ReturnType<Exec>>) ? never : Awaited<ReturnType<Exec>>;

export type ReusableTaskStepSpec<Input extends StepInput, TaskInput, Output> = Simplify<TaskNodeOptions & TaskStepOptions & {
  outputSchema?: never;
  input: Input;
  task: ReusableTaskToken<TaskInput, Output>;
  exec?: never;
}>;

export type TaskStepSpec<Input extends StepInput> =
  | InlineTaskStepSpec<Input>
  | ReusableTaskStepSpec<Input, any, any>;

type ValidTaskSpec<Input extends StepInput> = {
  target: TaskToken<RuntimeInput<Input>, any>;
  inputBindings: StepInput;
};

function createInlineTaskToken<Input, Output>(fn: TaskFunction<Input, Output>): InlineTaskToken<Input, Output> {
  return {
    [TASK]: true as const,
    kind: "inline",
    fn,
    source: fn.toString(),
  };
}

export interface TaskFactory {
  /**
   * Defines a reusable Task token for workflow modules.
   *
   * The task definition owns its input schema and executable body. Workflow
   * Call sites pass values through `input` and reference the token through
   * `task`.
   */
  define<InputSchema extends Schema<any>, Exec extends TaskFunction<z.output<InputSchema>, any>>(config: {
    inputSchema: InputSchema;
    outputSchema?: never;
    exec: Exec & TaskOutputCheck<TaskResult<NoInfer<Exec>>>;
  }): ReusableTaskToken<z.output<InputSchema>, TaskResult<Exec>>;
  /** Returns true when a value is an Acpus Task token. */
  isToken(value: unknown): value is TaskToken<any, any>;
}

export const task: TaskFactory = {
  define: ((config: { inputSchema: Schema<any>; exec: TaskFunction<any, any> }) => {
    return {
      [TASK]: true as const,
      kind: "external",
      fn: config.exec,
    };
  }) as TaskFactory["define"],
  isToken(value: unknown): value is TaskToken<any, any> {
    return Boolean(value && typeof value === "object" && (value as any)[TASK]);
  },
};

export function buildTaskNode<const Input extends StepInput>(
  id: string,
  spec: TaskStepSpec<Input>,
  links: ReusableTaskLinkPlan | undefined,
): TaskNodeIR {
  const parsed = taskSpecParts(spec);
  if (!parsed) {
    throw new TaskCompilationAbort({
      type: "invalid-task-spec",
      nodeId: id,
      message: `Task node '${id}' must use inline { input, exec } or reusable { input, task }.`,
    });
  }
  return stripUndefined({
    id,
    kind: "task",
    run: {
      input: bindingsToIR(parsed.inputBindings),
      target: taskTarget(id, parsed.target, links),
      cwd: spec.cwd === undefined ? undefined : valueToExprIR(spec.cwd),
      env: envToIR(spec.env),
      execution: spec.execution === undefined ? undefined : {
        defaultCommandTimeout: spec.execution.defaultCommandTimeout === undefined
          ? undefined
          : valueToExprIR(spec.execution.defaultCommandTimeout),
      },
    },
    timeout: spec.timeout === undefined ? undefined : valueToExprIR(spec.timeout),
  }) as TaskNodeIR;
}

function taskSpecParts<const Input extends StepInput>(spec: TaskStepSpec<Input>): ValidTaskSpec<Input> | undefined {
  const maybeExec = (spec as { exec?: unknown }).exec;
  if (typeof maybeExec === "function") {
    const inlineSpec = spec as InlineTaskStepSpec<Input>;
    return {
      target: createInlineTaskToken(inlineSpec.exec),
      inputBindings: inlineSpec.input,
    };
  }
  const maybeTask = (spec as { task?: unknown }).task;
  if (task.isToken(maybeTask)) {
    const reusableSpec = spec as ReusableTaskStepSpec<Input, any, any>;
    return {
      target: reusableSpec.task,
      inputBindings: reusableSpec.input,
    };
  }
  return undefined;
}

function taskTarget(
  id: string,
  target: TaskToken<any, any>,
  links: ReusableTaskLinkPlan | undefined,
): TaskExecutionTargetIR {
  if (target.kind === "inline") return { kind: "inline", source: target.source };
  if (!links) missingLink(id);
  const link = links.targets.get(id);
  if (!link) missingLink(id);
  assertNonEmptyLinkField(id, "specifier", link.specifier);
  assertNonEmptyLinkField(id, "exportName", link.exportName);
  const referrerPath = links.referrerPath;
  if (typeof referrerPath !== "string" || referrerPath.length === 0) {
    invalidLink(id, "referrerPath", "Reusable Task referrer path must be a non-empty string.");
  }
  if (isRootedPath(referrerPath)) {
    invalidLink(id, "referrerPath", "Reusable Task referrer path must be source-root-relative.");
  }
  if (referrerPath.split(/[\\/]/).includes("..")) {
    invalidLink(id, "referrerPath", "Reusable Task referrer path must stay inside the source root.");
  }
  return {
    kind: "module",
    specifier: link.specifier,
    exportName: link.exportName,
    referrer: { path: referrerPath },
  };
}

function missingLink(nodeId: string): never {
  throw new TaskCompilationAbort({
    type: "reusable-task-target-missing",
    nodeId,
    message: `Reusable Task node '${nodeId}' requires source link metadata; compile the workflow module through @acpus/workflow-compiler or provide reusableTasks.`,
  });
}

function assertNonEmptyLinkField(
  id: string,
  field: "specifier" | "exportName",
  value: unknown,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    invalidLink(id, field, `Reusable Task ${field} must be a non-empty string.`);
  }
}

function invalidLink(
  nodeId: string,
  field: Extract<TaskCompilationFailure, { type: "reusable-task-target-invalid" }>["field"],
  message: string,
): never {
  throw new TaskCompilationAbort({
    type: "reusable-task-target-invalid",
    nodeId,
    field,
    message,
  });
}
