import type { SchemaIR } from "@acpus/core/ir";
import type { JsonValue } from "@acpus/expression/ir";
import { describe, expect, it } from "vitest";
import { tryNormalizeValue } from "../src/evaluation/schema.js";

const schema: SchemaIR = {
  kind: "object",
  fields: { ok: { kind: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};

describe("schema normalization", () => {
  it("returns a tagged path and expected type for a schema mismatch", () => {
    const normalized = tryNormalizeValue(schema, { ok: "yes" }, "Node output");

    expect(normalized.isErr() && normalized.error).toEqual({
      type: "schema-mismatch",
      label: "Node output",
      path: "$.ok",
      expected: "boolean",
      actual: "string",
      message: "Node output does not match schema: $.ok expected boolean, got string.",
    });
  });

  it("does not turn an unexpected object inspection failure into a schema mismatch", () => {
    const sentinel = { type: "inspection-failed" };
    const value = new Proxy({ ok: true }, { ownKeys: () => { throw sentinel; } }) as JsonValue;
    let caught: unknown;

    try {
      tryNormalizeValue(schema, value, "Node output");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(sentinel);
  });

  it("does not satisfy a required constructor field through inheritance", () => {
    const required: SchemaIR = {
      kind: "object",
      fields: { constructor: { kind: "boolean" as const } },
      required: ["constructor"],
      additionalProperties: false,
    };

    const normalized = tryNormalizeValue(required, {}, "Node output");

    expect(normalized.isErr() && normalized.error).toMatchObject({
      type: "schema-mismatch",
      path: "$.constructor",
      actual: "missing",
    });
  });

  it("applies a __proto__ default as an own data property", () => {
    const withDefault: SchemaIR = {
      kind: "object",
      fields: { ["__proto__"]: { kind: "boolean", optional: true, default: true } },
      required: [],
      additionalProperties: false,
    };

    const normalized = tryNormalizeValue(withDefault, {}, "Node output");

    expect(normalized.isOk()).toBe(true);
    if (normalized.isErr() || typeof normalized.value !== "object" || normalized.value === null || Array.isArray(normalized.value)) throw new Error("expected object output");
    expect(Object.hasOwn(normalized.value, "__proto__")).toBe(true);
    expect(normalized.value.__proto__).toBe(true);
    expect(Object.getPrototypeOf(normalized.value)).toBe(Object.prototype);
  });

  it.each([
    { kind: "unknown" } satisfies SchemaIR,
    { kind: "literal", value: null } satisfies SchemaIR,
    { kind: "enum", values: [null] } satisfies SchemaIR,
    { kind: "union", variants: [{ kind: "string" }, { kind: "null" }] } satisfies SchemaIR,
  ])("accepts null according to $kind schema semantics", schema => {
    expect(tryNormalizeValue(schema, null, "Node output")._unsafeUnwrap()).toBeNull();
  });

  it("rejects an undeclared own __proto__ field", () => {
    const closed: SchemaIR = { kind: "object", fields: {}, required: [], additionalProperties: false };

    expect(tryNormalizeValue(closed, { ["__proto__"]: true }, "Node output")._unsafeUnwrapErr()).toMatchObject({
      type: "schema-mismatch",
      path: "$.__proto__",
      actual: "additional property",
    });
  });
});
