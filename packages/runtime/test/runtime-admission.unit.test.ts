import { describe, expect, it } from "vitest";
import type { WorkflowIR } from "@acpus/core/ir";
import { normalizeWorkflowInput } from "@acpus/runtime";
import { normalizeSignalPayload } from "../src/admission/input.js";

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

    expect(normalizeWorkflowInput(ir, {
      patch: { kind: "artifact", uri: "artifact://patch", mediaType: "text/plain" },
      token: "API_TOKEN",
    })).toEqual({
      base: "main",
      patch: { kind: "artifact", uri: "artifact://patch", mediaType: "text/plain" },
      token: "API_TOKEN",
    });
    expect(() => normalizeWorkflowInput(ir, {
      patch: { kind: "artifact", uri: "artifact://patch", mediaType: "application/json" },
      token: "API_TOKEN",
    })).toThrow("$.patch.mediaType expected literal \"text/plain\"");
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

    expect(normalizeSignalPayload(ir, "raw", "approved")).toBe("approved");
    expect(() => normalizeSignalPayload(ir, "raw", { text: "approved" })).toThrow("Signal payload expected string.");
    expect(normalizeSignalPayload(ir, "structured", { ok: true })).toEqual({ ok: true });
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
    irVersion: 5,
    name: "normalization",
    agents: {},
    inputSchema: { kind: "object", fields: {}, required: [], additionalProperties: false },
    diagnostics: [],
    ...rest,
    root: root ?? { nodes: nodes ?? [], output },
  } as WorkflowIR;
}
