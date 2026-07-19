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
});
