import { extractReferences } from "./cel-ast.js";
import { EXPRESSION_PATTERN, toCelParseSource } from "./expressions-shared.js";
import type { DiagnosticBag } from "./diagnostics.js";
import type { IrExpression } from "./types.js";

export { EXPRESSION_PATTERN, toCelParseSource } from "./expressions-shared.js";

/** Fields that are evaluated as raw CEL (evaluateExpression), not templates.
 *  Using ${{ }} in these fields causes a runtime CEL parse error. */
const RAW_CEL_FIELDS = new Set(["over", "until", "when"]);

export const ALLOWED_ROOTS = new Set(["input", "steps", "loop", "item", "item_id", "item_index", "run_id"]);
export const ALLOWED_FUNCTIONS = new Set(["now", "len", "startsWith", "matches", "coalesce", "json"]);

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

      const { references, functions, parseError } = extractReferences(source);
      if (parseError) {
        diagnostics.error("EXPR_PARSE", `Invalid CEL expression: ${parseError}`, path);
        continue;
      }

      const stepReferences: string[] = [];
      for (const ref of references) {
        // Unknown root (not an allowed context variable). Functions are reported
        // separately below so a function name is never mistaken for a root.
        if (!ALLOWED_ROOTS.has(ref.root)) {
          diagnostics.warning("EXPR_UNKNOWN_ROOT", `Expression root '${ref.root}' is not part of the M1 DSL context.`, path);
        }
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

      for (const fn of functions) {
        if (!ALLOWED_FUNCTIONS.has(fn)) {
          diagnostics.warning("EXPR_UNKNOWN_ROOT", `Expression function '${fn}' is not part of the M1 DSL context.`, path);
        }
      }

      expressions.push({
        id: `expr_${expressions.length + 1}`,
        source,
        path,
        references: stepReferences
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
