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
      validateKnownFields(expr, ["kind", "value"], diagnostics, path);
      if (!hasOwn(expr, "value") || !isJsonPrimitive(expr.value)) diagnostics.push(error("EX002", "Expression literal value must be a JSON primitive.", `${path}.value`));
      break;
    case "ref":
      validateKnownFields(expr, ["kind", "path"], diagnostics, path);
      validatePath(expr.path, diagnostics, `${path}.path`, "Expression ref path must be a non-empty string array.");
      break;
    case "array":
      validateKnownFields(expr, ["kind", "items"], diagnostics, path);
      validateExprArray(expr.items, diagnostics, `${path}.items`, seen);
      break;
    case "object":
      validateKnownFields(expr, ["kind", "fields"], diagnostics, path);
      validateExprFields(expr.fields, diagnostics, `${path}.fields`, seen);
      break;
    case "template":
      validateTemplate(expr, diagnostics, path, seen);
      break;
    case "call":
      validateKnownFields(expr, ["kind", "fn", "args"], diagnostics, path);
      validateCall(expr, diagnostics, path, seen);
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
  if (!isRecord(value) || !Array.isArray(value.parts)) {
    diagnostics.push(error("EX002", "Expression template parts must be an array.", `${path}.parts`));
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

function isJsonPrimitive(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  return typeof value === "number" && Number.isFinite(value);
}

function formatArity(arity: readonly number[]): string {
  return arity.length === 1 ? String(arity[0]) : arity.join(" or ");
}
