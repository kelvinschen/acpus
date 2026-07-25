import { describe, expect, it } from "vitest";
import { schemaToJsonSchema, toSchemaIR, tryToSchemaIR, z } from "../src/schema.js";
import { err } from "neverthrow";

describe("schema boundary lowering", () => {
  it("lowers the supported Zod boundary subset to durable SchemaIR", () => {
    const schema = z.object({
      repoPath: z.string(),
      count: z.number().int(),
      maybeSummary: z.string().nullable().optional(),
      mode: z.enum(["fast", "safe"]),
      tags: z.array(z.string()),
      scores: z.record(z.string(), z.number()),
    });

    const ir = toSchemaIR(schema);

    expect(ir).toMatchObject({
      kind: "object",
      additionalProperties: false,
      required: ["repoPath", "count", "mode", "tags", "scores"],
    });
    if (ir.kind !== "object") throw new Error("expected object schema");
    expect(ir.fields.repoPath).toEqual({ kind: "string" });
    expect(ir.fields.count).toEqual({ kind: "number" });
    expect(ir.fields.maybeSummary).toEqual({ kind: "string", nullable: true, optional: true });
    expect(ir.fields.tags).toEqual({ kind: "array", item: { kind: "string" } });
    expect(ir.fields.scores).toEqual({ kind: "record", value: { kind: "number" } });
  });

  it("preserves Zod descriptions in durable SchemaIR", () => {
    const schema = z.object({
      repoPath: z.string().describe("Repository path."),
      title: z.string().describe("Human-readable title."),
      notes: z.string().default("").describe("Optional notes."),
    }).describe("Workflow input.");

    expect(toSchemaIR(schema)).toMatchObject({
      kind: "object",
      description: "Workflow input.",
      fields: {
        repoPath: { kind: "string", description: "Repository path." },
        title: { kind: "string", description: "Human-readable title." },
        notes: { kind: "string", optional: true, default: "", description: "Optional notes." },
      },
    });
  });

  it("lowers non-empty homogeneous Zod tuples to unbounded array schemas", () => {
    const Choice = z.object({ label: z.string(), risk: z.string() });
    const tuple = z.tuple([Choice, Choice, Choice]).describe("Three choices.");

    expect(toSchemaIR(tuple)).toEqual({
      kind: "array",
      item: {
        kind: "object",
        fields: {
          label: { kind: "string" },
          risk: { kind: "string" },
        },
        required: ["label", "risk"],
        additionalProperties: false,
      },
      description: "Three choices.",
    });
    expect(toSchemaIR(z.tuple([z.string(), z.string()]))).toEqual({
      kind: "array",
      item: { kind: "string" },
    });
    expect(schemaToJsonSchema(toSchemaIR(tuple))).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          risk: { type: "string" },
        },
        required: ["label", "risk"],
        additionalProperties: false,
      },
      description: "Three choices.",
    });
  });

  it("renders SchemaIR metadata without adding undefined to optional fields", () => {
    const schema = z.object({
      label: z.string(),
      note: z.string().nullable().optional().describe("Optional note."),
      retries: z.number().default(2).describe("Retry count."),
    }).describe("Agent output.");

    expect(schemaToJsonSchema(toSchemaIR(schema))).toEqual({
      type: "object",
      properties: {
        label: { type: "string" },
        note: {
          anyOf: [{ type: "string" }, { type: "null" }],
          description: "Optional note.",
        },
        retries: {
          type: "number",
          description: "Retry count.",
          default: 2,
        },
      },
      required: ["label"],
      additionalProperties: false,
      description: "Agent output.",
    });
  });

  it("preserves prototype-named fields and defaults as own data properties", () => {
    const schema = z.object({ ["__proto__"]: z.boolean() });
    const ir = toSchemaIR(schema);
    if (ir.kind !== "object") throw new Error("expected object schema");

    expect(Object.keys(ir.fields)).toEqual(["__proto__"]);
    expect(Object.hasOwn(ir.fields, "__proto__")).toBe(true);
    const rendered = schemaToJsonSchema(ir) as { properties: Record<string, unknown> };
    expect(Object.keys(rendered.properties)).toEqual(["__proto__"]);
    expect(rendered.properties.__proto__).toEqual({ type: "boolean" });

    const defaultValue = Object.fromEntries([["__proto__", true]]);
    const defaulted = toSchemaIR(z.unknown().default(defaultValue));
    expect(defaulted.default).toEqual(defaultValue);
    expect(defaulted.default && typeof defaulted.default === "object" && Object.hasOwn(defaulted.default, "__proto__")).toBe(true);
    expect(schemaToJsonSchema(defaulted)).toEqual({ default: defaultValue });
  });

  it("preserves the failing index path inside a homogeneous tuple candidate", () => {
    expect(tryToSchemaIR(z.object({ values: z.tuple([z.string(), z.date()]) }))).toEqual(err({
      type: "unsupported-schema",
      path: "$schema.values[1]",
      schemaKind: "date",
      message: "$schema.values[1]: Zod 'date' is not supported as an Acpus graph-boundary schema",
    }));
  });

  it("rejects unsupported graph-boundary schemas with the failing path", () => {
    expect(() => toSchemaIR(z.object({ createdAt: z.date() }))).toThrow(
      "$schema.createdAt: Zod 'date' is not supported as an Acpus graph-boundary schema",
    );
  });

  it("returns tagged lowering errors for unsupported schemas", () => {
    expect(tryToSchemaIR(z.object({ createdAt: z.date() }))).toEqual(err({
      type: "unsupported-schema",
      path: "$schema.createdAt",
      schemaKind: "date",
      message: "$schema.createdAt: Zod 'date' is not supported as an Acpus graph-boundary schema",
    }));
  });

  it("returns tagged lowering errors for non-JSON literal values", () => {
    expect(tryToSchemaIR(z.literal(Number.NaN))).toEqual(err({
      type: "invalid-literal",
      path: "$schema",
      valueType: "number",
      message: "$schema: literal/enum value NaN is not JSON-serializable",
    }));
  });

  it("returns tagged lowering errors for non-JSON default values", () => {
    expect(tryToSchemaIR(z.any().default(Number.NaN))).toEqual(err({
      type: "invalid-default",
      path: "$schema",
      valueType: "number",
      message: "$schema: default value is not JSON-serializable",
    }));
  });

  it("returns a tagged lowering error for cyclic defaults instead of throwing", () => {
    const value: Record<string, unknown> = {};
    value.self = value;

    expect(tryToSchemaIR(z.unknown().default(() => value))).toEqual(err({
      type: "invalid-default",
      path: "$schema",
      valueType: "object",
      message: "$schema: default value is not JSON-serializable",
    }));
  });

  it("returns a tagged lowering error when a JSON-like default cannot be cloned", () => {
    const value = new Proxy({ label: "valid" }, {});

    expect(tryToSchemaIR(z.unknown().default(() => value))).toEqual(err({
      type: "invalid-default",
      path: "$schema",
      valueType: "object",
      message: "$schema: default value is not JSON-serializable",
    }));
  });
});
