import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { admitPreparedWorkflowRun } from "@acpus/runtime";
import { runCli } from "../src/program.js";
import { prepareWorkflowForCli } from "../src/workflow-preparation.js";
import { CaptureStream } from "./support/capture-stream.js";
import { runSourceCli } from "./support/cli-runner.js";
import { copyWorkflowFixture } from "./support/fixtures.js";
import { withTestWorkspace } from "./support/workspace.js";

const runIdPattern = /^\d{14}[A-F0-9]{20}$/;

describe.concurrent("acpus runs inspect smoke", () => {
  it("inspects, lists, and validates fork agent overrides for an admitted run", async () => {
    await withTestWorkspace("runs-inspect", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/valid.workflow.ts");
      const admitted = await runSourceCli(workspace, ["workflows", "run", workflow, "--input", "{\"ready\":true}", "--json"]);
      expect(admitted.exitCode).toBe(0);
      const runId = JSON.parse(admitted.stdout.trim().split("\n").at(-1)!).run.id;

      await expectInspectRun(workspace, runId);
      await expectListRuns(workspace, runId);

      const forked = await runSourceCli(workspace, ["runs", "fork", runId, "--agents", "{\"reviewer\":{\"use\":\"codex\"}}", "--json"]);

      expect(forked.exitCode).toBe(1);
      expect(JSON.parse(forked.stdout)).toMatchObject({
        ok: false,
        phase: "control",
        message: expect.stringContaining("Agent override 'reviewer' does not reference a declared agent."),
        errorCode: "RUN_NOT_CONTROLLABLE",
        control: { type: "fork", runId },
        run: { id: runId, status: "completed" },
      });
    });
  }, 15_000);

  it("rejects an empty fork target", async () => {
    await withTestWorkspace("runs-fork-empty-target", async workspace => {
      const forked = await runSourceCli(workspace, ["runs", "fork", "run_missing", "--target", "", "--json"]);

      expect(forked.exitCode).toBe(2);
      expect(JSON.parse(forked.stdout)).toMatchObject({
        ok: false,
        phase: "usage",
        message: "--target must be a non-empty string.",
      });
    });
  }, 15_000);

  it("passes unsafe fork reuse through to runtime audit events", async () => {
    await withTestWorkspace("runs-fork-unsafe-reuse", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/valid.workflow.ts");
      const admitted = await runSourceCli(workspace, ["workflows", "run", workflow, "--input", "{\"ready\":true}", "--json"]);
      expect(admitted.exitCode).toBe(0);
      const runId = JSON.parse(admitted.stdout.trim().split("\n").at(-1)!).run.id;

      const forked = await runSourceCli(workspace, ["runs", "fork", runId, "--unsafe-reuse", "--json"]);

      expect(forked.exitCode).toBe(0);
      const forkRunId = JSON.parse(forked.stdout).forkRunId;
      expect(forkRunId).toMatch(runIdPattern);
      const db = new DatabaseSync(join(workspace, ".acpus", ".local", "state", "runtime.db"));
      try {
        const row = db.prepare("SELECT payload_json FROM run_events WHERE run_id = ? AND type = 'run.forked'").get(forkRunId) as { payload_json?: string } | undefined;
        expect(JSON.parse(String(row?.payload_json))).toMatchObject({ sourceRunId: runId, unsafeReuse: true });
      } finally {
        db.close();
      }
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
      expect(inspected.stdout).toMatch(new RegExp(`Run ${runId}  cli-signal  awaiting  (?:<1s|\\d+s)`));
      expect(inspected.stdout).toMatch(/◌ approve~[a-f0-9]+  \[signal\]  awaiting/);
      expect(inspected.stdout).toContain("Prompt:\n      approve");
      expect(inspected.stdout).toContain("Expected payload:\n      ok: boolean (required)");
      expect(inspected.stdout).toMatch(new RegExp(`Signal: acpus runs signal ${runId} --target approve~[a-f0-9]+ --payload '<json>'`));
    });
  }, 15_000);

  it("reports stale non-terminal execution without mutating durable status", async () => {
    await withTestWorkspace("runs-inspect-stale", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/signals/signal.workflow.ts");
      const prepared = await prepareWorkflowForCli(workflow, workspace);
      const admitted = await admitPreparedWorkflowRun(workspace, prepared, {});
      const runId = admitted.id;
      const db = new DatabaseSync(join(workspace, ".acpus", ".local", "state", "runtime.db"));
      try {
        db.prepare(`
          INSERT INTO daemon_lease (
            workspace_realpath, generation, pid, heartbeat_at, idle_since_at,
            idle_stop_ms, protocol_version, package_version, node_version,
            exec_path, updated_at
          )
          VALUES (?, 1, ?, ?, NULL, 30000, 1, 'test', ?, ?, ?)
        `).run(workspace, process.pid, new Date(Date.now() - 10_000).toISOString(), process.version, process.execPath, new Date().toISOString());
      } finally {
        db.close();
      }

      const inspected = await runSourceCli(workspace, ["runs", "inspect", runId]);
      expect(inspected.exitCode).toBe(0);
      expect(inspected.stdout).toContain(`stale (daemon heartbeat expired, last status: pending)`);

      const inspectedJson = await runSourceCli(workspace, ["runs", "inspect", runId, "--json"]);
      expect(JSON.parse(inspectedJson.stdout)).toMatchObject({
        run: {
          status: "pending",
          execution: {
            state: "stale",
            lastStatus: "pending",
            reason: "daemon_heartbeat_expired",
          },
        },
      });
    });
  }, 15_000);

  it("inspects inactive non-terminal runs without starting the daemon", async () => {
    await withTestWorkspace("runs-inspect-inactive-no-daemon", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/signals/signal.workflow.ts");
      const prepared = await prepareWorkflowForCli(workflow, workspace);
      const admitted = await admitPreparedWorkflowRun(workspace, prepared, {});

      const inspected = await runSourceCli(workspace, ["runs", "inspect", admitted.id, "--json"]);

      expect(inspected.exitCode).toBe(0);
      expect(JSON.parse(inspected.stdout)).toMatchObject({
        run: {
          id: admitted.id,
          status: "pending",
          execution: {
            state: "inactive",
            lastStatus: "pending",
            reason: "no_liveness_evidence",
          },
        },
      });
      expect(daemonLeaseCount(workspace)).toBe(0);
    });
  }, 15_000);

  it("opens a TTY picker when run id is omitted", async () => {
    await withTestWorkspace("runs-inspect-picker", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/valid.workflow.ts");
      const prepared = await prepareWorkflowForCli(workflow, workspace);
      const first = await admitPreparedWorkflowRun(workspace, prepared, { ready: true });
      await new Promise(resolve => setTimeout(resolve, 1));
      await admitPreparedWorkflowRun(workspace, prepared, { ready: false });

      const stdin = new TtyInput();
      const stdout = ttyCapture();
      const stderr = ttyCapture();
      const inspected = runCli(["runs", "inspect"], { cwd: workspace, stdin, stdout, stderr });
      stdin.end("\x1b[B\r");

      expect(await inspected).toBe(0);
      expect(stdout.text).toContain(`Run ${first.id}  cli-valid  pending`);
      expect(stderr.text).toContain("Select a run to inspect:");
      expect(stdin.rawModes).toEqual([true, false]);
    });
  }, 15_000);

  it("rejects omitted run id in JSON mode", async () => {
    await withTestWorkspace("runs-inspect-json-missing-run-id", async workspace => {
      const inspected = await runSourceCli(workspace, ["runs", "inspect", "--json"]);

      expect(inspected.exitCode).toBe(2);
      expect(JSON.parse(inspected.stdout)).toMatchObject({
        ok: false,
        phase: "usage",
        message: "Run id is required when --json is used.",
      });
    });
  });

  it("rejects omitted run id outside an interactive terminal", async () => {
    await withTestWorkspace("runs-inspect-non-tty-missing-run-id", async workspace => {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();

      const exitCode = await runCli(["runs", "inspect"], {
        cwd: workspace,
        stdin: new PassThrough(),
        stdout,
        stderr,
      });

      expect(exitCode).toBe(2);
      expect(stderr.text).toContain("Run id is required when not running in an interactive terminal.");
    });
  });

  it("reports no runs from the interactive picker path", async () => {
    await withTestWorkspace("runs-inspect-picker-empty", async workspace => {
      const stdout = ttyCapture();
      const stderr = ttyCapture();

      const exitCode = await runCli(["runs", "inspect"], {
        cwd: workspace,
        stdin: new TtyInput(),
        stdout,
        stderr,
      });

      expect(exitCode).toBe(1);
      expect(stderr.text).toContain("No runs found.");
      expect(stdout.text).toBe("");
    });
  });
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

function daemonLeaseCount(workspace: string): number {
  const db = new DatabaseSync(join(workspace, ".acpus", ".local", "state", "runtime.db"), { readOnly: true });
  try {
    return Number((db.prepare("SELECT COUNT(*) AS count FROM daemon_lease").get() as { count: number }).count);
  } finally {
    db.close();
  }
}
