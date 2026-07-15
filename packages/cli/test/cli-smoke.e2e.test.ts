import { cp, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getRunInspection } from "@acpus/runtime";
import { describe, expect, it } from "vitest";
import { runSourceCli } from "./support/cli-runner.js";
import { copyWorkflowFixture } from "./support/fixtures.js";
import { skillWorkflowPath } from "./support/skill-workflow-examples.js";
import { withTestWorkspace } from "./support/workspace.js";

const runIdPattern = /^\d{14}[A-F0-9]{20}$/;

describe.concurrent("acpus CLI subprocess smoke", () => {
  it("checks a representative skill example workflow", async () => {
    await withTestWorkspace("e2e-check-skill-example", async workspace => {
      const sourceWorkflow = skillWorkflowPath("reusable-task-artifact");
      const targetDir = join(workspace, basename(dirname(sourceWorkflow)));
      await cp(dirname(sourceWorkflow), targetDir, { recursive: true });
      const workflow = join(targetDir, "workflow.ts");

      const result = await runSourceCli(workspace, ["workflow", "check", workflow, "--json"]);

      expect(result.exitCode, result.stdout || result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        phase: "check",
        diagnostics: [],
      });
    });
  });

  it("runs a workflow path in foreground JSON mode", async () => {
    await withTestWorkspace("e2e-run-path", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/valid.workflow.ts");
      const input = "sample input.JSON";
      await writeFile(join(workspace, input), "{\"ready\":true}\n");

      const result = await runSourceCli(workspace, ["workflow", "run", workflow, "--input", input, "--json"]);

      expect(result.exitCode, result.stdout || result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      const records = result.stdout.trim().split("\n").map(line => JSON.parse(line));
      expect(records[0]).toMatchObject({ ok: true, phase: "run", kind: "admitted" });
      expect(records[0].run.id).toMatch(runIdPattern);
      expect(records.at(-1)).toMatchObject({
        ok: true,
        phase: "run",
        kind: "done",
        run: {
          name: "cli-valid",
          status: "completed",
        },
        output: { ready: true },
      });
      expect(records.filter(record => record.output !== undefined)).toHaveLength(1);
    });
  });

  it("returns fork JSON around the created child run", async () => {
    await withTestWorkspace("e2e-runs-fork-identity", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/valid.workflow.ts");
      const source = await runSourceCli(workspace, ["workflow", "run", workflow, "--input", "{\"ready\":true}", "--json"]);
      expect(source.exitCode, source.stdout || source.stderr).toBe(0);
      const sourceRecords = source.stdout.trim().split("\n").map(line => JSON.parse(line));
      const sourceRunId = sourceRecords[0].run.id as string;

      const forked = await runSourceCli(workspace, ["runs", "fork", sourceRunId, "--json"]);
      expect(forked.exitCode, forked.stdout || forked.stderr).toBe(0);
      expect(forked.stderr).toBe("");
      const result = JSON.parse(forked.stdout);
      expect(result).toMatchObject({
        ok: true,
        phase: "control",
        message: "Fork run created.",
        control: { type: "fork", state: "applied", sourceRunId },
        run: { name: "cli-valid" },
      });
      expect(result.run.id).toMatch(runIdPattern);
      expect(result.run.id).not.toBe(sourceRunId);
      if (["completed", "failed", "canceled"].includes(result.run.status)) expect(result.followRunId).toBeUndefined();
      else expect(result.followRunId).toBe(result.run.id);
    });
  });

  it("runs and inspects direct composite workflow values", async () => {
    await withTestWorkspace("e2e-inspect-composite-values", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/inspection/complex.workflow.ts");
      const admitted = await runSourceCli(workspace, [
        "workflow",
        "run",
        workflow,
        "--background",
        "--input",
        '{"items":["alpha","beta"],"rounds":1,"usePrimary":true}',
        "--json",
      ]);
      expect(admitted.exitCode, admitted.stdout || admitted.stderr).toBe(0);
      const runId = JSON.parse(admitted.stdout).run.id as string;
      await waitForAwaitingSignal(workspace, runId, "approval");
      const followedPromise = runSourceCli(workspace, ["runs", "inspect", runId, "--follow", "--interval", "250ms"]);

      const overview = await runSourceCli(workspace, ["runs", "inspect", runId]);
      expect(overview.exitCode, overview.stdout || overview.stderr).toBe(0);
      expect(overview.stderr).toBe("");
      expect(overview.stdout).toContain("inspect-composite-smoke  awaiting");
      expect(overview.stdout).toContain("route  [if]");
      expect(overview.stdout).toContain("work  [parallel]");
      expect(overview.stdout).toContain("batches  [fanout]");
      expect(overview.stdout).toContain("refine_item  [loop]");
      expect(overview.stdout).toContain("approval  [signal]  awaiting");

      const route = await getRunInspection(workspace, { runId, mode: "target", target: "route" });
      expect(route.isOk()).toBe(true);
      if (route.isErr()) throw route.error;
      expect(route.value.kind).toBe("target");
      if (route.value.kind !== "target") throw new Error("Expected route target inspection.");
      expect(route.value.summary.output).toBe("primary");

      const work = await getRunInspection(workspace, { runId, mode: "target", target: "work" });
      expect(work.isOk()).toBe(true);
      if (work.isErr()) throw work.error;
      expect(work.value.kind).toBe("target");
      if (work.value.kind !== "target") throw new Error("Expected work target inspection.");
      expect(work.value.summary.output).toEqual({
        batches: [
          { itemIndex: 0, value: "alpha:round-1", completedRounds: 1 },
          { itemIndex: 1, value: "beta:round-1", completedRounds: 1 },
        ],
        audit: "audited:primary",
      });

      const expectedOutput = {
        runId,
        mode: "primary",
        audit: "audited:primary",
        results: [
          { itemIndex: 0, value: "alpha:round-1", completedRounds: 1 },
          { itemIndex: 1, value: "beta:round-1", completedRounds: 1 },
        ],
        note: "smoke-ok",
      };
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

      const terminal = await getRunInspection(workspace, { runId, mode: "overview" });
      expect(terminal.isOk()).toBe(true);
      if (terminal.isErr()) throw terminal.error;
      expect(terminal.value).toMatchObject({
        kind: "snapshot",
        run: { id: runId, status: "completed" },
        output: expectedOutput,
      });
    });
  });

  async function waitForAwaitingSignal(workspace: string, runId: string, target: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    let lastStatus: string | undefined;
    while (Date.now() <= deadline) {
      const inspected = await getRunInspection(workspace, { runId, mode: "target", target });
      if (inspected.isOk() && inspected.value.kind === "target") {
        lastStatus = inspected.value.summary.nodeStatus;
        if (lastStatus === "awaiting") return;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Signal target ${target} did not become awaiting; last status: ${lastStatus ?? "unavailable"}.`);
  }

  it("runs concurrent foreground workflows through a shared daemon", async () => {
    await withTestWorkspace("e2e-concurrent-run", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/concurrency/short-task.workflow.ts");

      const results = await Promise.all(Array.from({ length: 2 }, () => runSourceCli(workspace, ["workflow", "run", workflow, "--json"])));

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
            name: "cli-concurrency-short-task",
            status: "completed",
          },
          output: { ok: true },
        });
      }
      expect(runIds.size).toBe(results.length);
    });
  });
});
