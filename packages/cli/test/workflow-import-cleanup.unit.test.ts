import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  removePrivateTree: vi.fn<() => Promise<void>>(),
}));

vi.mock("../src/platform/private-directory.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/platform/private-directory.js")>(),
  removePrivateTree: mock.removePrivateTree,
}));

import { importWorkflowPackage } from "../src/workflow/import/index.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("workflow import cleanup failures", () => {
  it("reports cleanup failure after an otherwise successful import", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "acpus-import-cleanup-"));
    const source = join(workspace, "source.ts");
    await writeFile(source, workflowSource("cleanup-success"));
    mock.removePrivateTree.mockRejectedValue(new Error("cleanup denied"));

    try {
      const imported = await importWorkflowPackage({
        cwd: workspace,
        source,
        scope: "project",
        check: false,
      });

      expect(imported.isErr()).toBe(true);
      if (imported.isErr()) {
        expect(imported.error).toMatchObject({
          type: "import",
          errorCode: "IMPORT_CLEANUP_FAILED",
        });
      }
      await expect(access(join(
        workspace,
        ".acpus",
        "workflows",
        "cleanup-success",
        "workflow.ts",
      ))).resolves.toBeUndefined();
      expect(mock.removePrivateTree).toHaveBeenCalledOnce();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("preserves the primary import code when cleanup also fails", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "acpus-import-cleanup-"));
    const source = join(workspace, "source.ts");
    await mkdir(workspace, { recursive: true });
    await writeFile(source, "export const value = 1;\n");
    mock.removePrivateTree.mockRejectedValue(new Error("cleanup denied"));

    try {
      const imported = await importWorkflowPackage({
        cwd: workspace,
        source,
        scope: "project",
        check: false,
      });

      expect(imported.isErr()).toBe(true);
      if (imported.isErr()) {
        expect(imported.error).toMatchObject({
          type: "import",
          errorCode: "IMPORT_METADATA_INVALID",
        });
      }
      await expect(access(join(workspace, ".acpus", "workflows"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(mock.removePrivateTree).toHaveBeenCalledOnce();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

function workflowSource(name: string): string {
  return [
    'import { defineWorkflow } from "acpus/core";',
    `export default defineWorkflow({ name: ${JSON.stringify(name)} }).build(() => ({ ok: true }));`,
    "",
  ].join("\n");
}
