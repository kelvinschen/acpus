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
    expect(source).not.toContain('"design-forge-package.json"');
  });

  it("keeps editorial choices with Agents and Tasks mechanically small", async () => {
    const source = await readFile(skillExampleWorkflowPath("design-forge"), "utf8");
    const publishStart = source.indexOf('const published = step("publish_blackboard")');

    expect(source).toMatch(/fixed template/i);
    expect(source).toMatch(/best-effort/i);
    expect(source).toMatch(/Mermaid diagrams/i);
    expect(source).toMatch(/public sources/i);

    for (const rigidMechanism of [
      "references.json",
      "decision-log.md",
      "diagram-plan.md",
      "design-forge:summary",
      "requiredMarkers",
    ]) {
      expect(source).not.toContain(rigidMechanism);
    }

    expect(publishStart).toBeGreaterThan(0);
    expect(source.match(/\.task\(\{/g) ?? []).toHaveLength(2);

    const publishSource = source.slice(publishStart);
    expect(publishSource).toContain("artifact.write");
    expect(publishSource).not.toContain("throw new Error");
    expect(publishSource).not.toContain("JSON.parse");
    expect(publishSource).not.toContain("matchAll");
  });
});
