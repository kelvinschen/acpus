import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inspectTarget } from "@acpus/runtime";
import { describe, expect, it } from "vitest";
import { runSourceCli } from "./support/cli-runner.js";
import { copyWorkflowFixture } from "./support/fixtures.js";
import { withDaemonTestWorkspace } from "./support/workspace.js";

const runIdPattern = /^\d{14}[A-F0-9]{20}$/;

describe.concurrent("acpus CLI subprocess smoke", () => {
  it("follows a workflow path in JSON mode", async () => {
    await withDaemonTestWorkspace("e2e-run-path", async (workspace, home) => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/valid.workflow.ts");
      const input = "sample input.JSON";
      await writeFile(join(workspace, input), "{\"ready\":true}\n");

      const result = await runSourceCli(workspace, ["workflow", "run", workflow, "--input", input, "--follow", "--json"]);

      expect(result.exitCode, result.stdout || result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      const records = result.stdout.trim().split("\n").map(line => JSON.parse(line));
      expect(records[0]).toMatchObject({ schemaVersion: 1, ok: true, phase: "run", kind: "admitted" });
      expect(records[0].run.id).toMatch(runIdPattern);
      const views = records.slice(1);
      expect(views.every(record => record.schemaVersion === 2
        && record.ok === true
        && record.phase === "run"
        && record.kind === "view"
        && record.document?.kind === "snapshot"
        && record.document.run?.id === records[0].run.id)).toBe(true);
      expect(views.at(-1)).toMatchObject({
        schemaVersion: 2,
        ok: true,
        phase: "run",
        kind: "view",
        document: {
          run: { status: "completed" },
          output: { ready: true },
        },
      });
      expect(views.filter(record => record.document?.output !== undefined)).toHaveLength(1);
      await expect(access(join(home, ".acpus", "workspaces"))).resolves.toBeUndefined();
      await expect(access(join(workspace, ".acpus", ".local"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("runs and inspects direct composite workflow values", async () => {
    await withDaemonTestWorkspace("e2e-inspect-composite-values", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/inspection/complex.workflow.ts");
      const admitted = await runSourceCli(workspace, [
        "workflow",
        "run",
        workflow,
        "--input",
        '{"items":["alpha","beta"],"rounds":1,"usePrimary":true}',
        "--json",
      ]);
      expect(admitted.exitCode, admitted.stdout || admitted.stderr).toBe(0);
      const admission = JSON.parse(admitted.stdout);
      expect(admission).toMatchObject({
        schemaVersion: 1,
        ok: true,
        phase: "run",
        message: "Run submitted.",
        workflow: { name: "inspect-composite-smoke" },
        run: { id: expect.stringMatching(runIdPattern) },
      });
      const runId = admission.run.id as string;
      await waitForAwaitingSignal(workspace, runId, "approval");
      const followedPromise = runSourceCli(workspace, ["runs", "inspect", runId, "--follow"]);
      const [overview, summary, timeline] = await Promise.all([
        runSourceCli(workspace, ["runs", "inspect", runId]),
        runSourceCli(workspace, ["runs", "inspect", runId, "--target", "approval", "--json"]),
        runSourceCli(workspace, ["runs", "inspect", runId, "--target", "approval", "--timeline", "--json"]),
      ]);
      expect(overview.exitCode, overview.stdout || overview.stderr).toBe(0);
      expect(overview.stderr).toBe("");
      expect(summary.exitCode, summary.stdout || summary.stderr).toBe(0);
      expect(summary.stderr).toBe("");
      const summaryJson = JSON.parse(summary.stdout);
      const signalRef = summaryJson.subject.ref as string;
      expect(signalRef).toMatch(/^@[0-9a-f]{12}$/);

      expect(overview.stdout).toContain("inspect-composite-smoke  awaiting");
      expect(overview.stdout).toContain("Tree:");
      expect(overview.stdout).toContain("route · if");
      expect(overview.stdout).toContain("├┄ ✓ then · selected");
      expect(overview.stdout).toContain("└┄ · else · not selected");
      expect(overview.stdout).toContain("work · parallel");
      expect(overview.stdout).toContain("├┄ ✓ batches");
      expect(overview.stdout).toContain("batches · fanout · 2 items");
      expect(overview.stdout).toContain("├┄ ✓ item[0]");
      expect(overview.stdout).toContain("refine_item · loop · 1 round");
      expect(overview.stdout).toContain("└┄ ✓ round 1");
      expect(overview.stdout).toContain(`approval · signal · ${signalRef} · awaiting`);
      expect(overview.stdout).toContain("Attention:");
      expect(overview.stdout).toContain(
        `Signal: acpus runs signal ${runId} --target ${signalRef} --payload '<json>'`,
      );

      expect(summaryJson).toMatchObject({
        ok: true,
        phase: "inspect",
        kind: "target",
        subject: { ref: signalRef, kind: "signal" },
        state: { status: "awaiting" },
        availableActions: [
          { kind: "signal" },
          { kind: "inspect-timeline" },
        ],
      });

      expect(timeline.exitCode, timeline.stdout || timeline.stderr).toBe(0);
      expect(timeline.stderr).toBe("");
      expect(JSON.parse(timeline.stdout)).toMatchObject({
        ok: true,
        phase: "inspect",
        kind: "timeline",
        subject: { ref: signalRef, kind: "signal" },
        state: { status: "awaiting" },
        current: { kind: "signal" },
        recent: { entries: expect.any(Array), page: 1, limit: 12 },
      });

      const signaled = await runSourceCli(workspace, [
        "runs",
        "signal",
        runId,
        "--target",
        signalRef,
        "--payload",
        '{"approved":true,"note":"smoke-ok"}',
        "--json",
      ]);
      expect(signaled.exitCode, signaled.stdout || signaled.stderr).toBe(0);
      expect(signaled.stderr).toBe("");
      const signaledJson = JSON.parse(signaled.stdout);
      expect(signaledJson).toMatchObject({
        ok: true,
        phase: "control",
        message: "Signal consumed.",
        control: {
          type: "signal",
          state: "consumed",
          runId,
          target: signalRef,
          validation: { kind: "schema" },
        },
        run: { id: runId },
      });
      expect(signaledJson.control.target).toBe(signalRef);
      expect(signaledJson).not.toHaveProperty("payload");

      const followed = await followedPromise;
      expect(followed.exitCode, followed.stdout || followed.stderr).toBe(0);
      expect(followed.stderr).toBe("");
      expect(followed.stdout).toContain("inspect-composite-smoke  awaiting");

      const completed = await runSourceCli(workspace, ["runs", "inspect", runId, "--follow"]);
      expect(completed.exitCode, completed.stdout || completed.stderr).toBe(0);
      expect(completed.stderr).toBe("");
      expect(completed.stdout).toContain("inspect-composite-smoke  completed");
      expect(completed.stdout).toContain("Output:");
      expect(completed.stdout).toContain('"audit": "audited:primary"');
      expect(completed.stdout).toContain('"note": "smoke-ok"');
    });
  });

  async function waitForAwaitingSignal(workspace: string, runId: string, target: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    let lastStatus: string | undefined;
    while (Date.now() <= deadline) {
      const inspected = await inspectTarget(workspace, { runId, target });
      if (inspected.isOk() && inspected.value.kind === "target") {
        lastStatus = inspected.value.state.status;
        if (lastStatus === "awaiting") return;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Signal target ${target} did not become awaiting; last status: ${lastStatus ?? "unavailable"}.`);
  }

  it("follows concurrent workflows through a shared daemon", async () => {
    await withDaemonTestWorkspace("e2e-concurrent-run", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/concurrency/short-task.workflow.ts");

      const results = await Promise.all(Array.from({ length: 2 }, () => runSourceCli(workspace, [
        "workflow", "run", workflow, "--follow", "--json",
      ])));

      const runIds = new Set<string>();
      for (const [index, result] of results.entries()) {
        expect(result.stderr, `stderr for process ${index}`).not.toContain("database is locked");
        expect(result.exitCode, `exit for process ${index}: ${result.stdout || result.stderr}`).toBe(0);
        const records = result.stdout.trim().split("\n").map(line => JSON.parse(line));
        expect(records[0], `admission for process ${index}`).toMatchObject({ ok: true, phase: "run", kind: "admitted" });
        expect(records[0].run.id).toMatch(runIdPattern);
        runIds.add(records[0].run.id);
        expect(records.at(-1), `terminal for process ${index}`).toMatchObject({
          ok: true,
          phase: "run",
          kind: "view",
          document: {
            run: { status: "completed" },
            output: { ok: true },
          },
        });
      }
      expect(runIds.size).toBe(results.length);
    });
  });
});
