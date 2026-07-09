import { expressionOperatorSpec } from "./internal/operators.js";
import { callbackSourceIssue } from "./internal/callback-source.js";
import type { OperatorSpec } from "./internal/operators.js";

export type ExpressionDiagnostic = {
  code: `EX${number}`;
  severity: "error" | "warning" | "info";
  message: string;
  path?: string;
};

export function validateExprIR(expr: unknown): ExpressionDiagnostic[] {
  const diagnostics: ExpressionDiagnostic[] = [];
  validateExpr(expr, diagnostics, "$", new WeakSet());
  return diagnostics;
}

function validateExpr(
  expr: unknown,
  diagnostics: ExpressionDiagnostic[],
  path: string,
  seen: WeakSet<object>,
): void {
  if (!isRecord(expr) || typeof expr.kind !== "string") {
    diagnostics.push(error("EX002", "Expression must be an object with a string kind.", path));
    return;
  }
  if (seen.has(expr)) {
    diagnostics.push(error("EX002", "Expression graph must be acyclic.", path));
    return;
  }
  seen.add(expr);

  switch (expr.kind) {
    case "literal":
      validateKnownFields(expr, ["kind", "value", "type"], diagnostics, path);
      if (!hasOwn(expr, "value") || !isJsonValue(expr.value)) diagnostics.push(error("EX002", "Expression literal value must be JSON-compatible.", `${path}.value`));
      validateOptionalType(expr.type, diagnostics, `${path}.type`);
      validateLiteralType(expr, diagnostics, path);
      break;
    case "ref":
      validateKnownFields(expr, ["kind", "path", "type"], diagnostics, path);
      validatePath(expr.path, diagnostics, `${path}.path`, "Expression ref path must be a non-empty string array.");
      validateOptionalType(expr.type, diagnostics, `${path}.type`);
      break;
    case "array":
      validateKnownFields(expr, ["kind", "items", "type"], diagnostics, path);
      validateExprArray(expr.items, diagnostics, `${path}.items`, seen);
      validateOptionalType(expr.type, diagnostics, `${path}.type`);
      break;
    case "object":
      validateKnownFields(expr, ["kind", "fields", "type"], diagnostics, path);
      validateExprFields(expr.fields, diagnostics, `${path}.fields`, seen);
      validateOptionalType(expr.type, diagnostics, `${path}.type`);
      break;
    case "template":
      validateKnownFields(expr, ["kind", "template", "type"], diagnostics, path);
      validateTemplate(expr.template, diagnostics, `${path}.template`, seen);
      validateOptionalType(expr.type, diagnostics, `${path}.type`);
      break;
    case "call":
      validateKnownFields(expr, ["kind", "fn", "args", "type"], diagnostics, path);
      validateCall(expr, diagnostics, path, seen);
      validateOptionalType(expr.type, diagnostics, `${path}.type`);
      break;
    default:
      diagnostics.push(error("EX002", `Unknown expression kind '${expr.kind}'.`, `${path}.kind`));
  }

  seen.delete(expr);
}

function validateCall(expr: Record<string, unknown>, diagnostics: ExpressionDiagnostic[], path: string, seen: WeakSet<object>): void {
  if (typeof expr.fn !== "string") {
    diagnostics.push(error("EX002", "Expression call fn must be a string.", `${path}.fn`));
    return;
  }
  const fn = expr.fn;
  const spec = expressionOperatorSpec(fn);
  if (!spec) {
    diagnostics.push(error("EX001", `Unknown expression operator '${fn}'.`, `${path}.fn`));
    return;
  }
  if (!Array.isArray(expr.args)) {
    diagnostics.push(error("EX002", "Expression call args must be an array.", `${path}.args`));
    return;
  }
  validateArity(fn, expr.args.length, spec.arity, diagnostics, `${path}.args`);
  forEachDense(expr.args, diagnostics, `${path}.args`, (arg, index) => {
    if (spec.callback?.callbackSourceArg === index && (!isRecord(arg) || arg.kind !== "literal" || typeof arg.value !== "string")) {
      diagnostics.push(error("EX002", `${fn}(...) expected callback source string.`, `${path}.args[${index}]`));
      return;
    }
    if (spec.callback?.callbackSourceArg === index && isRecord(arg) && arg.kind === "literal" && typeof arg.value === "string") {
      const issue = callbackSourceIssue(arg.value, spec.callback.callbackParamCount);
      if (issue) diagnostics.push(error("EX002", `${fn}(...) ${issue}`, `${path}.args[${index}]`));
    }
    validateExpr(arg, diagnostics, `${path}.args[${index}]`, seen);
  });
}

function validateExprArray(
  value: unknown,
  diagnostics: ExpressionDiagnostic[],
  path: string,
  seen: WeakSet<object>,
): void {
  if (!Array.isArray(value)) {
    diagnostics.push(error("EX002", "Expression array items must be an array.", path));
    return;
  }
  forEachDense(value, diagnostics, path, (item, index) => validateExpr(item, diagnostics, `${path}[${index}]`, seen));
}

function validateExprFields(value: unknown, diagnostics: ExpressionDiagnostic[], path: string, seen: WeakSet<object>): void {
  if (!isRecord(value)) {
    diagnostics.push(error("EX002", "Expression object fields must be an object.", path));
    return;
  }
  for (const [key, item] of Object.entries(value)) validateExpr(item, diagnostics, `${path}.${key}`, seen);
}

function validateTemplate(value: unknown, diagnostics: ExpressionDiagnostic[], path: string, seen: WeakSet<object>): void {
  if (!isRecord(value) || value.kind !== "template" || !Array.isArray(value.parts)) {
    diagnostics.push(error("EX002", "Expression template must contain template parts.", path));
    return;
  }
  validateKnownFields(value, ["kind", "parts"], diagnostics, path);
  forEachDense(value.parts, diagnostics, `${path}.parts`, (part, index) => {
    const partPath = `${path}.parts[${index}]`;
    if (!isRecord(part)) {
      diagnostics.push(error("EX002", "Template part must be an object.", partPath));
    } else if (part.kind === "expr") {
      validateKnownFields(part, ["kind", "expr"], diagnostics, partPath);
      validateExpr(part.expr, diagnostics, `${partPath}.expr`, seen);
    } else if (part.kind === "text") {
      validateKnownFields(part, ["kind", "value"], diagnostics, partPath);
      if (typeof part.value !== "string") diagnostics.push(error("EX002", "Template text value must be a string.", `${partPath}.value`));
    } else {
      diagnostics.push(error("EX002", `Unknown template part kind '${String(part.kind)}'.`, `${partPath}.kind`));
    }
  });
}

function validateOptionalType(value: unknown, diagnostics: ExpressionDiagnostic[], path: string): void {
  if (value !== undefined) validateType(value, diagnostics, path, new WeakSet());
}

function validateType(value: unknown, diagnostics: ExpressionDiagnostic[], path: string, seen: WeakSet<object>): void {
  if (!isRecord(value) || typeof value.kind !== "string") {
    diagnostics.push(error("EX009", "Type metadata must be an object with a string kind.", path));
    return;
  }
  if (seen.has(value)) {
    diagnostics.push(error("EX009", "Type metadata must be acyclic.", path));
    return;
  }
  seen.add(value);

  switch (value.kind) {
    case "unknown":
    case "string":
    case "number":
    case "boolean":
    case "null":
      validateKnownFields(value, ["kind"], diagnostics, path);
      break;
    case "array":
      validateKnownFields(value, ["kind", "item"], diagnostics, path);
      validateType(value.item, diagnostics, `${path}.item`, seen);
      break;
    case "object": {
      validateKnownFields(value, ["kind", "fields", "required", "additionalProperties"], diagnostics, path);
      if (!isRecord(value.fields)) {
        diagnostics.push(error("EX009", "Object type fields must be an object.", `${path}.fields`));
      } else {
        for (const [key, field] of Object.entries(value.fields)) validateType(field, diagnostics, `${path}.fields.${key}`, seen);
      }
      if (!Array.isArray(value.required)) {
        diagnostics.push(error("EX009", "Object type required must be a string array.", `${path}.required`));
      } else {
        forEachDense(value.required, diagnostics, `${path}.required`, (required, index) => {
          if (typeof required !== "string") diagnostics.push(error("EX009", "Object type required must be a string array.", `${path}.required[${index}]`));
          else if (isRecord(value.fields) && !hasOwn(value.fields, required)) diagnostics.push(error("EX009", `Required type field '${required}' is not present in object fields.`, `${path}.required[${index}]`));
        });
      }
      if (typeof value.additionalProperties !== "boolean") diagnostics.push(error("EX009", "Object type additionalProperties must be a boolean.", `${path}.additionalProperties`));
      break;
    }
    case "record":
      validateKnownFields(value, ["kind", "value"], diagnostics, path);
      validateType(value.value, diagnostics, `${path}.value`, seen);
      break;
    case "union":
      validateKnownFields(value, ["kind", "variants"], diagnostics, path);
      if (!Array.isArray(value.variants)) {
        diagnostics.push(error("EX009", "Union type variants must be an array.", `${path}.variants`));
      } else {
        forEachDense(value.variants, diagnostics, `${path}.variants`, (variant, index) => validateType(variant, diagnostics, `${path}.variants[${index}]`, seen));
      }
      break;
    default:
      diagnostics.push(error("EX009", `Unknown type kind '${value.kind}'.`, `${path}.kind`));
  }

  seen.delete(value);
}

function validateKnownFields(value: Record<string, unknown>, allowed: readonly string[], diagnostics: ExpressionDiagnostic[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) diagnostics.push(error("EX002", `Unknown expression field '${key}'.`, `${path}.${key}`));
}

function validatePath(value: unknown, diagnostics: ExpressionDiagnostic[], path: string, message: string, empty = false): void {
  if (!Array.isArray(value) || (!empty && value.length === 0)) {
    diagnostics.push(error("EX006", message, path));
    return;
  }
  forEachDense(value, diagnostics, path, (segment, index) => {
    if (typeof segment !== "string") diagnostics.push(error("EX006", message, `${path}[${index}]`));
  });
}

function validateLiteralType(expr: Record<string, unknown>, diagnostics: ExpressionDiagnostic[], path: string): void {
  if (!isRecord(expr.type) || typeof expr.type.kind !== "string") return;
  const value = expr.value;
  const kind = value === null ? "null" : typeof value;
  if (["string", "number", "boolean", "null"].includes(expr.type.kind) && expr.type.kind !== kind) {
    diagnostics.push(error("EX008", "Literal type metadata does not match literal value.", `${path}.type`));
  }
}

function validateArity(fn: string, actual: number, arity: OperatorSpec["arity"], diagnostics: ExpressionDiagnostic[], path: string): void {
  if (!arity.includes(actual)) diagnostics.push(error("EX003", `${fn}(...) expected ${formatArity(arity)} args, got ${actual}.`, path));
}

function forEachDense<T>(items: T[], diagnostics: ExpressionDiagnostic[], path: string, run: (item: T, index: number) => void): void {
  for (let index = 0; index < items.length; index++) {
    if (!hasOwn(items, index)) {
      diagnostics.push(error("EX002", "Array values must not contain sparse holes.", `${path}[${index}]`));
      continue;
    }
    run(items[index]!, index);
  }
}

function error(code: ExpressionDiagnostic["code"], message: string, path: string): ExpressionDiagnostic {
  return { code, severity: "error", message, path };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    for (let index = 0; index < value.length; index++) {
      if (!hasOwn(value, index) || !isJsonValue(value[index], seen)) return false;
    }
    seen.delete(value);
    return true;
  }
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  for (const item of Object.values(value)) if (!isJsonValue(item, seen)) return false;
  seen.delete(value);
  return true;
}

function formatArity(arity: readonly number[]): string {
  return arity.length === 1 ? String(arity[0]) : arity.join(" or ");
}
