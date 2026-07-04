import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { admitPreparedWorkflowRun } from "@acpus/runtime";
import { runSourceCli } from "./support/cli-runner.js";
import { copyWorkflowFixture } from "./support/fixtures.js";
import { withTestWorkspace } from "./support/workspace.js";
import { prepareWorkflowForCli } from "../src/workflow-preparation.js";

describe.concurrent("acpus runs list", () => {
  it("defaults to 20 recent runs and supports limit/all options", async () => {
    await withTestWorkspace("runs-list-options", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/signals/signal.workflow.ts");
      const prepared = await prepareWorkflowForCli(workflow, workspace);
      for (let i = 0; i < 21; i += 1) {
        await admitPreparedWorkflowRun(workspace, prepared, {});
        await new Promise(resolve => setTimeout(resolve, 1));
      }

      const defaultList = await runSourceCli(workspace, ["runs", "list", "--json"]);
      expect(defaultList.exitCode).toBe(0);
      const defaultOutput = JSON.parse(defaultList.stdout);
      expect(defaultOutput).toMatchObject({
        list: { total: 21, limit: 20, truncated: true, order: "updatedAt DESC" },
        runs: expect.arrayContaining([expect.objectContaining({ name: "cli-signal" })]),
      });
      expect(defaultOutput.runs).toHaveLength(20);
      expectUpdatedAtDesc(defaultOutput.runs);

      const limited = await runSourceCli(workspace, ["runs", "list", "--limit", "3", "--json"]);
      expect(limited.exitCode).toBe(0);
      expect(JSON.parse(limited.stdout)).toMatchObject({
        list: { total: 21, limit: 3, truncated: true },
      });
      expect(JSON.parse(limited.stdout).runs).toHaveLength(3);

      const all = await runSourceCli(workspace, ["runs", "list", "--all", "--json"]);
      expect(all.exitCode).toBe(0);
      const allOutput = JSON.parse(all.stdout);
      expect(allOutput).toMatchObject({
        list: { total: 21, truncated: false },
      });
      expect(allOutput.list).not.toHaveProperty("limit");
      expect(allOutput.runs).toHaveLength(21);
      expectUpdatedAtDesc(allOutput.runs);
      expect(daemonLeaseCount(workspace)).toBe(0);
    });
  }, 15_000);

  it("rejects conflicting or invalid list limits as usage errors", async () => {
    await withTestWorkspace("runs-list-invalid-options", async workspace => {
      for (const args of [["runs", "list", "--all", "--limit", "1", "--json"], ["runs", "list", "--limit", "0", "--json"]]) {
        const result = await runSourceCli(workspace, args);
        expect(result.exitCode).toBe(2);
        expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, phase: "usage" });
      }
    });
  });
});

function expectUpdatedAtDesc(runs: Array<{ updatedAt: string }>): void {
  expect(runs.map(run => run.updatedAt)).toEqual([...runs].map(run => run.updatedAt).sort().reverse());
}

function daemonLeaseCount(workspace: string): number {
  const db = new DatabaseSync(join(workspace, ".acpus", ".local", "state", "runtime.db"), { readOnly: true });
  try {
    return Number((db.prepare("SELECT COUNT(*) AS count FROM daemon_lease").get() as { count: number }).count);
  } finally {
    db.close();
  }
}
