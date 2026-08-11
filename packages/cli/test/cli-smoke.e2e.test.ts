import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getRuntimeHealth,
  requestDaemonShutdown,
  requestDaemonStatus,
} from "@acpus/runtime";
import { describe, expect, it } from "vitest";
import { getCliPackageInfo } from "../src/platform/package-info.js";
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

  it("follows a terminal run locally after daemon shutdown without recreating the socket", async () => {
    await withDaemonTestWorkspace("e2e-offline-follow", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/valid.workflow.ts");
      const submitted = await runSourceCli(workspace, [
        "workflow", "run", workflow, "--input", "{\"ready\":true}", "--follow",
      ]);
      const [runId] = submitted.stdout.match(/\d{14}[A-F0-9]{20}/gu) ?? [];
      expect(submitted.exitCode, submitted.stdout || submitted.stderr).toBe(0);
      expect(runId).toMatch(runIdPattern);

      const shutdown = await requestDaemonShutdown(workspace);
      expect(shutdown.isOk()).toBe(true);
      await waitForDaemonUnavailable(workspace);

      const inspected = await runSourceCli(workspace, ["runs", "inspect", runId!, "--follow"]);

      expect(inspected.exitCode, inspected.stdout || inspected.stderr).toBe(0);
      expect(inspected.stderr).toBe("");
      expect(inspected.stdout).toContain(`Run ${runId}`);
      expect(inspected.stdout).toContain("completed");
      const daemonStatus = await requestDaemonStatus(workspace);
      expect(daemonStatus.isErr()).toBe(true);
      if (daemonStatus.isErr()) expect(daemonStatus.error).toMatchObject({ type: "transport" });
    });
  });

  it("detaches a nonterminal local follow after daemon shutdown without starting a daemon", async () => {
    await withDaemonTestWorkspace("e2e-offline-detach", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/signals/signal.workflow.ts");
      const submitted = await runSourceCli(workspace, ["workflow", "run", workflow, "--await-decision"]);
      const [runId] = submitted.stdout.match(/\d{14}[A-F0-9]{20}/gu) ?? [];
      expect(submitted.exitCode, submitted.stdout || submitted.stderr).toBe(0);
      expect(runId).toMatch(runIdPattern);

      const shutdown = await requestDaemonShutdown(workspace);
      expect(shutdown.isOk()).toBe(true);
      await waitForDaemonUnavailable(workspace);

      const followed = await runSourceCli(
        workspace,
        ["runs", "inspect", runId!, "--follow"],
        { interruptAfterStdout: /Attached:/u },
      );

      expect(followed.exitCode, followed.stdout || followed.stderr).toBe(0);
      expect(followed.stderr).toBe("");
      expect(followed.stdout).toContain("Attached:");
      expect(followed.stdout).toContain(`Detached from run ${runId}.`);
      const daemonStatus = await requestDaemonStatus(workspace);
      expect(daemonStatus.isErr()).toBe(true);
      if (daemonStatus.isErr()) expect(daemonStatus.error).toMatchObject({ type: "transport" });
    });
  });

});

async function waitForDaemonUnavailable(workspace: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const status = await requestDaemonStatus(workspace);
    if (status.isErr()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Daemon remained available after graceful shutdown for '${workspace}'.`);
}
