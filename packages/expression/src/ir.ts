export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;
export type JsonArray = JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type ExprIR =
  | { kind: "literal"; value: JsonPrimitive }
  | { kind: "ref"; path: string[] }
  | { kind: "call"; fn: string; args: ExprIR[] }
  | { kind: "array"; items: ExprIR[] }
  | { kind: "object"; fields: Record<string, ExprIR> }
  | TemplateIR;

export type TemplateIR = {
  kind: "template";
  parts: TemplatePartIR[];
};

export type TemplatePartIR =
  | { kind: "text"; value: string }
  | { kind: "expr"; expr: ExprIR };

export type StaticExprShape =
  | { kind: "object"; possibleKeys: string[] }
  | { kind: "array" }
  | { kind: "scalar" }
  | { kind: "dynamic" };

export function staticExprShape(expr: ExprIR): StaticExprShape {
  switch (expr.kind) {
    case "object":
      return { kind: "object", possibleKeys: Object.keys(expr.fields).sort() };
    case "array":
      return { kind: "array" };
    case "literal":
    case "template":
      return { kind: "scalar" };
    case "ref":
    case "call":
      return { kind: "dynamic" };
  }
}

export { expr, isExpr, refExpr, valueToExprIR, tryValueToExprIR } from "./internal/expr.js";
export type { Expr, ExprLoweringError, ExprValue, Resolvable, WorkflowData } from "./internal/expr.js";
export { EXPRESSION_OPERATORS, expressionCallbackLayout, expressionCallbackOperatorNames, expressionOperatorSpec } from "./internal/operators.js";
export type { ExpressionCallbackLayout, ExpressionCallbackOperatorName, ExpressionOperatorName, OperatorSpec } from "./internal/operators.js";
