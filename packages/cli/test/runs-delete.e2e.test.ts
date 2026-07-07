import { access } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { admitPreparedWorkflowRun } from "@acpus/runtime";
import { runCli } from "../src/program.js";
import { prepareWorkflowForCli } from "../src/workflow-preparation.js";
import { CaptureStream } from "./support/capture-stream.js";
import { runSourceCli } from "./support/cli-runner.js";
import { copyWorkflowFixture } from "./support/fixtures.js";
import { withTestWorkspace } from "./support/workspace.js";

describe("acpus runs delete", () => {
  it("deletes an explicit run id without starting the daemon", async () => {
    await withTestWorkspace("runs-delete-explicit", async workspace => {
      const run = await admitRun(workspace, { ready: true });
      const runDir = join(workspace, ".acpus", ".local", "runs", run.id);

      const deleted = await runSourceCli(workspace, ["runs", "delete", run.id, "--json"]);

      expect(deleted.exitCode).toBe(0);
      expect(JSON.parse(deleted.stdout)).toMatchObject({
        ok: true,
        phase: "delete",
        message: "Run deleted.",
        run: { id: run.id },
        deletedRuns: [expect.objectContaining({ id: run.id })],
        skippedRuns: [],
      });
      await expect(access(runDir)).rejects.toMatchObject({ code: "ENOENT" });
      const inspected = await runSourceCli(workspace, ["runs", "inspect", run.id, "--json"]);
      expect(inspected.exitCode).toBe(1);
      expect(JSON.parse(inspected.stdout)).toMatchObject({ ok: false, phase: "inspect" });
      expect(daemonLeaseCount(workspace)).toBe(0);
    });
  }, 15_000);

  it("rejects active run deletion", async () => {
    await withTestWorkspace("runs-delete-active", async workspace => {
      const run = await admitRun(workspace, { ready: true });
      claimRun(workspace, run.id);

      const deleted = await runSourceCli(workspace, ["runs", "delete", run.id, "--json"]);

      expect(deleted.exitCode).toBe(1);
      expect(JSON.parse(deleted.stdout)).toMatchObject({
        ok: false,
        phase: "delete",
        errorCode: "RUN_ACTIVE",
        run: { id: run.id },
      });
      const inspected = await runSourceCli(workspace, ["runs", "inspect", run.id, "--json"]);
      expect(JSON.parse(inspected.stdout)).toMatchObject({ run: { id: run.id } });
    });
  }, 15_000);

  it("uses the picker to delete selected runs", async () => {
    await withTestWorkspace("runs-delete-picker-one", async workspace => {
      const first = await admitRun(workspace, { ready: true });
      await new Promise(resolve => setTimeout(resolve, 1));
      const second = await admitRun(workspace, { ready: false });

      const stdin = new TtyInput();
      const stdout = ttyCapture();
      const stderr = ttyCapture();
      const deleting = runCli(["runs", "delete"], { cwd: workspace, stdin, stdout, stderr });
      answerDeletePicker(stdin, "\x1b[B \r", " \r");

      expect(await deleting).toBe(0);
      expect(stdout.text).toContain(`Deleted: ${second.id}`);
      expect(stderr.text).toContain("Select runs to delete:");
      expect(stderr.text).toContain(second.id);
      expect(stderr.text).not.toContain(".workflow.ts");
      expect((await runSourceCli(workspace, ["runs", "inspect", second.id, "--json"])).exitCode).toBe(1);
      expect((await runSourceCli(workspace, ["runs", "inspect", first.id, "--json"])).exitCode).toBe(0);
    });
  }, 15_000);

  it("uses the picker all option to clear deletable runs and skip active runs", async () => {
    await withTestWorkspace("runs-delete-picker-all", async workspace => {
      const active = await admitRun(workspace, { ready: true });
      claimRun(workspace, active.id);
      await new Promise(resolve => setTimeout(resolve, 1));
      const deletable = await admitRun(workspace, { ready: false });

      const stdin = new TtyInput();
      const stdout = ttyCapture();
      const stderr = ttyCapture();
      const deleting = runCli(["runs", "delete"], { cwd: workspace, stdin, stdout, stderr });
      answerDeletePicker(stdin, " \r", " \r");

      expect(await deleting).toBe(0);
      expect(stdout.text).toContain(`Deleted: ${deletable.id}`);
      expect(stdout.text).toContain(`Skipped: ${active.id}`);
      expect((await runSourceCli(workspace, ["runs", "inspect", deletable.id, "--json"])).exitCode).toBe(1);
      expect((await runSourceCli(workspace, ["runs", "inspect", active.id, "--json"])).exitCode).toBe(0);
    });
  }, 15_000);

  it("does not delete when picker confirmation is declined", async () => {
    await withTestWorkspace("runs-delete-picker-decline", async workspace => {
      const run = await admitRun(workspace, { ready: true });

      const stdin = new TtyInput();
      const stdout = ttyCapture();
      const stderr = ttyCapture();
      const deleting = runCli(["runs", "delete"], { cwd: workspace, stdin, stdout, stderr });
      answerDeletePicker(stdin, " \r", "\r");

      expect(await deleting).toBe(2);
      expect(stderr.text).toContain("Run deletion cancelled.");
      expect((await runSourceCli(workspace, ["runs", "inspect", run.id, "--json"])).exitCode).toBe(0);
      expect(stdout.text).toBe("");
    });
  }, 15_000);

  it("rejects omitted run id in JSON mode", async () => {
    await withTestWorkspace("runs-delete-json-missing-run-id", async workspace => {
      const deleted = await runSourceCli(workspace, ["runs", "delete", "--json"]);

      expect(deleted.exitCode).toBe(2);
      expect(JSON.parse(deleted.stdout)).toMatchObject({
        ok: false,
        phase: "usage",
        message: "Run id is required when --json is used.",
      });
    });
  });

  it("rejects omitted run id outside an interactive terminal", async () => {
    await withTestWorkspace("runs-delete-non-tty-missing-run-id", async workspace => {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();

      const exitCode = await runCli(["runs", "delete"], {
        cwd: workspace,
        stdin: new PassThrough(),
        stdout,
        stderr,
      });

      expect(exitCode).toBe(2);
      expect(stderr.text).toContain("Run id is required when not running in an interactive terminal.");
    });
  });
});

async function admitRun(workspace: string, input: { ready: boolean }) {
  const workflow = await copyWorkflowFixture(workspace, "workflows/basic/valid.workflow.ts");
  const prepared = await prepareWorkflowForCli(workflow, workspace);
  return admitPreparedWorkflowRun(workspace, prepared, input);
}

function claimRun(workspace: string, runId: string): void {
  const db = new DatabaseSync(join(workspace, ".acpus", ".local", "state", "runtime.db"));
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO run_leases (
        run_id, owner_id, owner_epoch, lease_expires_at, heartbeat_at, claimed_at, released_at, reason
      )
      VALUES (?, 'owner', 1, ?, ?, ?, NULL, 'test')
    `).run(runId, new Date(Date.now() + 60_000).toISOString(), now, now);
  } finally {
    db.close();
  }
}

function daemonLeaseCount(workspace: string): number {
  const db = new DatabaseSync(join(workspace, ".acpus", ".local", "state", "runtime.db"), { readOnly: true });
  try {
    return Number((db.prepare("SELECT COUNT(*) AS count FROM daemon_lease").get() as { count: number }).count);
  } finally {
    db.close();
  }
}

function answerDeletePicker(stdin: TtyInput, selection: string, confirmation: string): void {
  stdin.write(selection);
  setTimeout(() => stdin.end(confirmation), 50);
}

class TtyInput extends PassThrough {
  readonly isTTY = true;
  isRaw = false;
  rawModes: boolean[] = [];

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.rawModes.push(mode);
    return this;
  }
}

type TtyCaptureStream = CaptureStream & {
  columns: number;
  isTTY: true;
};

function ttyCapture(): TtyCaptureStream {
  return Object.assign(new CaptureStream(), { columns: 120, isTTY: true as const });
}
