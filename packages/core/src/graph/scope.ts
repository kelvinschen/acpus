import { OUTPUT_TOKEN } from "../internal/symbols.js";
import { valueToExprIR, type Expr } from "../expressions/expr.js";
import type { Primitive } from "./refs.js";
import type { DiagnosticIR, ExprIR, NodeIR, ScopeIR } from "../ir/types.js";
import type { StepFactory } from "./builder.js";

declare const ROOT_OUTPUT_SCOPE: unique symbol;
declare const OUTPUT_SCOPE: unique symbol;
declare const SCOPE: unique symbol;

export type RootOutputScope = typeof ROOT_OUTPUT_SCOPE;
export type ScopeIdentity = { readonly [SCOPE]: unknown };

export type OutputToken<T, Scope = RootOutputScope> = {
  readonly [OUTPUT_TOKEN]: true;
  readonly [OUTPUT_SCOPE]: Scope;
  readonly values: T;
  readonly ir: Record<string, ExprIR>;
};

export type OutputHelper = <T extends Record<string, unknown>>(values: T) => OutputToken<T, RootOutputScope>;

export type OutputValue<T> =
  | Expr<T>
  | (T extends Primitive
    ? T
    : T extends readonly (infer Item)[]
      ? readonly OutputValue<Item>[]
      : T extends object
        ? { readonly [K in keyof T]: OutputValue<T[K]> }
        : T);

export type OutputValues<T extends object> = {
  [K in keyof T]: OutputValue<T[K]>;
};

export type TypedOutputHelper<Output extends object, Scope = ScopeIdentity> = (values: OutputValues<Output>) => OutputToken<OutputValues<Output>, Scope>;

export type ScopeContext<Output extends object = Record<string, unknown>, AgentKey extends string = never, Scope = ScopeIdentity> = {
  step: StepFactory<AgentKey>;
  output: TypedOutputHelper<Output, Scope>;
};

type ScopeBuildState<AgentKey extends string = string> = {
  readonly nodes: NodeIR[];
  readonly step: StepFactory<AgentKey>;
};

export function makeOutputToken<T extends Record<string, unknown>, Scope = RootOutputScope>(values: T): OutputToken<T, Scope> {
  const ir: Record<string, ExprIR> = {};
  for (const [key, value] of Object.entries(values)) ir[key] = valueToExprIR(value);
  return { [OUTPUT_TOKEN]: true as const, values, ir } as OutputToken<T, Scope>;
}

export function isOutputToken(value: unknown): value is OutputToken<any, any> {
  return Boolean(value && typeof value === "object" && (value as any)[OUTPUT_TOKEN]);
}

export function buildImplicitScope<AgentKey extends string, Extra extends object>(
  diagnostics: DiagnosticIR[],
  child: ScopeBuildState<AgentKey>,
  fn: (ctx: ScopeContext<any, AgentKey> & Extra) => OutputToken<any, any>,
  extra: Extra,
): ScopeIR {
  const result = fn({ step: child.step, output: makeOutputToken, ...extra });
  if (!isOutputToken(result)) {
    diagnostics.push({ code: "B001", severity: "error", message: "Composite scope must return output({...})." });
    return { nodes: child.nodes };
  }
  return { nodes: child.nodes, outputs: result.ir };
}
