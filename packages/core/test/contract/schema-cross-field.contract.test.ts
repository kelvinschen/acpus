import { describe, expect, it } from "vitest";
import { lintWorkflow, compileWorkflow } from "../../src/index.js";
import { expectDiagnostic } from "../support/diagnostic-helpers.js";

describe("Schema validation: if/then cross-field", () => {
  it("rejects quorum fanout without quorum field", () => {
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
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "FANOUT_QUORUM" });
  });

  it("accepts quorum fanout with quorum field", () => {
    const src = `
version: 1
name: test
workflow:
  steps:
    - id: s1
      fanout:
        over: [1, 2]
        join: quorum
        quorum: 2
        do:
          - id: each
            run: program
            cmd: ["echo", "hi"]
`;
    const result = compileWorkflow(src);
    expect(result.ok).toBe(true);
  });

  it("accepts capture from file with path", () => {
    const src = `
version: 1
name: test
workflow:
  steps:
    - id: s1
      run: program
      cmd: ["echo", "hi"]
      capture: { from: file, parse: json, path: "/tmp/out.txt" }
`;
    const result = compileWorkflow(src);
    expect(result.ok).toBe(true);
  });

  it("rejects capture from file without path", () => {
    const src = `
version: 1
name: test
workflow:
  steps:
    - id: s1
      run: program
      cmd: ["echo", "hi"]
      capture: { from: file, parse: json }
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "CAPTURE_PATH" });
  });

  it("does not require quorum when join is not quorum", () => {
    const src = `
version: 1
name: test
workflow:
  steps:
    - id: s1
      fanout:
        over: [1, 2]
        join: all
        do:
          - id: each
            run: program
            cmd: ["echo", "hi"]
`;
    const result = compileWorkflow(src);
    expect(result.ok).toBe(true);
  });

  it("does not require capture path when from is stdout", () => {
    const src = `
version: 1
name: test
workflow:
  steps:
    - id: s1
      run: program
      cmd: ["echo", "hi"]
      capture: { from: stdout, parse: text }
`;
    const result = compileWorkflow(src);
    expect(result.ok).toBe(true);
  });

  it("accepts an approval gate with only prompt (no timeout = wait indefinitely)", () => {
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
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(true);
  });

  it("rejects an approval gate with timeout but no on_timeout", () => {
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
`;
    const result = lintWorkflow(src);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "APPROVAL_ON_TIMEOUT" });
  });
});
