import { describe, expect, it } from "vitest";
import { runSourceCli } from "./support/cli-runner.js";
import { copyWorkflowFixture } from "./support/fixtures.js";
import { withTestWorkspace } from "./support/workspace.js";

describe("acpus runs signal smoke", () => {
  it("accepts a signal payload and completes an awaiting run", async () => {
    await withTestWorkspace("runs-signal", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/signals/signal.workflow.ts");
      const admitted = await runSourceCli(workspace, ["workflows", "run", workflow, "--json"]);
      expect(admitted.exitCode).toBe(0);
      const runId = JSON.parse(admitted.stdout.trim().split("\n").at(-1)!).run.id;
      expect(JSON.parse(admitted.stdout.trim().split("\n").at(-1)!).run.status).toBe("awaiting");

      const signaled = await runSourceCli(workspace, ["runs", "signal", runId, "--target", "approve", "--payload", "{\"ok\":true}", "--json"]);

      expect(signaled.exitCode).toBe(0);
      expect(JSON.parse(signaled.stdout)).toMatchObject({
        ok: true,
        phase: "control",
        command: {
          type: "signal",
          status: "applied",
        },
        run: {
          id: runId,
        },
      });

      const completed = await waitForCompletedRun(workspace, runId);
      expect(completed).toMatchObject({
        status: "completed",
        output: { ok: true },
      });
    });
  }, 15_000);
});

async function waitForCompletedRun(workspace: string, runId: string): Promise<Record<string, unknown>> {
  let last: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const inspected = await runSourceCli(workspace, ["runs", "inspect", runId, "--json"]);
    last = JSON.parse(inspected.stdout).run;
    if (last?.status === "completed") return last;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for completed run. Last: ${JSON.stringify(last)}`);
}
