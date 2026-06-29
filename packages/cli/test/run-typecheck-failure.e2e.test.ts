import { describe, expect, it } from "vitest";
import { runSourceCli } from "./support/cli-runner.js";
import { copyWorkflowFixture } from "./support/fixtures.js";
import { withTestWorkspace } from "./support/workspace.js";

describe("acpus run preparation failure smoke", () => {
  it("reports workflow typecheck failures through the CLI phase mapping", async () => {
    await withTestWorkspace("run-typecheck", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/invalid/type-error.workflow.fixture", "type-error.workflow.ts");

      const result = await runSourceCli(workspace, ["run", workflow, "--json"]);

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        phase: "typecheck",
      });
    });
  });
});
