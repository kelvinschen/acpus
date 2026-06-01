import { describe, expect, it } from "vitest";
import { findVariableIssues, renderPrompt } from "../../src/variables/interpolate.js";
import { parseSourcePath } from "../../src/variables/paths.js";

describe("variables", () => {
  it("extracts missing and unused prompt variables", () => {
    const result = findVariableIssues("Task ${task} Plan ${plan}", [
      { name: "task", source: "input.task" },
      { name: "unused", source: "input.cwd" }
    ]);
    expect(result.missing).toEqual(["plan"]);
    expect(result.unused).toEqual(["unused"]);
  });

  it("renders declared placeholders and preserves escaped placeholders", () => {
    expect(renderPrompt("Task ${task} literal \\${kept}", { task: "hello" })).toBe("Task hello literal ${kept}");
  });

  it("parses restricted dotted source paths", () => {
    expect(parseSourcePath("outputs.plan.summary")).toEqual({
      root: "outputs",
      parts: ["plan", "summary"]
    });
    expect(() => parseSourcePath("$.outputs.plan")).toThrow();
  });
});
