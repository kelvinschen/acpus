import { access } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSourceCli } from "./support/cli-runner.js";
import { copyWorkflowFixture } from "./support/fixtures.js";
import { withTestWorkspace } from "./support/workspace.js";

describe.concurrent("acpus run admission smoke", () => {
  it("runs a pure workflow and reports the completed run", async () => {
    await withTestWorkspace("run-pure", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/valid.workflow.ts");

      const result = await runSourceCli(workspace, ["run", workflow, "--input", "{\"ready\":true}", "--json"]);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        phase: "admit",
        run: {
          status: "completed",
        },
      });
    });
  });

  it("rejects invalid JSON input without creating runtime state", async () => {
    await withTestWorkspace("run-invalid-json", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/valid.workflow.ts");

      const result = await runSourceCli(workspace, ["run", workflow, "--input", "{", "--json"]);

      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        phase: "usage",
      });
      await expect(access(join(workspace, ".acpus", "state", "runtime.db"))).rejects.toThrow();
    });
  });
});
