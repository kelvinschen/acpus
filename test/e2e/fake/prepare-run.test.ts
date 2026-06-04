import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { prepareRun, startPreparedRun } from "../../../src/runtime/run-workflow.js";
import { syncRun } from "../../../src/runtime/sync.js";
import { setAgentRuntimeFactoryForTests } from "../../../src/runtime/agent-runtime.js";
import { setAgentTaskRetryDelayForTests } from "../../../src/runtime/agent-task-retry.js";
import { RuntimeErrorCodes } from "../../../src/run-index/read-write.js";
import { WorkflowSpecSchema } from "../../../src/schema/workflow-spec.js";
import { baseOutput, fakeRuntimeFactory, gateOutput, plainJsonOutput } from "../../helpers/fake-runtime.js";

describe("runtime-driven fake e2e", () => {
  beforeEach(() => setAgentTaskRetryDelayForTests(0));
  afterEach(() => {
    setAgentRuntimeFactoryForTests(undefined);
    setAgentTaskRetryDelayForTests(undefined);
  });

  it("creates a logical run snapshot with YAML spec and execution-plan.json", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "acpus-test-"));
    const spec = await readExample("simple-feature.workflow.spec.yaml");
    const prepared = await prepareRun(spec, {
      cwd: temp,
      input: { task: "test", cwd: temp, testHints: "" },
      sourcePath: "example"
    });

    await expect(fs.stat(path.join(prepared.dir, "run.json"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(prepared.dir, "execution-plan.json"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(prepared.dir, "workflow.spec.yaml"))).resolves.toBeTruthy();
  });

  it("runs a linear workflow through fake runtime turns", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "acpus-linear-"));
    const spec = await readExample("simple-feature.workflow.spec.yaml");
    const fake = fakeRuntimeFactory([
      { text: plainJsonOutput({ summary: "plan" }) },
      { text: plainJsonOutput(baseOutput({ summary: "implemented", data: [{ kind: "file", path: "src/app.ts", status: "updated" }] })) },
      { text: plainJsonOutput(gateOutput({ summary: "done" })) }
    ]);
    setAgentRuntimeFactoryForTests(fake.factory);
    const prepared = await prepareRun(spec, { cwd: temp, input: { task: "test", cwd: temp, testHints: "" } });

    let index = await startPreparedRun(temp, prepared);
    while (index.status === "running" || index.status === "pending") index = await syncRun(temp, prepared.logicalRunId);
    const gate = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "gate.json"), "utf8")) as { summary: string; verdict: string };

    expect(index.status).toBe("completed");
    expect(index.agentUsage.actual).toBe(3);
    expect(index.gateVerdict).toBe("pass");
    expect(gate).toMatchObject({ summary: "done", verdict: "pass" });
    await expect(fs.stat(path.join(prepared.dir, "outputs", "gate.json"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(prepared.dir, "attempts", "implement", "attempt-1", "raw.txt"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(prepared.dir, "sessions", "actor-bindings.json"))).resolves.toBeTruthy();
  });

  it("persists deterministic blocked stages before wait polling", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "acpus-blocked-"));
    await fs.writeFile(path.join(temp, "sample.txt"), "hello\n", "utf8");
    const spec = WorkflowSpecSchema.parse({
      schemaVersion: "acpus.workflow/v1",
      name: "deterministic-blocked",
      root: "decide",
      input: { schema: "{cwd:string}", default: { cwd: temp } },
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
    });

    const prepared = await prepareRun(spec, { cwd: temp, input: { cwd: temp } });
    const index = await startPreparedRun(temp, prepared);
    const persisted = JSON.parse(await fs.readFile(path.join(prepared.dir, "run.json"), "utf8")) as typeof index;

    expect(index.status).toBe("blocked");
    expect(persisted.status).toBe("blocked");
    expect(persisted.stages.decide?.status).toBe("blocked");
    expect(persisted.stages.gate?.status).toBe("skipped");
    expect(Object.keys(persisted.attempts)).toEqual([]);
  });

  it("blocks when a program gate condition is false", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "acpus-gate-blocked-"));
    const spec = WorkflowSpecSchema.parse({
      schemaVersion: "acpus.workflow/v1",
      name: "program-gate-blocked",
      root: "gate",
      input: { schema: "{cwd:string}", default: { cwd: temp } },
      limits: { stageTimeoutMinutes: 1 },
      stages: [{ id: "gate", kind: "gate", mode: "program", condition: { source: "input.missing", op: "exists" } }]
    });
    const prepared = await prepareRun(spec, { cwd: temp, input: { cwd: temp } });
    const index = await startPreparedRun(temp, prepared);
    const gate = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "gate.json"), "utf8")) as { status: string; verdict: string; blockedReason: string };

    expect(index.status).toBe("blocked");
    expect(index.gateVerdict).toBe("failed");
    expect(index.blockedReason).toBe("GATE_CONDITION_FAILED");
    expect(gate).toMatchObject({ status: "blocked", verdict: "failed", blockedReason: "GATE_CONDITION_FAILED" });
  });

  it("continues after schema-invalid output and records retry accounting", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "acpus-continuation-"));
    const spec = await readExample("simple-feature.workflow.spec.yaml");
    const fake = fakeRuntimeFactory([
      { text: plainJsonOutput({ summary: "plan" }) },
      { text: plainJsonOutput({ card: "domain-report" }) },
      { text: plainJsonOutput(baseOutput({ summary: "continued implementation" })) },
      { text: plainJsonOutput(gateOutput()) }
    ]);
    setAgentRuntimeFactoryForTests(fake.factory);
    const prepared = await prepareRun(spec, { cwd: temp, input: { task: "test", cwd: temp, testHints: "" } });

    let index = await startPreparedRun(temp, prepared);
    while (index.status === "running" || index.status === "pending") index = await syncRun(temp, prepared.logicalRunId);

    expect(index.status).toBe("completed");
    expect(index.agentUsage.actual).toBe(4);
    expect(index.agentUsage.retryCalls).toBe(1);
    expect(index.agentUsage.retries.continuation).toBe(1);
    await expect(fs.stat(path.join(prepared.dir, "attempts", "implement", "attempt-2", "prompt.md"))).resolves.toBeTruthy();
  });

  it("blocks when continuation retry fails schema validation", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "acpus-continuation-fail-"));
    const spec = await readExample("simple-feature.workflow.spec.yaml");
    const fake = fakeRuntimeFactory([
      { text: plainJsonOutput({ summary: "plan" }) },
      { text: plainJsonOutput({ card: "domain-report" }) },
      { text: plainJsonOutput({ still: "invalid" }) }
    ]);
    setAgentRuntimeFactoryForTests(fake.factory);
    const prepared = await prepareRun(spec, { cwd: temp, input: { task: "test", cwd: temp, testHints: "" } });

    let index = await startPreparedRun(temp, prepared);
    while (index.status === "running" || index.status === "pending") index = await syncRun(temp, prepared.logicalRunId);
    const output = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "implement.json"), "utf8")) as { blockedReason: string };

    expect(index.status).toBe("blocked");
    expect(output.blockedReason).toBe(RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED);
    expect(fake.runtime.requests.filter((request) => request.sessionKey === "agent:implementer")).toHaveLength(3);
    expect(index.agentUsage.retryCalls).toBe(2);
    expect(index.agentUsage.retries.continuation).toBe(2);
    expect(index.attempts["implement:attempt-3"]).toMatchObject({
      status: "blocked",
      retryReason: "continuation",
      retryOrdinal: 2,
      retryBudgetUsed: 2,
      retryBudgetLimit: 2,
      blockedReason: "OUTPUT_SCHEMA_FAILED"
    });
  });

  it("runs fanout items with independent session keys", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "acpus-fanout-"));
    const spec = await readExample("fanout/program-fanin.workflow.spec.yaml");
    const fake = fakeRuntimeFactory([
      { text: plainJsonOutput(baseOutput({ summary: "item 1", data: [{ summary: "item 1" }] })) },
      { text: plainJsonOutput(baseOutput({ summary: "item 2", data: [{ summary: "item 2" }] })) },
      { text: plainJsonOutput(gateOutput({ summary: "done" })) }
    ]);
    setAgentRuntimeFactoryForTests(fake.factory);
    const prepared = await prepareRun(spec, { cwd: temp, input: { task: "edit", cwd: temp, items: [{ path: "a.ts" }, { path: "b.ts" }] } });

    let index = await startPreparedRun(temp, prepared);
    while (index.status === "running" || index.status === "pending") index = await syncRun(temp, prepared.logicalRunId);

    expect(index.status).toBe("completed");
    const sessionKeys = fake.runtime.requests.map((request) => request.sessionKey);
    expect(sessionKeys).toContain("fanout:review_items:item:path-0d18d4eb377a:lane:validator:agent:validator");
    expect(sessionKeys).toContain("fanout:review_items:item:path-ded2f7f761b7:lane:validator:agent:validator");
    await expect(fs.stat(path.join(prepared.dir, "outputs", "review_items.json"))).resolves.toBeTruthy();
  });
});

async function readExample(relativePath: string) {
  const raw = await fs.readFile(path.resolve(__dirname, "..", "..", "..", "workflows/examples", relativePath), "utf8");
  return WorkflowSpecSchema.parse(YAML.parse(raw));
}
