import { describe, expect, it } from "vitest";
import { compileSchemaDsl } from "../src/schema/dsl.js";

describe("compileSchemaDsl", () => {
  it("exposes recursive schema DSL compiler as an independent module", () => {
    expect(compileSchemaDsl({
      issues: [{ description: "string", "severity?": "string" }]
    }).schema).toEqual({
      type: "object",
      properties: {
        issues: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              severity: { type: "string" }
            },
            additionalProperties: false,
            required: ["description"]
          }
        }
      },
      additionalProperties: false,
      required: ["issues"]
    });
  });

  it("compiles an empty object to a closed object with empty properties", () => {
    const result = compileSchemaDsl({});
    expect(result.errors).toEqual([]);
    expect(result.schema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("compiles a single required field", () => {
    const result = compileSchemaDsl({ name: "string" });
    expect(result.errors).toEqual([]);
    expect(result.schema).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
      required: ["name"],
    });
  });

  it("compiles output with only optional fields (no required array)", () => {
    const result = compileSchemaDsl({ "name?": "string" });
    expect(result.errors).toEqual([]);
    expect(result.schema).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    });
    expect(result.schema).not.toHaveProperty("required");
  });

  it("compiles deeply nested objects (3+ levels)", () => {
    const result = compileSchemaDsl({
      level1: {
        level2: {
          level3: {
            value: "integer",
          },
        },
      },
    });
    expect(result.errors).toEqual([]);
    expect(result.schema).toEqual({
      type: "object",
      properties: {
        level1: {
          type: "object",
          properties: {
            level2: {
              type: "object",
              properties: {
                level3: {
                  type: "object",
                  properties: {
                    value: { type: "integer" },
                  },
                  additionalProperties: false,
                  required: ["value"],
                },
              },
              additionalProperties: false,
              required: ["level3"],
            },
          },
          additionalProperties: false,
          required: ["level2"],
        },
      },
      additionalProperties: false,
      required: ["level1"],
    });
  });

  it("resolves type aliases: int, str, bool, num", () => {
    const result = compileSchemaDsl({
      count: "int",
      label: "str",
      active: "bool",
      score: "num",
    });
    expect(result.errors).toEqual([]);
    expect(result.schema.properties).toEqual({
      count: { type: "integer" },
      label: { type: "string" },
      active: { type: "boolean" },
      score: { type: "number" },
    });
  });

  it("accepts case-insensitive type names", () => {
    const result = compileSchemaDsl({
      a: "String",
      b: "INTEGER",
      c: "Bool",
    });
    expect(result.errors).toEqual([]);
    expect(result.schema.properties).toEqual({
      a: { type: "string" },
      b: { type: "integer" },
      c: { type: "boolean" },
    });
  });

  it("compiles bare 'object' type with additionalProperties: false", () => {
    const result = compileSchemaDsl({ meta: "object" });
    expect(result.errors).toEqual([]);
    expect(result.schema.properties.meta).toEqual({
      type: "object",
      additionalProperties: false,
    });
  });

  it("compiles bare 'array' type without items constraint", () => {
    const result = compileSchemaDsl({ tags: "array" });
    expect(result.errors).toEqual([]);
    expect(result.schema.properties.tags).toEqual({ type: "array" });
  });

  it("parses default values in string shorthand", () => {
    const result = compileSchemaDsl({
      count: "integer = 5",
      ratio: "number = 3.14",
      flag: "boolean = true",
      label: "string = hello",
      "opt?": "string = 'quoted'",
      nothing: "string = null",
    });
    expect(result.errors).toEqual([]);
    expect(result.schema.properties.count).toEqual({ type: "integer", default: 5 });
    expect(result.schema.properties.ratio).toEqual({ type: "number", default: 3.14 });
    expect(result.schema.properties.flag).toEqual({ type: "boolean", default: true });
    expect(result.schema.properties.label).toEqual({ type: "string", default: "hello" });
    expect(result.schema.properties.opt).toEqual({ type: "string", default: "quoted" });
    expect(result.schema.properties.nothing).toEqual({ type: "string", default: null });
    // Fields with defaults are implicitly optional — not in required array
    const required = (result.schema.required as string[]) ?? [];
    expect(required).not.toContain("count");
    expect(required).not.toContain("opt");
  });

  it("compiles object-form with required, default, and description", () => {
    const result = compileSchemaDsl({
      name: { type: "string", required: true, description: "User name" },
      role: { type: "string", default: "viewer", description: "User role" },
      "opt?": { type: "integer", required: false, default: 0 },
    });
    expect(result.errors).toEqual([]);
    expect(result.schema.properties.name).toEqual({
      type: "string",
      description: "User name",
    });
    expect(result.schema.properties.role).toEqual({
      type: "string",
      default: "viewer",
      description: "User role",
    });
    expect(result.schema.properties.opt).toEqual({
      type: "integer",
      default: 0,
    });
    // name is required (explicit required: true overrides key optional)
    // role is not required (has default, no explicit required)
    // opt is not required (explicit required: false)
    expect(result.schema.required).toEqual(["name"]);
  });

  it("rejects invalid type names", () => {
    const result = compileSchemaDsl({ bad: "notatype" });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("Invalid type 'notatype'");
    expect(result.errors[0].message).toContain("string, integer, number, boolean, array, object");
  });

  it("rejects invalid field value types (number, boolean, null)", () => {
    const numResult = compileSchemaDsl({ bad: 42 as unknown as string });
    expect(numResult.errors).toHaveLength(1);
    expect(numResult.errors[0].message).toContain("must be a type string");

    const boolResult = compileSchemaDsl({ bad: true as unknown as string });
    expect(boolResult.errors).toHaveLength(1);

    const nullResult = compileSchemaDsl({ bad: null as unknown as string });
    expect(nullResult.errors).toHaveLength(1);
  });

  it("rejects unsupported object-form key 'items' with DSL hint", () => {
    const result = compileSchemaDsl({
      list: { type: "array", items: { type: "string" } } as Record<string, unknown>,
    });
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    const itemsError = result.errors.find(e => e.message.includes("Unsupported object-form key 'items'"));
    expect(itemsError).toBeDefined();
    expect(itemsError!.message).toContain("recursive DSL instead of raw schema keys");
  });

  it("rejects unsupported object-form key 'properties' with DSL hint", () => {
    const result = compileSchemaDsl({
      obj: { type: "object", properties: { x: { type: "string" } } } as Record<string, unknown>,
    });
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    const propsError = result.errors.find(e => e.message.includes("Unsupported object-form key 'properties'"));
    expect(propsError).toBeDefined();
    expect(propsError!.message).toContain("recursive DSL instead of raw schema keys");
  });

  it("rejects generic unsupported object-form keys without DSL hint", () => {
    const result = compileSchemaDsl({
      field: { type: "string", minItems: 1 } as Record<string, unknown>,
    });
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    const minItemsError = result.errors.find(e => e.message.includes("Unsupported object-form key 'minItems'"));
    expect(minItemsError).toBeDefined();
    expect(minItemsError!.message).not.toContain("recursive DSL instead of raw schema keys");
  });

  it("reports both unsupported keys and invalid type in object-form", () => {
    const result = compileSchemaDsl({
      field: { type: "bogus", items: "string" } as Record<string, unknown>,
    });
    // Should report the unsupported key 'items' AND the invalid type 'bogus'
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    expect(result.errors.some(e => e.message.includes("Unsupported object-form key 'items'"))).toBe(true);
    expect(result.errors.some(e => e.message.includes("Invalid type 'bogus'"))).toBe(true);
  });

  it("rejects empty array schema (must have exactly one item)", () => {
    const result = compileSchemaDsl({ items: [] });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("exactly one item schema");
  });

  it("rejects array schema with more than one item", () => {
    const result = compileSchemaDsl({ items: ["string", "integer"] });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("exactly one item schema");
  });

  it("compiles array of objects where object has no required fields", () => {
    const result = compileSchemaDsl({
      items: [{ "a?": "string", "b?": "integer" }],
    });
    expect(result.errors).toEqual([]);
    const itemsSchema = result.schema.properties.items as Record<string, unknown>;
    const innerProps = (itemsSchema.items as Record<string, unknown>).properties as Record<string, unknown>;
    expect(innerProps).toEqual({
      a: { type: "string" },
      b: { type: "integer" },
    });
    // No required fields in the array item object
    expect((itemsSchema.items as Record<string, unknown>)).not.toHaveProperty("required");
  });

  it("mixes object-form and shorthand fields in the same schema", () => {
    const result = compileSchemaDsl({
      name: "string",
      role: { type: "string", default: "viewer" },
      count: "integer = 0",
    });
    expect(result.errors).toEqual([]);
    expect(result.schema.properties).toEqual({
      name: { type: "string" },
      role: { type: "string", default: "viewer" },
      count: { type: "integer", default: 0 },
    });
    // Only 'name' is required (role and count have defaults)
    expect(result.schema.required).toEqual(["name"]);
  });
});
