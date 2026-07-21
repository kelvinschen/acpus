import { describe, expect, it } from "vitest";
import * as expression from "@acpus/expression";
import * as evaluator from "@acpus/expression/evaluator";
import * as ir from "@acpus/expression/ir";
import * as validator from "@acpus/expression/validator";

describe("@acpus/expression public API", () => {
  it("exports the root authoring surface", () => {
    expect(Object.keys(expression).sort()).toEqual([
      "and",
      "eq",
      "gt",
      "gte",
      "lift",
      "lt",
      "lte",
      "md",
      "ne",
      "not",
      "or",
      "template",
    ]);
  });

  it("exports focused low-level subpaths", () => {
    expect(Object.keys(ir).sort()).toEqual([
      "EXPRESSION_OPERATORS",
      "expr",
      "expressionCallbackLayout",
      "expressionCallbackOperatorNames",
      "expressionOperatorSpec",
      "isExpr",
      "isJsonValue",
      "refExpr",
      "staticExprShape",
      "tryValueToExprIR",
      "valueToExprIR",
    ]);
    expect(Object.keys(validator).sort()).toEqual(["validateExprIR"]);
    expect(Object.keys(evaluator).sort()).toEqual([
      "ExpressionEvaluationError",
      "evaluateExpr",
      "renderTemplate",
    ]);
    expect(ir.EXPRESSION_OPERATORS).toEqual({
      lift: { arity: [2, 3, 4], callback: true },
      access: { arity: [2] },
    });
    expect(ir.expressionCallbackOperatorNames()).toEqual(["lift"]);
  });
});
