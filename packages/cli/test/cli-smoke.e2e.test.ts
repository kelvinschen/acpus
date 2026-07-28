import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getRunInspection } from "@acpus/runtime";
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
      expect(records[1]).toMatchObject({
        schemaVersion: 2,
        ok: true,
        phase: "run",
        kind: "snapshot",
        document: {
          schemaVersion: 2,
          kind: "snapshot",
          run: { id: records[0].run.id },
        },
      });
      expect(records.slice(2, -1).every(record =>
        record.schemaVersion === 2
        && record.phase === "run"
        && (record.kind === "delta" || record.kind === "resync")
      )).toBe(true);
      expect(records.at(-1)).toMatchObject({
        schemaVersion: 2,
        ok: true,
        phase: "run",
        kind: "done",
        run: {
          status: "completed",
        },
        output: { ready: true },
      });
      expect(records.filter(record => record.output !== undefined)).toHaveLength(1);
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
      const followedPromise = runSourceCli(workspace, ["runs", "inspect", runId, "--follow", "--interval", "250ms"]);
      const [overview, summary, timeline] = await Promise.all([
        runSourceCli(workspace, ["runs", "inspect", runId]),
        runSourceCli(workspace, ["runs", "inspect", runId, "--target", "approval", "--json"]),
        runSourceCli(workspace, ["runs", "inspect", runId, "--target", "approval", "--timeline", "--json"]),
      ]);
      expect(overview.exitCode, overview.stdout || overview.stderr).toBe(0);
      expect(overview.stderr).toBe("");
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
      expect(overview.stdout).toContain("approval · signal · awaiting");
      expect(overview.stdout).toContain("Attention:");
      expect(overview.stdout).toContain(`Signal: acpus runs signal ${runId} --target approval`);

      expect(summary.exitCode, summary.stdout || summary.stderr).toBe(0);
      expect(summary.stderr).toBe("");
      expect(JSON.parse(summary.stdout)).toMatchObject({
        ok: true,
        phase: "inspect",
        schemaVersion: 2,
        kind: "target",
        subject: { targetKind: "static-node", id: "approval", kind: "signal" },
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
        schemaVersion: 2,
        kind: "timeline",
        subject: { targetKind: "static-node", id: "approval", kind: "signal" },
        state: { status: "awaiting" },
        current: { kind: "signal" },
        recent: { entries: expect.any(Array) },
      });

      const signaled = await runSourceCli(workspace, [
        "runs",
        "signal",
        runId,
        "--target",
        "approval",
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
          requestedTarget: "approval",
          validation: { kind: "schema" },
        },
        run: { id: runId },
      });
      expect(signaledJson.control.target).toMatch(/^approval~/);
      expect(signaledJson).not.toHaveProperty("payload");

      const followed = await followedPromise;
      expect(followed.exitCode, followed.stdout || followed.stderr).toBe(0);
      expect(followed.stderr).toBe("");
      expect(followed.stdout).toContain("inspect-composite-smoke  completed");
      expect(followed.stdout).toContain("Output:");
      expect(followed.stdout).toContain('"audit": "audited:primary"');
      expect(followed.stdout).toContain('"note": "smoke-ok"');
    });
  });

  async function waitForAwaitingSignal(workspace: string, runId: string, target: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    let lastStatus: string | undefined;
    while (Date.now() <= deadline) {
      const inspected = await getRunInspection(workspace, { runId, mode: "target", target });
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
          kind: "done",
          run: {
            status: "completed",
          },
          output: { ok: true },
        });
      }
      expect(runIds.size).toBe(results.length);
    });
  });
});
