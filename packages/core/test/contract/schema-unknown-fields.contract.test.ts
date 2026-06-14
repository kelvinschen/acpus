import { describe, expect, it } from "vitest";
import { lintWorkflow } from "../../src/index.js";
import { expectDiagnostic } from "../support/diagnostic-helpers.js";

describe("Schema validation: unknown fields", () => {
  it("rejects unknown top-level property", () => {
    const src = `
version: 1
name: test
unknown_top: true
workflow:
  steps:
    - id: s1
      run: program
      cmd: ["echo", "hi"]
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "SPEC_SHAPE", message: "Unknown" });
  });

  it("rejects unknown agent property", () => {
    const src = `
version: 1
name: test
agents:
  coder: { type: command, use: "echo", modle: gpt-5 }
workflow:
  steps:
    - id: s1
      run: agent
      use: coder
      prompt: "x"
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "AGENT_SHAPE", message: "Unknown" });
  });

  it("rejects unknown step property on agent step", () => {
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
      cmdd: "echo"
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "STEP_SHAPE", message: "Unknown" });
  });

  it("rejects unknown step property on program step", () => {
    const src = `
version: 1
name: test
workflow:
  steps:
    - id: s1
      run: program
      cmd: ["echo", "hi"]
      defaults: { x: 1 }
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "STEP_SHAPE", path: "$.workflow.steps[0]", message: "Unknown" });
  });

  it("rejects unknown capture property", () => {
    const src = `
version: 1
name: test
workflow:
  steps:
    - id: s1
      run: program
      cmd: ["echo", "hi"]
      capture: { from: stdout, parse: text, encoding: utf8 }
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "CAPTURE_SHAPE", message: "Unknown" });
  });

  it("rejects unknown fanout property", () => {
    const src = `
version: 1
name: test
workflow:
  steps:
    - id: s1
      fanout:
        over: [1, 2]
        batch_size: 5
        do:
          - id: each
            run: program
            cmd: ["echo", "hi"]
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "STEP_SHAPE", message: "Unknown" });
  });

  it("rejects unknown approval property", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: gate
      approval:
        prompt: "OK?"
        timeout: 5m
        on_timeout: fail
        notify: admin@example.com
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "STEP_SHAPE", message: "Unknown" });
  });

  it("rejects unknown guard property", () => {
    const src = `
version: 1
name: test
workflow:
  steps:
    - id: check
      guard:
        when: input.ok
        then: continue
        else: fail
        severity: high
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "STEP_SHAPE", message: "Unknown" });
  });

  it("rejects unknown retry property", () => {
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
      retry: { max: 3, max_attempts: 2 }
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "RETRY_SHAPE", message: "Unknown" });
  });

  it("rejects unknown workflow property", () => {
    const src = `
version: 1
name: test
workflow:
  timeout: 10m
  steps:
    - id: s1
      run: program
      cmd: ["echo", "hi"]
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "SPEC_SHAPE", message: "Unknown" });
  });
});
