import { describe, expect, it } from "vitest";
import { runSourceCli } from "./support/cli-runner.js";
import { copyWorkflowFixture } from "./support/fixtures.js";
import { withTestWorkspace } from "./support/workspace.js";

describe("acpus runs inspect smoke", () => {
  it("shows, lists, and replays an admitted run", async () => {
    await withTestWorkspace("runs-inspect", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/valid.workflow.ts");
      const admitted = await runSourceCli(workspace, ["run", workflow, "--input", "{\"ready\":true}", "--json"]);
      expect(admitted.exitCode).toBe(0);
      const runId = JSON.parse(admitted.stdout).run.id;

      await expectShowRun(workspace, runId);
      await expectListRuns(workspace, runId);
      await expectReplay(workspace, runId);
    });
  }, 15_000);

  it("passes fork agent overrides to runtime validation", async () => {
    await withTestWorkspace("runs-fork-agents-validation", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/valid.workflow.ts");
      const admitted = await runSourceCli(workspace, ["run", workflow, "--input", "{\"ready\":true}", "--json"]);
      expect(admitted.exitCode).toBe(0);
      const runId = JSON.parse(admitted.stdout).run.id;

      const forked = await runSourceCli(workspace, ["runs", "fork", runId, "--agents", "{\"reviewer\":{\"use\":\"codex\"}}", "--json"]);

      expect(forked.exitCode).toBe(1);
      expect(JSON.parse(forked.stdout)).toMatchObject({
        ok: false,
        phase: "validate",
        message: "Agent override 'reviewer' does not reference a declared agent.",
      });
    });
  }, 15_000);
});

async function expectShowRun(workspace: string, runId: string): Promise<void> {
  const show = await runSourceCli(workspace, ["runs", "show", runId, "--json"]);
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
  expect(JSON.parse(list.stdout).runs).toEqual([
    expect.objectContaining({ id: runId, status: "completed", name: "cli-valid" }),
  ]);
}

async function expectReplay(workspace: string, runId: string): Promise<void> {
  const replay = await runSourceCli(workspace, ["runs", "replay", runId, "--json"]);
  expect(replay.exitCode).toBe(0);
  expect(JSON.parse(replay.stdout)).toMatchObject({
    ok: true,
    replay: {
      ok: true,
      runId,
      expected: { ready: true },
      actual: { ready: true },
    },
  });
}
