import { parse as parseCel } from "@marcbachmann/cel-js";
import type { DiagnosticBag } from "./diagnostics.js";
import type { IrExpression } from "./types.js";

const EXPRESSION_PATTERN = /\$\{\{\s*([\s\S]*?)\s*\}\}/g;
const STEP_REFERENCE_PATTERN = /\bsteps\.([A-Za-z_][A-Za-z0-9_-]*)\b/g;
const ROOT_REFERENCE_PATTERN = /(?<![\w.])([A-Za-z_][A-Za-z0-9_]*)\s*(?:\.|\()/g;
const ALLOWED_ROOTS = new Set(["input", "steps", "loop", "item", "item_id", "item_index", "run_id"]);
const ALLOWED_FUNCTIONS = new Set(["now", "len", "startsWith", "matches", "coalesce"]);

export interface ExpressionCollector {
  expressions: IrExpression[];
  visit(value: unknown, path: string): void;
}

export function createExpressionCollector(diagnostics: DiagnosticBag, knownStepIds: Set<string>): ExpressionCollector {
  const expressions: IrExpression[] = [];

  function collectFromString(value: string, path: string): void {
    for (const match of value.matchAll(EXPRESSION_PATTERN)) {
      const source = match[1]?.trim() ?? "";
      if (source.length === 0) {
        diagnostics.error("EXPR_EMPTY", "Expression cannot be empty.", path);
        continue;
      }

      try {
        parseCel(toCelParseSource(source));
      } catch (error) {
        diagnostics.error("EXPR_PARSE", `Invalid CEL expression: ${errorMessage(error)}`, path);
      }

      const references = [...source.matchAll(STEP_REFERENCE_PATTERN)].map((reference) => reference[1] as string);
      for (const reference of references) {
        if (!knownStepIds.has(reference)) {
          diagnostics.error("EXPR_UNKNOWN_STEP", `Expression references unknown step '${reference}'.`, path);
        }
      }

      for (const root of source.matchAll(ROOT_REFERENCE_PATTERN)) {
        const name = root[1] as string;
        if (name === "json" || name === "hash") {
          continue;
        }
        if (!ALLOWED_ROOTS.has(name) && !ALLOWED_FUNCTIONS.has(name)) {
          diagnostics.warning("EXPR_UNKNOWN_ROOT", `Expression root '${name}' is not part of the M1 DSL context.`, path);
        }
      }

      expressions.push({
        id: `expr_${expressions.length + 1}`,
        source,
        path,
        references
      });
    }
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toCelParseSource(source: string): string {
  return source.replace(/\bloop\./g, "loop_ctx.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
