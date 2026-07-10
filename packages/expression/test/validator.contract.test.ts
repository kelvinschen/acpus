import { describe, expect, it } from "vitest";
import { validateExprIR } from "@acpus/expression/validator";

describe("expression validator", () => {
  it("returns diagnostics data", () => {
    expect(validateExprIR({ kind: "literal", value: true })).toEqual([]);
  });

  it("uses the EX diagnostic namespace", () => {
    expect(validateExprIR({ kind: "call", fn: "unknown", args: [] })).toEqual([{
      code: "EX001",
      severity: "error",
      message: "Unknown expression operator 'unknown'.",
      path: "$.fn",
    }]);
  });

  it("validates new operator arity and callback source placement", () => {
    expect(validateExprIR({ kind: "call", fn: "fmap", args: [{ kind: "literal", value: true }] })).toEqual([{
      code: "EX003",
      severity: "error",
      message: "fmap(...) expected 2 args, got 1.",
      path: "$.args",
    }]);
    expect(validateExprIR({
      kind: "call",
      fn: "fmap",
      args: [{ kind: "literal", value: 1 }, { kind: "ref", path: ["input", "fn"] }],
    })).toEqual([{
      code: "EX002",
      severity: "error",
      message: "fmap(...) expected callback source string.",
      path: "$.args[1]",
    }]);
    expect(validateExprIR({ kind: "call", fn: "lift2", args: [{ kind: "literal", value: 1 }, { kind: "literal", value: 2 }, { kind: "literal", value: "(a, b) => a + b" }] })).toEqual([]);
    expect(validateExprIR({ kind: "call", fn: "lift3", args: [{ kind: "literal", value: 1 }, { kind: "literal", value: 2 }, { kind: "literal", value: 3 }, { kind: "literal", value: "(a, b, c) => a + b + c" }] })).toEqual([]);
    expect(validateExprIR({ kind: "call", fn: "lift", args: [{ kind: "object", fields: { a: { kind: "literal", value: 1 } } }, { kind: "literal", value: "({ a }) => a" }] })).toEqual([]);
    expect(validateExprIR({ kind: "call", fn: "access", args: [{ kind: "literal", value: { a: 1 } }, { kind: "literal", value: "a" }] })).toEqual([]);
  });

  it("accepts expression-body and block-body callback source strings", () => {
    expect(validateExprIR({ kind: "call", fn: "fmap", args: [{ kind: "literal", value: 1 }, { kind: "literal", value: "value => value" }] })).toEqual([]);
    expect(validateExprIR({ kind: "call", fn: "fmap", args: [{ kind: "literal", value: 1 }, { kind: "literal", value: "value => { const next = value + 1; return next; }" }] })).toEqual([]);
    expect(validateExprIR({ kind: "call", fn: "fmap", args: [{ kind: "literal", value: 1 }, { kind: "literal", value: "value => /* comment */ { return value; }" }] })).toEqual([]);
  });

  it("rejects callback source strings with invalid shape", () => {
    expect(validateExprIR({ kind: "call", fn: "lift2", args: [{ kind: "literal", value: 1 }, { kind: "literal", value: 2 }, { kind: "literal", value: "value => value" }] })).toEqual([{
      code: "EX002",
      severity: "error",
      message: "lift2(...) callback source expected 2 parameters, got 1.",
      path: "$.args[2]",
    }]);
    expect(validateExprIR({ kind: "call", fn: "fmap", args: [{ kind: "literal", value: 1 }, { kind: "literal", value: "async value => { return value; }" }] })).toEqual([{
      code: "EX002",
      severity: "error",
      message: "fmap(...) callback source must be synchronous.",
      path: "$.args[1]",
    }]);
  });

  it("rejects removed lambda and var IR", () => {
    expect(validateExprIR({ kind: "var", id: "v0", path: [] } as any)).toEqual([{
      code: "EX002",
      severity: "error",
      message: "Unknown expression kind 'var'.",
      path: "$.kind",
    }]);
    expect(validateExprIR({ kind: "lambda", params: [{ id: "v0" }], body: { kind: "literal", value: true } } as any)).toEqual([{
      code: "EX002",
      severity: "error",
      message: "Unknown expression kind 'lambda'.",
      path: "$.kind",
    }]);
  });

  it("rejects removed operators", () => {
    for (const fn of [
      "not",
      "and",
      "or",
      "eq",
      "ne",
      "lt",
      "lte",
      "gt",
      "gte",
      "add",
      "subtract",
      "multiply",
      "divide",
      "mod",
      "ifElse",
      "coalesce",
      "len",
      "includes",
      "isEmpty",
      "startsWith",
      "endsWith",
      "matches",
      "get",
      "head",
      "every",
      "some",
      "map",
      "filter",
      "join",
      "max",
      "min",
      "where",
      "pick",
      "transform",
    ]) {
      expect(validateExprIR({ kind: "call", fn, args: [] })).toEqual([{
        code: "EX001",
        severity: "error",
        message: `Unknown expression operator '${fn}'.`,
        path: "$.fn",
      }]);
    }
  });

  it("validates malformed expression shapes", () => {
    expect(validateExprIR({ kind: "literal", value: undefined } as any)).toEqual([{
      code: "EX002",
      severity: "error",
      message: "Expression literal value must be JSON-compatible.",
      path: "$.value",
    }]);
    expect(validateExprIR({ kind: "literal", value: Number.POSITIVE_INFINITY } as any)).toEqual([{
      code: "EX002",
      severity: "error",
      message: "Expression literal value must be JSON-compatible.",
      path: "$.value",
    }]);
    expect(validateExprIR({ kind: "literal", value: Number.NaN } as any)).toEqual([{
      code: "EX002",
      severity: "error",
      message: "Expression literal value must be JSON-compatible.",
      path: "$.value",
    }]);
    expect(validateExprIR({
      kind: "template",
      template: { kind: "template", parts: [{ kind: "text" }] },
    } as any)).toEqual([{
      code: "EX002",
      severity: "error",
      message: "Template text value must be a string.",
      path: "$.template.parts[0].value",
    }]);
    expect(validateExprIR({ kind: "ref", path: [] })).toEqual([{
      code: "EX006",
      severity: "error",
      message: "Expression ref path must be a non-empty string array.",
      path: "$.path",
    }]);
    expect(validateExprIR({ kind: "mystery" } as any)).toEqual([{
      code: "EX002",
      severity: "error",
      message: "Unknown expression kind 'mystery'.",
      path: "$.kind",
    }]);
  });

  it("validates closed shapes and sparse arrays", () => {
    expect(validateExprIR({ kind: "ref", path: ["input"], extra: true } as any)).toEqual([{
      code: "EX002",
      severity: "error",
      message: "Unknown expression field 'extra'.",
      path: "$.extra",
    }]);

    const args = new Array(2);
    expect(validateExprIR({ kind: "call", fn: "fmap", args } as any)).toEqual([
      {
        code: "EX002",
        severity: "error",
        message: "Array values must not contain sparse holes.",
        path: "$.args[0]",
      },
      {
        code: "EX002",
        severity: "error",
        message: "Array values must not contain sparse holes.",
        path: "$.args[1]",
      },
    ]);

    const parts = new Array(1);
    expect(validateExprIR({ kind: "template", template: { kind: "template", parts } } as any)).toEqual([{
      code: "EX002",
      severity: "error",
      message: "Array values must not contain sparse holes.",
      path: "$.template.parts[0]",
    }]);
  });

  it("validates type metadata", () => {
    expect(validateExprIR({ kind: "literal", value: 1, type: { kind: "integer" } } as any)).toEqual([{
      code: "EX009",
      severity: "error",
      message: "Unknown type kind 'integer'.",
      path: "$.type.kind",
    }]);

    expect(validateExprIR({
      kind: "literal",
      value: 1,
      type: { kind: "object", fields: { id: { kind: "string" } }, required: ["missing"], additionalProperties: false },
    } as any)).toContainEqual({
      code: "EX009",
      severity: "error",
      message: "Required type field 'missing' is not present in object fields.",
      path: "$.type.required[0]",
    });
  });

  it("rejects malformed templates", () => {
    expect(validateExprIR({
      kind: "template",
      template: { kind: "not_template", parts: [] },
    } as any)).toEqual([{
      code: "EX002",
      severity: "error",
      message: "Expression template must contain template parts.",
      path: "$.template",
    }]);
  });
});
