import { extractReferences } from "./cel-ast.js";
import { createAcpusCelEnvironment } from "./cel-environment.js";
import { EXPRESSION_PATTERN, toCelParseSource } from "./expressions-shared.js";
import type { DiagnosticBag } from "./diagnostics.js";
import type { IrExpression } from "./types.js";

export { EXPRESSION_PATTERN, toCelParseSource } from "./expressions-shared.js";

/** Fields that are evaluated as raw CEL (evaluateExpression), not templates.
 *  Using ${{ }} in these fields causes a runtime CEL parse error. */
const RAW_CEL_FIELDS = new Set(["over", "until", "when"]);

export interface ExpressionCollector {
  expressions: IrExpression[];
  visit(value: unknown, path: string): void;
}

export function createExpressionCollector(diagnostics: DiagnosticBag, knownStepIds: Set<string>): ExpressionCollector {
  const expressions: IrExpression[] = [];
  const celEnv = createAcpusCelEnvironment();

  function collectFromString(value: string, path: string): void {
    const fieldName = path.split(".").pop() ?? "";
    const isRawCel = RAW_CEL_FIELDS.has(fieldName);
    const hasTemplate = EXPRESSION_PATTERN.test(value);
    EXPRESSION_PATTERN.lastIndex = 0;

    if (isRawCel && hasTemplate) {
      diagnostics.warning(
        "EXPR_TEMPLATE_IN_CEL",
        `Field '${fieldName}' is evaluated as raw CEL — remove ${{ }} wrappers or the expression will fail at runtime.`,
        path
      );
    }

    if (isRawCel && !hasTemplate) {
      collectExpression(value.trim(), path);
      return;
    }

    for (const match of value.matchAll(EXPRESSION_PATTERN)) {
      const source = match[1]?.trim() ?? "";
      if (source.length === 0) {
        diagnostics.error("EXPR_EMPTY", "Expression cannot be empty.", path);
        continue;
      }
      collectExpression(source, path);
    }
  }

  function collectExpression(source: string, path: string): void {
    if (source.length === 0) return;
    const check = celEnv.check(toCelParseSource(source));
    if (!check.valid) {
      const error = check.error;
      diagnostics.error(celDiagnosticCode(error), `Invalid CEL expression: ${errorMessage(error)}`, path);
      return;
    }

    const { references, parseError } = extractReferences(source);
    if (parseError) {
      diagnostics.error("EXPR_PARSE", `Invalid CEL expression: ${parseError}`, path);
      return;
    }

    const stepReferences: string[] = [];
    for (const ref of references) {
      if (ref.root === "steps") {
        const first = ref.segments[0];
        if (first && first.kind === "field") {
          stepReferences.push(first.name);
          if (!knownStepIds.has(first.name)) {
            diagnostics.error("EXPR_UNKNOWN_STEP", `Expression references unknown step '${first.name}'.`, path);
          }
        }
      }
    }

    expressions.push({
      id: `expr_${expressions.length + 1}`,
      source,
      path,
      references: stepReferences
    });
  }

  function visit(value: unknown, path: string): void {
    if (typeof value === "string") {
      collectFromString(value, path);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        visit(child, `${path}.${key}`);
      }
    }
  }

  return { expressions, visit };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function celDiagnosticCode(error: unknown): string {
  if (isCelError(error, "ParseError")) return "EXPR_PARSE";
  if (isCelError(error, "TypeError") && error.code === "unknown_variable") return "EXPR_UNKNOWN_ROOT";
  return "EXPR_CEL";
}

function isCelError(error: unknown, name: string): error is { name: string; code?: string; message?: string } {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === name;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
