import * as Result from "effect/Result";
import { stat } from "node:fs/promises";
import { tryPrepareWorkflow } from "@acpus/workflow-compiler";
import { describe, expect, it, vi } from "vitest";
import { settle } from "./effect.js";
import { expectNoScratchReference, withCompilerWorkspace } from "./support/preflight.js";

const scratchDirectories = vi.hoisted((): string[] => []);

vi.mock("../src/preflight/temp.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/preflight/temp.js")>();
  return {
    ...original,
    createScratchDir: async (): Promise<string> => {
      const path = await original.createScratchDir();
      scratchDirectories.push(path);
      return path;
    },
  };
});

describe("workflow preparation scratch cleanup", () => {
  it("rejects private materialization paths in snapshot IR and removes scratch", async () => {
    await withCompilerWorkspace("compiler-snapshot-failure-paths", async workspaceDir => {
      const scratchIndex = scratchDirectories.length;
      const result = await settle(tryPrepareWorkflow({
        workspaceDir,
        source: {
          kind: "files",
          entry: "workflow.ts",
          files: [
            { path: "package.json", content: "{\"type\":\"module\"}\n" },
            {
              path: "workflow.ts",
              content: `import { defineWorkflow } from "acpus/core";
export default defineWorkflow({
  name: "private-materialization",
  description: import.meta.url,
}).build(() => ({}));
`,
            },
          ],
        },
      }));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) throw new Error("expected source failure");
      expect(result.failure).toEqual({
        type: "source-invalid",
        phase: "source",
        message: "Snapshot workflow IR must not reference the compiler's private source materialization.",
      });
      const scratch = scratchDirectories.slice(scratchIndex);
      expect(scratch).toHaveLength(1);
      expectNoScratchReference(result.failure, scratch);
      await expect(stat(scratch[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
