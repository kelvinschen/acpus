import { describe, expect, it } from "vitest";
import type { WorkflowIR } from "@acpus/core/ir";
import { tryNormalizeWorkflowInput } from "@acpus/runtime";
import { tryNormalizeSignalPayload } from "../src/admission/input.js";
import { tryValidatePreparedRunWorkflow } from "../src/store/store.js";
import { preparedWorkflow } from "./support/runtime-fixtures.js";

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

  it("rejects self-consistent invalid frozen IR while allowing warning diagnostics", () => {
    const cwd = "/workspace";
    const workflowPath = `${cwd}/workflow.ts`;
    const unsupportedVersion = workflow();
    (unsupportedVersion as { irVersion: number }).irVersion = 999;
    for (const ir of [
      unsupportedVersion,
      workflow({ root: { nodes: [], output: { kind: "object", fields: {} }, extra: true } as any }),
      workflow({ output: { kind: "ref", path: ["unknown", "value"] } }),
      workflow({ diagnostics: [{ code: "TEST", severity: "error", message: "not admissible" }] }),
    ]) {
      const result = tryValidatePreparedRunWorkflow(cwd, preparedWorkflow(ir, workflowPath, cwd));
      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected invalid frozen IR");
      expect(result.error).toMatchObject({
        type: "prepared-workflow-invalid",
        reason: "invalid-ir",
      });
    }

    const warning = workflow({
      diagnostics: [{ code: "W002", severity: "warning", message: "warning only" }],
    });
    const warningPrepared = preparedWorkflow(warning, workflowPath, cwd);
    const originalDiagnostics = structuredClone(warningPrepared.ir.diagnostics);
    const originalIrJson = warningPrepared.irJson;

    expect(tryValidatePreparedRunWorkflow(cwd, warningPrepared).isOk()).toBe(true);
    expect(warningPrepared.ir.diagnostics).toEqual(originalDiagnostics);
    expect(warningPrepared.irJson).toBe(originalIrJson);
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
    irVersion: 6,
    name: "normalization",
    agents: {},
    inputSchema: { kind: "object", fields: {}, required: [], additionalProperties: false },
    diagnostics: [],
    ...rest,
    root: root ?? { nodes: nodes ?? [], output },
  } as WorkflowIR;
}
