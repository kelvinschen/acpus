import { assertStableId, stripUndefined } from "../../graph/lowering.js";
import { templateToIR, type TemplateInput } from "../../template/template.js";
import { toSchemaIR, type Schema } from "../../schema/index.js";
import type { DiagnosticIR, SignalNodeIR, SignalRunIR } from "../../ir/types.js";

export type SignalRunSpec = {
  prompt: TemplateInput;
};

type SignalTimeoutSpec =
  | { timeout: string; onTimeout?: { action: "fail"; message?: string } }
  | { timeout?: undefined; onTimeout?: never };

export type SignalStepSpec<OutSchema extends Schema<any> | undefined = Schema<any> | undefined> =
  (OutSchema extends Schema<any>
    ? {
        outputSchema: OutSchema;
        run: SignalRunSpec;
      }
    : {
        outputSchema?: undefined;
        run: SignalRunSpec;
      }) & SignalTimeoutSpec;

function signalRunToIR(spec: SignalRunSpec): SignalRunIR {
  return { kind: "signal_run", prompt: templateToIR(spec.prompt) };
}

export function buildSignalNode<OutSchema extends Schema<any> | undefined>(
  id: string,
  spec: SignalStepSpec<OutSchema>,
  diagnostics: DiagnosticIR[],
): SignalNodeIR {
  assertStableId(id, diagnostics);
  return stripUndefined({
    id,
    kind: "signal",
    outputSchema: spec.outputSchema ? toSchemaIR(spec.outputSchema) : undefined,
    run: signalRunToIR(spec.run),
    timeout: spec.timeout,
    onTimeout: spec.onTimeout,
  }) as SignalNodeIR;
}
