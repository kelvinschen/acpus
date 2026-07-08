import { describe, expect, it } from "vitest";
import { runSourceCli } from "./support/cli-runner.js";
import { copyWorkflowFixture } from "./support/fixtures.js";
import { withTestWorkspace } from "./support/workspace.js";

const runIdPattern = /^\d{14}[A-F0-9]{20}$/;

describe.concurrent("acpus CLI subprocess smoke", () => {
  it("runs a workflow path in foreground JSON mode", async () => {
    await withTestWorkspace("e2e-run-path", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/valid.workflow.ts");

      const result = await runSourceCli(workspace, ["workflow", "run", workflow, "--input", "{\"ready\":true}", "--json"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const records = result.stdout.trim().split("\n").map(line => JSON.parse(line));
      expect(records[0]).toMatchObject({ ok: true, phase: "run", kind: "admitted" });
      expect(records[0].run.id).toMatch(runIdPattern);
      expect(records.at(-1)).toMatchObject({
        ok: true,
        phase: "run",
        kind: "terminal summary",
        run: {
          name: "cli-valid",
          status: "completed",
          output: { ready: true },
        },
      });
    });
  });

  it("signals an awaiting workflow through the subprocess CLI", async () => {
    await withTestWorkspace("e2e-runs-signal", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/signals/signal.workflow.ts");
      const admitted = await runSourceCli(workspace, ["workflow", "run", workflow, "--json"]);
      expect(admitted.exitCode).toBe(0);
      const runId = JSON.parse(admitted.stdout.trim().split("\n").at(-1)!).run.id;

      const signaled = await runSourceCli(workspace, ["runs", "signal", runId, "--target", "approve", "--payload", "{\"ok\":true}", "--json"]);

      expect(signaled.exitCode).toBe(0);
      expect(signaled.stderr).toBe("");
      expect(JSON.parse(signaled.stdout)).toMatchObject({
        ok: true,
        phase: "control",
        run: { id: runId },
      });
    });
  });
});
