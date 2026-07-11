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
> = Simplify<TaskNodeOptions & {
  outputSchema?: never;
  run: TaskStepOptions & {
    input: Input;
    exec: Exec & TaskOutputCheck<Awaited<ReturnType<NoInfer<Exec>>>>;
  };
}>;

export type ReusableTaskStepSpec<Input extends StepInput, TaskInput, Output> = Simplify<TaskNodeOptions & {
  outputSchema?: never;
  run: TaskStepOptions & {
    input: Input;
    task: ReusableTaskToken<TaskInput, Output>;
  };
}>;

export type TaskStepSpec<Input extends StepInput> =
  | InlineTaskStepSpec<Input>
  | ReusableTaskStepSpec<Input, any, any>;

type ValidTaskSpec<Input extends StepInput> = {
  run: TaskToken<RuntimeInput<Input>, any>;
  inputBindings: StepInput;
  runOptions: TaskStepOptions;
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
   * call sites pass values through `run.input` and reference the token through
   * `run.task`.
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
    diagnostics.push({ code: "T000", severity: "error", message: `Task node '${id}' must use inline { run: { input, exec } } or reusable { run: { input, task } }.` });
  }
  return stripUndefined({
    id,
    kind: "task",
    run: parsed ? {
      input: bindingsToIR(parsed.inputBindings),
      target: taskTarget(parsed.run),
      cwd: parsed.runOptions.cwd === undefined ? undefined : valueToExprIR(parsed.runOptions.cwd),
      env: envToIR(parsed.runOptions.env),
      execution: parsed.runOptions.execution === undefined ? undefined : {
        defaultCommandTimeout: parsed.runOptions.execution.defaultCommandTimeout === undefined
          ? undefined
          : valueToExprIR(parsed.runOptions.execution.defaultCommandTimeout),
      },
    } : {
      input: {},
      target: { kind: "inline", source: "" },
    },
    timeout: spec.timeout === undefined ? undefined : valueToExprIR(spec.timeout),
  }) as TaskNodeIR;
}

function taskSpecParts<const Input extends StepInput>(spec: TaskStepSpec<Input>): ValidTaskSpec<Input> | undefined {
  const maybeRun = (spec as { run?: unknown }).run;
  if (maybeRun && typeof maybeRun === "object" && "exec" in maybeRun) {
    const inlineSpec = spec as InlineTaskStepSpec<Input>;
    return {
      run: createInlineTaskToken(inlineSpec.run.exec),
      inputBindings: inlineSpec.run.input,
      runOptions: inlineSpec.run,
    };
  } else if (maybeRun && typeof maybeRun === "object" && "task" in maybeRun && task.isToken(maybeRun.task)) {
    const reusableSpec = spec as ReusableTaskStepSpec<Input, any, any>;
    return {
      run: reusableSpec.run.task,
      inputBindings: reusableSpec.run.input,
      runOptions: reusableSpec.run,
    };
  }
  return undefined;
}

function taskTarget(run: TaskToken<any, any>): TaskExecutionTargetIR {
  if (run.kind === "inline") return { kind: "inline", source: run.source };
  return {
    kind: "module",
    specifier: "",
    exportName: "",
    referrer: { path: "" },
  };
}
