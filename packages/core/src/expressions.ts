import { parse as parseCel } from "@marcbachmann/cel-js";
import type { DiagnosticBag } from "./diagnostics.js";
import type { IrExpression } from "./types.js";

export const EXPRESSION_PATTERN = /\$\{\{\s*([\s\S]*?)\s*\}\}/g;

/** Fields that are evaluated as raw CEL (evaluateExpression), not templates.
 *  Using ${{ }} in these fields causes a runtime CEL parse error. */
const RAW_CEL_FIELDS = new Set(["over", "until", "when"]);

const STEP_REFERENCE_PATTERN = /\bsteps\.([A-Za-z_][A-Za-z0-9_-]*)\b/g;
const STEP_PATH_PATTERN = /\bsteps\.([A-Za-z_][A-Za-z0-9_-]*)((?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*)/g;
const ROOT_REFERENCE_PATTERN = /(?<![\w.])([A-Za-z_][A-Za-z0-9_]*)\s*(?:\.|\()/g;

/** Step kinds that are composite (no .output envelope on the step itself). */
const COMPOSITE_KINDS = new Set(["parallel", "fanout", "loop", "switch", "subworkflow"]);

export const ALLOWED_ROOTS = new Set(["input", "steps", "loop", "item", "item_id", "item_index", "run_id"]);
export const ALLOWED_FUNCTIONS = new Set(["now", "len", "startsWith", "matches", "coalesce"]);

export interface ExpressionCollector {
  expressions: IrExpression[];
  visit(value: unknown, path: string): void;
}

export function createExpressionCollector(diagnostics: DiagnosticBag, knownStepIds: Set<string>, stepKinds: Map<string, string>): ExpressionCollector {
  const expressions: IrExpression[] = [];

  function collectFromString(value: string, path: string): void {
    const fieldName = path.split(".").pop() ?? "";

    // Warn if ${{ }} appears in a raw-CEL field
    if (RAW_CEL_FIELDS.has(fieldName) && EXPRESSION_PATTERN.test(value)) {
      diagnostics.warning(
        "EXPR_TEMPLATE_IN_CEL",
        `Field '${fieldName}' is evaluated as raw CEL — remove ${{ }} wrappers or the expression will fail at runtime.`,
        path
      );
    }

    // Reset regex lastIndex after test() calls above (test() with /g advances it)
    EXPRESSION_PATTERN.lastIndex = 0;

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

      // Check for .output access on composite nodes (parallel, fanout, loop, switch, subworkflow)
      for (const pathMatch of source.matchAll(STEP_PATH_PATTERN)) {
        const stepId = pathMatch[1] as string;
        const pathChain = pathMatch[2] ?? "";
        if (!pathChain.startsWith(".output")) continue;
        const kind = stepKinds.get(stepId);
        if (!kind || !COMPOSITE_KINDS.has(kind)) continue;
        diagnostics.error("EXPR_COMPOSITE_OUTPUT", compositeOutputHint(stepId, kind), path);
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

export function toCelParseSource(source: string): string {
  return source.replace(/\bloop\./g, "loop_ctx.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function compositeOutputHint(stepId: string, kind: string): string {
  if (kind === "fanout") {
    return `Step '${stepId}' is a fanout node — its output is an array. Use steps.${stepId}[<index>].output.<field> to access a specific lane instead of steps.${stepId}.output.`;
  }
  if (kind === "parallel") {
    return `Step '${stepId}' is a ${kind} node — use steps.${stepId}.<child_id>.output.<field> instead of steps.${stepId}.output.`;
  }
  if (kind === "subworkflow") {
    return `Step '${stepId}' is a ${kind} node — its output does not have an '.output' envelope. Access its fields directly as steps.${stepId}.<field>.`;
  }
  // loop, switch
  return `Step '${stepId}' is a ${kind} node — its output does not have an '.output' envelope.`;
}
