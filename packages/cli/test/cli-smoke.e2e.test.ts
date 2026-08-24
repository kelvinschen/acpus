import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { readInspection, requestDaemonStatus } from "@acpus/runtime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";
import { getCliPackageInfo } from "../src/platform/package-info.js";
import { runSourceCli } from "./support/cli-runner.js";
import { copyWorkflowFixture } from "./support/fixtures.js";
import { withDaemonTestWorkspace } from "./support/workspace.js";

const runIdPattern = /^\d{14}[A-F0-9]{20}$/;
const daemonEntry = fileURLToPath(new URL("../src/daemon-entry.ts", import.meta.url));
const tsxImport = import.meta.resolve("tsx");

describe.concurrent("acpus CLI subprocess smoke", () => {
  it("admits a workflow path and publishes its CLI package version to the daemon", async () => {
    await withDaemonTestWorkspace("e2e-run-path", async (workspace, home) => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/valid.workflow.ts");
      const input = "sample input.JSON";
      await writeFile(join(workspace, input), "{\"ready\":true}\n");

      const result = await runSourceCli(workspace, ["workflow", "run", workflow, "--input", input]);

      expect(result.exitCode, result.stdout || result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      const [runId] = result.stdout.match(/\d{14}[A-F0-9]{20}/gu) ?? [];
      expect(runId).toMatch(runIdPattern);
      expect(result.stdout).toContain(`Run ${runId}`);
      expect(result.stdout).toMatch(/pending/u);
      expect(result.stdout).toContain(`Inspect: acpus runs inspect ${runId}`);
      const daemonStatus = await Effect.runPromise(Effect.result(requestDaemonStatus(workspace)));
      expect(Result.isSuccess(daemonStatus)).toBe(true);
      if (Result.isSuccess(daemonStatus)) expect(daemonStatus.success.packageVersion).toBe(getCliPackageInfo().version);
      await expect(access(join(home, ".acpus", "workspaces"))).resolves.toBeUndefined();
      await expect(access(join(workspace, ".acpus", ".local"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("lets NodeRuntime interrupt the daemon and await scoped shutdown", async () => {
    await withDaemonTestWorkspace("e2e-daemon-runtime-entry", async (workspace, home) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        FORCE_COLOR: "0",
      };
      delete env.NODE_NO_WARNINGS;
      delete env.NODE_OPTIONS;
      const child = spawn(process.execPath, [
        "--conditions=development",
        "--import",
        tsxImport,
        daemonEntry,
        workspace,
        "25",
      ], {
        cwd: workspace,
        env,
        stdio: ["ignore", "ignore", "pipe"],
      });
      const stderr: Buffer[] = [];
      child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
      try {
        await waitForDaemon(workspace);
        child.kill("SIGTERM");
        const [exitCode, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
        expect({ exitCode, signal, stderr: Buffer.concat(stderr).toString("utf8") }).toEqual({
          exitCode: 0,
          signal: null,
          stderr: "",
        });
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    });
  });

  it("lets the first SIGINT detach from follow without cancelling the durable run", async () => {
    await withDaemonTestWorkspace("e2e-follow-detach", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/signals/signal.workflow.ts");

      const result = await runSourceCli(
        workspace,
        ["workflow", "run", workflow, "--follow"],
        { interruptAfterStdout: /Attached:/u },
      );

      expect(result.exitCode, result.stdout || result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      const [runId] = result.stdout.match(/\d{14}[A-F0-9]{20}/gu) ?? [];
      expect(runId).toMatch(runIdPattern);
      expect(result.stdout.match(new RegExp(`Detached from run ${runId}\\.`, "gu"))).toHaveLength(1);

      const inspected = await Effect.runPromise(Effect.result(readInspection(workspace, {
        kind: "run",
        runId: runId!,
      })));
      expect(Result.isSuccess(inspected)).toBe(true);
      if (Result.isSuccess(inspected) && inspected.success.kind === "run") {
        expect(inspected.success.run.id).toBe(runId);
        expect(inspected.success.run.status).not.toBe("canceled");
      }
    });
  });

});

async function waitForDaemon(workspace: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const status = await Effect.runPromise(Effect.result(requestDaemonStatus(workspace)));
    if (Result.isSuccess(status)) return;
    await delay(25);
  }
  throw new Error("Daemon did not become ready.");
}
