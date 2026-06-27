import { createHash } from "node:crypto";
import { TASK } from "../../internal/symbols.js";
import { envToIR, inputsToIR, assertStableId, stripUndefined } from "../../graph/lowering.js";
import { valueToExprIR } from "../../expressions/expr.js";
import { toSchemaIR, type InferSchema, type Schema } from "../../schema/index.js";
import type { DiagnosticIR, JsonObject, RetryIR, TaskBundleIR, TaskNodeIR } from "../../ir/types.js";
import type { TaskFunction } from "../../runtime/task-context.js";
import type { RuntimeInput, StepInput } from "./shared.js";

type BaseTaskToken<Input, Output, Params extends JsonObject> = {
  readonly [TASK]: true;
  readonly params?: Params;
  readonly fn: TaskFunction<Input, Output, Params>;
  readonly source: string;
  readonly bundleId: string;
  readonly digest: string;
  toBundleIR(): TaskBundleIR;
};

export type InlineTaskToken<Input = any, Output = any, Params extends JsonObject = JsonObject> = BaseTaskToken<Input, Output, Params> & {
  readonly kind: "inline";
  readonly input?: undefined;
  readonly output?: undefined;
};

export type ReusableTaskToken<Input = any, Output = any, Params extends JsonObject = JsonObject> = BaseTaskToken<Input, Output, Params> & {
  readonly kind: "external";
  readonly input: Schema<Input>;
  readonly output: Schema<Output>;
};

export type TaskToken<Input = any, Output = any, Params extends JsonObject = JsonObject> =
  | InlineTaskToken<Input, Output, Params>
  | ReusableTaskToken<Input, Output, Params>;

type TaskStepOptions = {
  params?: JsonObject;
  cwd?: unknown;
  env?: Record<string, unknown>;
  timeout?: string;
  retry?: RetryIR;
  execution?: {
    shell?: "bash" | "powershell" | "pwsh";
    defaultCommandTimeout?: string;
    commandRunner?: "acpus-zx-core" | "custom";
  };
};

export type InlineTaskStepSpec<Input extends StepInput, OutSchema extends Schema<any>> = TaskStepOptions & {
  input: Input;
  output: OutSchema;
  run: TaskFunction<RuntimeInput<Input>, InferSchema<OutSchema>, any>;
};

export type ReusableTaskStepSpec<Input extends StepInput, TaskInput, Output> = TaskStepOptions & {
  input: Input;
  output?: never;
  run: ReusableTaskToken<TaskInput, Output, any>;
};

export type TaskStepSpec<Input extends StepInput, OutSchema extends Schema<any> = Schema<any>> =
  | InlineTaskStepSpec<Input, OutSchema>
  | ReusableTaskStepSpec<Input, any, any>;

function digest(source: string): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function makeTaskToken<Input, Output, Params extends JsonObject>(args: {
  kind: "inline" | "external";
  input?: Schema<Input>;
  output?: Schema<Output>;
  params?: Params;
  fn: TaskFunction<Input, Output, Params>;
  sourcePrefix?: string;
}): TaskToken<Input, Output, Params> {
  const source = `${args.sourcePrefix ?? ""}${args.fn.toString()}`;
  const hash = digest(source);
  const bundleId = `task_${hash.slice("sha256:".length, "sha256:".length + 16)}`;
  return {
    [TASK]: true as const,
    kind: args.kind,
    input: args.input,
    output: args.output,
    params: args.params,
    fn: args.fn,
    source,
    digest: hash,
    bundleId,
    toBundleIR() {
      return {
        id: bundleId,
        digest: hash,
        runtime: "node",
        source,
        inline: args.kind === "inline",
        note: "Core-alpha records Function#toString as a task source placeholder. Production must AST-extract and bundle task functions.",
      };
    },
  } as TaskToken<Input, Output, Params>;
}

export function createInlineTaskToken<Input, Output, Params extends JsonObject = JsonObject>(fn: TaskFunction<Input, Output, Params>): InlineTaskToken<Input, Output, Params> {
  return makeTaskToken({ kind: "inline", fn }) as InlineTaskToken<Input, Output, Params>;
}

export interface TaskFactory {
  define<InputSchema extends Schema<any>, OutputSchema extends Schema<any>>(config: { input: InputSchema; output: OutputSchema }): {
    input: InputSchema;
    output: OutputSchema;
    run(fn: TaskFunction<InferSchema<InputSchema>, InferSchema<OutputSchema>>): ReusableTaskToken<InferSchema<InputSchema>, InferSchema<OutputSchema>>;
  };
  isToken(value: unknown): value is TaskToken<any, any, any>;
}

export const task: TaskFactory = {
  define<InputSchema extends Schema<any>, OutputSchema extends Schema<any>>(config: { input: InputSchema; output: OutputSchema }) {
    type Input = InferSchema<InputSchema>;
    type Output = InferSchema<OutputSchema>;
    return {
      input: config.input,
      output: config.output,
      run(fn: TaskFunction<Input, Output>): ReusableTaskToken<Input, Output> {
        return makeTaskToken({ kind: "external", input: config.input, output: config.output, fn }) as ReusableTaskToken<Input, Output>;
      },
    };
  },
  isToken(value: unknown): value is TaskToken<any, any, any> {
    return Boolean(value && typeof value === "object" && (value as any)[TASK]);
  },
};

export function buildTaskNode<const Input extends StepInput>(
  id: string,
  spec: TaskStepSpec<Input>,
  taskBundles: Record<string, TaskBundleIR>,
  diagnostics: DiagnosticIR[],
): TaskNodeIR {
  assertStableId(id, diagnostics);
  let run: TaskToken<RuntimeInput<Input>, any, any>;
  let outputSchema: Schema<any>;
  if (typeof spec.run === "function") {
    const inlineSpec = spec as InlineTaskStepSpec<Input, Schema<any>>;
    run = createInlineTaskToken(inlineSpec.run);
    outputSchema = inlineSpec.output;
  } else {
    run = spec.run;
    outputSchema = spec.run.output;
  }
  if (!task.isToken(run)) {
    diagnostics.push({ code: "T000", severity: "error", message: `Task node '${id}' must use run: async ctx => ... or a task.define(...).run(...) token.` });
  }
  const bundle = run.toBundleIR();
  taskBundles[bundle.id] = bundle;
  return stripUndefined({
    id,
    kind: "task",
    inputs: inputsToIR(spec.input),
    outputSchema: toSchemaIR(outputSchema),
    run: {
      kind: "task_run",
      bundleId: bundle.id,
      exportName: "default",
      digest: bundle.digest,
      runtime: "node",
      inline: run.kind === "inline",
    },
    params: spec.params ?? run.params,
    cwd: spec.cwd === undefined ? undefined : valueToExprIR(spec.cwd),
    env: envToIR(spec.env),
    execution: spec.execution,
    timeout: spec.timeout,
    retry: spec.retry,
  }) as TaskNodeIR;
}
