import { describe, expect, it } from "vitest";
import type { WorkflowIR } from "@acpus/core/ir";
import { normalizeSignalPayload, normalizeWorkflowInput } from "@acpus/runtime";

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
      nodes: [
        {
          id: "raw",
          kind: "signal",
          run: { kind: "signal_run", prompt: { kind: "template", parts: [] } },
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
          run: { kind: "signal_run", prompt: { kind: "template", parts: [] } },
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
  root?: WorkflowIR["root"];
};

function workflow(partial: WorkflowParts = {}): WorkflowIR {
  const { nodes, root, ...rest } = partial;
  return {
    irVersion: 2,
    name: "normalization",
    agents: {},
    inputSchema: { kind: "object", fields: {}, required: [], additionalProperties: false },
    outputs: {},
    lock: { acpusCoreVersion: "test", generatedAt: "2026-06-30T00:00:00.000Z", notes: [] },
    diagnostics: [],
    ...rest,
    root: root ?? { nodes: nodes ?? [] },
  } as WorkflowIR;
}
