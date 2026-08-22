import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";
import type { WorkflowIR } from "@acpus/core/ir";
import { tryNormalizeSignalPayload, tryNormalizeWorkflowInput } from "../src/admission/input.js";

describe("runtime admission normalization", () => {
  it("applies input defaults and rejects invalid artifact ref objects", () => {
    const ir = workflow({
      inputSchema: {
        kind: "object",
        fields: {
          base: { kind: "string", optional: true, default: "main" },
          patch: {
            kind: "object",
            fields: {
              kind: { kind: "literal", value: "artifact" },
              uri: { kind: "string" },
              mediaType: { kind: "literal", value: "text/plain" },
            },
            required: ["kind", "uri", "mediaType"],
            additionalProperties: false,
          },
          token: { kind: "string" },
        },
        required: ["patch", "token"],
        additionalProperties: false,
      },
    });

    expect(Result.getOrThrow(tryNormalizeWorkflowInput(ir, {
      patch: { kind: "artifact", uri: "artifact://patch", mediaType: "text/plain" },
      token: "API_TOKEN",
    }))).toEqual({
      base: "main",
      patch: { kind: "artifact", uri: "artifact://patch", mediaType: "text/plain" },
      token: "API_TOKEN",
    });
    expect(Result.getOrThrow(Result.flip(tryNormalizeWorkflowInput(ir, {
      patch: { kind: "artifact", uri: "artifact://patch", mediaType: "application/json" },
      token: "API_TOKEN",
    })))).toMatchObject({ type: "schema-mismatch", path: "$.patch.mediaType", expected: "literal \"text/plain\"" });
  });

  it("normalizes schema-backed signal payloads and requires raw strings without schema", () => {
    const ir = workflow({
      output: { kind: "object", fields: {} },
      nodes: [
        {
          id: "raw",
          kind: "signal",
          run: { prompt: { kind: "literal", value: "" } },
        },
        {
          id: "structured",
          kind: "signal",
          outputSchema: {
            kind: "object",
            fields: { ok: { kind: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
          run: { prompt: { kind: "literal", value: "" } },
        },
      ],
    });

    expect(Result.getOrThrow(tryNormalizeSignalPayload(ir, "raw", "approved"))).toBe("approved");
    expect(Result.getOrThrow(Result.flip(tryNormalizeSignalPayload(ir, "raw", { text: "approved" })))).toMatchObject({ type: "signal-payload-invalid" });
    expect(Result.getOrThrow(tryNormalizeSignalPayload(ir, "structured", { ok: true }))).toEqual({ ok: true });
  });
});

type WorkflowParts = Partial<Omit<WorkflowIR, "root">> & {
  nodes?: WorkflowIR["root"]["nodes"];
  output?: WorkflowIR["root"]["output"];
  root?: WorkflowIR["root"];
};

function workflow(partial: WorkflowParts = {}): WorkflowIR {
  const { nodes, output = { kind: "object", fields: {} }, root, ...rest } = partial;
  return {
    irVersion: 8,
    name: "normalization",
    agents: {},
    inputSchema: { kind: "object", fields: {}, required: [], additionalProperties: false },
    diagnostics: [],
    ...rest,
    root: root ?? { nodes: nodes ?? [], output },
  } as WorkflowIR;
}
