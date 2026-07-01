import { describe, expect, it } from "vitest";
import { runSourceCli } from "./support/cli-runner.js";
import { copyWorkflowFixture } from "./support/fixtures.js";
import { withTestWorkspace } from "./support/workspace.js";

describe("acpus run preparation failure smoke", () => {
  it("reports workflow check failures through the CLI phase mapping", async () => {
    await withTestWorkspace("run-check", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/invalid/type-error.workflow.fixture", "type-error.workflow.ts");

      const result = await runSourceCli(workspace, ["run", workflow, "--json"]);

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        phase: "check",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: expect.stringMatching(/^TS/) }),
        ]),
      });
    });
  });

  it("reports workflow check failures through dry-run phase mapping", async () => {
    await withTestWorkspace("run-dry-check", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/invalid/type-error.workflow.fixture", "type-error.workflow.ts");

      const result = await runSourceCli(workspace, ["run", workflow, "--dry-run", "--json"]);

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        phase: "check",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: expect.stringMatching(/^TS/) }),
        ]),
      });
    });
  });
});
