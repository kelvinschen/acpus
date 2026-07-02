import { describe, expect, it } from "vitest";
import { runSourceCli } from "./support/cli-runner.js";
import { copyWorkflowFixture } from "./support/fixtures.js";
import { withTestWorkspace } from "./support/workspace.js";

describe("acpus workflows check validation failure smoke", () => {
  it("reports compiled IR diagnostics through the CLI phase mapping", async () => {
    await withTestWorkspace("run-validate", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/malformed.workflow.ts");

      const result = await runSourceCli(workspace, ["workflows", "check", workflow, "--json"]);

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        phase: "validate",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "ID001", severity: "error" }),
        ]),
      });
    });
  });

  it("renders validation diagnostic hints in text output", async () => {
    await withTestWorkspace("run-validate-text", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/malformed.workflow.ts");

      const result = await runSourceCli(workspace, ["workflows", "check", workflow]);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("[error] ID001");
      expect(result.stderr).toContain("hint: Node ids must be compile-time stable strings.");
    });
  });
});
