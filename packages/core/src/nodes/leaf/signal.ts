import { stripUndefined } from "../../graph/lowering.js";
import { valueToExprIR } from "@acpus/expression/ir";
import type { Resolvable } from "@acpus/expression";
import { toSchemaIR, type Schema } from "../../schema/index.js";
import type { SignalNodeIR } from "../../ir/types.js";

type SignalStepBase = {
  prompt: Resolvable<string>;
};

type SignalTimeoutSpec =
  | { timeout: Resolvable<string>; onTimeout?: { message?: Resolvable<string> } }
  | { timeout?: undefined; onTimeout?: never };

/** Authoring spec for a Signal node that waits for operator input. */
export type SignalStepSpec<OutSchema extends Schema<any> | undefined = Schema<any> | undefined> =
  SignalStepBase & (OutSchema extends Schema<any>
    ? {
        outputSchema: OutSchema;
      }
    : {
        outputSchema?: undefined;
      }) & SignalTimeoutSpec;

export function buildSignalNode<OutSchema extends Schema<any> | undefined>(
  id: string,
  spec: SignalStepSpec<OutSchema>,
): SignalNodeIR {
  return stripUndefined({
    id,
    kind: "signal",
    outputSchema: spec.outputSchema ? toSchemaIR(spec.outputSchema) : undefined,
    run: { prompt: valueToExprIR(spec.prompt) },
    timeout: spec.timeout === undefined ? undefined : valueToExprIR(spec.timeout),
    onTimeout: spec.onTimeout === undefined ? undefined : {
      message: spec.onTimeout.message === undefined ? undefined : valueToExprIR(spec.onTimeout.message),
    },
  }) as SignalNodeIR;
}
