export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;
export type JsonArray = JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type TypeIR =
  | { kind: "unknown" }
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "null" }
  | { kind: "array"; item: TypeIR }
  | { kind: "object"; fields: Record<string, TypeIR>; required: string[]; additionalProperties: boolean }
  | { kind: "record"; value: TypeIR }
  | { kind: "union"; variants: TypeIR[] };

export type ExprIR =
  | { kind: "literal"; value: JsonValue; type?: TypeIR }
  | { kind: "ref"; path: string[]; type?: TypeIR }
  | { kind: "call"; fn: string; args: ExprIR[]; type?: TypeIR }
  | { kind: "array"; items: ExprIR[]; type?: TypeIR }
  | { kind: "object"; fields: Record<string, ExprIR>; type?: TypeIR }
  | { kind: "template"; template: TemplateIR; type?: TypeIR };

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
