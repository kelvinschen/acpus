import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workflowSourcePolicy } from "../src/index.js";

describe("workflow source policy", () => {
  it("allows readable Workflow Spec paths inside the workspace", () => {
    const workspace = mkdtempSync(join(tmpdir(), "acpus-source-policy-"));
    try {
      const sourcePath = join(workspace, "workflow.yaml");
      writeFileSync(sourcePath, "version: 1\n", "utf8");

      const policy = workflowSourcePolicy(workspace);

      expect(policy.validateSourcePath(sourcePath)).toBe(realpathSync.native(sourcePath));
      expect(policy.isAllowedSourcePath(sourcePath)).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects includes whose symlink target resolves outside the workspace", () => {
    const workspace = mkdtempSync(join(tmpdir(), "acpus-source-policy-"));
    const outside = mkdtempSync(join(tmpdir(), "acpus-source-policy-outside-"));
    try {
      const workflowDir = join(workspace, "workflows");
      mkdirSync(workflowDir, { recursive: true });
      const parentPath = join(workflowDir, "parent.yaml");
      const outsidePath = join(outside, "child.yaml");
      const linkPath = join(workflowDir, "linked-child.yaml");
      writeFileSync(parentPath, "version: 1\n", "utf8");
      writeFileSync(outsidePath, "version: 1\n", "utf8");
      symlinkSync(outsidePath, linkPath);

      const policy = workflowSourcePolicy(workspace);
      const includeResolver = policy.createIncludeResolver(parentPath);

      expect(() => includeResolver("linked-child.yaml", parentPath)).toThrow(/outside allowed Workflow Spec roots/);
      expect(policy.isAllowedSourcePath(linkPath)).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
