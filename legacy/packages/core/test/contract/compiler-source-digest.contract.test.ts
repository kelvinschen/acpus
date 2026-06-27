import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileWorkflow } from "../../src/index.js";

const fixtures = join(import.meta.dirname, "..", "fixtures");

function fixture(name: string): string {
  return readFileSync(join(fixtures, name), "utf8");
}

describe("@acpus/core compiler: source digest and session key", () => {
  it("IR contains source digest for reproducibility", () => {
    const result = compileWorkflow(fixture("case-a-plan-review-impl.yaml"), {
      sourcePath: join(fixtures, "case-a-plan-review-impl.yaml")
    });
    expect(result.ok).toBe(true);
    expect(result.ir?.source.digest).toBeTruthy();
    expect(typeof result.ir?.source.digest).toBe("string");
    expect(result.ir?.source.path).toBe(join(fixtures, "case-a-plan-review-impl.yaml"));
  });

  it("preserves agent session_key and collects template expressions", () => {
    const source = `
version: 1
name: agent-session-key
agents:
  mock: { type: command, use: "echo stub" }
workflow:
  steps:
    - id: seed
      run: program
      cmd: ["echo", "seed"]
    - id: ask
      run: agent
      use: mock
      session_key: "review-\${{ input.ticket }}-\${{ steps.seed.exit_code }}"
      prompt: "x"
`;
    const result = compileWorkflow(source);
    expect(result.ok).toBe(true);
    const askNode = result.ir?.root.children?.[1];
    expect(askNode?.kind).toBe("run.agent");
    expect(askNode?.metadata.session_key).toBe("review-${{ input.ticket }}-${{ steps.seed.exit_code }}");
    expect(result.ir?.expressions.some((expr) => expr.path === "$.workflow.steps[1].session_key" && expr.source === "input.ticket")).toBe(true);
    expect(result.ir?.expressions.some((expr) => expr.path === "$.workflow.steps[1].session_key" && expr.source === "steps.seed.exit_code")).toBe(true);
  });
});
