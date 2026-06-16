import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lintWorkflow } from "../../src/index.js";
import { expectDiagnostic, expectDiagnosticCount } from "../support/diagnostic-helpers.js";

const fixtures = join(import.meta.dirname, "..", "fixtures");

function fixture(name: string): string {
  return readFileSync(join(fixtures, name), "utf8");
}

describe("@acpus/core compiler: diagnostics", () => {
  it("rejects invalid YAML", () => {
    const result = lintWorkflow("version: 1\nname: [\n  broken");
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "YAML_PARSE" });
  });

  it("rejects invalid spec shape (missing required top-level fields)", () => {
    const result = lintWorkflow("just_a_string: true");
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "SPEC_SHAPE" });
  });

  it("rejects include cycles", () => {
    const fixturePath = join(fixtures, "include-cycle-a.yaml");
    const result = lintWorkflow(fixture("include-cycle-a.yaml"), {
      sourcePath: fixturePath,
      includeResolver: (includePath, fromPath) => {
        const baseDir = fromPath ? join(fixturePath, "..") : process.cwd();
        return readFileSync(join(baseDir, includePath), "utf8");
      }
    });
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "INCLUDE_CYCLE" });
  });

  it("rejects output with unsupported DSL keys (no schema escape hatch)", () => {
    const source = `
version: 1
name: invalid-schema
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      output:
        schema: { type: definitely-not-json-schema-type }
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "OUTPUT_SHAPE" });
  });

  it("rejects output.schema key with deprecation message", () => {
    const source = `
version: 1
name: schema-deprecated
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      output:
        schema: { type: object }
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    const schemaDiag = result.diagnostics.find((d) => d.path === "$.workflow.steps[0].output.schema");
    expect(schemaDiag).toBeDefined();
    expect(schemaDiag!.message).toContain("no longer supported");
    expect(schemaDiag!.message).toContain("escape hatch");
  });

  it("rejects expressions referencing unknown step ids", () => {
    const result = lintWorkflow(fixture("invalid-reference.yaml"));
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "EXPR_UNKNOWN_STEP" });
  });

  it("rejects string timeout that is not a valid duration", () => {
    const source = `
version: 1
name: bad-timeout
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      timeout: "not-a-duration"
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "STEP_TIMEOUT" });
  });

  it("rejects signal timeout with invalid duration format", () => {
    const source = `
version: 1
name: bad-signal-timeout
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: gate
      run: signal
      prompt: "Approve?"
      timeout: "2d"
      on_timeout: fail
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "SIGNAL_TIMEOUT" });
    // The signal-specific check owns timeout validation; the generic
    // validateStepTimeout must not also fire (no duplicate diagnostic).
    expectDiagnosticCount(result, "SIGNAL_TIMEOUT", 1);
    expectDiagnosticCount(result, "STEP_TIMEOUT", 0);
  });

  it("rejects invalid fanout join values", () => {
    const source = `
version: 1
name: bad-joins
workflow:
  steps:
    - id: par
      join: diagonal
      parallel:
        - id: left
          run: program
          cmd: ["echo", "left"]
    - id: mapped
      fanout:
        over: [1, 2]
        join: diagonal
        do:
          - id: each
            run: program
            cmd: ["echo", "hi"]
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.filter((d) => d.code === "JOIN_VALUE")).toHaveLength(2);
  });

  it("rejects fanout over array containing objects (not valid CEL)", () => {
    const source = `
version: 1
name: over-with-objects
workflow:
  steps:
    - id: mapped
      fanout:
        over:
          - key: val
        join: all
        do:
          - id: each
            run: program
            cmd: ["echo", "hi"]
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "FANOUT_OVER_TYPE" });
  });

  it("rejects non-boolean non-string until", () => {
    const source = `
version: 1
name: bad-until-type
workflow:
  steps:
    - id: fix
      loop:
        until: 42
        max_iterations: 3
        do:
          - id: step_a
            run: program
            cmd: ["echo", "a"]
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "LOOP_UNTIL_TYPE" });
  });

  it("rejects non-boolean non-string when", () => {
    const source = `
version: 1
name: bad-when-type
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: route
      switch:
        cases:
          - when: null
            do:
              - id: go
                run: program
                cmd: ["echo", "ok"]
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "SWITCH_WHEN_TYPE" });
  });

  it("rejects invalid guard shape and action values", () => {
    const source = `
version: 1
name: bad-guard
workflow:
  steps:
    - id: check
      guard:
        when: 42
        then: continue
        else: skip
        message: ["bad"]
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "GUARD_WHEN_TYPE" });
    expectDiagnostic(result, { code: "GUARD_ACTION" });
    expectDiagnostic(result, { code: "GUARD_MESSAGE" });
  });

  it("rejects guard with missing required else action", () => {
    const source = `
version: 1
name: guard-missing-else
workflow:
  steps:
    - id: check
      guard:
        when: input.ok
        then: continue
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "GUARD_ACTION" });
  });

  it("reports 'got null' instead of 'got object' for null when/until", () => {
    const sourceUntil = `
version: 1
name: until-null
workflow:
  steps:
    - id: fix
      loop:
        until: null
        max_iterations: 3
        do:
          - id: step_a
            run: program
            cmd: ["echo", "a"]
`;
    const result = lintWorkflow(sourceUntil);
    expect(result.ok).toBe(false);
    const diag = result.diagnostics.find((d) => d.code === "LOOP_UNTIL_TYPE")!;
    expect(diag.message).toContain("got null");
    expect(diag.message).not.toContain("got object");
  });

  it("rejects session_key on non-agent steps", () => {
    const source = `
version: 1
name: test
workflow:
  steps:
    - id: s1
      run: program
      cmd: ["echo", "hi"]
      session_key: "not-agent"
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "STEP_SHAPE", message: "session_key" });
  });

  it("rejects non-string agent session_key values", () => {
    const source = `
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
      session_key: 123
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "SPEC_SHAPE", path: "$.workflow.steps[0].session_key" });
  });

  it("rejects step ids containing colons", () => {
    const source = `
version: 1
name: colon-id
workflow:
  steps:
    - id: "branch:blue"
      run: program
      cmd: ["echo", "hi"]
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "STEP_ID_COLON" });
  });

  it("rejects step ids with item: prefix (reserved dynamic dimension)", () => {
    const source = `
version: 1
name: item-id
workflow:
  steps:
    - id: "item:my-step"
      run: program
      cmd: ["echo", "hi"]
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "STEP_ID_COLON" });
  });

  it("rejects duplicate step ids across sibling steps", () => {
    const source = `
version: 1
name: dup-id
workflow:
  steps:
    - id: s1
      run: program
      cmd: ["echo", "a"]
    - id: s1
      run: program
      cmd: ["echo", "b"]
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "STEP_ID_DUPLICATE" });
  });

  it("rejects duplicate step ids across nested steps", () => {
    const source = `
version: 1
name: dup-id-nested
workflow:
  steps:
    - id: s1
      run: program
      cmd: ["echo", "a"]
    - id: par
      parallel:
        - id: s1
          run: program
          cmd: ["echo", "b"]
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "STEP_ID_DUPLICATE" });
  });
});
