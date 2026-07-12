import { readFile } from "node:fs/promises";
import * as core from "acpus/core";
import * as expression from "acpus/expression";
import * as gitTasks from "acpus/tasks/git";
import { describe, expect, it } from "vitest";
import { skillWorkflowExamples, skillWorkflowPath, workflowNodeKinds } from "./support/skill-workflow-examples.js";

const authoringFacades = {
  "acpus/core": core,
  "acpus/expression": expression,
  "acpus/tasks/git": gitTasks,
} as const;

describe("skill workflow source contracts", () => {
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

  it("makes every runtime authoring helper discoverable from each example", async () => {
    for (const example of skillWorkflowExamples) {
      const source = await readFile(skillWorkflowPath(example.directory), "utf8");
      for (const [specifier, facade] of Object.entries(authoringFacades)) {
        expect(discoverableHelpers(source, specifier), `${example.name}: ${specifier}`).toEqual(Object.keys(facade).sort());
      }
    }
  });
});

function discoverableHelpers(source: string, specifier: string): string[] {
  const imports = source.matchAll(/^(?:\/\/ )?import\s+\{([^}]*)\}\s+from\s+"([^"]+)";$/gm);
  const names = [...imports].find(match => match[2] === specifier)?.[1];
  if (!names) return [];
  return names
    .replaceAll("/*", "")
    .replaceAll("*/", "")
    .split(",")
    .map(name => name.trim())
    .filter(Boolean)
    .sort();
}
