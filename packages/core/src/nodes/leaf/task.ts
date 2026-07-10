import { TASK } from "../../internal/symbols.js";
import type { Simplify } from "../../internal/type-utils.js";
import { envToIR, bindingsToIR, assertStableId, stripUndefined } from "../../graph/lowering.js";
import { valueToExprIR } from "@acpus/expression/ir";
import type { z } from "zod";
import { type Schema } from "../../schema/index.js";
import type { WorkflowValue } from "@acpus/expression";
import type { DiagnosticIR, TaskExecutionTargetIR, TaskNodeIR } from "../../ir/types.js";
import type { TaskFunction } from "../../runtime/task-context.js";
import type { EnvInput, RuntimeInput, StepInput } from "./shared.js";

type BaseTaskToken<Input, Output> = {
  readonly [TASK]: true;
  readonly fn: TaskFunction<Input, Output>;
  readonly source: string;
};

export type InlineTaskToken<Input, Output> = BaseTaskToken<Input, Output> & {
  readonly kind: "inline";
  readonly inputSchema?: undefined;
  readonly outputSchema?: undefined;
};

export type ReusableTaskToken<Input, Output> = BaseTaskToken<Input, Output> & {
  readonly kind: "external";
  readonly inputSchema: Schema<Input>;
};

export type TaskToken<Input, Output> =
  | InlineTaskToken<Input, Output>
  | ReusableTaskToken<Input, Output>;

type TaskStepOptions = {
  cwd?: WorkflowValue<string>;
  env?: EnvInput;
  execution?: {
    shell?: "bash" | "powershell" | "pwsh";
    defaultCommandTimeout?: string;
    commandRunner?: "acpus-zx-core" | "custom";
  };
};

type TaskNodeOptions = {
  timeout?: string;
  retry?: never;
};

export type InlineTaskStepSpec<
  Input extends StepInput,
  Exec extends TaskFunction<RuntimeInput<Input>, any> = TaskFunction<RuntimeInput<Input>, any>,
> = Simplify<TaskNodeOptions & {
  outputSchema?: never;
  run: TaskStepOptions & {
    input: Input;
    exec: Exec;
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

function makeTaskToken<Input, Output>(args: {
  kind: "inline" | "external";
  inputSchema?: Schema<Input>;
  fn: TaskFunction<Input, Output>;
}): TaskToken<Input, Output> {
  const source = args.fn.toString();
  return {
    [TASK]: true as const,
    kind: args.kind,
    inputSchema: args.inputSchema,
    fn: args.fn,
    source,
  } as TaskToken<Input, Output>;
}

export function createInlineTaskToken<Input, Output>(fn: TaskFunction<Input, Output>): InlineTaskToken<Input, Output> {
  return makeTaskToken({ kind: "inline", fn }) as InlineTaskToken<Input, Output>;
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
    exec: Exec;
  }): ReusableTaskToken<z.output<InputSchema>, Awaited<ReturnType<Exec>>>;
  /** Returns true when a value is an Acpus Task token. */
  isToken(value: unknown): value is TaskToken<any, any>;
}

export const task: TaskFactory = {
  define<InputSchema extends Schema<any>, Exec extends TaskFunction<z.output<InputSchema>, any>>(config: {
    inputSchema: InputSchema;
    exec: Exec;
  }) {
    type Input = z.output<InputSchema>;
    type Output = Awaited<ReturnType<Exec>>;
    return makeTaskToken({
      kind: "external",
      inputSchema: config.inputSchema,
      fn: config.exec,
    }) as ReusableTaskToken<Input, Output>;
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
  if ((spec as { retry?: unknown }).retry !== undefined) {
    diagnostics.push({ code: "IR001", severity: "error", message: `Task node '${id}' does not support workflow-level automatic retry.`, path: `root.nodes.${id}.retry` });
  }
  const parsed = taskSpecParts(spec);
  if (!parsed) {
    diagnostics.push({ code: "T000", severity: "error", message: `Task node '${id}' must use inline { run: { input, exec } } or reusable { run: { input, task } }.` });
  }
  return stripUndefined({
    id,
    kind: "task",
    run: parsed ? {
      kind: "task_run",
      input: bindingsToIR(parsed.inputBindings),
      target: taskTarget(parsed.run),
      cwd: parsed.runOptions.cwd === undefined ? undefined : valueToExprIR(parsed.runOptions.cwd),
      env: envToIR(parsed.runOptions.env),
      execution: parsed.runOptions.execution,
    } : {
      kind: "task_run",
      input: {},
      target: { kind: "inline", runtime: "node", source: "" },
    },
    timeout: spec.timeout,
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
  if (run.kind === "inline") return { kind: "inline", runtime: "node", source: run.source };
  return {
    kind: "module",
    runtime: "node",
    specifier: "",
    exportName: "",
    referrer: { kind: "workflow", path: "" },
  };
}
