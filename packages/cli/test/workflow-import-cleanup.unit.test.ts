import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  removePrivateTree: vi.fn<(path: string) => Promise<void>>(),
  extractWorkflowMetadata: vi.fn(),
  tryPrepareWorkflow: vi.fn(),
}));

vi.mock("@acpus/workflow-compiler", () => ({
  extractWorkflowMetadata: mock.extractWorkflowMetadata,
  tryPrepareWorkflow: mock.tryPrepareWorkflow,
}));

vi.mock("../src/platform/private-directory.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/platform/private-directory.js")>(),
  removePrivateTree: mock.removePrivateTree,
}));

import { importWorkflowPackage } from "../src/workflow/import/index.js";
import { settle } from "./effect.js";

beforeEach(() => {
  mock.extractWorkflowMetadata.mockImplementation((source: string) => {
    const name = /name:\s*["']([^"']+)["']/u.exec(source)?.[1];
    return name === undefined
      ? Effect.fail({ message: "Workflow metadata is invalid." })
      : Effect.succeed({ name });
  });
  mock.removePrivateTree.mockImplementation((path: string) => rm(path, { recursive: true, force: true }));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("workflow import cleanup failures", () => {
  it("preserves a typed preparation failure without committing the package", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "acpus-import-preparation-"));
    const source = join(workspace, "source.ts");
    await writeFile(source, workflowSource("preparation-failure"));
    mock.tryPrepareWorkflow.mockReturnValue(Effect.fail({
      type: "compile-failed",
      phase: "compile",
      message: "top-level import failure",
      failure: {
        type: "module-import-failed",
        entry: source,
        message: "top-level import failure",
      },
    }));

    try {
      const imported = await settle(importWorkflowPackage({
        cwd: workspace,
        source,
        scope: "project",
        check: true,
      }));

      expect(Result.isFailure(imported) && imported.failure).toMatchObject({
        type: "preparation",
        failure: { type: "compile-failed", phase: "compile", message: "top-level import failure" },
      });
      await expect(access(join(
        workspace,
        ".acpus",
        "workflows",
        "preparation-failure",
      ))).rejects.toMatchObject({ code: "ENOENT" });
      expect(mock.removePrivateTree).toHaveBeenCalledOnce();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reports cleanup failure after an otherwise successful import", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "acpus-import-cleanup-"));
    const source = join(workspace, "source.ts");
    await writeFile(source, workflowSource("cleanup-success"));
    mock.removePrivateTree.mockRejectedValue(new Error("cleanup denied"));

    try {
      const imported = await settle(importWorkflowPackage({
        cwd: workspace,
        source,
        scope: "project",
        check: false,
      }));

      expect(Result.isFailure(imported)).toBe(true);
      if (Result.isFailure(imported)) {
        expect(imported.failure).toMatchObject({
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
      const imported = await settle(importWorkflowPackage({
        cwd: workspace,
        source,
        scope: "project",
        check: false,
      }));

      expect(Result.isFailure(imported)).toBe(true);
      if (Result.isFailure(imported)) {
        expect(imported.failure).toMatchObject({
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
