import { cp, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getRunInspection } from "@acpus/runtime";
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

  it("signals an awaiting workflow through the subprocess CLI", async () => {
    await withTestWorkspace("e2e-runs-signal", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/signals/signal.workflow.ts");
      const admitted = await runSourceCli(workspace, ["workflow", "run", workflow, "--background", "--json"]);
      expect(admitted.exitCode, admitted.stdout || admitted.stderr).toBe(0);
      const runId = JSON.parse(admitted.stdout).run.id;
      await waitForAwaitingSignal(workspace, runId, "approve");

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
      expect(admittedJson.followRunId).toBe(admittedJson.run.id);

      const followed = await runSourceCli(workspace, ["runs", "inspect", admittedJson.run.id, "--follow", "--interval", "250ms", "--json"]);
      expect(followed.exitCode, followed.stdout || followed.stderr).toBe(0);
      expect(followed.stderr).toBe("");
      const followRecords = followed.stdout.trim().split("\n").map(line => JSON.parse(line));
      expect(followRecords.length).toBeGreaterThanOrEqual(2);
      expect(followRecords[0]).toMatchObject({
        ok: true,
        phase: "inspect",
        schemaVersion: 1,
        kind: "snapshot",
        document: {
          kind: "snapshot",
          run: { id: admittedJson.run.id },
          items: expect.any(Array),
        },
      });
      expect(followRecords[0].document.run.dynamic).toBeUndefined();
      expect(followRecords[0].document.output).toBeUndefined();
      expect(followRecords.slice(1, -1).every(record => record.kind === "update")).toBe(true);
      expect(followRecords.at(-1)).toMatchObject({
        ok: true,
        phase: "inspect",
        kind: "done",
        run: {
          id: admittedJson.run.id,
          name: "cli-concurrency-short-task",
          status: "completed",
        },
        output: { ok: true },
      });
      expect(followRecords.filter(record => record.output !== undefined)).toHaveLength(1);
    });
  });

  async function waitForAwaitingSignal(workspace: string, runId: string, target: string): Promise<void> {
    const deadline = Date.now() + 5_000;
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
