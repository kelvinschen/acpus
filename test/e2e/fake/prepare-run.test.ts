import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareRun, startPreparedRun } from "../../../src/runtime/run-workflow.js";
import { syncRun } from "../../../src/runtime/sync.js";
import { setAgentRuntimeFactoryForTests } from "../../../src/runtime/agent-runtime.js";
import { WorkflowSpecSchema } from "../../../src/schema/workflow-spec.js";
import { fakeRuntimeFactory, implementationOutput, gateOutput, validationOutput, plainJsonOutput } from "../../helpers/fake-runtime.js";

describe("runtime-driven fake e2e", () => {
  afterEach(() => setAgentRuntimeFactoryForTests(undefined));

  it("creates a logical run snapshot with execution-plan.json and no flow artifacts", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-workflow-orchestrator-test-"));
    const spec = WorkflowSpecSchema.parse(JSON.parse(await fs.readFile(path.resolve(__dirname, "..", "..", "..", "workflows/examples/simple-feature.workflow.spec.json"), "utf8")));
    const prepared = await prepareRun(spec, {
      cwd: temp,
      input: { task: "test", cwd: temp, testHints: "" },
      sourcePath: "example"
    });

    await expect(fs.stat(path.join(prepared.dir, "run.json"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(prepared.dir, "execution-plan.json"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(prepared.dir, "workflow.flow.ts"))).rejects.toBeTruthy();
    await expect(fs.stat(path.join(prepared.dir, "segments"))).rejects.toBeTruthy();
  });

  it("runs a linear workflow through fake runtime turns", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-workflow-orchestrator-linear-"));
    const spec = WorkflowSpecSchema.parse(JSON.parse(await fs.readFile(path.resolve(__dirname, "..", "..", "..", "workflows/examples/simple-feature.workflow.spec.json"), "utf8")));
    const fake = fakeRuntimeFactory([
      { text: plainJsonOutput({ status: "completed", summary: "plan", artifacts: [], nextFocus: "implement" }) },
      { text: plainJsonOutput(implementationOutput({ summary: "implemented", changedFiles: ["src/app.ts"] })) },
      { text: plainJsonOutput(validationOutput({ summary: "validated" })) },
      { text: plainJsonOutput(gateOutput({ summary: "done", changedFiles: ["src/app.ts"] })) }
    ]);
    setAgentRuntimeFactoryForTests(fake.factory);
    const prepared = await prepareRun(spec, { cwd: temp, input: { task: "test", cwd: temp, testHints: "" } });

    let index = await startPreparedRun(temp, prepared);
    while (index.status === "running" || index.status === "pending") index = await syncRun(temp, prepared.logicalRunId);
    const gate = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "gate.json"), "utf8")) as { summary: string; verdict: string; changedFiles: string[] };

    expect(index.status).toBe("completed");
    expect(index.agentUsage.actual).toBe(3);
    expect(index.gateVerdict).toBe("pass");
    expect(gate).toMatchObject({ summary: "validated", verdict: "pass", changedFiles: [] });
    await expect(fs.stat(path.join(prepared.dir, "outputs", "gate.json"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(prepared.dir, "attempts", "implement", "attempt-1", "raw.txt"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(prepared.dir, "sessions", "role-bindings.json"))).resolves.toBeTruthy();
  });

  it("persists deterministic blocked stages before wait polling", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-workflow-orchestrator-blocked-"));
    await fs.writeFile(path.join(temp, "sample.txt"), "hello\n", "utf8");
    const spec = WorkflowSpecSchema.parse({
      schemaVersion: "acpx-workflow-orchestrator.workflow/v1",
      name: "deterministic-blocked",
      root: "discover",
      inputs: { cwd: { type: "path", default: temp } },
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
    });

    const prepared = await prepareRun(spec, { cwd: temp, input: { cwd: temp } });
    const index = await startPreparedRun(temp, prepared);
    const persisted = JSON.parse(await fs.readFile(path.join(prepared.dir, "run.json"), "utf8")) as typeof index;

    expect(index.status).toBe("blocked");
    expect(persisted.status).toBe("blocked");
    expect(persisted.stages.discover?.status).toBe("completed");
    expect(persisted.stages.decide?.status).toBe("blocked");
    expect(persisted.stages.gate?.status).toBe("skipped");
    expect(Object.keys(persisted.attempts)).toEqual([]);
  });

  it("blocks when a program gate condition is false", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-workflow-orchestrator-gate-blocked-"));
    const spec = WorkflowSpecSchema.parse({
      schemaVersion: "acpx-workflow-orchestrator.workflow/v1",
      name: "program-gate-blocked",
      root: "gate",
      inputs: { cwd: { type: "path", default: temp } },
      roles: {},
      limits: { stageTimeoutMinutes: 1 },
      stages: [{ id: "gate", kind: "gate", condition: { source: "input.missing", op: "exists" } }]
    });
    const prepared = await prepareRun(spec, { cwd: temp, input: { cwd: temp } });
    const index = await startPreparedRun(temp, prepared);
    const gate = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "gate.json"), "utf8")) as { status: string; verdict: string; blockedReason: string };

    expect(index.status).toBe("blocked");
    expect(index.gateVerdict).toBe("blocked");
    expect(index.blockedReason).toBe("GATE_CONDITION_FAILED");
    expect(gate).toMatchObject({ status: "blocked", verdict: "blocked", blockedReason: "GATE_CONDITION_FAILED" });
  });

  it("repairs schema-invalid output and records repair accounting", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-workflow-orchestrator-repair-"));
    const spec = WorkflowSpecSchema.parse(JSON.parse(await fs.readFile(path.resolve(__dirname, "..", "..", "..", "workflows/examples/simple-feature.workflow.spec.json"), "utf8")));
    const fake = fakeRuntimeFactory([
      { text: plainJsonOutput({ status: "completed", summary: "plan", artifacts: [], nextFocus: "implement" }) },
      { text: plainJsonOutput({ card: "domain-report" }) },
      { text: plainJsonOutput(implementationOutput({ summary: "repaired implementation" })) },
      { text: plainJsonOutput(validationOutput()) },
      { text: plainJsonOutput(gateOutput()) }
    ]);
    setAgentRuntimeFactoryForTests(fake.factory);
    const prepared = await prepareRun(spec, { cwd: temp, input: { task: "test", cwd: temp, testHints: "" } });

    let index = await startPreparedRun(temp, prepared);
    while (index.status === "running" || index.status === "pending") index = await syncRun(temp, prepared.logicalRunId);

    expect(index.status).toBe("completed");
    expect(index.agentUsage.actual).toBe(4);
    expect(index.agentUsage.repairCalls).toBe(1);
    await expect(fs.stat(path.join(prepared.dir, "attempts", "implement", "repair-1", "prompt.md"))).resolves.toBeTruthy();
  });

  it("repairs checks[].result instead of accepting it as an alias", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-workflow-orchestrator-alias-"));
    const spec = WorkflowSpecSchema.parse(JSON.parse(await fs.readFile(path.resolve(__dirname, "..", "..", "..", "workflows/examples/simple-feature.workflow.spec.json"), "utf8")));
    const fake = fakeRuntimeFactory([
      { text: plainJsonOutput({ status: "completed", summary: "plan", artifacts: [], nextFocus: "implement" }) },
      { text: plainJsonOutput(implementationOutput({ checks: [{ name: "unit", result: "pass" }] })) },
      { text: plainJsonOutput(implementationOutput({ checks: [{ name: "unit", status: "pass" }] })) },
      { text: plainJsonOutput(validationOutput()) },
      { text: plainJsonOutput(gateOutput()) }
    ]);
    setAgentRuntimeFactoryForTests(fake.factory);
    const prepared = await prepareRun(spec, { cwd: temp, input: { task: "test", cwd: temp, testHints: "" } });

    let index = await startPreparedRun(temp, prepared);
    while (index.status === "running" || index.status === "pending") index = await syncRun(temp, prepared.logicalRunId);
    const output = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "implement.json"), "utf8")) as { checks: unknown[]; metadata: { outputParse: Record<string, unknown> } };

    expect(index.agentUsage.repairCalls).toBe(1);
    expect(output.checks).toEqual([{ name: "unit", status: "pass" }]);
    expect(output.metadata.outputParse).not.toHaveProperty("outputNormalizedAliases");
  });

  it("blocks when repair also fails schema validation", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-workflow-orchestrator-repair-fail-"));
    const spec = WorkflowSpecSchema.parse(JSON.parse(await fs.readFile(path.resolve(__dirname, "..", "..", "..", "workflows/examples/simple-feature.workflow.spec.json"), "utf8")));
    const fake = fakeRuntimeFactory([
      { text: plainJsonOutput({ status: "completed", summary: "plan", artifacts: [], nextFocus: "implement" }) },
      { text: plainJsonOutput({ card: "domain-report" }) },
      { text: plainJsonOutput({ still: "invalid" }) }
    ]);
    setAgentRuntimeFactoryForTests(fake.factory);
    const prepared = await prepareRun(spec, { cwd: temp, input: { task: "test", cwd: temp, testHints: "" } });

    let index = await startPreparedRun(temp, prepared);
    while (index.status === "running" || index.status === "pending") index = await syncRun(temp, prepared.logicalRunId);
    const output = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "implement.json"), "utf8")) as { blockedReason: string };

    expect(index.status).toBe("blocked");
    expect(output.blockedReason).toBe("OUTPUT_REPAIR_FAILED");
  });

  it("runs fanout items with independent session keys", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-workflow-orchestrator-fanout-"));
    const spec = WorkflowSpecSchema.parse(JSON.parse(await fs.readFile(path.resolve(__dirname, "..", "..", "..", "workflows/examples/edit-fanout-reconcile.workflow.spec.json"), "utf8")));
    const fake = fakeRuntimeFactory([
      { text: plainJsonOutput(implementationOutput({ summary: "item 1" })) },
      { text: plainJsonOutput(implementationOutput({ summary: "item 2" })) },
      { text: plainJsonOutput(validationOutput({ summary: "reconciled" })) },
      { text: plainJsonOutput(gateOutput({ summary: "done" })) }
    ]);
    setAgentRuntimeFactoryForTests(fake.factory);
    const prepared = await prepareRun(spec, { cwd: temp, input: { task: "edit", cwd: temp, items: [{ path: "a.ts" }, { path: "b.ts" }] } });

    let index = await startPreparedRun(temp, prepared);
    while (index.status === "running" || index.status === "pending") index = await syncRun(temp, prepared.logicalRunId);

    expect(index.status).toBe("completed");
    const sessionKeys = fake.runtime.requests.map((request) => request.sessionKey);
    expect(sessionKeys).toContain("role:implementer:fanout:edit_items:item:path-0d18d4eb377a");
    expect(sessionKeys).toContain("role:implementer:fanout:edit_items:item:path-ded2f7f761b7");
    await expect(fs.stat(path.join(prepared.dir, "outputs", "edit_items.json"))).resolves.toBeTruthy();
  });
});
