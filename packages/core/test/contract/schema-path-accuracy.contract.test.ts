import { describe, expect, it } from "vitest";
import { lintWorkflow } from "../../src/index.js";
import { expectDiagnostic } from "../support/diagnostic-helpers.js";

describe("Schema validation: path accuracy", () => {
  it("reports correct path for unknown top-level property", () => {
    const src = `
version: 1
name: test
unknown_prop: true
workflow:
  steps:
    - id: s1
      run: program
      cmd: ["echo", "hi"]
`;
    const r = lintWorkflow(src);
    expectDiagnostic(r, { code: "SPEC_SHAPE", path: "$" });
  });

  it("reports correct path for unknown agent property", () => {
    const src = `
version: 1
name: test
agents:
  coder: { type: command, use: "echo", badprop: true }
workflow:
  steps:
    - id: s1
      run: agent
      use: coder
      prompt: "x"
`;
    const r = lintWorkflow(src);
    expectDiagnostic(r, { code: "AGENT_SHAPE", path: "$.agents.coder" });
  });

  it("reports correct path for capture enum error", () => {
    const src = `
version: 1
name: test
workflow:
  steps:
    - id: s1
      run: program
      cmd: ["echo", "hi"]
      capture: { from: stderr, parse: text }
`;
    const r = lintWorkflow(src);
    expectDiagnostic(r, { code: "CAPTURE_FROM", path: "$.workflow.steps[0].capture.from" });
  });

  it("reports correct path for on_error enum error", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: s1
      run: agent
      use: mock
      prompt: "x"
      on_error: explode
`;
    const r = lintWorkflow(src);
    expectDiagnostic(r, { code: "STEP_ON_ERROR", path: "$.workflow.steps[0].on_error" });
  });

  it("reports correct path for quorum fanout without quorum", () => {
    const src = `
version: 1
name: test
workflow:
  steps:
    - id: s1
      fanout:
        over: [1, 2]
        join: quorum
        do:
          - id: each
            run: program
            cmd: ["echo", "hi"]
`;
    const r = lintWorkflow(src);
    expectDiagnostic(r, { code: "FANOUT_QUORUM", path: "$.workflow.steps[0].fanout" });
  });
});
