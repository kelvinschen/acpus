import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { skillExampleWorkflowPath } from "./support/skill-workflow-examples.js";

describe("design-forge publication contract", () => {
  it("publishes a reader-facing Markdown design separately from the audit trail", async () => {
    const source = await readFile(skillExampleWorkflowPath("design-forge"), "utf8");

    expect(source).toContain('"design-forge.md"');
    expect(source).toContain('{ mediaType: "text/markdown" }');
    expect(source).toContain('"design-forge-package.json"');
    expect(source).toContain('{ mediaType: "application/json" }');
    expect(source).toContain('"design-forge-review-log.txt"');
    expect(source).toContain('{ mediaType: "text/plain" }');
    expect(source).toContain("not a scratchpad and not a transcript");
  });

  it("grounds the publication in structured decisions, references, and useful diagrams", async () => {
    const source = await readFile(skillExampleWorkflowPath("design-forge"), "utf8");

    for (const file of ["references.json", "decision-log.md", "diagram-plan.md"]) {
      expect(source).toContain(file);
    }
    for (const marker of [
      "summary",
      "context",
      "options",
      "design",
      "operations",
      "risks",
      "delivery",
      "references",
    ]) {
      expect(source).toContain(`design-forge:${marker}`);
    }
    expect(source).toContain("new URL(candidate.url).protocol");
    expect(source).toContain("points to a missing path");
    expect(source).toContain('trimmed === "```mermaid"');
    expect(source).toContain("contains unused sources");
  });
});
