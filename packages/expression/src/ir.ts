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

export { expr, isExpr, refExpr, valueToExprIR, tryValueToExprIR } from "./internal/expr.js";
export type { Expr, ExprLoweringError, ExprValue, Resolvable, WorkflowData } from "./internal/expr.js";
export { EXPRESSION_OPERATORS, expressionCallbackOperatorNames, expressionOperatorSpec } from "./internal/operators.js";
export type { ExpressionCallbackOperatorName, ExpressionOperatorName, OperatorSpec } from "./internal/operators.js";
