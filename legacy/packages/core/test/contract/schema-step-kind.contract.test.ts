import { describe, expect, it } from "vitest";
import { lintWorkflow } from "../../src/index.js";
import { expectDiagnostic } from "../support/diagnostic-helpers.js";

describe("Schema validation: step kind oneOf", () => {
  it("rejects a step with no recognizable kind", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: s1
      use: mock
      prompt: "x"
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "STEP_KIND" });
  });

  it("rejects a step that has run but with invalid value", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: s1
      run: container
      use: mock
      prompt: "x"
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "STEP_KIND" });
  });
});
