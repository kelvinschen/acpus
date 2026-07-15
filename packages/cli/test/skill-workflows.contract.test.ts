import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { skillFilePath, skillReferencePath, skillWorkflowExamples, skillWorkflowPath, workflowNodeKinds } from "./support/skill-workflow-examples.js";

const defaultRouteByteBudget = 12_367;

describe("skill workflow source contracts", () => {
  it("keeps the default authoring route within its fixed context budget", async () => {
    const sources = await Promise.all([
      readFile(skillFilePath("SKILL.md"), "utf8"),
      readFile(skillReferencePath("authoring"), "utf8"),
    ]);
    expect(sources.reduce((bytes, source) => bytes + Buffer.byteLength(source), 0)).toBeLessThanOrEqual(defaultRouteByteBudget);
  });

  it("labels all checked scenario examples and covers every workflow node kind", async () => {
    const covered = new Set<string>();

    for (const example of skillWorkflowExamples) {
      const source = await readFile(skillWorkflowPath(example.directory), "utf8");
      expect(source).toContain(` * Pattern: ${example.pattern}`);
      expect(source).toContain(` * Nodes: ${example.nodes.join(", ")}`);
      for (const node of example.nodes) covered.add(node);
    }

    expect([...covered].sort()).toEqual([...workflowNodeKinds].sort());
  });

  it("routes each example from exactly one disclosure layer", async () => {
    const references = await Promise.all(
      ["authoring", "advanced-authoring", "signal-authoring"].map(async name => ({
        name,
        source: await readFile(skillReferencePath(name), "utf8"),
      })),
    );
    for (const example of skillWorkflowExamples) {
      const link = `../examples/workflows/${example.directory}/workflow.ts`;
      const routes = references.filter(reference => reference.source.includes(link)).map(reference => reference.name);
      expect(routes, example.name).toEqual([example.reference]);
    }
  });

});


