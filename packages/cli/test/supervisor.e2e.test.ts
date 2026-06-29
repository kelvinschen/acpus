import { describe, expect, it } from "vitest";
import { runSourceCli } from "./support/cli-runner.js";
import { withTestWorkspace } from "./support/workspace.js";

describe("acpus supervisor commands", () => {
  it("starts and shuts down the source supervisor through durable commands", async () => {
    await withTestWorkspace("supervisor-source", async workspace => {
      const started = await runSourceCli(workspace, ["runs", "supervise", "--background", "--json"]);
      expect(started.exitCode).toBe(0);
      expect(JSON.parse(started.stdout)).toMatchObject({
        ok: true,
        message: "Supervisor started.",
      });

      const shutdown = await waitForShutdownCommand(workspace, runSourceCli);
      expect(JSON.parse(shutdown.stdout).message).toBe("Supervisor shutdown command queued.");
    });
  }, 10_000);
});

async function waitForShutdownCommand(
  workspace: string,
  runCli: (cwd: string, args: string[]) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  let last: { exitCode: number | null; stdout: string; stderr: string } | undefined;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    last = await runCli(workspace, ["runs", "shutdown", "--json"]);
    if (last.exitCode === 0) return last;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for supervisor shutdown command. Last result: ${JSON.stringify(last ?? { exitCode: null, stdout: "", stderr: "" })}`);
}
