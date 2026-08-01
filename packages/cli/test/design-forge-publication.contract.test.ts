import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { skillExampleWorkflowPath } from "./support/skill-workflow-examples.js";

describe("design-forge publication contract", () => {
  it("publishes the Agent-authored Markdown separately from review history", async () => {
    const source = await readFile(skillExampleWorkflowPath("design-forge"), "utf8");

    expect(source).toContain('"design-forge.md"');
    expect(source).toContain('{ mediaType: "text/markdown" }');
    expect(source).toContain('"design-forge-review-log.txt"');
    expect(source).toContain('{ mediaType: "text/plain" }');
    expect(source).toMatch(/reader-facing Markdown deliverable, not a\s+scratchpad/);
    expect(source).not.toContain('"design-forge-package.json"');
  });

  it("keeps document structure, references, and visuals under Agent judgment", async () => {
    const source = await readFile(skillExampleWorkflowPath("design-forge"), "utf8");

    expect(source).toContain("Use judgment rather than a fixed template");
    expect(source).toMatch(/There is no required\s+heading list, citation notation, diagram count, decision schema, or\s+publication marker/);
    expect(source).toMatch(/Add Mermaid diagrams only when a visual explains/);
    expect(source).toMatch(/Cite authoritative workspace files or public sources when they support/);
    expect(source).toContain("do not turn the review into a rigid compliance checklist");

    for (const rigidResource of [
      "references.json",
      "decision-log.md",
      "diagram-plan.md",
      "design-forge:summary",
    ]) {
      expect(source).not.toContain(rigidResource);
    }
  });

  it("keeps Tasks limited to small blackboard and artifact operations", async () => {
    const source = await readFile(skillExampleWorkflowPath("design-forge"), "utf8");
    const publishStart = source.indexOf('const published = step("publish_blackboard")');

    expect(publishStart).toBeGreaterThan(0);
    expect(source.match(/\.task\(\{/g) ?? []).toHaveLength(2);

    const publishSource = source.slice(publishStart);
    expect(publishSource).toContain("artifact.write");
    expect(publishSource).not.toContain("throw new Error");
    expect(publishSource).not.toContain("JSON.parse");
    expect(publishSource).not.toContain("requiredMarkers");
    expect(publishSource).not.toContain("matchAll");
  });
});
