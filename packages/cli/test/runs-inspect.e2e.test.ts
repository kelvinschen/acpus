import { describe, expect, it } from "vitest";
import { runSourceCli } from "./support/cli-runner.js";
import { copyWorkflowFixture } from "./support/fixtures.js";
import { withTestWorkspace } from "./support/workspace.js";

describe("acpus runs inspect smoke", () => {
  it("inspects and lists an admitted run", async () => {
    await withTestWorkspace("runs-inspect", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/valid.workflow.ts");
      const admitted = await runSourceCli(workspace, ["workflows", "run", workflow, "--input", "{\"ready\":true}", "--json"]);
      expect(admitted.exitCode).toBe(0);
      const runId = JSON.parse(admitted.stdout.trim().split("\n").at(-1)!).run.id;

      await expectInspectRun(workspace, runId);
      await expectListRuns(workspace, runId);
    });
  }, 15_000);

  it("passes fork agent overrides to runtime validation", async () => {
    await withTestWorkspace("runs-fork-agents-validation", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/valid.workflow.ts");
      const admitted = await runSourceCli(workspace, ["workflows", "run", workflow, "--input", "{\"ready\":true}", "--json"]);
      expect(admitted.exitCode).toBe(0);
      const runId = JSON.parse(admitted.stdout.trim().split("\n").at(-1)!).run.id;

      const forked = await runSourceCli(workspace, ["runs", "fork", runId, "--agents", "{\"reviewer\":{\"use\":\"codex\"}}", "--json"]);

      expect(forked.exitCode).toBe(1);
      expect(JSON.parse(forked.stdout)).toMatchObject({
        ok: false,
        phase: "control",
        message: "Agent override 'reviewer' does not reference a declared agent.",
      });
    });
  }, 15_000);

  it("prints compact actionable signal guidance in text mode", async () => {
    await withTestWorkspace("runs-inspect-signal-text", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/signals/signal.workflow.ts");
      const admitted = await runSourceCli(workspace, ["workflows", "run", workflow, "--json"]);
      expect(admitted.exitCode).toBe(0);
      const runId = JSON.parse(admitted.stdout.trim().split("\n").at(-1)!).run.id;

      const inspected = await runSourceCli(workspace, ["runs", "inspect", runId]);

      expect(inspected.exitCode).toBe(0);
      expect(inspected.stdout).toMatch(/Awaiting signal: approve~[a-f0-9]+/);
      expect(inspected.stdout).toMatch(new RegExp(`Use: acpus runs signal ${runId} --target approve~[a-f0-9]+ --payload '<json>'`));
    });
  }, 15_000);
});

async function expectInspectRun(workspace: string, runId: string): Promise<void> {
  const show = await runSourceCli(workspace, ["runs", "inspect", runId, "--json"]);
  expect(show.exitCode).toBe(0);
  expect(JSON.parse(show.stdout)).toMatchObject({
    ok: true,
    phase: "inspect",
    run: {
      id: runId,
      status: "completed",
      input: { ready: true },
      output: { ready: true },
    },
  });
}

async function expectListRuns(workspace: string, runId: string): Promise<void> {
  const list = await runSourceCli(workspace, ["runs", "list", "--json"]);
  expect(list.exitCode).toBe(0);
  expect(JSON.parse(list.stdout)).toMatchObject({
    list: {
      total: 1,
      truncated: false,
      order: "updatedAt DESC",
    },
  });
  expect(JSON.parse(list.stdout).runs).toEqual([
    expect.objectContaining({ id: runId, status: "completed", name: "cli-valid" }),
  ]);
}
