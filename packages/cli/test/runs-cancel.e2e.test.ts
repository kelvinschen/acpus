import { describe, expect, it } from "vitest";
import { runSourceCli } from "./support/cli-runner.js";
import { copyWorkflowFixture } from "./support/fixtures.js";
import { withTestWorkspace } from "./support/workspace.js";

describe("acpus runs cancel smoke", () => {
  it("cancels an awaiting scheduler run", async () => {
    await withTestWorkspace("runs-cancel", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/signals/signal.workflow.ts");
      const admitted = await runSourceCli(workspace, ["run", workflow, "--json"]);
      expect(admitted.exitCode).toBe(0);
      const runId = JSON.parse(admitted.stdout).run.id;

      const canceled = await runSourceCli(workspace, ["runs", "cancel", runId, "--json"]);

      expect(canceled.exitCode).toBe(0);
      expect(JSON.parse(canceled.stdout)).toMatchObject({
        ok: true,
        message: "Run canceled.",
        run: {
          id: runId,
          status: "canceled",
        },
      });
    });
  });

  it("forwards a targeted cancel option", async () => {
    await withTestWorkspace("runs-cancel-target", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/signals/signal.workflow.ts");
      const admitted = await runSourceCli(workspace, ["run", workflow, "--json"]);
      expect(admitted.exitCode).toBe(0);
      const runId = JSON.parse(admitted.stdout).run.id;

      const canceled = await runSourceCli(workspace, ["runs", "cancel", runId, "--target", "approve", "--json"]);

      expect(canceled.exitCode).toBe(0);
      const run = JSON.parse(canceled.stdout).run;
      expect(run.id).toBe(runId);
      expect(run.dynamic.nodeInstances).toEqual([
        expect.objectContaining({
          nodeId: "approve",
          status: "cancelled",
          statusReason: "operator_cancelled",
        }),
      ]);
    });
  });
});
