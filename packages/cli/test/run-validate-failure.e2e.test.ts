import { describe, expect, it } from "vitest";
import { runSourceCli } from "./support/cli-runner.js";
import { copyWorkflowFixture } from "./support/fixtures.js";
import { withTestWorkspace } from "./support/workspace.js";

describe("acpus run validation failure smoke", () => {
  it("reports compiled IR diagnostics through the CLI phase mapping", async () => {
    await withTestWorkspace("run-validate", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/malformed.workflow.ts");

      const result = await runSourceCli(workspace, ["run", workflow, "--dry-run", "--json"]);

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
});
