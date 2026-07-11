import { TASK } from "../../internal/symbols.js";
import type { Simplify } from "../../internal/type-utils.js";
import { envToIR, bindingsToIR, assertStableId, stripUndefined } from "../../graph/lowering.js";
import { valueToExprIR } from "@acpus/expression/ir";
import type { z } from "zod";
import { type Schema } from "../../schema/index.js";
import type { Resolvable } from "@acpus/expression";
import type { DiagnosticIR, TaskExecutionTargetIR, TaskNodeIR } from "../../ir/types.js";
import type { TaskFunction } from "../../runtime/task-context.js";
import type { EnvInput, RuntimeInput, StepInput } from "./shared.js";
import type { TaskOutputCheck } from "../../graph/scope.js";

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
  exec: Exec & TaskOutputCheck<Awaited<ReturnType<NoInfer<Exec>>>>;
  task?: never;
}>;

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
    exec: Exec & TaskOutputCheck<Awaited<ReturnType<NoInfer<Exec>>>>;
  }): ReusableTaskToken<z.output<InputSchema>, Awaited<ReturnType<Exec>>>;
  /** Returns true when a value is an Acpus Task token. */
  isToken(value: unknown): value is TaskToken<any, any>;
}

export const task: TaskFactory = {
  define<InputSchema extends Schema<any>, Exec extends TaskFunction<z.output<InputSchema>, any>>(config: {
    inputSchema: InputSchema;
    exec: Exec & TaskOutputCheck<Awaited<ReturnType<NoInfer<Exec>>>>;
  }) {
    type Input = z.output<InputSchema>;
    type Output = Awaited<ReturnType<Exec>>;
    return {
      [TASK]: true as const,
      kind: "external",
      fn: config.exec,
    } as ReusableTaskToken<Input, Output>;
  },
  isToken(value: unknown): value is TaskToken<any, any> {
    return Boolean(value && typeof value === "object" && (value as any)[TASK]);
  },
};

export function buildTaskNode<const Input extends StepInput>(
  id: string,
  spec: TaskStepSpec<Input>,
  diagnostics: DiagnosticIR[],
): TaskNodeIR {
  assertStableId(id, diagnostics);
  const parsed = taskSpecParts(spec);
  if (!parsed) {
    diagnostics.push({ code: "T000", severity: "error", message: `Task node '${id}' must use inline { input, exec } or reusable { input, task }.` });
  }
  return stripUndefined({
    id,
    kind: "task",
    run: parsed ? {
      input: bindingsToIR(parsed.inputBindings),
      target: taskTarget(parsed.target),
      cwd: spec.cwd === undefined ? undefined : valueToExprIR(spec.cwd),
      env: envToIR(spec.env),
      execution: spec.execution === undefined ? undefined : {
        defaultCommandTimeout: spec.execution.defaultCommandTimeout === undefined
          ? undefined
          : valueToExprIR(spec.execution.defaultCommandTimeout),
      },
    } : {
      input: {},
      target: { kind: "inline", source: "" },
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

function taskTarget(target: TaskToken<any, any>): TaskExecutionTargetIR {
  if (target.kind === "inline") return { kind: "inline", source: target.source };
  return {
    kind: "module",
    specifier: "",
    exportName: "",
    referrer: { path: "" },
  };
}
