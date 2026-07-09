import { isExpr, type Expr } from "@acpus/expression";
import { bindingsToIR } from "./lowering.js";
import type { DiagnosticIR, NodeIR, ScopeIR } from "../ir/types.js";

type Primitive = string | number | boolean | null | undefined;

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

type ScopeBuildState = {
  readonly nodes: NodeIR[];
};

export function isOutputObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || isExpr(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function buildImplicitScope<Extra extends object>(
  diagnostics: DiagnosticIR[],
  child: ScopeBuildState,
  fn: (ctx: Extra) => Record<string, unknown>,
  extra: Extra,
): ScopeIR {
  const result = fn(extra);
  if (!isOutputObject(result)) {
    diagnostics.push({
      code: "B001",
      severity: "error",
      message: "Composite scope must return an output object.",
      hint: "Return a plain object from the composite callback, for example return { result: value }.",
    });
    return { nodes: child.nodes };
  }
  return { nodes: child.nodes, outputs: bindingsToIR(result) };
}
