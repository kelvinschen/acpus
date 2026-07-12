import { describe, expect, it } from "vitest";
import { validateWorkflowIR, type DiagnosticIR, type WorkflowIR } from "../src/ir.js";

function minimalWorkflow(overrides: Partial<WorkflowIR> = {}): WorkflowIR {
  return {
    irVersion: 4,
    name: "diagnostic_hints",
    agents: {},
    root: { nodes: [] },
    outputs: {},
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
    const diagnostics = validateWorkflowIR(minimalWorkflow({
      root: {
        nodes: [
          {
            id: "missing_agent",
            kind: "agent",
            run: { agent: "reviewer", prompt: { kind: "literal", value: "" } },
          },
          {
            id: "if_without_else",
            kind: "if",
            condition: { kind: "literal", value: true },
            then: { nodes: [], outputs: { status: { kind: "literal", value: "ok" } } },
          },
          {
            id: "switch_without_default",
            kind: "switch",
            cases: [{ when: { kind: "literal", value: true }, then: { nodes: [], outputs: { status: { kind: "literal", value: "ok" } } } }],
          },
        ] as any,
      },
    }));

    expectHint(diagnostics, "A001", ["defineWorkflow", "agents"]);
    expectHint(diagnostics, "G002", ["else"]);
    expectHint(diagnostics, "G003", ["default"]);
  });
});
