export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;
export type JsonArray = JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export function isJsonValue(value: unknown): value is JsonValue {
  try {
    return visitJsonValue(value, new WeakSet(), new WeakSet());
  } catch {
    return false;
  }
}

function visitJsonValue(value: unknown, visiting: WeakSet<object>, validated: WeakSet<object>): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (validated.has(value)) return true;
  if (visiting.has(value)) return false;

  visiting.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) return false;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index) || !visitJsonValue(value[index], visiting, validated)) return false;
      }
      validated.add(value);
      return true;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (!Object.values(value).every(item => visitJsonValue(item, visiting, validated))) return false;
    validated.add(value);
    return true;
  } finally {
    visiting.delete(value);
  }
}

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
