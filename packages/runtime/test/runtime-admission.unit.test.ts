import { describe, expect, it } from "vitest";
import type { WorkflowIR } from "@acpus/core/ir";
import { tryNormalizeWorkflowInput } from "@acpus/runtime";
import { tryNormalizeSignalPayload } from "../src/admission/input.js";

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

    expect(tryNormalizeWorkflowInput(ir, {
      patch: { kind: "artifact", uri: "artifact://patch", mediaType: "text/plain" },
      token: "API_TOKEN",
    })._unsafeUnwrap()).toEqual({
      base: "main",
      patch: { kind: "artifact", uri: "artifact://patch", mediaType: "text/plain" },
      token: "API_TOKEN",
    });
    expect(tryNormalizeWorkflowInput(ir, {
      patch: { kind: "artifact", uri: "artifact://patch", mediaType: "application/json" },
      token: "API_TOKEN",
    })._unsafeUnwrapErr()).toMatchObject({ type: "schema-mismatch", path: "$.patch.mediaType", expected: "literal \"text/plain\"" });
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

    expect(tryNormalizeSignalPayload(ir, "raw", "approved")._unsafeUnwrap()).toBe("approved");
    expect(tryNormalizeSignalPayload(ir, "raw", { text: "approved" })._unsafeUnwrapErr()).toMatchObject({ type: "signal-payload-invalid" });
    expect(tryNormalizeSignalPayload(ir, "structured", { ok: true })._unsafeUnwrap()).toEqual({ ok: true });
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
