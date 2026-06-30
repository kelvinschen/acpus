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
    expect(validateExprIR({ kind: "call", fn: "all", args: [] })).toEqual([{
      code: "EX001",
      severity: "error",
      message: "Unknown expression operator 'all'.",
      path: "$.fn",
    }]);
    expect(validateExprIR({ kind: "call", fn: "any", args: [] })).toEqual([{
      code: "EX001",
      severity: "error",
      message: "Unknown expression operator 'any'.",
      path: "$.fn",
    }]);
  });

  it("validates arity and lambda placement", () => {
    expect(validateExprIR({ kind: "call", fn: "eq", args: [{ kind: "literal", value: true }] })).toEqual([{
      code: "EX003",
      severity: "error",
      message: "eq(...) expected 2 args, got 1.",
      path: "$.args",
    }]);
    expect(validateExprIR({
      kind: "call",
      fn: "eq",
      args: [
        { kind: "lambda", params: [{ id: "v0" }], body: { kind: "var", id: "v0", path: [] } },
        { kind: "literal", value: true },
      ],
    })).toEqual([{
      code: "EX004",
      severity: "error",
      message: "Lambda expression is not allowed here.",
      path: "$.args[0]",
    }]);
    expect(validateExprIR({
      kind: "call",
      fn: "map",
      args: [
        { kind: "ref", path: ["input", "items"] },
        { kind: "literal", value: true },
      ],
    })).toEqual([{
      code: "EX004",
      severity: "error",
      message: "map(...) expected lambda callback.",
      path: "$.args[1]",
    }]);
  });

  it("validates lambda var scope", () => {
    expect(validateExprIR({
      kind: "call",
      fn: "map",
      args: [
        { kind: "ref", path: ["input", "items"] },
        { kind: "lambda", params: [{ id: "v0" }], body: { kind: "var", id: "missing", path: [] } },
      ],
    })).toEqual([{
      code: "EX005",
      severity: "error",
      message: "Unbound expression variable 'missing'.",
      path: "$.args[1].body",
    }]);
  });

  it("validates duplicate lambda params and obvious type conflicts", () => {
    expect(validateExprIR({
      kind: "call",
      fn: "map",
      args: [
        { kind: "ref", path: ["input", "items"] },
        {
          kind: "lambda",
          params: [{ id: "v0" }, { id: "v0" }],
          body: { kind: "var", id: "v0", path: [] },
        },
      ],
    })).toEqual([{
      code: "EX007",
      severity: "error",
      message: "Duplicate lambda param id 'v0'.",
      path: "$.args[1].params[1].id",
    }]);
    expect(validateExprIR({ kind: "literal", value: true, type: { kind: "number" } })).toEqual([{
      code: "EX008",
      severity: "error",
      message: "Literal type metadata does not match literal value.",
      path: "$.type",
    }]);
    expect(validateExprIR({
      kind: "call",
      fn: "map",
      args: [
        { kind: "ref", path: ["input", "groups"] },
        {
          kind: "lambda",
          params: [{ id: "v0" }],
          body: {
            kind: "call",
            fn: "map",
            args: [
              { kind: "var", id: "v0", path: ["items"] },
              {
                kind: "lambda",
                params: [{ id: "v0" }, { id: "v0" }],
                body: { kind: "var", id: "v0", path: [] },
              },
            ],
          },
        },
      ],
    })).toEqual([{
      code: "EX007",
      severity: "error",
      message: "Duplicate lambda param id 'v0'.",
      path: "$.args[1].body.args[1].params[1].id",
    }]);
  });

  it("validates malformed expression shapes", () => {
    expect(validateExprIR({ kind: "literal", value: undefined } as any)).toEqual([{
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

  it("validates closed shapes, sparse arrays, and required var paths", () => {
    expect(validateExprIR({ kind: "ref", path: ["input"], extra: true } as any)).toEqual([{
      code: "EX002",
      severity: "error",
      message: "Unknown expression field 'extra'.",
      path: "$.extra",
    }]);

    expect(validateExprIR({
      kind: "call",
      fn: "map",
      args: [
        { kind: "ref", path: ["input", "items"] },
        { kind: "lambda", params: [{ id: "v0" }], body: { kind: "var", id: "v0" } },
      ],
    } as any)).toContainEqual({
      code: "EX006",
      severity: "error",
      message: "Expression var path must be a string array.",
      path: "$.args[1].body.path",
    });

    const args = new Array(2);
    expect(validateExprIR({ kind: "call", fn: "eq", args } as any)).toEqual([
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

  it("validates type metadata and removed lambda return type fields", () => {
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

    expect(validateExprIR({
      kind: "call",
      fn: "map",
      args: [
        { kind: "ref", path: ["input", "items"] },
        { kind: "lambda", params: [{ id: "v0" }], body: { kind: "var", id: "v0", path: [] }, returnType: { kind: "string" } },
      ],
    } as any)).toContainEqual({
      code: "EX002",
      severity: "error",
      message: "Unknown expression field 'returnType'.",
      path: "$.args[1].returnType",
    });
  });

  it("rejects malformed templates and zero-arg coalesce", () => {
    expect(validateExprIR({
      kind: "template",
      template: { kind: "not_template", parts: [] },
    } as any)).toEqual([{
      code: "EX002",
      severity: "error",
      message: "Expression template must contain template parts.",
      path: "$.template",
    }]);

    expect(validateExprIR({ kind: "call", fn: "coalesce", args: [] })).toEqual([{
      code: "EX003",
      severity: "error",
      message: "coalesce(...) expected at least 1 args, got 0.",
      path: "$.args",
    }]);
  });
});
