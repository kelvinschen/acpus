import * as Result from "effect/Result";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tryPrepareWorkflow } from "@acpus/workflow-compiler";
import { describe, expect, it } from "vitest";
import {
  copyFixture,
  expectPreparationFailure,
  pathOptions,
  withCompilerWorkspace,
} from "./support/preflight.js";
import { settle } from "./effect.js";

describe("workflow preparation", () => {
  it("emits a v2 lock for a successfully prepared workspace workflow", async () => {
    await withCompilerWorkspace("compiler-success-lock", async workspaceDir => {
      const workflow = await copyFixture(workspaceDir, "workflows/same-file-reusable.workflow.ts");
      const result = await settle(tryPrepareWorkflow(pathOptions(workspaceDir, workflow)));

      if (Result.isFailure(result)) throw new Error(result.failure.message);
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

  it("returns typed check failures without throwing", async () => {
    await withCompilerWorkspace("compiler-task-check-result", async workspaceDir => {
      const workflow = await copyFixture(workspaceDir, "workflows/inline-capture.workflow.ts");
      const result = await settle(tryPrepareWorkflow(pathOptions(workspaceDir, workflow)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) throw new Error("expected check failure");
      if (result.failure.type !== "check-failed") throw new Error("expected typed check failure");
      expect(result.failure.phase).toBe("check");
      expect(result.failure.diagnostics).toContainEqual(expect.objectContaining({
        code: "TB003",
        source: expect.objectContaining({ file: expect.stringContaining("inline-capture.workflow.ts") }),
        hint: expect.stringContaining("through Task input"),
      }));
    });
  });

  it("returns validation diagnostics for compiled invalid IR", async () => {
    await withCompilerWorkspace("compiler-validate", async workspaceDir => {
      const workflow = await copyFixture(workspaceDir, "workflows/basic/malformed.workflow.ts");
      const failure = await expectPreparationFailure(workflow, workspaceDir);
      expect(failure).toMatchObject({
        type: "validate-failed",
        phase: "validate",
      });
      if (failure.phase !== "validate") throw new Error("expected validate failure");
      expect(failure.diagnostics).toContainEqual(expect.objectContaining({
        code: "ID001",
        severity: "error",
        path: "root.nodes.bad id",
      }));
    });
  });

  it("retains the typed compile worker failure", async () => {
    await withCompilerWorkspace("compiler-worker-result", async workspaceDir => {
      const workflow = join(workspaceDir, "invalid.workflow.ts");
      await writeFile(workflow, "export default {};\n");

      const result = await settle(tryPrepareWorkflow(pathOptions(workspaceDir, workflow)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) throw new Error("expected compile failure");
      expect(result.failure).toEqual({
        type: "compile-failed",
        phase: "compile",
        message: `Default export of ${workflow} is not an Acpus workflow definition.`,
        failure: {
          type: "invalid-default-export",
          entry: workflow,
          message: `Default export of ${workflow} is not an Acpus workflow definition.`,
        },
      });
    });
  });
});
