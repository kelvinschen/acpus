import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getRuntimeHealth, requestDaemonStatus } from "@acpus/runtime";
import { describe, expect, it } from "vitest";
import { getCliPackageInfo } from "../src/package-info.js";
import { runSourceCli } from "./support/cli-runner.js";
import { copyWorkflowFixture } from "./support/fixtures.js";
import { withDaemonTestWorkspace } from "./support/workspace.js";

const runIdPattern = /^\d{14}[A-F0-9]{20}$/;

describe.concurrent("acpus CLI subprocess smoke", () => {
  it("follows a workflow path and publishes its CLI package version to the daemon", async () => {
    await withDaemonTestWorkspace("e2e-run-path", async (workspace, home) => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/valid.workflow.ts");
      const input = "sample input.JSON";
      await writeFile(join(workspace, input), "{\"ready\":true}\n");

      const result = await runSourceCli(workspace, ["workflow", "run", workflow, "--input", input, "--follow"]);

      expect(result.exitCode, result.stdout || result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      const [runId] = result.stdout.match(/\d{14}[A-F0-9]{20}/gu) ?? [];
      expect(runId).toMatch(runIdPattern);
      expect(result.stdout).toContain(`Run ${runId}`);
      expect(result.stdout).toMatch(/completed/u);
      expect(result.stdout).toContain("Output:\n  {\n    \"ready\": true\n  }");
      const daemonStatus = await requestDaemonStatus(workspace);
      expect(daemonStatus.isOk()).toBe(true);
      if (daemonStatus.isOk()) expect(daemonStatus.value.packageVersion).toBe(getCliPackageInfo().version);
      const health = await getRuntimeHealth(workspace);
      expect(health.checks.find(check => check.area === "daemon")).toMatchObject({
        details: { packageVersion: getCliPackageInfo().version },
      });
      await expect(access(join(home, ".acpus", "workspaces"))).resolves.toBeUndefined();
      await expect(access(join(workspace, ".acpus", ".local"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

});
