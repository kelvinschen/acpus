import { describe, expect, it } from "vitest";
import { defineWorkflow, z } from "../src/index.js";
import { validateWorkflowIR, type DiagnosticIR, type WorkflowIR } from "../src/ir.js";
import { compileWorkflowDefinition } from "../src/workflow.js";

function minimalWorkflow(overrides: Partial<WorkflowIR> = {}): WorkflowIR {
  return {
    irVersion: 2,
    name: "diagnostic_hints",
    agents: {},
    root: { nodes: [] },
    outputs: {},
    assets: { taskBundles: {} },
    lock: { acpusCoreVersion: "test", taskBundleDigests: {}, generatedAt: "2026-01-01T00:00:00.000Z", notes: [] },
    diagnostics: [],
    ...overrides,
  };
}

function expectHint(diagnostics: DiagnosticIR[], code: string, words: string[]): void {
  const diagnostic = diagnostics.find(item => item.code === code);
  expect(diagnostic?.hint, `${code} hint`).toBeTypeOf("string");
  for (const word of words) expect(diagnostic!.hint).toContain(word);
}

describe("core diagnostic hints contract", () => {
  it("attaches actionable hints to validation diagnostics owned by core", () => {
    const outputSchema = {
      kind: "object" as const,
      fields: { status: { kind: "string" as const } },
      required: [],
      additionalProperties: false,
    };
    const diagnostics = validateWorkflowIR(minimalWorkflow({
      root: {
        nodes: [
          {
            id: "missing_agent",
            kind: "agent",
            run: { kind: "agent_run", agent: "reviewer", prompt: { kind: "template", parts: [] } },
          },
          {
            id: "if_without_else",
            kind: "if",
            condition: { kind: "literal", value: true },
            outputSchema,
            then: { nodes: [], outputs: { status: { kind: "literal", value: "ok" }, extra: { kind: "literal", value: "extra" } } },
          },
          {
            id: "switch_without_default",
            kind: "switch",
            outputSchema,
            cases: [{ when: { kind: "literal", value: true }, then: { nodes: [], outputs: { status: { kind: "literal", value: "ok" } } } }],
          },
        ],
      },
    }));

    expectHint(diagnostics, "A001", ["defineWorkflow", "agents"]);
    expectHint(diagnostics, "G002", ["else", "outputSchema"]);
    expectHint(diagnostics, "G003", ["default", "outputSchema"]);
    expectHint(diagnostics, "O001", ["Remove", "outputSchema"]);
  });

  it("attaches actionable hints to build-time output diagnostics owned by core", () => {
    const missingWorkflowOutput = defineWorkflow({ name: "missing_workflow_output" })
      .build((() => undefined) as any);
    const malformedComposite = defineWorkflow({ name: "malformed_composite" })
      .build(({ step }) => {
        step("gate").if({
          condition: true,
          outputSchema: z.object({ status: z.string() }),
          then: (() => undefined) as any,
          else: () => ({ status: "ok" }),
        });
        return {};
      });

    expectHint(compileWorkflowDefinition(missingWorkflowOutput).diagnostics, "W001", ["Return", "workflow"]);
    expectHint(compileWorkflowDefinition(malformedComposite).diagnostics, "B001", ["Return", "composite"]);
  });
});
