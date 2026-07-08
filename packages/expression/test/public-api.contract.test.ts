import { describe, expect, it } from "vitest";
import * as expression from "@acpus/expression";
import * as evaluator from "@acpus/expression/evaluator";
import * as ir from "@acpus/expression/ir";
import * as validator from "@acpus/expression/validator";

describe("@acpus/expression public API", () => {
  it("exports the root authoring surface", () => {
    expect(Object.keys(expression).sort()).toEqual([
      "add",
      "and",
      "coalesce",
      "divide",
      "endsWith",
      "eq",
      "every",
      "filter",
      "get",
      "gt",
      "gte",
      "head",
      "ifElse",
      "includes",
      "isEmpty",
      "isExpr",
      "join",
      "len",
      "lt",
      "lte",
      "map",
      "matches",
      "max",
      "md",
      "min",
      "mod",
      "multiply",
      "ne",
      "not",
      "or",
      "pick",
      "some",
      "startsWith",
      "subtract",
      "template",
      "transform",
      "where",
    ]);
  });

  it("exports focused low-level subpaths", () => {
    expect(Object.keys(ir).sort()).toEqual(["expr", "refExpr", "tryValueToExprIR", "valueToExprIR"]);
    expect(Object.keys(validator).sort()).toEqual(["validateExprIR"]);
    expect(Object.keys(evaluator).sort()).toEqual([
      "ExpressionEvaluationError",
      "evaluateExpr",
      "renderTemplate",
    ]);
  });
});
