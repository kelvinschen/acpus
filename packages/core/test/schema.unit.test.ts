import { describe, expect, it } from "vitest";
import { safeParseSchema, toSchemaIR, z } from "../src/index.js";

describe("schema boundary lowering", () => {
  it("lowers the supported Zod boundary subset to durable SchemaIR", () => {
    const schema = z.object({
      repoPath: z.path(),
      patch: z.artifact("text/x-patch"),
      token: z.secretRef().optional(),
      count: z.number().int(),
      maybeSummary: z.string().nullable().optional(),
      mode: z.enum(["fast", "safe"]),
      tags: z.array(z.string()),
      scores: z.record(z.string(), z.number()),
    });

    expect(toSchemaIR(schema)).toEqual({
      kind: "object",
      additionalProperties: false,
      required: ["repoPath", "patch", "count", "mode", "tags", "scores"],
      fields: {
        repoPath: { kind: "path" },
        patch: { kind: "artifact", mediaType: "text/x-patch" },
        token: { kind: "secret_ref", optional: true },
        count: { kind: "integer" },
        maybeSummary: { kind: "string", nullable: true, optional: true },
        mode: { kind: "enum", values: ["fast", "safe"] },
        tags: { kind: "array", item: { kind: "string" } },
        scores: { kind: "record", key: { kind: "string" }, value: { kind: "number" } },
      },
    });
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
