import { createHash } from "node:crypto";
import { TASK } from "../../internal/symbols.js";
import { envToIR, inputsToIR, assertStableId, stripUndefined } from "../../graph/lowering.js";
import { valueToExprIR } from "../../expressions/expr.js";
import { toSchemaIR, type InferSchema, type Schema } from "../../schema/index.js";
import type { DiagnosticIR, JsonObject, RetryIR, TaskBundleIR, TaskNodeIR } from "../../ir/types.js";
import type { TaskFunction } from "../../runtime/task-context.js";
import type { RuntimeInput, StepInput } from "./shared.js";

export type TaskToken<Input = any, Output = any, Params extends JsonObject = JsonObject> = {
  readonly [TASK]: true;
  readonly kind: "inline" | "external";
  readonly input?: Schema<Input>;
  readonly output?: Schema<Output>;
  readonly params?: Params;
  readonly fn: TaskFunction<Input, Output, Params>;
  readonly source: string;
  readonly bundleId: string;
  readonly digest: string;
  toBundleIR(): TaskBundleIR;
};

export type TaskStepSpec<Input extends StepInput, OutSchema extends Schema<any>> = {
  input: Input;
  output: OutSchema;
  run: TaskFunction<RuntimeInput<Input>, InferSchema<OutSchema>, any> | TaskToken<RuntimeInput<Input>, InferSchema<OutSchema>, any>;
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

export function createInlineTaskToken<Input, Output, Params extends JsonObject = JsonObject>(fn: TaskFunction<Input, Output, Params>): TaskToken<Input, Output, Params> {
  return makeTaskToken({ kind: "inline", fn });
}

export interface TaskFactory {
  define<InputSchema extends Schema<any>, OutputSchema extends Schema<any>>(config: { input: InputSchema; output: OutputSchema }): {
    input: InputSchema;
    output: OutputSchema;
    run(fn: TaskFunction<InferSchema<InputSchema>, InferSchema<OutputSchema>>): TaskToken<InferSchema<InputSchema>, InferSchema<OutputSchema>>;
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
      run(fn: TaskFunction<Input, Output>): TaskToken<Input, Output> {
        return makeTaskToken({ kind: "external", input: config.input, output: config.output, fn });
      },
    };
  },
  isToken(value: unknown): value is TaskToken<any, any, any> {
    return Boolean(value && typeof value === "object" && (value as any)[TASK]);
  },
};

export const defineTask = task.define;

export function buildTaskNode<const Input extends StepInput, OutSchema extends Schema<any>>(
  id: string,
  spec: TaskStepSpec<Input, OutSchema>,
  taskBundles: Record<string, TaskBundleIR>,
  diagnostics: DiagnosticIR[],
): TaskNodeIR {
  assertStableId(id, diagnostics);
  const run = typeof spec.run === "function" ? createInlineTaskToken(spec.run) : spec.run;
  if (!task.isToken(run)) {
    diagnostics.push({ code: "T000", severity: "error", message: `Task node '${id}' must use run: async ctx => ... or a task.define(...).run(...) token.` });
  }
  const bundle = run.toBundleIR();
  taskBundles[bundle.id] = bundle;
  return stripUndefined({
    id,
    kind: "task",
    inputs: inputsToIR(spec.input),
    outputSchema: toSchemaIR(spec.output),
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
