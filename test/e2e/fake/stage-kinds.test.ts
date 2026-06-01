import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setAgentRuntimeFactoryForTests } from "../../../src/runtime/agent-runtime.js";
import { prepareRun } from "../../../src/runtime/run-workflow.js";
import { syncRun } from "../../../src/runtime/sync.js";
import { WorkflowSpecSchema, type WorkflowSpec } from "../../../src/schema/workflow-spec.js";
import { baseOutput, fakeRuntimeFactory, implementationOutput, gateOutput, validationOutput, plainJsonOutput } from "../../helpers/fake-runtime.js";

describe("stage kind fake runtime e2e", () => {
  afterEach(() => setAgentRuntimeFactoryForTests(undefined));

  it("runs agent discovery into program reduce", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-stage-agent-discover-"));
    const fake = fakeRuntimeFactory([
      { text: plainJsonOutput({ ...baseOutput({ nextFocus: "reduce" }), items: [{ findings: [{ severity: "P1", summary: "one" }] }, { findings: [{ severity: "P3", summary: "two" }] }] }) },
      { text: plainJsonOutput(gateOutput({ summary: "done" })) }
    ]);
    setAgentRuntimeFactoryForTests(fake.factory);
    const prepared = await prepareRun(agentDiscoverProgramReduceSpec(cwd), { cwd, input: { cwd } });

    const index = await runToTerminal(cwd, prepared.logicalRunId);
    const reduced = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "reduce.json"), "utf8")) as { items: Record<string, number> };

    expect(index.status).toBe("completed");
    expect(reduced.items).toEqual({ P0: 0, P1: 1, P2: 0, P3: 1 });
  });

  it("skips unselected downstream routes for agent decision gates", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-stage-agent-decision-"));
    const fake = fakeRuntimeFactory([
      { text: plainJsonOutput({ ...baseOutput({ nextFocus: "left" }), route: "left" }) },
      { text: plainJsonOutput(baseOutput({ summary: "left ran" })) },
      { text: plainJsonOutput(baseOutput({ summary: "left ran" })) },
      { text: plainJsonOutput(gateOutput({ summary: "done" })) }
    ]);
    setAgentRuntimeFactoryForTests(fake.factory);
    const prepared = await prepareRun(agentDecisionSpec(cwd), { cwd, input: { cwd } });

    const index = await runToTerminal(cwd, prepared.logicalRunId);

    expect(index.status).toBe("completed");
    expect(index.stages.left?.status).toBe("completed");
    expect(index.stages.right?.status).toBe("skipped");
    expect(fake.runtime.requests.map((request) => request.prompt)).not.toEqual(expect.arrayContaining([
      expect.stringContaining("Right")
    ]));
  });

  it("runs fixLoop validator and fixer attempts without overwriting attempt ids", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-stage-fixloop-"));
    const fake = fakeRuntimeFactory([
      { text: plainJsonOutput(validationOutput({ verdict: "fix", findings: [{ severity: "P1", summary: "fix it" }] })) },
      { text: plainJsonOutput(implementationOutput({ summary: "fixed" })) },
      { text: plainJsonOutput(validationOutput({ verdict: "pass", summary: "passed" })) },
      { text: plainJsonOutput(gateOutput({ summary: "done" })) }
    ]);
    setAgentRuntimeFactoryForTests(fake.factory);
    const prepared = await prepareRun(fixLoopSpec(cwd), { cwd, input: { cwd } });

    const index = await runToTerminal(cwd, prepared.logicalRunId);
    const attemptIds = Object.keys(index.attempts).sort();

    expect(index.status).toBe("completed");
    expect(attemptIds).toEqual([
      "quality_loop:attempt-1",
      "quality_loop:attempt-2",
      "quality_loop:attempt-3"
    ]);
    await expect(fs.stat(path.join(prepared.dir, "attempts", "quality_loop", "attempt-1", "raw.txt"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(prepared.dir, "attempts", "quality_loop", "attempt-2", "raw.txt"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(prepared.dir, "attempts", "quality_loop", "attempt-3", "raw.txt"))).resolves.toBeTruthy();
  });
});

async function runToTerminal(cwd: string, runId: string) {
  let index = await syncRun(cwd, runId);
  while (index.status === "pending" || index.status === "running") index = await syncRun(cwd, runId);
  return index;
}

function agentDiscoverProgramReduceSpec(cwd: string): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpx-workflow-orchestrator.workflow/v1",
    name: "agent-discover-program-reduce",
    root: "discover",
    inputs: { cwd: { type: "path", default: cwd } },
    roles: {
      discoverer: { category: "coordination", agent: "fake", mode: "readOnly" }
    },
    limits: { maxAgents: 2, maxConcurrency: 1, maxFanoutItems: 4, maxFixRounds: 0, stageTimeoutMinutes: 1 },
    stages: [
      { id: "discover", kind: "discover", method: "agent", role: "discoverer", output: "items", prompt: "Discover items" },
      { id: "reduce", kind: "reduce", mode: "program", from: "discover", operation: "severitySummary", dependsOn: ["discover"] },
      { id: "gate", kind: "gate", dependsOn: ["reduce"] }
    ]
  });
}

function agentDecisionSpec(cwd: string): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpx-workflow-orchestrator.workflow/v1",
    name: "agent-decision",
    root: "decide",
    inputs: { cwd: { type: "path", default: cwd } },
    roles: {
      decider: { category: "validation", agent: "fake", mode: "readOnly" },
      worker: { category: "coordination", agent: "fake", mode: "readOnly" }
    },
    limits: { maxAgents: 4, maxConcurrency: 1, maxFanoutItems: 1, maxFixRounds: 0, stageTimeoutMinutes: 1 },
    stages: [
      { id: "decide", kind: "decisionGate", mode: "agent", role: "decider", prompt: "Pick a route", rules: [{ when: { source: "input.cwd", op: "exists" }, to: "left" }], default: "right", routes: ["left", "right"] },
      { id: "left", kind: "agentTask", role: "worker", dependsOn: ["decide"], prompt: "Left" },
      { id: "right", kind: "agentTask", role: "worker", dependsOn: ["decide"], prompt: "Right" },
      { id: "gate", kind: "gate", dependsOn: ["left", "right"], condition: { any: [{ source: "outputs.left", op: "exists" }, { source: "outputs.right", op: "exists" }] } }
    ]
  });
}

function fixLoopSpec(cwd: string): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpx-workflow-orchestrator.workflow/v1",
    name: "fix-loop",
    root: "quality_loop",
    inputs: { cwd: { type: "path", default: cwd } },
    roles: {
      validator: { category: "validation", agent: "fake", mode: "readOnly" },
      implementer: { category: "implementation", agent: "fake", mode: "edit" }
    },
    limits: { maxAgents: 4, maxConcurrency: 1, maxFanoutItems: 1, maxFixRounds: 2, stageTimeoutMinutes: 1 },
    stages: [
      {
        id: "quality_loop",
        kind: "fixLoop",
        maxRounds: 2,
        validator: { role: "validator", prompt: "Validate" },
        fixer: { role: "implementer", prompt: "Fix" },
        routingPolicy: { fixOn: ["P0", "P1"], ignoreForRouting: ["P2", "P3"], unknown: "blocked" },
        onUnknown: "blocked",
        onExhausted: "blocked"
      },
      { id: "gate", kind: "gate", dependsOn: ["quality_loop"] }
    ]
  });
}
