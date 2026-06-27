import { OUTPUT_TOKEN } from "../internal/symbols.js";
import { valueToExprIR } from "../expressions/expr.js";
import type { DiagnosticIR, ExprIR, ScopeIR } from "../ir/types.js";
import type { StepBuilder } from "./builder.js";

export type OutputToken<T> = {
  readonly [OUTPUT_TOKEN]: true;
  readonly values: T;
  readonly ir: Record<string, ExprIR>;
};

export type OutputHelper = <T extends Record<string, unknown>>(values: T) => OutputToken<T>;

export type ScopeContext = {
  step: StepBuilder;
  output: OutputHelper;
};

export function makeOutputToken<T extends Record<string, unknown>>(values: T): OutputToken<T> {
  const ir: Record<string, ExprIR> = {};
  for (const [key, value] of Object.entries(values)) ir[key] = valueToExprIR(value);
  return { [OUTPUT_TOKEN]: true as const, values, ir };
}

export function isOutputToken(value: unknown): value is OutputToken<any> {
  return Boolean(value && typeof value === "object" && (value as any)[OUTPUT_TOKEN]);
}

export function buildImplicitScope<Extra extends object>(
  diagnostics: DiagnosticIR[],
  child: StepBuilder,
  fn: (ctx: ScopeContext & Extra) => OutputToken<any>,
  extra: Extra,
): ScopeIR {
  const result = fn({ step: child, output: makeOutputToken, ...extra });
  if (!isOutputToken(result)) {
    diagnostics.push({ code: "B001", severity: "error", message: "Composite scope must return output({...})." });
    return { nodes: child.nodes };
  }
  return { nodes: child.nodes, outputs: result.ir };
}
