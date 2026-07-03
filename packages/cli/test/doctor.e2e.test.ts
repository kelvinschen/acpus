import { access } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startSupervisorLoop } from "@acpus/runtime";
import { runSourceCli } from "./support/cli-runner.js";
import { copyWorkflowFixture } from "./support/fixtures.js";
import { withTestWorkspace } from "./support/workspace.js";

describe.concurrent("acpus doctor", () => {
  it("reports a no-store workspace as healthy without creating state", async () => {
    await withTestWorkspace("doctor-no-store", async workspace => {
      const result = await runSourceCli(workspace, ["doctor", "--json"]);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        phase: "doctor",
        checks: [
          expect.objectContaining({
            area: "workspace",
            status: "ok",
          }),
        ],
      });
      await expect(access(join(workspace, ".acpus", "state", "runtime.db"))).rejects.toThrow();
    });
  });

  it("reports runtime health after background admission", async () => {
    await withTestWorkspace("doctor-runtime", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/signals/signal.workflow.ts");
      const admitted = await runSourceCli(workspace, ["workflows", "run", workflow, "--background", "--json"]);
      expect(admitted.exitCode).toBe(0);

      const result = await runSourceCli(workspace, ["doctor", "--json"]);

      expect(result.exitCode).toBe(0);
      const checks = JSON.parse(result.stdout).checks;
      expect(checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ area: "store", status: "ok" }),
        expect.objectContaining({ area: "queues" }),
        expect.objectContaining({ area: "runs" }),
        expect.objectContaining({ area: "idle-stop" }),
      ]));
    });
  }, 15_000);

  it("reports supervisor idle age without mutating state", async () => {
    await withTestWorkspace("doctor-supervisor-idle", async workspace => {
      const loop = await startSupervisorLoop(workspace, {
        heartbeatMs: 5,
        idleStopMs: 5_000,
        packageVersion: "test",
      });
      try {
        await new Promise(resolve => setTimeout(resolve, 30));

        const result = await runSourceCli(workspace, ["doctor", "--json"]);

        expect(result.exitCode).toBe(0);
        const checks = JSON.parse(result.stdout).checks;
        expect(checks).toEqual(expect.arrayContaining([
          expect.objectContaining({
            area: "supervisor",
            details: expect.objectContaining({
              idleSinceAt: expect.any(String),
              idleAgeMs: expect.any(Number),
              idleStopMs: 5_000,
            }),
          }),
          expect.objectContaining({
            area: "idle-stop",
            details: expect.objectContaining({
              idleSinceAt: expect.any(String),
              idleAgeMs: expect.any(Number),
              idleStopMs: 5_000,
            }),
          }),
        ]));
      } finally {
        await loop.shutdown();
      }
    });
  });
});
