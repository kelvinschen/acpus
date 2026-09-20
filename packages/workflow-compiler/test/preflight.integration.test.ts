import * as Result from "effect/Result";
import { tryPrepareWorkflow } from "@acpus/workflow-compiler";
import { describe, expect, it } from "vitest";
import {
  copyFixture,
  pathOptions,
  withCompilerWorkspace,
} from "./support/preflight.js";
import { settle } from "./effect.js";

describe("workflow preparation", () => {
  it("emits a v2 lock for a successfully prepared workspace workflow", async () => {
    await withCompilerWorkspace("compiler-success-lock", async workspaceDir => {
      const workflow = await copyFixture(workspaceDir, "workflows/same-file-reusable.workflow.ts");
      const result = await settle(tryPrepareWorkflow(pathOptions(workspaceDir, workflow)));

      if (Result.isFailure(result)) throw new Error(JSON.stringify(result.failure));
      expect(result.success.source).toEqual({ kind: "workspace", entry: "same-file-reusable.workflow.ts" });
      expect(result.success.lock).toEqual({
        kind: "acpus_workflow_preparation_lock",
        version: 2,
        workflow: {
          source: result.success.source,
          entryDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        ir: {
          path: "workflow.ir.json",
          digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        sourceGraphDigest: result.success.sourceGraphDigest,
      });
    });
  });
});
