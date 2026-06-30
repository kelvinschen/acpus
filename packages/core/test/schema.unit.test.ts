import { describe, expect, it } from "vitest";
import { safeParseSchema, toSchemaIR, z } from "../src/schema.js";

describe("schema boundary lowering", () => {
  it("lowers the supported Zod boundary subset to durable SchemaIR", () => {
    const schema = z.object({
      repoPath: z.path(),
      patch: z.artifact("text/x-patch"),
      token: z.secretRef().optional(),
      count: z.number().int(),
      retries: z.integer(),
      maybeSummary: z.string().nullable().optional(),
      mode: z.enum(["fast", "safe"]),
      tags: z.array(z.string()),
      scores: z.record(z.string(), z.number()),
    });

    const ir = toSchemaIR(schema);

    expect(ir).toMatchObject({
      kind: "object",
      additionalProperties: false,
      required: ["repoPath", "patch", "count", "retries", "mode", "tags", "scores"],
    });
    if (ir.kind !== "object") throw new Error("expected object schema");
    expect(ir.fields.repoPath).toEqual({ kind: "path" });
    expect(ir.fields.patch).toEqual({ kind: "artifact", mediaType: "text/x-patch" });
    expect(ir.fields.token).toEqual({ kind: "secret_ref", optional: true });
    expect(ir.fields.retries).toEqual({ kind: "number" });
    expect(ir.fields.maybeSummary).toEqual({ kind: "string", nullable: true, optional: true });
    expect(ir.fields.tags).toEqual({ kind: "array", item: { kind: "string" } });
    expect(ir.fields.scores).toEqual({ kind: "record", value: { kind: "number" } });
  });

  it("rejects unsupported graph-boundary schemas with the failing path", () => {
    expect(() => toSchemaIR(z.object({ createdAt: z.date() }))).toThrow(
      "$schema.createdAt: Zod 'date' is not supported as an Acpus graph-boundary schema",
    );
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
