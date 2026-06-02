import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { beforeAll, describe, expect, it } from "vitest";
import { readRunIndex, updateRunIndex } from "../../src/run-index/read-write.js";
import { prepareRun } from "../../src/runtime/run-workflow.js";
import { terminalRunStatus } from "../../src/runtime/worker.js";
import { WorkflowSpecSchema } from "../../src/schema/workflow-spec.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tsxBin = path.join(root, "node_modules", ".bin", "tsx");
const cli = path.join(root, "src", "cli.ts");

describe("CLI lifecycle", () => {
  beforeAll(async () => {
    await execa("npm", ["run", "build"], { cwd: root });
  }, 60_000);

  it("validates, saves, runs, observes, diagnoses, resumes, and generates drafts", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-cli-lifecycle-"));
    await fs.writeFile(path.join(cwd, "sample.txt"), "hello\n", "utf8");
    const specPath = path.join(cwd, "deterministic.workflow.spec.json");
    await fs.writeFile(specPath, `${JSON.stringify(deterministicSpec(cwd), null, 2)}\n`, "utf8");

    const validate = JSON.parse((await run(cwd, "validate", "--spec", specPath, "--json")).stdout) as { ok: boolean };
    const preview = JSON.parse((await run(cwd, "preview", "--spec", specPath, "--json")).stdout) as { workflowName: string; status: string };
    const save = JSON.parse((await run(cwd, "save", "deterministic", "--spec", specPath, "--json")).stdout) as { ok: boolean; workflow: string };
    const workflows = JSON.parse((await run(cwd, "list", "workflows", "--json")).stdout) as { entries: string[] };
    const saved = JSON.parse((await run(cwd, "show", "workflow", "deterministic", "--json")).stdout) as { name: string };
    const generated = JSON.parse((await run(cwd, "generate", "--name", "generated", "--json")).stdout) as { ok: boolean; path: string };
    const drafts = JSON.parse((await run(cwd, "list", "drafts", "--json")).stdout) as { entries: string[] };
    const draft = JSON.parse((await run(cwd, "show", "draft", path.basename(generated.path), "--json")).stdout) as { name: string };
    const runEvents = parseNdjson((await run(cwd, "run", "--workflow", "deterministic", "--wait", "--json")).stdout);
    const runResult = runEvents.at(-1) as { type: string; ok: boolean; logicalRunId: string; runDir: string; status: string; blockedReason?: string; gateVerdict?: string };
    const follow = JSON.parse((await run(cwd, "follow", runResult.logicalRunId, "--json")).stdout) as { version: string; run: { status: string }; tasks: unknown[] };
    const monitor = JSON.parse((await run(cwd, "monitor", runResult.logicalRunId, "--json")).stdout) as { version: string; run: { status: string }; tasks: unknown[] };
    const diagnose = JSON.parse((await run(cwd, "diagnose", runResult.logicalRunId, "--wait", "--json")).stdout) as { status: string; diagnosticId: string; diagnostics: { version: string; run: { status: string }; diagnostics: unknown[] } };
    const resume = JSON.parse((await run(cwd, "resume", runResult.logicalRunId, "--wait", "--json")).stdout) as { status: string };
    const shownRun = JSON.parse((await run(cwd, "show", "run", runResult.logicalRunId, "--json")).stdout) as { logicalRunId: string };
    const runs = JSON.parse((await run(cwd, "list", "runs", "--json")).stdout) as { entries: string[] };

    expect(validate.ok).toBe(true);
    expect(preview).toMatchObject({ workflowName: "deterministic-cli", status: "pending" });
    expect(save).toMatchObject({ ok: true, workflow: "deterministic" });
    expect(workflows.entries).toContain("deterministic");
    expect(saved.name).toBe("deterministic-cli");
    expect(generated.ok).toBe(true);
    expect(drafts.entries).toContain(path.basename(generated.path));
    expect(draft.name).toBe("generated");
    expect(runEvents.map((event) => event.type)).toContain("worker_started");
    expect(runResult).toMatchObject({
      type: "terminal_summary",
      ok: true,
      logicalRunId: expect.any(String),
      runDir: expect.stringContaining(runResult.logicalRunId),
      status: "blocked"
    });
    expect(runResult.status).toBe("blocked");
    expect(follow.version).toBe("acpx-workflow-orchestrator.monitor/v1");
    expect(follow.run.status).toBe("blocked");
    expect(monitor.version).toBe("acpx-workflow-orchestrator.monitor/v1");
    expect(monitor.run.status).toBe("blocked");
    expect(monitor.tasks).toEqual(follow.tasks);
    expect(diagnose.status).toBe("diagnosed_blocked");
    expect(diagnose.diagnosticId).toBe("diagnostic-1");
    expect(diagnose.diagnostics.version).toBe("acpx-workflow-orchestrator.diagnostics/v1");
    expect(diagnose.diagnostics.run.status).toBe("diagnosed_blocked");
    expect(resume.status).toBe("blocked");
    expect(shownRun.logicalRunId).toBe(runResult.logicalRunId);
    expect(runs.entries).toContain(runResult.logicalRunId);
  }, 60_000);

  it("keeps follow observation-only for pending prepared runs", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-cli-observe-"));
    const spec = observationOnlySpec();
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });

    const follow = JSON.parse((await run(cwd, "follow", prepared.logicalRunId, "--json")).stdout) as { version: string; run: { status: string }; tasks: Array<{ id: string }> };
    const monitor = JSON.parse((await run(cwd, "monitor", prepared.logicalRunId, "--json")).stdout) as { version: string; run: { status: string }; tasks: Array<{ id: string }> };
    const detail = JSON.parse((await run(cwd, "monitor", "detail", prepared.logicalRunId, follow.tasks[0]?.id ?? "", "--json")).stdout) as { version: string; task: { id: string } };
    const afterFollow = await readRunIndex(cwd, prepared.logicalRunId);

    expect(follow.version).toBe("acpx-workflow-orchestrator.monitor/v1");
    expect(follow.run.status).toBe("pending");
    expect(monitor.version).toBe("acpx-workflow-orchestrator.monitor/v1");
    expect(monitor.run.status).toBe("pending");
    expect(follow.tasks[0]?.id).toBe("task:task");
    expect(detail.version).toBe("acpx-workflow-orchestrator.task-detail/v1");
    expect(detail.task.id).toBe("task:task");
    expect(afterFollow.stages.task.status).toBe("pending");
  }, 60_000);

  it("starts a background worker by default and returns a lightweight JSON envelope", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-cli-background-"));
    await fs.writeFile(path.join(cwd, "sample.txt"), "hello\n", "utf8");
    const specPath = path.join(cwd, "background.workflow.spec.json");
    await fs.writeFile(specPath, `${JSON.stringify(deterministicSpec(cwd), null, 2)}\n`, "utf8");

    const started = JSON.parse((await run(cwd, "run", "--spec", specPath, "--json")).stdout) as {
      ok: boolean;
      logicalRunId: string;
      runDir: string;
      status: string;
      worker?: { pid?: number; status?: string };
    };
    const finalIndex = await waitForTerminal(cwd, started.logicalRunId);

    expect(started).toMatchObject({ ok: true, status: "running" });
    expect(started.worker?.pid).toEqual(expect.any(Number));
    expect(started.worker?.status).toBe("running");
    expect(started.runDir).toContain(started.logicalRunId);
    expect(finalIndex.status).toBe("blocked");
    await expect(fs.stat(path.join(started.runDir, "worker.log"))).resolves.toBeTruthy();
  }, 60_000);

  it("rejects resume for non-recovery run states", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-cli-resume-policy-"));
    const prepared = await prepareRun(observationOnlySpec(), { cwd, input: { cwd } });

    const resume = await runMaybe(cwd, "resume", prepared.logicalRunId, "--json");

    expect(resume.exitCode).not.toBe(0);
    expect(`${resume.stderr}\n${resume.stdout}`).toContain("RESUME_POLICY_INVALID");
  }, 60_000);

  it("rejects recover for an active worker and starts a new worker after it is stale", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-cli-recover-"));
    await fs.writeFile(path.join(cwd, "sample.txt"), "hello\n", "utf8");
    const spec = deterministicSpec(cwd);
    const prepared = await prepareRun(WorkflowSpecSchema.parse(spec), { cwd, input: { cwd } });
    await updateRunIndex(cwd, prepared.logicalRunId, (index) => ({
      ...index,
      status: "running",
      worker: {
        pid: 12345,
        generation: 1,
        status: "running",
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString()
      }
    }));

    const activeRecover = await runMaybe(cwd, "recover", prepared.logicalRunId, "--json");
    await updateRunIndex(cwd, prepared.logicalRunId, (index) => ({
      ...index,
      worker: index.worker ? {
        ...index.worker,
        heartbeatAt: new Date(Date.now() - 61_000).toISOString()
      } : undefined
    }));
    const recovered = await run(cwd, "recover", prepared.logicalRunId);
    const finalIndex = await waitForTerminal(cwd, prepared.logicalRunId);

    expect(activeRecover.exitCode).not.toBe(0);
    expect(`${activeRecover.stderr}\n${activeRecover.stdout}`).toContain("already has an active worker");
    expect(recovered.stdout).toContain(`runId=${prepared.logicalRunId}`);
    expect(recovered.stdout).toContain(`runDir=${prepared.dir}`);
    expect(recovered.stdout).toContain("worker=");
    expect(finalIndex.status).toBe("blocked");
  }, 60_000);

  it("starts a background worker for resume without wait", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-cli-resume-background-"));
    await fs.writeFile(path.join(cwd, "sample.txt"), "hello\n", "utf8");
    const specPath = path.join(cwd, "resume-background.workflow.spec.json");
    await fs.writeFile(specPath, `${JSON.stringify(deterministicSpec(cwd), null, 2)}\n`, "utf8");
    const runEvents = parseNdjson((await run(cwd, "run", "--spec", specPath, "--wait", "--json")).stdout);
    const runResult = runEvents.at(-1) as { logicalRunId: string };

    const resumed = JSON.parse((await run(cwd, "resume", runResult.logicalRunId, "--json")).stdout) as {
      ok: boolean;
      runId: string;
      status: string;
      worker?: { pid?: number; status?: string; generation?: number };
      message: string;
    };
    const finalIndex = await waitForTerminal(cwd, runResult.logicalRunId);

    expect(resumed).toMatchObject({
      ok: true,
      runId: runResult.logicalRunId,
      status: "running",
      message: "Run resume started a background worker."
    });
    expect(resumed.worker?.pid).toEqual(expect.any(Number));
    expect(resumed.worker?.generation).toEqual(expect.any(Number));
    expect(finalIndex.status).toBe("blocked");
  }, 60_000);

  it("rejects resume while an active worker owns the run", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-cli-resume-active-"));
    const prepared = await prepareRun(observationOnlySpec(), { cwd, input: { cwd } });
    await updateRunIndex(cwd, prepared.logicalRunId, (index) => ({
      ...index,
      status: "blocked",
      blockedReason: "test",
      worker: {
        pid: 12345,
        generation: 1,
        status: "running",
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString()
      }
    }));

    const resume = await runMaybe(cwd, "resume", prepared.logicalRunId, "--wait", "--json");

    expect(resume.exitCode).not.toBe(0);
    expect(`${resume.stderr}\n${resume.stdout}`).toContain("already has an active worker");
  }, 60_000);
});

async function run(cwd: string, ...args: string[]) {
  return execa(tsxBin, [cli, ...args], { cwd });
}

async function runMaybe(cwd: string, ...args: string[]) {
  return execa(tsxBin, [cli, ...args], { cwd, reject: false });
}

function parseNdjson(stdout: string): Array<Record<string, unknown>> {
  return stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForTerminal(cwd: string, logicalRunId: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const index = await readRunIndex(cwd, logicalRunId);
    if (terminalRunStatus(index.status)) return index;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for terminal run ${logicalRunId}`);
}

function deterministicSpec(cwd: string) {
  return {
    schemaVersion: "acpx-workflow-orchestrator.workflow/v1",
    name: "deterministic-cli",
    description: "No-agent CLI lifecycle workflow.",
    root: "discover",
    inputs: {
      cwd: { type: "path", default: cwd }
    },
    roles: {},
    limits: { stageTimeoutMinutes: 1 },
    stages: [
      { id: "discover", kind: "discover", method: "glob", args: { scope: ["*.txt"] }, output: "files" },
      {
        id: "decide",
        kind: "decisionGate",
        mode: "program",
        dependsOn: ["discover"],
        rules: [{ when: { source: "outputs.discover.files", op: "exists" }, to: "blocked" }],
        default: "blocked"
      },
      { id: "gate", kind: "gate", dependsOn: ["decide"] }
    ]
  };
}

function observationOnlySpec() {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpx-workflow-orchestrator.workflow/v1",
    name: "observation-only-cli",
    root: "task",
    roles: {
      implementer: { category: "implementation", agent: "gpt-test", mode: "readOnly" }
    },
    limits: { stageTimeoutMinutes: 1 },
    stages: [
      { id: "task", kind: "agentTask", role: "implementer", prompt: "Observe only." },
      { id: "gate", kind: "gate", dependsOn: ["task"] }
    ]
  });
}
