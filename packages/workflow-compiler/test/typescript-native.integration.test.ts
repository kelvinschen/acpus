import * as Result from "effect/Result";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Digest } from "@acpus/core/content-identity";
import { Snapshot } from "typescript/unstable/sync";
import { describe, expect, it, vi } from "vitest";
import { tryCompileWorkflowModule } from "../src/compiler/module.js";
import { settle } from "./effect.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

describe("TypeScript native compile boundary", () => {
  it("maps parser-project failures to task-analysis-failed", async () => {
    const getProject = vi.spyOn(Snapshot.prototype, "getProject").mockReturnValue(undefined);
    try {
      const entry = resolve(repoRoot, "packages/workflow-compiler/test/fixtures/workflows/release.workflow.ts");
      const result = await settle(tryCompileWorkflowModule(entry, repoRoot, {
        expectedSourceDigest: sha256Digest(await readFile(entry, "utf8")),
      }));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toEqual(expect.objectContaining({
        type: "task-analysis-failed",
        message: expect.stringContaining("did not open project"),
      }));
    } finally {
      getProject.mockRestore();
    }
  });
});
