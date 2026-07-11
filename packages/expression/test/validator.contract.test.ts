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
    expect(validateExprIR({ kind: "call", fn: "access", args: [{ kind: "object", fields: { a: { kind: "literal", value: 1 } } }, { kind: "literal", value: "a" }] })).toEqual([]);
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

  it("validates malformed expression shapes", () => {
    expect(validateExprIR({ kind: "literal", value: undefined } as any)).toEqual([{
      code: "EX002",
      severity: "error",
      message: "Expression literal value must be a JSON primitive.",
      path: "$.value",
    }]);
    expect(validateExprIR({ kind: "literal", value: Number.POSITIVE_INFINITY } as any)).toEqual([{
      code: "EX002",
      severity: "error",
      message: "Expression literal value must be a JSON primitive.",
      path: "$.value",
    }]);
    expect(validateExprIR({ kind: "literal", value: Number.NaN } as any)).toEqual([{
      code: "EX002",
      severity: "error",
      message: "Expression literal value must be a JSON primitive.",
      path: "$.value",
    }]);
    expect(validateExprIR({ kind: "literal", value: [] } as any)).toEqual([{
      code: "EX002",
      severity: "error",
      message: "Expression literal value must be a JSON primitive.",
      path: "$.value",
    }]);
    expect(validateExprIR({ kind: "literal", value: {} } as any)).toEqual([{
      code: "EX002",
      severity: "error",
      message: "Expression literal value must be a JSON primitive.",
      path: "$.value",
    }]);
    expect(validateExprIR({
      kind: "template",
      parts: [{ kind: "text" }],
    } as any)).toEqual([{
      code: "EX002",
      severity: "error",
      message: "Template text value must be a string.",
      path: "$.parts[0].value",
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
    expect(validateExprIR({ kind: "template", parts } as any)).toEqual([{
      code: "EX002",
      severity: "error",
      message: "Array values must not contain sparse holes.",
      path: "$.parts[0]",
    }]);
  });

  it("rejects malformed templates", () => {
    expect(validateExprIR({
      kind: "template",
      parts: [{ kind: "unknown" }],
    } as any)).toEqual([{
      code: "EX002",
      severity: "error",
      message: "Unknown template part kind 'unknown'.",
      path: "$.parts[0].kind",
    }]);
  });
});
