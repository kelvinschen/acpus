import { SIGNAL_RUN } from "../../internal/symbols.js";
import { inputsToIR, assertStableId, stripUndefined } from "../../graph/lowering.js";
import { templateToIR, type Template } from "../../template/template.js";
import { toSchemaIR, type Schema } from "../../schema/index.js";
import type { DiagnosticIR, SignalNodeIR, SignalRunIR } from "../../ir/types.js";
import type { GraphInput, StepInput } from "./shared.js";

export type SignalRunSpec = {
  prompt: Template | string;
};

export type SignalStepSpec<Input extends StepInput, OutSchema extends Schema<any>> = {
  input: Input;
  output: OutSchema;
  run: (ctx: { input: GraphInput<Input> }) => SignalRunSpec;
  timeout?: string;
  onTimeout?: { action: "fail" | "complete"; message?: string };
};

export type SignalRun = {
  readonly [SIGNAL_RUN]: true;
  readonly spec: SignalRunSpec;
  toIR(): SignalRunIR;
};

export type SignalFactory = {
  (spec: SignalRunSpec): SignalRun;
  isRun(value: unknown): value is SignalRun;
};

export const signal: SignalFactory = Object.assign(
  (spec: SignalRunSpec): SignalRun => ({
    [SIGNAL_RUN]: true as const,
    spec,
    toIR() {
      return { kind: "signal_run", prompt: templateToIR(spec.prompt) };
    },
  }),
  {
    isRun(value: unknown): value is SignalRun {
      return Boolean(value && typeof value === "object" && (value as any)[SIGNAL_RUN]);
    },
  },
);

export function buildSignalNode<const Input extends StepInput, OutSchema extends Schema<any>>(
  id: string,
  spec: SignalStepSpec<Input, OutSchema>,
  diagnostics: DiagnosticIR[],
): SignalNodeIR {
  assertStableId(id, diagnostics);
  const run = signal(spec.run({ input: spec.input }));
  return stripUndefined({
    id,
    kind: "signal",
    inputs: inputsToIR(spec.input),
    outputSchema: toSchemaIR(spec.output),
    run: run.toIR(),
    timeout: spec.timeout,
    onTimeout: spec.onTimeout,
  }) as SignalNodeIR;
}
