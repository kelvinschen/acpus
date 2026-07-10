import { cp } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSourceCli } from "./support/cli-runner.js";
import { copyWorkflowFixture } from "./support/fixtures.js";
import { skillWorkflowExamples, skillWorkflowPath } from "./support/skill-workflow-examples.js";
import { withTestWorkspace } from "./support/workspace.js";

const runIdPattern = /^\d{14}[A-F0-9]{20}$/;

describe.concurrent("acpus CLI subprocess smoke", () => {
  it.each(skillWorkflowExamples.map(example => [example.name, example] as const))("checks skill example workflow: %s", async (_name, example) => {
    await withTestWorkspace(`e2e-check-${_name.replaceAll(" ", "-")}`, async workspace => {
      const sourceWorkflow = skillWorkflowPath(example.directory);
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

      const result = await runSourceCli(workspace, ["workflow", "run", workflow, "--input", "{\"ready\":true}", "--json"]);

      expect(result.exitCode, result.stdout || result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      const records = result.stdout.trim().split("\n").map(line => JSON.parse(line));
      expect(records[0]).toMatchObject({ ok: true, phase: "run", kind: "admitted" });
      expect(records[0].run.id).toMatch(runIdPattern);
      expect(records.at(-1)).toMatchObject({
        ok: true,
        phase: "run",
        kind: "terminal summary",
        run: {
          name: "cli-valid",
          status: "completed",
          output: { ready: true },
        },
      });
    });
  });

  it("signals an awaiting workflow through the subprocess CLI", async () => {
    await withTestWorkspace("e2e-runs-signal", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/signals/signal.workflow.ts");
      const admitted = await runSourceCli(workspace, ["workflow", "run", workflow, "--json"]);
      expect(admitted.exitCode, admitted.stdout || admitted.stderr).toBe(0);
      const runId = JSON.parse(admitted.stdout.trim().split("\n").at(-1)!).run.id;

      const signaled = await runSourceCli(workspace, ["runs", "signal", runId, "--target", "approve", "--payload", "{\"ok\":true}", "--json"]);

      expect(signaled.exitCode).toBe(0);
      expect(signaled.stderr).toBe("");
      expect(JSON.parse(signaled.stdout)).toMatchObject({
        ok: true,
        phase: "control",
        run: { id: runId },
      });
    });
  });

  it("admits a background workflow and lets the daemon complete it", async () => {
    await withTestWorkspace("e2e-background-run", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/concurrency/short-task.workflow.ts");

      const admitted = await runSourceCli(workspace, ["workflow", "run", workflow, "--background", "--json"]);

      expect(admitted.exitCode, admitted.stdout || admitted.stderr).toBe(0);
      expect(admitted.stderr).toBe("");
      const admittedJson = JSON.parse(admitted.stdout);
      expect(admittedJson).toMatchObject({
        ok: true,
        phase: "run",
        run: {
          name: "cli-concurrency-short-task",
        },
      });
      expect(admittedJson.run.id).toMatch(runIdPattern);

      const inspected = await waitForCompletedRun(workspace, admittedJson.run.id);
      expect(inspected).toMatchObject({
        ok: true,
        phase: "inspect",
        run: {
          id: admittedJson.run.id,
          status: "completed",
          output: { ok: true },
        },
      });
    });
  });

  async function waitForCompletedRun(workspace: string, runId: string): Promise<unknown> {
    const deadline = Date.now() + 5_000;
    let lastJson: unknown;
    while (Date.now() <= deadline) {
      const inspected = await runSourceCli(workspace, ["runs", "inspect", runId, "--json"]);
      expect(inspected.stderr).toBe("");
      lastJson = JSON.parse(inspected.stdout);
      if ((lastJson as { run?: { status?: unknown } }).run?.status === "completed") return lastJson;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Run ${runId} did not complete. Last inspect: ${JSON.stringify(lastJson)}`);
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
          kind: "terminal summary",
          run: {
            name: "cli-concurrency-short-task",
            status: "completed",
            output: { ok: true },
          },
        });
      }
      expect(runIds.size).toBe(results.length);
    });
  });
});
