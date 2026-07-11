import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Snapshot } from "typescript/unstable/sync";
import { describe, expect, it, vi } from "vitest";
import { tryCompileWorkflowModule } from "../src/compiler/module.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

describe("TypeScript native compile boundary", () => {
  it("maps parser-project failures to task-analysis-failed", async () => {
    const getProject = vi.spyOn(Snapshot.prototype, "getProject").mockReturnValue(undefined);
    try {
      const entry = resolve(repoRoot, "packages/workflow-compiler/test/fixtures/workflows/release.workflow.ts");
      const result = await tryCompileWorkflowModule(entry, repoRoot);

      expect(result.isErr()).toBe(true);
      if (result.isOk()) return;
      expect(result.error).toEqual(expect.objectContaining({
        type: "task-analysis-failed",
        message: expect.stringContaining("did not open project"),
      }));
    } finally {
      getProject.mockRestore();
    }
  });
});
