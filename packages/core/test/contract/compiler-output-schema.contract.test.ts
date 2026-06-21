import { describe, expect, it } from "vitest";
import { compileWorkflow, lintWorkflow } from "../../src/index.js";
import { expectDiagnostic } from "../support/diagnostic-helpers.js";

describe("@acpus/core compiler: output schema", () => {
  it("compiles agent output with flat-map shorthand", () => {
    const source = `
version: 1
name: flat-output
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      output:
        plan_md: string
        commit_sha?: string
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const askNode = result.ir?.root.children?.[0];
    expect(askNode?.kind).toBe("run.agent");
    expect(askNode?.metadata.output).toEqual({
      type: "object",
      properties: {
        plan_md: { type: "string" },
        commit_sha: { type: "string" }
      },
      additionalProperties: false,
      required: ["plan_md"]
    });
  });

  it("compiles recursive agent output with arrays of objects and optional nested fields", () => {
    const source = `
version: 1
name: recursive-output
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      output:
        issues:
          - description: string
            severity?: string
        summary?: string
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const askNode = result.ir?.root.children?.[0];
    expect(askNode?.metadata.output).toEqual({
      type: "object",
      properties: {
        issues: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              severity: { type: "string" }
            },
            additionalProperties: false,
            required: ["description"]
          }
        },
        summary: { type: "string" }
      },
      additionalProperties: false,
      required: ["issues"]
    });
  });

  it("compiles recursive agent output with nested objects and arrays of primitives", () => {
    const source = `
version: 1
name: recursive-nested-output
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      output:
        report:
          title: string
          tags:
            - string
          stats?:
            count: integer
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const askNode = result.ir?.root.children?.[0];
    expect(askNode?.metadata.output).toEqual({
      type: "object",
      properties: {
        report: {
          type: "object",
          properties: {
            title: { type: "string" },
            tags: {
              type: "array",
              items: { type: "string" }
            },
            stats: {
              type: "object",
              properties: {
                count: { type: "integer" }
              },
              additionalProperties: false,
              required: ["count"]
            }
          },
          additionalProperties: false,
          required: ["title", "tags"]
        }
      },
      additionalProperties: false,
      required: ["report"]
    });
  });

  it("allows agent steps without output", () => {
    const source = `
version: 1
name: agent-no-output
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const askNode = result.ir?.root.children?.[0];
    expect(askNode?.kind).toBe("run.agent");
    expect(askNode?.metadata.output).toBeUndefined();
  });

  it("treats empty output maps as no declared schema", () => {
    const cases = [
      `
version: 1
name: agent-empty-output
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      output: {}
`,
      `
version: 1
name: program-empty-output
workflow:
  steps:
    - id: run_it
      run: program
      cmd: ["echo", "hello"]
      output: {}
`
    ];
    for (const source of cases) {
      const result = compileWorkflow(source);
      expect(result.ok).toBe(true);
      expect(result.ir?.root.children?.[0]?.metadata.output).toBeUndefined();
    }
  });

  it("rejects unsupported object-form schema keys in agent output", () => {
    const source = `
version: 1
name: bad-output-schema-keys
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      output:
        issues:
          type: array
          items:
            type: object
            properties:
              text: { type: string }
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "OUTPUT_SHAPE",
          path: "$.workflow.steps[0].output.issues.items"
        })
      ])
    );
  });

  it("rejects agent output when present but not an object", () => {
    const source = `
version: 1
name: bad-agent-output
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      output: nope
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "OUTPUT_SHAPE" });
  });

  it("compiles program step output schema into metadata.output", () => {
    const source = `
version: 1
name: program-output
workflow:
  steps:
    - id: parse_result
      run: program
      cmd: ["echo", '{"count": 5}']
      capture: { from: stdout, parse: json }
      output:
        count: integer
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const node = result.ir?.root.children?.[0];
    expect(node?.kind).toBe("run.program");
    expect(node?.metadata.output).toEqual({
      type: "object",
      properties: { count: { type: "integer" } },
      additionalProperties: false,
      required: ["count"]
    });
  });

  it("allows program step without output", () => {
    const source = `
version: 1
name: program-no-output
workflow:
  steps:
    - id: run_it
      run: program
      cmd: ["echo", "hello"]
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    expect(result.ir?.root.children?.[0]?.metadata.output).toBeUndefined();
  });

  it("rejects program step output when not an object", () => {
    const source = `
version: 1
name: program-bad-output
workflow:
  steps:
    - id: run_it
      run: program
      cmd: ["echo", "hello"]
      capture: { from: stdout, parse: json }
      output: nope
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "OUTPUT_SHAPE", path: "$.workflow.steps[0].output" });
  });

  it("accepts program output with capture.parse: json", () => {
    const source = `
version: 1
name: program-output-json
workflow:
  steps:
    - id: parse_it
      run: program
      cmd: ["echo", '{"status": "ok"}']
      capture: { from: stdout, parse: json }
      output:
        status: string
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
  });

  it("rejects program output with capture.parse: text", () => {
    const source = `
version: 1
name: program-output-text
workflow:
  steps:
    - id: parse_it
      run: program
      cmd: ["echo", "hello"]
      capture: { from: stdout, parse: text }
      output:
        status: string
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "OUTPUT_REQUIRES_JSON" });
  });

  it("rejects program output without capture", () => {
    const source = `
version: 1
name: program-output-no-capture
workflow:
  steps:
    - id: parse_it
      run: program
      cmd: ["echo", "hello"]
      output:
        status: string
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "OUTPUT_REQUIRES_JSON" });
  });

  it("rejects program output with schema escape hatch key", () => {
    const source = `
version: 1
name: program-output-schema-key
workflow:
  steps:
    - id: parse_it
      run: program
      cmd: ["echo", "hello"]
      capture: { from: stdout, parse: json }
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

  it("does not store partial output schema metadata after DSL compile errors", () => {
    const source = `
version: 1
name: partial-output-error
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      output:
        good: string
        bad: unsupported
`;
    const result = lintWorkflow(source);
    expect(result.ok).toBe(false);
    expectDiagnostic(result, { code: "OUTPUT_SHAPE" });

    const compiled = compileWorkflow(source, { strict: false });
    expect(compiled.ir?.root.children?.[0]?.metadata.output).toBeUndefined();
  });

  it("compiles equivalent output schema metadata across agent, program, and signal nodes", () => {
    const source = `
version: 1
name: shared-output-schema
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      output:
        status: string
    - id: parse
      run: program
      cmd: ["echo", '{"status":"ok"}']
      capture: { from: stdout, parse: json }
      output:
        status: string
    - id: gate
      run: signal
      prompt: "OK?"
      output:
        status: string
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const [agent, program, signal] = result.ir?.root.children ?? [];
    expect(agent?.metadata.output).toEqual(program?.metadata.output);
    expect(program?.metadata.output).toEqual(signal?.metadata.output);
  });

  it("stores program-step capture in metadata.capture (not metadata.output)", () => {
    const source = `
version: 1
name: program-capture
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: run_it
      run: program
      cmd: ["echo", "hello"]
      capture: { from: stdout, parse: json }
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const runNode = result.ir?.root.children?.[0];
    expect(runNode?.kind).toBe("run.program");
    expect(runNode?.metadata.capture).toEqual({ from: "stdout", parse: "json" });
    expect(runNode?.metadata.output).toBeUndefined();
  });

  it("allows program steps without capture", () => {
    const source = `
version: 1
name: program-no-capture
workflow:
  steps:
    - id: run_it
      run: program
      cmd: ["echo", "hello"]
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const runNode = result.ir?.root.children?.[0];
    expect(runNode?.kind).toBe("run.program");
    expect(runNode?.metadata.capture).toBeUndefined();
  });
});
