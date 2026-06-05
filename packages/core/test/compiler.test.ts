import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileWorkflow, lintWorkflow } from "../src/index.js";

const fixtures = join(import.meta.dirname, "fixtures");

function fixture(name: string): string {
  return readFileSync(join(fixtures, name), "utf8");
}

describe("@acpus/core compiler", () => {
  it("compiles a workflow with all M1 primitives", () => {
    const result = compileWorkflow(fixture("all-primitives.yaml"), {
      sourcePath: join(fixtures, "all-primitives.yaml")
    });

    expect(result.ok).toBe(true);
    expect(result.ir?.name).toBe("all-primitives");
    expect(result.ir?.root.children?.map((node) => node.kind)).toEqual([
      "run.program",
      "run.agent",
      "parallel",
      "fanout",
      "switch",
      "loop",
      "approval",
      "subworkflow"
    ]);
    expect(result.schedule?.nodes).toHaveLength(8);
    expect(result.ir?.expressions.some((expression) => expression.source.includes("steps.discover.output.files"))).toBe(true);
  });

  it("rejects composite nodes without outputFrom", () => {
    const result = lintWorkflow(fixture("invalid-missing-output-from.yaml"));

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "OUTPUT_FROM_REQUIRED")).toBe(true);
  });

  it("rejects unknown step references", () => {
    const result = lintWorkflow(fixture("invalid-reference.yaml"));

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "EXPR_UNKNOWN_STEP")).toBe(true);
  });

  it("rejects invalid JSON Schema", () => {
    const source = `
version: 1
name: invalid-schema
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: ask
      run: agent
      use: mock
      prompt: "x"
      expect:
        schema: { type: definitely-not-json-schema-type }
`;
    const result = lintWorkflow(source);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "JSON_SCHEMA_INVALID")).toBe(true);
  });
});
