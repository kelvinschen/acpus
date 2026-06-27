import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { compileWorkflow } from "@acpus/core";
import { globalWorkflowRoot, listWorkflowCatalog, resolveWorkflowTarget } from "../../src/catalog.js";

describe("Workflow Catalog", () => {
  it("keeps checked-in project catalog workflows lint-ready", () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
    const workflows = [
      ".acpus/workflows/adversarial-feature-implementation-review.workflow.spec.yaml",
      ".acpus/workflows/codebase-deep-research.workflow.spec.yaml",
      ".acpus/workflows/goal-driven-development.workflow.spec.yaml",
      ".acpus/workflows/human-in-the-loop-development.workflow.spec.yaml",
      ".acpus/workflows/loop-until-green-fix.workflow.spec.yaml",
      ".acpus/workflows/solution-generate-filter.workflow.spec.yaml",
      ".acpus/workflows/worktree-implementation-tournament.workflow.spec.yaml",
      ".acpus/workflows/stress-demo/workflow.spec.yaml",
      ".acpus/workflows/swarm-intelligence/workflow.spec.yaml"
    ];

    for (const rel of workflows) {
      const sourcePath = join(repoRoot, rel);
      const result = compileWorkflow(readFileSync(sourcePath, "utf8"), { sourcePath });
      expect(result.diagnostics, rel).toEqual([]);
      expect(result.ok, rel).toBe(true);
    }
  });

  it("discovers ready, invalid, and conflict entries from the project catalog", () => {
    const workspace = mkdtempSync(join(tmpdir(), "acpus-catalog-"));
    try {
      const root = join(workspace, ".acpus", "workflows");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "ready.workflow.yaml"), SIMPLE_WORKFLOW("catalog-ready"), "utf8");
      mkdirSync(join(root, "bundle"), { recursive: true });
      writeFileSync(join(root, "bundle", "workflow.spec.yaml"), SIMPLE_WORKFLOW("catalog-bundle"), "utf8");
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
      expect(entries.find((entry) => entry.name === "catalog-bundle")).toMatchObject({
        scope: "project",
        ref: "project:catalog-bundle",
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

  it("marks specs ready when includes resolve outside workspace/global catalog roots", () => {
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

      // Catalog discovery roots remain constrained; file references from discovered specs
      // are not constrained by those roots.
      expect(entry?.status).toBe("ready");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("accepts includes from project and global Workflow Catalog source roots", () => {
    const workspace = mkdtempSync(join(tmpdir(), "acpus-catalog-policy-"));
    const originalHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "acpus-catalog-home-"));
    process.env.HOME = home;
    try {
      const projectRoot = join(workspace, ".acpus", "workflows");
      const globalRoot = globalWorkflowRoot();
      mkdirSync(projectRoot, { recursive: true });
      mkdirSync(globalRoot, { recursive: true });
      writeFileSync(join(projectRoot, "project-child.yaml"), SIMPLE_WORKFLOW("project-child"), "utf8");
      writeFileSync(join(projectRoot, "project-parent.workflow.yaml"), INCLUDE_WORKFLOW("project-parent", "project-child.yaml"), "utf8");
      writeFileSync(join(globalRoot, "global-child.yaml"), SIMPLE_WORKFLOW("global-child"), "utf8");
      writeFileSync(join(globalRoot, "global-parent.workflow.yaml"), INCLUDE_WORKFLOW("global-parent", "global-child.yaml"), "utf8");

      const entries = listWorkflowCatalog(workspace);

      expect(entries.find((entry) => entry.name === "project-parent")).toMatchObject({
        scope: "project",
        status: "ready"
      });
      expect(entries.find((entry) => entry.name === "global-parent")).toMatchObject({
        scope: "global",
        status: "ready"
      });
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(workspace, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
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

function INCLUDE_WORKFLOW(name: string, include: string): string {
  return `
version: 1
name: ${name}
workflow:
  steps:
    - include: ${include}
`;
}
