import { describe, expect, it } from "vitest";
import { safeParseSchema, toSchemaIR, tryToSchemaIR, z } from "../src/schema.js";
import { err } from "neverthrow";

describe("schema boundary lowering", () => {
  it("exposes only the current Acpus schema helper surface", () => {
    expect(typeof z.path).toBe("function");
    expect("integer" in z).toBe(false);
    expect("artifact" in z).toBe(false);
    expect("secretRef" in z).toBe(false);
  });

  it("lowers the supported Zod boundary subset to durable SchemaIR", () => {
    const schema = z.object({
      repoPath: z.path(),
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
    expect(ir.fields.repoPath).toEqual({ kind: "path" });
    expect(ir.fields.count).toEqual({ kind: "number" });
    expect(ir.fields.maybeSummary).toEqual({ kind: "string", nullable: true, optional: true });
    expect(ir.fields.tags).toEqual({ kind: "array", item: { kind: "string" } });
    expect(ir.fields.scores).toEqual({ kind: "record", value: { kind: "number" } });
  });

  it("preserves Zod descriptions in durable SchemaIR", () => {
    const schema = z.object({
      repoPath: z.path().describe("Repository path."),
      title: z.string().describe("Human-readable title."),
      notes: z.string().default("").describe("Optional notes."),
    }).describe("Workflow input.");

    expect(toSchemaIR(schema)).toMatchObject({
      kind: "object",
      description: "Workflow input.",
      fields: {
        repoPath: { kind: "path", description: "Repository path." },
        title: { kind: "string", description: "Human-readable title." },
        notes: { kind: "string", optional: true, default: "", description: "Optional notes." },
      },
    });
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

  it("normalizes validation issues to Acpus paths", () => {
    const result = safeParseSchema(z.object({ ready: z.boolean() }), { ready: "yes" });

    expect(result).toEqual({
      success: false,
      issues: [
        expect.objectContaining({
          path: "$.ready",
          expected: "invalid_type",
        }),
      ],
    });
  });
});
