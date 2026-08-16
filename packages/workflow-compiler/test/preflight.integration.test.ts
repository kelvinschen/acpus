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

describe("workflow preparation", () => {
  it("returns typed check failures without throwing", async () => {
    await withCompilerWorkspace("compiler-task-check-result", async workspaceDir => {
      const workflow = await copyFixture(workspaceDir, "workflows/inline-capture.workflow.ts");
      const result = await tryPrepareWorkflow(pathOptions(workspaceDir, workflow));

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected check failure");
      if (result.error.type !== "check-failed") throw new Error("expected typed check failure");
      expect(result.error.phase).toBe("check");
      expect(result.error.diagnostics).toContainEqual(expect.objectContaining({
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

      const result = await tryPrepareWorkflow(pathOptions(workspaceDir, workflow));

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected compile failure");
      expect(result.error).toEqual({
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
