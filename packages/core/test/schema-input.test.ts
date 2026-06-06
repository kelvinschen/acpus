import { describe, expect, it } from "vitest";
import { compileInputSchema } from "../src/schema/input.js";

describe("compileInputSchema", () => {
  it("compiles flat-map shorthand fields", () => {
    const { schema, errors } = compileInputSchema({ feature: "string" });
    expect(errors).toEqual([]);
    expect(schema).toEqual({
      type: "object",
      properties: { feature: { type: "string" } },
      required: ["feature"]
    });
  });

  it("compiles optional fields with defaults", () => {
    const { schema, errors } = compileInputSchema({
      topic: "string",
      "depth?": "integer = 2"
    });
    expect(errors).toEqual([]);
    expect(schema).toEqual({
      type: "object",
      properties: {
        topic: { type: "string" },
        depth: { type: "integer", default: 2 }
      },
      required: ["topic"]
    });
  });

  it("rejects invalid type names", () => {
    const { errors } = compileInputSchema({ feature: "notarealtype" });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("Invalid type 'notarealtype'");
  });

  it("compiles object-form fields with description and default", () => {
    const { schema, errors } = compileInputSchema({
      name: { type: "string", required: true, description: "User name" },
      role: { type: "string", default: "viewer" },
    });
    expect(errors).toEqual([]);
    expect(schema.properties!.name).toEqual({ type: "string", description: "User name" });
    expect(schema.properties!.role).toEqual({ type: "string", default: "viewer" });
    expect(schema.required).toEqual(["name"]);
  });

  it("rejects field values that are neither string nor object", () => {
    const { errors } = compileInputSchema({ bad: 42 as unknown as string });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("must be a type string or an object");
  });

  it("rejects object-form without a type key", () => {
    const { errors } = compileInputSchema({ bad: { required: true } as Record<string, unknown> });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("must include a string 'type'");
  });
});
