import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lintWorkflow, compileWorkflow } from "../../src/index.js";
import { expectDiagnostic, expectNoDiagnostic } from "../support/diagnostic-helpers.js";

const fixtures = join(import.meta.dirname, "..", "fixtures");

function fixture(name: string): string {
  return readFileSync(join(fixtures, name), "utf8");
}

describe("Schema validation: type/enum/required", () => {
  it("rejects empty string step id", () => {
    const src = `
version: 1
name: test
workflow:
  steps:
    - id: ""
      run: program
      cmd: ["echo", "hi"]
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "STEP_ID" });
  });

  it("rejects invalid agent type", () => {
    const src = `
version: 1
name: test
agents:
  coder: { type: bogus, use: pi }
workflow:
  steps:
    - id: s1
      run: agent
      use: coder
      prompt: "x"
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "AGENT_SHAPE" });
  });

  it("rejects invalid on_timeout enum in a signal node", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: gate
      run: signal
      prompt: "OK?"
      timeout: 5m
      on_timeout: maybe
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "SIGNAL_ON_TIMEOUT" });
  });

  it("accepts zero retry max", () => {
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
      retry: { max: 0 }
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(true);
    expectNoDiagnostic(result, "RETRY_SHAPE");
  });

  it("rejects negative retry max", () => {
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
      retry: { max: -1 }
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "RETRY_SHAPE" });
  });

  it("rejects agent output that is not an object", () => {
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
      output: nope
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "OUTPUT_SHAPE", path: "$.workflow.steps[0].output" });
  });

  it("rejects program output that is not an object", () => {
    const src = `
version: 1
name: test
workflow:
  steps:
    - id: s1
      run: program
      cmd: ["echo", "hi"]
      capture: { from: stdout, parse: json }
      output: nope
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "OUTPUT_SHAPE", path: "$.workflow.steps[0].output" });
  });

  it("rejects fanout without over", () => {
    const src = `
version: 1
name: test
workflow:
  steps:
    - id: s1
      fanout:
        join: all
        do:
          - id: each
            run: program
            cmd: ["echo", "hi"]
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "FANOUT_OVER" });
  });

  it("rejects wrong DSL version", () => {
    const src = `
version: 99
name: test
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: s1
      run: program
      cmd: ["echo", "hi"]
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "SPEC_VERSION" });
  });

  it("rejects missing step id", () => {
    const result = lintWorkflow(fixture("invalid-missing-id.yaml"));
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "STEP_ID" });
  });

  it("rejects invalid on_error enum", () => {
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
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "STEP_ON_ERROR" });
  });

  it("rejects negative numeric timeout", () => {
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
      timeout: -500
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "STEP_TIMEOUT" });
  });

  it("rejects non-string on_error (null)", () => {
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
      on_error: null
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "STEP_ON_ERROR" });
  });

  it("rejects capture from invalid source", () => {
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
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "CAPTURE_FROM" });
  });

  it("rejects capture with invalid parse", () => {
    const src = `
version: 1
name: test
workflow:
  steps:
    - id: s1
      run: program
      cmd: ["echo", "hi"]
      capture: { from: stdout, parse: xml }
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "CAPTURE_PARSE" });
  });

  it("rejects fanout over with wrong type", () => {
    const src = `
version: 1
name: test
workflow:
  steps:
    - id: s1
      fanout:
        over: 42
        join: all
        do:
          - id: each
            run: program
            cmd: ["echo", "hi"]
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "FANOUT_OVER_TYPE" });
  });

  it("rejects invalid success_criteria min_success", () => {
    const src = `
version: 1
name: test
workflow:
  steps:
    - id: s1
      fanout:
        over: [1, 2]
        join: all
        success_criteria:
          min_success: 0
        do:
          - id: each
            run: program
            cmd: ["echo", "hi"]
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "FANOUT_SUCCESS_CRITERIA" });
  });

  it("rejects capture that is not an object", () => {
    const src = `
version: 1
name: test
workflow:
  steps:
    - id: s1
      run: program
      cmd: ["echo", "hi"]
      capture: nope
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "CAPTURE_SHAPE" });
  });

  it("rejects invalid join value in parallel", () => {
    const src = `
version: 1
name: test
workflow:
  steps:
    - id: par
      join: diagonal
      parallel:
        - id: left
          do:
            - id: left_step
              run: program
              cmd: ["echo", "left"]
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "JOIN_VALUE" });
  });

  it("rejects invalid join value in fanout", () => {
    const src = `
version: 1
name: test
workflow:
  steps:
    - id: s1
      fanout:
        over: [1, 2]
        join: diagonal
        do:
          - id: each
            run: program
            cmd: ["echo", "hi"]
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "JOIN_VALUE" });
  });
});
