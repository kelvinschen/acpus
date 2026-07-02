import { describe, expect, it } from "vitest";
import { runSourceCli } from "./support/cli-runner.js";
import { copyWorkflowFixture } from "./support/fixtures.js";
import { withTestWorkspace } from "./support/workspace.js";

describe("acpus runs signal smoke", () => {
  it("accepts a signal payload and completes an awaiting run", async () => {
    await withTestWorkspace("runs-signal", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/signals/signal.workflow.ts");
      const admitted = await runSourceCli(workspace, ["run", workflow, "--json"]);
      expect(admitted.exitCode).toBe(0);
      const runId = JSON.parse(admitted.stdout).run.id;
      expect(JSON.parse(admitted.stdout).run.status).toBe("awaiting");

      const signaled = await runSourceCli(workspace, ["runs", "signal", runId, "--node", "approve", "--payload", "{\"ok\":true}", "--json"]);

      expect(signaled.exitCode).toBe(0);
      expect(JSON.parse(signaled.stdout).run).toMatchObject({
        id: runId,
        status: "completed",
        output: { ok: true },
      });
    });
  }, 15_000);
});
