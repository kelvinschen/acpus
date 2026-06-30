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
  | { kind: "var"; id: string; path: string[]; type?: TypeIR }
  | { kind: "call"; fn: string; args: ExprIR[]; type?: TypeIR }
  | { kind: "array"; items: ExprIR[]; type?: TypeIR }
  | { kind: "object"; fields: Record<string, ExprIR>; type?: TypeIR }
  | { kind: "template"; template: TemplateIR; type?: TypeIR }
  | { kind: "lambda"; params: LambdaParamIR[]; body: ExprIR };

export type LambdaParamIR = {
  id: string;
  type?: TypeIR;
};

export type TemplateIR = {
  kind: "template";
  parts: TemplatePartIR[];
};

export type TemplatePartIR =
  | { kind: "text"; value: string }
  | { kind: "expr"; expr: ExprIR };

export { expr, refExpr, valueToExprIR } from "./internal/expr.js";
export type { Expr, OutputAccessor, WorkflowValue } from "./internal/expr.js";
