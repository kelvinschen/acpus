import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { globSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintWorkflow, compileWorkflow } from "../src/index.js";

const fixtures = join(import.meta.dirname, "fixtures");

function fixture(name: string): string {
  return readFileSync(join(fixtures, name), "utf8");
}

/**
 * Helper: extract error-level diagnostic codes from a lint result.
 */
function errorCodes(src: string): string[] {
  const r = lintWorkflow(src);
  return r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
}

/**
 * Helper: check that lint produces at least one error with a specific code.
 */
function hasError(src: string, code: string): boolean {
  return errorCodes(src).includes(code);
}

// ── Unknown field detection (additionalProperties: false) ──

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
    expect(hasError(src, "SPEC_SHAPE")).toBe(true);
  });

  it("rejects unknown agent property", () => {
    const src = `
version: 1
name: test
agents:
  coder: { type: mock, modle: gpt-5 }
workflow:
  steps:
    - id: s1
      run: agent
      use: coder
      prompt: "x"
`;
    expect(hasError(src, "AGENT_SHAPE")).toBe(true);
  });

  it("rejects unknown step property on agent step", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: s1
      run: agent
      use: mock
      prompt: "x"
      cmdd: "echo"
`;
    expect(hasError(src, "STEP_SHAPE")).toBe(true);
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
    expect(hasError(src, "STEP_SHAPE")).toBe(true);
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
    expect(hasError(src, "CAPTURE_SHAPE")).toBe(true);
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
    expect(hasError(src, "STEP_SHAPE")).toBe(true);
  });

  it("rejects unknown approval property", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: gate
      approval:
        prompt: "OK?"
        timeout: 5m
        on_timeout: fail
        notify: admin@example.com
`;
    expect(hasError(src, "STEP_SHAPE")).toBe(true);
  });

  it("accepts an approval gate with only prompt (no timeout = wait indefinitely)", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: gate
      approval:
        prompt: "OK?"
`;
    expect(lintWorkflow(src).ok).toBe(true);
  });

  it("rejects an approval gate with timeout but no on_timeout", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: gate
      approval:
        prompt: "OK?"
        timeout: 5m
`;
    expect(hasError(src, "APPROVAL_ON_TIMEOUT")).toBe(true);
  });

  it("rejects unknown retry property", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: s1
      run: agent
      use: mock
      prompt: "x"
      retry: { max: 3, max_attempts: 2 }
`;
    expect(hasError(src, "RETRY_SHAPE")).toBe(true);
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
    expect(hasError(src, "SPEC_SHAPE")).toBe(true);
  });
});

// ── Type / enum / required constraints ──

describe("Schema validation: type/enum/required", () => {
  it("rejects wrong DSL version", () => {
    const src = `
version: 99
name: test
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: s1
      run: program
      cmd: ["echo", "hi"]
`;
    expect(hasError(src, "SPEC_VERSION")).toBe(true);
  });

  it("rejects missing step id", () => {
    const r = lintWorkflow(fixture("invalid-missing-id.yaml"));
    expect(r.ok).toBe(false);
    expect(hasError(fixture("invalid-missing-id.yaml"), "STEP_ID")).toBe(true);
  });

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
    expect(hasError(src, "STEP_ID")).toBe(true);
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
    expect(hasError(src, "AGENT_SHAPE")).toBe(true);
  });

  it("rejects builtin/command agent without use", () => {
    const src = `
version: 1
name: test
agents:
  coder: { type: builtin }
workflow:
  steps:
    - id: s1
      run: agent
      use: coder
      prompt: "x"
`;
    expect(hasError(src, "AGENT_SHAPE")).toBe(true);
  });

  it("rejects invalid on_error enum", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: s1
      run: agent
      use: mock
      prompt: "x"
      on_error: explode
`;
    expect(hasError(src, "STEP_ON_ERROR")).toBe(true);
  });

  it("rejects invalid on_timeout enum in approval", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: gate
      approval:
        prompt: "OK?"
        timeout: 5m
        on_timeout: maybe
`;
    expect(hasError(src, "APPROVAL_ON_TIMEOUT")).toBe(true);
  });

  it("rejects non-positive retry max", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: s1
      run: agent
      use: mock
      prompt: "x"
      retry: { max: 0 }
`;
    expect(hasError(src, "RETRY_SHAPE")).toBe(true);
  });

  it("rejects negative numeric timeout", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: s1
      run: agent
      use: mock
      prompt: "x"
      timeout: -500
`;
    expect(hasError(src, "STEP_TIMEOUT")).toBe(true);
  });

  it("rejects non-string on_error (null)", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: s1
      run: agent
      use: mock
      prompt: "x"
      on_error: null
`;
    expect(hasError(src, "STEP_ON_ERROR")).toBe(true);
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
    expect(hasError(src, "CAPTURE_FROM")).toBe(true);
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
    expect(hasError(src, "CAPTURE_PARSE")).toBe(true);
  });

  it("rejects agent output that is not an object", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: s1
      run: agent
      use: mock
      prompt: "x"
      output: nope
`;
    expect(hasError(src, "OUTPUT_SHAPE")).toBe(true);
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
    expect(hasError(src, "OUTPUT_SHAPE")).toBe(true);
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
    expect(hasError(src, "FANOUT_OVER")).toBe(true);
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
    expect(hasError(src, "FANOUT_OVER_TYPE")).toBe(true);
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
    expect(hasError(src, "FANOUT_SUCCESS_CRITERIA")).toBe(true);
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
    expect(hasError(src, "CAPTURE_SHAPE")).toBe(true);
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
          run: program
          cmd: ["echo", "left"]
`;
    expect(hasError(src, "JOIN_VALUE")).toBe(true);
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
    expect(hasError(src, "JOIN_VALUE")).toBe(true);
  });
});

// ── if/then cross-field dependencies ──

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
    expect(hasError(src, "FANOUT_QUORUM")).toBe(true);
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
    const r = compileWorkflow(src);
    expect(r.ok).toBe(true);
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
    expect(hasError(src, "CAPTURE_PATH")).toBe(true);
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
    const r = compileWorkflow(src);
    expect(r.ok).toBe(true);
  });

  it("rejects builtin agent without use when type is explicit", () => {
    const src = `
version: 1
name: test
agents:
  coder: { type: builtin }
workflow:
  steps:
    - id: s1
      run: agent
      use: coder
      prompt: "x"
`;
    expect(hasError(src, "AGENT_SHAPE")).toBe(true);
  });

  it("accepts mock agent without use", () => {
    const src = `
version: 1
name: test
agents:
  fake: { type: mock }
workflow:
  steps:
    - id: s1
      run: agent
      use: fake
      prompt: "x"
`;
    const r = compileWorkflow(src);
    expect(r.ok).toBe(true);
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
    const r = compileWorkflow(src);
    expect(r.ok).toBe(true);
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
    const r = compileWorkflow(src);
    expect(r.ok).toBe(true);
  });
});

// ── Step kind (oneOf) ──

describe("Schema validation: step kind oneOf", () => {
  it("rejects a step with no recognizable kind", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: s1
      use: mock
      prompt: "x"
`;
    expect(hasError(src, "STEP_KIND")).toBe(true);
  });

  it("rejects a step that has run but with invalid value", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: s1
      run: container
      use: mock
      prompt: "x"
`;
    expect(hasError(src, "STEP_KIND")).toBe(true);
  });
});

// ── Path accuracy ──

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
    const err = r.diagnostics.find((d) => d.code === "SPEC_SHAPE" && d.severity === "error");
    expect(err).toBeDefined();
    expect(err!.path).toBe("$");
  });

  it("reports correct path for unknown agent property", () => {
    const src = `
version: 1
name: test
agents:
  coder: { type: mock, badprop: true }
workflow:
  steps:
    - id: s1
      run: agent
      use: coder
      prompt: "x"
`;
    const r = lintWorkflow(src);
    const err = r.diagnostics.find((d) => d.code === "AGENT_SHAPE" && d.severity === "error");
    expect(err).toBeDefined();
    expect(err!.path).toBe("$.agents.coder");
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
    const err = r.diagnostics.find((d) => d.code === "CAPTURE_FROM");
    expect(err).toBeDefined();
    expect(err!.path).toBe("$.workflow.steps[0].capture.from");
  });

  it("reports correct path for on_error enum error", () => {
    const src = `
version: 1
name: test
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: s1
      run: agent
      use: mock
      prompt: "x"
      on_error: explode
`;
    const r = lintWorkflow(src);
    const err = r.diagnostics.find((d) => d.code === "STEP_ON_ERROR");
    expect(err).toBeDefined();
    expect(err!.path).toBe("$.workflow.steps[0].on_error");
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
    const err = r.diagnostics.find((d) => d.code === "FANOUT_QUORUM");
    expect(err).toBeDefined();
    expect(err!.path).toBe("$.workflow.steps[0].fanout");
  });
});

// ── Production YAML fixtures pass Schema validation ──

describe("Production YAML fixtures pass Schema validation", () => {
  const fixtureDir = fixtures;
  const yamlFiles = globSync(join(fixtureDir, "*.yaml"));

  for (const file of yamlFiles) {
    it(`passes Schema validation: ${basename(file)}`, () => {
      const source = readFileSync(file, "utf8");
      const result = compileWorkflow(source, { sourcePath: file });

      // Skip fixtures that are intentionally invalid (contain known error codes)
      const fileName = basename(file);
      if (fileName.startsWith("invalid-")) {
        // These should still not produce unknown-field errors (SPEC_SHAPE/STEP_SHAPE/AGENT_SHAPE
        // from additionalProperties violations), only the expected structural errors
        return;
      }

      // Valid fixtures should produce no schema-level unknown-field errors
      const schemaErrors = result.diagnostics.filter(
        (d) =>
          d.severity === "error" &&
          (d.code === "SPEC_SHAPE" || d.code === "STEP_SHAPE" || d.code === "AGENT_SHAPE") &&
          d.message.includes("Unknown")
      );
      expect(schemaErrors).toHaveLength(0);
    });
  }
});
