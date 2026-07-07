import { describe, expect, it } from "vitest";
import { runSourceCli } from "./support/cli-runner.js";
import { copyWorkflowFixture } from "./support/fixtures.js";
import { withTestWorkspace } from "./support/workspace.js";

describe("acpus runs retry smoke", () => {
  it("reports missing run control failures with control phase", async () => {
    await withTestWorkspace("runs-retry-missing", async workspace => {
      const retried = await runSourceCli(workspace, ["runs", "retry", "run_missing", "--json"]);

      expect(retried.exitCode).toBe(1);
      expect(JSON.parse(retried.stdout)).toMatchObject({
        ok: false,
        phase: "control",
      });
    });
  });

  it("forwards a targeted retry option", async () => {
    await withTestWorkspace("runs-retry-target", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/valid.workflow.ts");
      const admitted = await runSourceCli(workspace, ["workflow", "run", workflow, "--input", "{\"ready\":false}", "--json"]);
      expect(admitted.exitCode).toBe(1);
      const runId = JSON.parse(admitted.stdout.trim().split("\n").at(-1)!).run.id;

      const retried = await runSourceCli(workspace, ["runs", "retry", runId, "--target", "missing", "--json"]);

      expect(retried.exitCode).toBe(1);
      expect(JSON.parse(retried.stdout)).toMatchObject({
        ok: false,
        phase: "control",
      });
      expect(JSON.parse(retried.stdout).message).toContain("target 'missing' was not found");
    });
  }, 15_000);
});
