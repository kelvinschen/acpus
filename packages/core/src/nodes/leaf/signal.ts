import { assertStableId, stripUndefined } from "../../graph/lowering.js";
import { valueToExprIR } from "@acpus/expression/ir";
import type { Resolvable } from "@acpus/expression";
import { toSchemaIR, type Schema } from "../../schema/index.js";
import type { DiagnosticIR, SignalNodeIR, SignalRunIR } from "../../ir/types.js";

export type SignalRunSpec = {
  prompt: Resolvable<string>;
};

type SignalTimeoutSpec =
  | { timeout: Resolvable<string>; onTimeout?: { message?: Resolvable<string> } }
  | { timeout?: undefined; onTimeout?: never };

/** Authoring spec for a Signal node that waits for operator input. */
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
  return { prompt: valueToExprIR(spec.prompt) };
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
    timeout: spec.timeout === undefined ? undefined : valueToExprIR(spec.timeout),
    onTimeout: spec.onTimeout === undefined ? undefined : {
      message: spec.onTimeout.message === undefined ? undefined : valueToExprIR(spec.onTimeout.message),
    },
  }) as SignalNodeIR;
}
