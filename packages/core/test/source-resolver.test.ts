import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workflowSourceResolver, createIncludeResolver } from "../src/index.js";

describe("workflow source resolver", () => {
  it("validates and returns realpath for readable source paths at any location", () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-source-resolver-"));
    try {
      const sourcePath = join(dir, "workflow.yaml");
      writeFileSync(sourcePath, "version: 1\n", "utf8");

      const resolver = workflowSourceResolver(dir);

      expect(resolver.validateSourcePath(sourcePath)).toBe(realpathSync.native(sourcePath));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves includes whose symlink target is outside the workspace", () => {
    const workspace = mkdtempSync(join(tmpdir(), "acpus-source-resolver-ws-"));
    const outside = mkdtempSync(join(tmpdir(), "acpus-source-resolver-out-"));
    try {
      const workflowDir = join(workspace, "workflows");
      mkdirSync(workflowDir, { recursive: true });
      const parentPath = join(workflowDir, "parent.yaml");
      const outsidePath = join(outside, "child.yaml");
      const linkPath = join(workflowDir, "linked-child.yaml");
      writeFileSync(parentPath, "version: 1\n", "utf8");
      writeFileSync(outsidePath, "version: 1\n", "utf8");
      symlinkSync(outsidePath, linkPath);

      const resolver = workflowSourceResolver(workspace);
      const includeResolver = resolver.createIncludeResolver(parentPath);

      // Include resolves the symlink and reads the real file content — no root restriction.
      expect(includeResolver("linked-child.yaml", parentPath)).toBe("version: 1\n");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects non-existent source paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-source-resolver-"));
    try {
      const resolver = workflowSourceResolver(dir);

      expect(() => resolver.validateSourcePath("/nonexistent/path/workflow.yaml")).toThrow(
        /does not exist or is not readable/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("createIncludeResolver resolves includes from any directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-source-resolver-include-"));
    try {
      const childPath = join(dir, "child.yaml");
      writeFileSync(childPath, "version: 1\n", "utf8");

      const includeResolver = createIncludeResolver();
      expect(includeResolver(childPath)).toBe("version: 1\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("createIncludeResolver rejects non-existent include paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "acpus-source-resolver-include-"));
    try {
      const includeResolver = createIncludeResolver();

      expect(() => includeResolver("/nonexistent/child.yaml")).toThrow(
        /does not exist or is not readable/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates source paths outside workspace/global catalog roots", () => {
    const workspace = mkdtempSync(join(tmpdir(), "acpus-source-resolver-ws-"));
    const outside = mkdtempSync(join(tmpdir(), "acpus-source-resolver-out-"));
    try {
      const outsidePath = join(outside, "workflow.yaml");
      writeFileSync(outsidePath, "version: 1\n", "utf8");

      const resolver = workflowSourceResolver(workspace);

      // Paths outside workspace/global roots are now accepted — any readable path is valid.
      expect(resolver.validateSourcePath(outsidePath)).toBe(realpathSync.native(outsidePath));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
