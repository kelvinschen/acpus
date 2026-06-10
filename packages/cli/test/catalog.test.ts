import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listWorkflowCatalog, resolveWorkflowTarget } from "../src/catalog.js";

describe("Workflow Catalog", () => {
  it("discovers ready, invalid, and conflict entries from the project catalog", () => {
    const workspace = mkdtempSync(join(tmpdir(), "acpus-catalog-"));
    try {
      const root = join(workspace, ".acpus", "workflows");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "ready.workflow.yaml"), SIMPLE_WORKFLOW("catalog-ready"), "utf8");
      writeFileSync(join(root, "invalid.workflow.yaml"), "version: 1\nworkflow: {}\n", "utf8");
      writeFileSync(join(root, "dupe-one.workflow.yaml"), SIMPLE_WORKFLOW("catalog-dupe"), "utf8");
      writeFileSync(join(root, "dupe-two.workflow.yaml"), SIMPLE_WORKFLOW("catalog-dupe"), "utf8");
      writeFileSync(join(root, "ignored.yaml"), SIMPLE_WORKFLOW("ignored"), "utf8");

      const entries = listWorkflowCatalog(workspace).filter((entry) => entry.path.startsWith(root));

      expect(entries.find((entry) => entry.name === "catalog-ready")).toMatchObject({
        scope: "project",
        ref: "project:catalog-ready",
        status: "ready"
      });
      expect(entries.find((entry) => entry.path.endsWith("invalid.workflow.yaml"))?.status).toBe("invalid");
      expect(entries.filter((entry) => entry.name === "catalog-dupe").map((entry) => entry.status)).toEqual(["conflict", "conflict"]);
      expect(entries.some((entry) => entry.name === "ignored")).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("resolves unique short names and rejects conflicted short names", () => {
    const workspace = mkdtempSync(join(tmpdir(), "acpus-catalog-resolve-"));
    try {
      const root = join(workspace, ".acpus", "workflows");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "ready.workflow.yaml"), SIMPLE_WORKFLOW("catalog-run-me"), "utf8");
      writeFileSync(join(root, "dupe-one.workflow.yaml"), SIMPLE_WORKFLOW("catalog-conflict"), "utf8");
      writeFileSync(join(root, "dupe-two.workflow.yaml"), SIMPLE_WORKFLOW("catalog-conflict"), "utf8");

      expect(resolveWorkflowTarget("catalog-run-me", workspace)).toMatchObject({
        sourcePath: join(root, "ready.workflow.yaml"),
        workflowRef: "project:catalog-run-me"
      });
      expect(() => resolveWorkflowTarget("catalog-conflict", workspace)).toThrow(/conflict|duplicated/i);
      expect(() => resolveWorkflowTarget("project:catalog-conflict", workspace)).toThrow(/conflict|duplicated/i);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("marks specs invalid when includes resolve outside allowed source roots", () => {
    const workspace = mkdtempSync(join(tmpdir(), "acpus-catalog-include-"));
    const outside = mkdtempSync(join(tmpdir(), "acpus-catalog-outside-"));
    try {
      const root = join(workspace, ".acpus", "workflows");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(outside, "child.yaml"), SIMPLE_WORKFLOW("outside-child"), "utf8");
      writeFileSync(join(root, "parent.workflow.yaml"), `
version: 1
name: catalog-parent
workflow:
  steps:
    - include: ${join(outside, "child.yaml")}
`, "utf8");

      const entry = listWorkflowCatalog(workspace).find((item) => item.name === "catalog-parent");

      expect(entry?.status).toBe("invalid");
      expect(entry?.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toMatch(/outside allowed Workflow Spec roots/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

function SIMPLE_WORKFLOW(name: string): string {
  return `
version: 1
name: ${name}
workflow:
  steps:
    - id: ok
      run: program
      cmd: "echo ok"
`;
}
