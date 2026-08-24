import { rename, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  resolveRuntimeLayout,
  resolveRuntimeWorkspaceLayout,
} from "../../runtime/src/runtime-layout.js";
import {
  openRuntimeStoreAdapter,
} from "../../runtime/src/store/store.js";
import {
  RUNTIME_APPLICATION_ID,
  RUNTIME_STORAGE_VERSION,
} from "../../runtime/src/storage/database.js";
import { runCli } from "../src/program.js";
import { followRun } from "../src/runs/follow.js";
import { CaptureStream } from "./support/capture-stream.js";
import { withPlainTestWorkspace } from "./support/workspace.js";

describe("Runtime store repair diagnostics", () => {
  it("directs inspection of a legacy store to Doctor repair", async () => {
    await withPlainTestWorkspace("runtime-store-repair-required", async workspace => {
      const store = await openRuntimeStoreAdapter(workspace);
      store.close();

      const current = resolveRuntimeLayout(workspace);
      const legacy = resolveRuntimeWorkspaceLayout(workspace);
      await rm(current.generationMetadataPath);
      await rename(current.runtimeRoot, legacy.legacyRuntimeRoot);
      await rm(legacy.generationsRoot, { recursive: true, force: true });
      await writeFile(legacy.manifestPath, `${JSON.stringify({
        manifestVersion: 1,
        workspaceKey: legacy.workspaceKey,
        canonicalPath: legacy.canonicalPath,
        platform: legacy.platform,
        createdAt: "2026-08-10T00:00:00.000Z",
      }, null, 2)}\n`);

      const database = new DatabaseSync(legacy.databasePath);
      try {
        database.exec(`
          PRAGMA application_id = ${RUNTIME_APPLICATION_ID};
          PRAGMA user_version = 8;
        `);
      } finally {
        database.close();
      }

      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const exitCode = await runCli(["runs", "inspect", "run_legacy"], {
        cwd: workspace,
        stdout,
        stderr,
      });

      expect(RUNTIME_STORAGE_VERSION).toBe(19);
      expect(exitCode).toBe(1);
      expect(stdout.text).toBe("");
      expect(stderr.text).toContain("Error code: RUNTIME_STORE_REPAIR_REQUIRED");
      expect(stderr.text).toContain("acpus doctor --fix");
      expect(stderr.text).not.toContain("READ_FAILED");
    });
  });

  it("keeps unsupported storage out of generic inspection read failures", async () => {
    await withPlainTestWorkspace("runtime-store-unsupported", async workspace => {
      const store = await openRuntimeStoreAdapter(workspace);
      store.close();
      const layout = resolveRuntimeLayout(workspace);
      const database = new DatabaseSync(layout.databasePath);
      try {
        database.exec(`PRAGMA user_version = ${RUNTIME_STORAGE_VERSION + 1}`);
      } finally {
        database.close();
      }

      const oneShot = await runCliCommand(workspace, ["runs", "inspect", "run_future"]);
      expect(oneShot.exitCode).toBe(1);
      expect(oneShot.stdout).toBe("");
      expect(oneShot.stderr).toContain("Error code: RUNTIME_STORE_UNSUPPORTED");
      expect(oneShot.stderr).toContain("acpus doctor");
      expect(oneShot.stderr).not.toContain("--fix");
      expect(oneShot.stderr).not.toContain("READ_FAILED");

      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const followed = await followRun(workspace, { kind: "run", runId: "run_future" }, {
        until: "subject-terminal",
        stdout,
        stderr,
      });
      expect(followed).toMatchObject({
        kind: "error",
        error: {
          type: "runtime-store-unsupported",
          runId: "run_future",
        },
      });
      expect(stderr.text).toContain("Error code: RUNTIME_STORE_UNSUPPORTED");
      expect(stderr.text).not.toContain("READ_FAILED");
    });
  });
});

async function runCliCommand(
  workspace: string,
  argv: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runCli(argv, { cwd: workspace, stdout, stderr });
  return { exitCode, stdout: stdout.text, stderr: stderr.text };
}
