import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";
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

  it("plans, saves, runs, observes, and resumes", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-cli-lifecycle-"));
    await fs.writeFile(path.join(cwd, "sample.txt"), "hello\n", "utf8");
    const specPath = path.join(cwd, "deterministic.workflow.spec.yaml");
    await fs.writeFile(specPath, YAML.stringify(deterministicSpec(cwd)), "utf8");

    const planQuiet = JSON.parse((await run(cwd, "plan", specPath, "--quiet", "--json")).stdout) as { ok: boolean };
    const plan = JSON.parse((await run(cwd, "plan", specPath, "--json")).stdout) as { workflowName: string; status: string };
    const save = JSON.parse((await run(cwd, "save", "deterministic", specPath, "--json")).stdout) as { ok: boolean; workflow: string; path: string };
    const saveOverwrite = JSON.parse((await run(cwd, "save", "deterministic", specPath, "--overwrite", "--json")).stdout) as { ok: boolean; workflow: string; path: string };
    const saveMissingSpec = await runMaybe(cwd, "save", "missing-spec");
    const workflows = JSON.parse((await run(cwd, "list", "workflows", "--json")).stdout) as { entries: string[] };
    const saved = JSON.parse((await run(cwd, "show", "workflow", "deterministic", "--json")).stdout) as { name: string };
    const runEvents = parseNdjson((await run(cwd, "run", "deterministic", "--wait", "--json")).stdout);
    const runResult = runEvents.at(-1) as { type: string; ok: boolean; logicalRunId: string; runDir: string; status: string; blockedReason?: string; gateVerdict?: string };
    const followOutput = parseNdjson((await run(cwd, "follow", runResult.logicalRunId, "--json")).stdout);
    const follow = (followOutput.at(-1) ?? {}) as { version: string; run: { status: string }; tasks: unknown[] };
    const monitor = JSON.parse((await run(cwd, "monitor", runResult.logicalRunId, "--json")).stdout) as { version: string; run: { status: string }; tasks: unknown[] };
    const resume = JSON.parse((await run(cwd, "resume", runResult.logicalRunId, "--wait", "--json")).stdout) as { status: string };
    const shownRun = JSON.parse((await run(cwd, "show", "run", runResult.logicalRunId, "--json")).stdout) as { logicalRunId: string };
    const runs = JSON.parse((await run(cwd, "list", "runs", "--json")).stdout) as { entries: string[] };
    const monitorRuns = JSON.parse((await run(cwd, "monitor", "--json")).stdout) as { kind: string; dir: string; entries: Array<{ runId: string; status: string; workflowName: string; sortTime: string }> };
    const followRuns = JSON.parse((await run(cwd, "follow", "--json")).stdout) as { kind: string; dir: string; entries: Array<{ runId: string; status: string; workflowName: string; sortTime: string }> };
    const monitorText = (await run(cwd, "monitor")).stdout;
    const followText = (await run(cwd, "follow")).stdout;

    expect(planQuiet.ok).toBe(true);
    expect(plan).toMatchObject({ workflowName: "deterministic-cli", status: "pending" });
    expect(save).toMatchObject({ ok: true, workflow: "deterministic", path: expect.any(String) });
    expect(saveOverwrite).toMatchObject({ ok: true, workflow: "deterministic", path: save.path });
    expect(saveMissingSpec.exitCode).toBe(1);
    expect(saveMissingSpec.stderr).toContain("missing required argument 'spec'");
    expect(workflows.entries).toContain("deterministic");
    expect(saved.name).toBe("deterministic-cli");
    expect(runEvents.map((event) => event.type)).toContain("worker_started");
    expect(runResult).toMatchObject({
      type: "terminal_summary",
      ok: true,
      logicalRunId: expect.any(String),
      runDir: expect.stringContaining(runResult.logicalRunId),
      status: "blocked"
    });
    expect(runResult.status).toBe("blocked");
    expect(follow.version).toBe("acpus.monitor/v1");
    expect(follow.run.status).toBe("blocked");
    expect(monitor.version).toBe("acpus.monitor/v1");
    expect(monitor.run.status).toBe("blocked");
    expect(monitor.tasks).toEqual(follow.tasks);
    expect(resume.status).toBe("blocked");
    expect(shownRun.logicalRunId).toBe(runResult.logicalRunId);
    expect(runs.entries).toContain(runResult.logicalRunId);
    expect(monitorRuns).toMatchObject({ kind: "runs" });
    expect(monitorRuns.dir).toContain(path.join(".acpus", "runs"));
    expect(monitorRuns.entries[0]).toMatchObject({ runId: runResult.logicalRunId, status: "blocked", workflowName: "deterministic-cli" });
    expect(followRuns).toMatchObject({ kind: "runs" });
    expect(followRuns.entries).toEqual(monitorRuns.entries);
    expect(monitorText).toContain("runs in");
    expect(monitorText).toContain(runResult.logicalRunId);
    expect(followText).toContain("runs in");
    expect(followText).toContain(runResult.logicalRunId);
  }, 60_000);

  it("keeps follow observation-only for pending prepared runs", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-cli-observe-"));
    const spec = observationOnlySpec();
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });

    const followOutput = parseNdjson((await run(cwd, "follow", prepared.logicalRunId, "--json")).stdout);
    const follow = (followOutput.at(-1) ?? {}) as { version: string; run: { status: string }; tasks: Array<{ id: string }> };
    const monitor = JSON.parse((await run(cwd, "monitor", prepared.logicalRunId, "--json")).stdout) as { version: string; run: { status: string }; tasks: Array<{ id: string }> };
    const detail = JSON.parse((await run(cwd, "monitor", "detail", prepared.logicalRunId, follow.tasks[0]?.id ?? "", "--json")).stdout) as { version: string; task: { id: string } };
    const afterFollow = await readRunIndex(cwd, prepared.logicalRunId);

    expect(follow.version).toBe("acpus.monitor/v1");
    expect(follow.run.status).toBe("pending");
    expect(monitor.version).toBe("acpus.monitor/v1");
    expect(monitor.run.status).toBe("pending");
    expect(follow.tasks[0]?.id).toBe("task:task");
    expect(detail.version).toBe("acpus.task-detail/v1");
    expect(detail.task.id).toBe("task:task");
    expect(afterFollow.stages.task.status).toBe("pending");
  }, 60_000);

  it("exposes finalOutput from completed program gates in wait, follow, and monitor JSON", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-cli-final-output-"));
    const specPath = path.join(cwd, "final-output.workflow.spec.yaml");
    await fs.writeFile(specPath, YAML.stringify(finalOutputSpec(cwd)), "utf8");

    const runEvents = parseNdjson((await run(cwd, "run", specPath, "--wait", "--json")).stdout);
    const runResult = runEvents.at(-1) as { type: string; status: string; finalOutput?: { status?: string; verdict?: string; data?: { data?: { value?: unknown } } }; logicalRunId: string };
    const follow = parseNdjson((await run(cwd, "follow", runResult.logicalRunId, "--json")).stdout).at(-1) as { finalOutput?: unknown };
    const monitor = JSON.parse((await run(cwd, "monitor", runResult.logicalRunId, "--json")).stdout) as { finalOutput?: unknown };

    expect(runResult).toMatchObject({
      type: "terminal_summary",
      status: "completed",
      finalOutput: {
        status: "completed",
        verdict: "pass",
        data: {
          data: {
            value: { answer: 42 }
          }
        }
      }
    });
    expect(follow.finalOutput).toEqual(runResult.finalOutput);
    expect(monitor.finalOutput).toEqual(runResult.finalOutput);
  }, 60_000);

  it("resolves input-sourced limits at run start and writes only numbers to execution-plan.json", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-cli-input-limits-"));
    const specPath = path.join(cwd, "input-limits.workflow.spec.yaml");
    const inputPath = path.join(cwd, "input.json");
    await fs.writeFile(specPath, YAML.stringify(inputLimitSpec()), "utf8");
    await fs.writeFile(inputPath, JSON.stringify({ reviewItems: [], maxConcurrency: 7, maxFanoutItems: 9 }), "utf8");

    const runEvents = parseNdjson((await run(cwd, "run", specPath, "--input", inputPath, "--wait", "--json")).stdout);
    const inlineRunEvents = parseNdjson((await run(cwd, "run", specPath, "--input", JSON.stringify({ reviewItems: [], maxConcurrency: 3, maxFanoutItems: 4 }), "--wait", "--json")).stdout);
    const runResult = runEvents.at(-1) as { type: string; status: string; runDir: string };
    const inlineRunResult = inlineRunEvents.at(-1) as { type: string; status: string; runDir: string };
    const plan = JSON.parse(await fs.readFile(path.join(runResult.runDir, "execution-plan.json"), "utf8")) as {
      stages: Array<{ id: string; limits?: Record<string, unknown>; fanout?: { maxConcurrency?: number; maxItems?: number } }>;
    };
    const inlinePlan = JSON.parse(await fs.readFile(path.join(inlineRunResult.runDir, "execution-plan.json"), "utf8")) as {
      stages: Array<{ id: string; limits?: Record<string, unknown>; fanout?: { maxConcurrency?: number; maxItems?: number } }>;
    };
    const snapshot = YAML.parse(await fs.readFile(path.join(runResult.runDir, "workflow.spec.yaml"), "utf8")) as {
      stages: Array<{ id: string; limits?: Record<string, unknown> }>;
    };
    const reviewPlan = plan.stages.find((stage) => stage.id === "review");
    const inlineReviewPlan = inlinePlan.stages.find((stage) => stage.id === "review");
    const reviewSnapshot = snapshot.stages.find((stage) => stage.id === "review");

    expect(runResult).toMatchObject({ type: "terminal_summary", status: "completed" });
    expect(inlineRunResult).toMatchObject({ type: "terminal_summary", status: "completed" });
    expect(reviewPlan?.limits).toEqual({ maxConcurrency: 7, maxFanoutItems: 9 });
    expect(reviewPlan?.fanout).toMatchObject({ maxConcurrency: 7, maxItems: 9 });
    expect(inlineReviewPlan?.limits).toEqual({ maxConcurrency: 3, maxFanoutItems: 4 });
    expect(inlineReviewPlan?.fanout).toMatchObject({ maxConcurrency: 3, maxItems: 4 });
    expect(reviewSnapshot?.limits?.maxConcurrency).toEqual({ source: "input.maxConcurrency" });
    expect(reviewSnapshot?.limits?.maxFanoutItems).toEqual({ source: "input.maxFanoutItems", default: 5 });
  }, 60_000);

  it("starts a background worker by default and returns a lightweight JSON envelope", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-cli-background-"));
    await fs.writeFile(path.join(cwd, "sample.txt"), "hello\n", "utf8");
    const specPath = path.join(cwd, "background.workflow.spec.yaml");
    await fs.writeFile(specPath, YAML.stringify(deterministicSpec(cwd)), "utf8");

    const started = JSON.parse((await run(cwd, "run", specPath, "--json")).stdout) as {
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

  it("rejects resume --force for an active worker and starts a new worker after it is stale", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-cli-recover-"));
    await fs.writeFile(path.join(cwd, "sample.txt"), "hello\n", "utf8");
    const spec = deterministicSpec(cwd);
    const prepared = await prepareRun(WorkflowSpecSchema.parse(spec), { cwd, input: { cwd } });
    const activeWorker = spawnLiveProcess(cwd);
    try {
      await updateRunIndex(cwd, prepared.logicalRunId, (index) => ({
        ...index,
        status: "running",
        worker: {
          pid: activeWorker.pid,
          generation: 1,
          status: "running",
          startedAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString()
        }
      }));

      const activeResume = await runMaybe(cwd, "resume", prepared.logicalRunId, "--force", "--json");
      await updateRunIndex(cwd, prepared.logicalRunId, (index) => ({
        ...index,
        worker: index.worker ? {
          ...index.worker,
          heartbeatAt: new Date(Date.now() - 61_000).toISOString()
        } : undefined
      }));
      const recovered = await run(cwd, "resume", prepared.logicalRunId, "--force");
      const finalIndex = await waitForTerminal(cwd, prepared.logicalRunId);

      expect(activeResume.exitCode).not.toBe(0);
      expect(`${activeResume.stderr}\n${activeResume.stdout}`).toContain("active worker");
      expect(recovered.stdout).toContain(`runId=${prepared.logicalRunId}`);
      expect(recovered.stdout).toContain(`runDir=${prepared.dir}`);
      expect(recovered.stdout).toContain("worker=");
      expect(finalIndex.status).toBe("blocked");
    } finally {
      activeWorker.kill();
    }
  }, 60_000);

  it("starts a background worker for resume without wait", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-cli-resume-background-"));
    await fs.writeFile(path.join(cwd, "sample.txt"), "hello\n", "utf8");
    const specPath = path.join(cwd, "resume-background.workflow.spec.yaml");
    await fs.writeFile(specPath, YAML.stringify(deterministicSpec(cwd)), "utf8");
    const runEvents = parseNdjson((await run(cwd, "run", specPath, "--wait", "--json")).stdout);
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
    const activeWorker = spawnLiveProcess(cwd);
    try {
      await updateRunIndex(cwd, prepared.logicalRunId, (index) => ({
        ...index,
        status: "blocked",
        blockedReason: "test",
        worker: {
          pid: activeWorker.pid,
          generation: 1,
          status: "running",
          startedAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString()
        }
      }));

      const resume = await runMaybe(cwd, "resume", prepared.logicalRunId, "--wait", "--json");

      expect(resume.exitCode).not.toBe(0);
      expect(`${resume.stderr}\n${resume.stdout}`).toContain("active worker");
    } finally {
      activeWorker.kill();
    }
  }, 60_000);
});

async function run(cwd: string, ...args: string[]) {
  return execa(tsxBin, [cli, ...args], { cwd });
}

async function runMaybe(cwd: string, ...args: string[]) {
  return execa(tsxBin, [cli, ...args], { cwd, reject: false });
}

function spawnLiveProcess(cwd: string): { pid: number; kill: () => void } {
  const child = execa(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { cwd });
  child.catch(() => undefined);
  if (!child.pid) throw new Error("Failed to spawn live pid test process.");
  return {
    pid: child.pid,
    kill: () => {
      child.kill();
    }
  };
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
    schemaVersion: "acpus.workflow/v1",
    name: "deterministic-cli",
    description: "No-agent CLI lifecycle workflow.",
    root: "decide",
    input: { schema: "{cwd:string}", default: { cwd } },
    limits: { stageTimeoutMinutes: 1 },
    stages: [
      {
        id: "decide",
        kind: "route",
        mode: "program",
        rules: [{ when: { source: "outputs.missing", op: "exists" }, to: "gate" }],
        routes: ["gate"]
      },
      { id: "gate", kind: "gate", mode: "program", dependsOn: ["decide"] }
    ]
  };
}

function observationOnlySpec() {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "observation-only-cli",
    root: "task",
    limits: { stageTimeoutMinutes: 1 },
    stages: [
      { id: "task", kind: "task", mode: "agent", actor: { agent: "gpt-test", mode: "readOnly", label: "implementer" }, prompt: "Observe only." },
      { id: "gate", kind: "gate", mode: "program", dependsOn: ["task"] }
    ]
  });
}

function finalOutputSpec(cwd: string) {
  return {
    schemaVersion: "acpus.workflow/v1",
    name: "final-output-cli",
    root: "produce",
    input: { schema: "{cwd:string}", default: { cwd } },
    limits: { stageTimeoutMinutes: 1 },
    stages: [
      {
        id: "produce",
        kind: "task",
        mode: "program",
        operation: "command",
        command: "node",
        args: ["-e", "process.stdout.write(JSON.stringify({status:'completed',data:{answer:42}}))"]
      },
      { id: "gate", kind: "gate", dependsOn: ["produce"] }
    ]
  };
}

function inputLimitSpec() {
  return {
    schemaVersion: "acpus.workflow/v1",
    name: "input-limits-cli",
    root: "review",
    input: {
      schema: "{reviewItems:[unknown],maxConcurrency?:number,maxFanoutItems?:number}",
      default: { reviewItems: [], maxConcurrency: 2 }
    },
    limits: { stageTimeoutMinutes: 1 },
    stages: [
      {
        id: "review",
        kind: "fanout",
        items: { source: "input.reviewItems" },
        prompt: "Review item.",
        limits: {
          maxConcurrency: { source: "input.maxConcurrency" },
          maxFanoutItems: { source: "input.maxFanoutItems", default: 5 }
        },
        lanes: [
          { id: "reviewer", actor: { agent: "aiden", mode: "readOnly" } }
        ],
        fanin: { mode: "program", operation: "mergeArrays" }
      },
      { id: "gate", kind: "gate", dependsOn: ["review"] }
    ]
  };
}
