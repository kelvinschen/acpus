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

  it("runs loop rounds without overwriting attempt ids", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-stage-loop-"));
    const fake = fakeRuntimeFactory([
      { text: plainJsonOutput(baseOutput({ summary: "again", data: { needsAnotherRound: true } })) },
      { text: plainJsonOutput(baseOutput({ summary: "passed", data: { needsAnotherRound: false } })) },
      { text: plainJsonOutput(gateOutput({ summary: "done" })) }
    ]);
    setAgentRuntimeFactoryForTests(fake.factory);
    const prepared = await prepareRun(loopSpec(cwd), { cwd, input: { cwd } });

    const index = await runToTerminal(cwd, prepared.logicalRunId);
    const attemptIds = Object.keys(index.attempts).sort();

    expect(index.status).toBe("completed");
    expect(attemptIds).toEqual([
      "quality_loop:round-1__stage-review:attempt-1",
      "quality_loop:round-2__stage-review:attempt-1"
    ]);
    await expect(fs.stat(path.join(prepared.dir, "outputs", "quality_loop", "round-1", "review.json"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(prepared.dir, "outputs", "quality_loop", "round-2", "review.json"))).resolves.toBeTruthy();
  });

  it("runs loop review convergence workflow through dual review and final summary", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-loop-review-convergence-"));
    const spec = WorkflowSpecSchema.parse(JSON.parse(await fs.readFile(path.resolve(__dirname, "..", "..", "..", "workflows", "examples", "loop-review-convergence.workflow.spec.json"), "utf8")));
    const fake = fakeRuntimeFactory([
      { match: (request) => request.sessionKey.includes("round:1") && request.sessionKey.includes(":lane:"), text: plainJsonOutput(validationOutput({ verdict: "fix", findings: [{ severity: "P1", summary: "review blocker" }], severityCounts: { P0: 0, P1: 1, P2: 0, P3: 0 } })) },
      { match: (request) => request.sessionKey.includes("round:1") && request.sessionKey.includes(":lane:"), text: plainJsonOutput(validationOutput({ verdict: "fix", findings: [{ severity: "P1", summary: "review blocker" }], severityCounts: { P0: 0, P1: 1, P2: 0, P3: 0 } })) },
      { match: (request) => request.sessionKey.includes("round:1:stage:converge_review"), text: plainJsonOutput(baseOutput({ summary: "review needs another round", data: { needsAnotherRound: true, consensus: "blocking review findings remain", blockingFindings: ["static blocker", "semantic blocker"] } })) },
      { match: (request) => request.sessionKey.includes("round:2") && request.sessionKey.includes(":lane:"), text: plainJsonOutput(validationOutput({ verdict: "pass", summary: "review lane passed" })) },
      { match: (request) => request.sessionKey.includes("round:2") && request.sessionKey.includes(":lane:"), text: plainJsonOutput(validationOutput({ verdict: "pass", summary: "review lane passed" })) },
      { match: (request) => request.sessionKey.includes("round:2:stage:converge_review"), text: plainJsonOutput(baseOutput({ summary: "review converged", data: { needsAnotherRound: false, consensus: "review conclusions converged", blockingFindings: [] } })) },
      { match: (request) => request.sessionKey === "role:final_summarizer", text: plainJsonOutput(baseOutput({ summary: "final review summary" })) },
      { text: plainJsonOutput(gateOutput({ summary: "done" })) }
    ]);
    setAgentRuntimeFactoryForTests(fake.factory);
    const prepared = await prepareRun(spec, { cwd, input: { cwd, reviewItems: [{ id: "workflow-loop", path: "src/runtime/stage-runner.ts" }] } });

    const index = await runToTerminal(cwd, prepared.logicalRunId);
    const loopOutput = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "review_loop.json"), "utf8")) as { round: number; rounds: unknown[]; bodyOutput?: { data?: { consensus?: string } } };

    expect(index.status).toBe("completed");
    expect(loopOutput.round).toBe(2);
    expect(loopOutput.rounds).toHaveLength(2);
    expect(loopOutput.bodyOutput?.data?.consensus).toBe("review conclusions converged");
    await expect(fs.stat(path.join(prepared.dir, "outputs", "review_loop", "round-1", "cross_review", "workflow-loop", "dual_review", "static.json"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(prepared.dir, "outputs", "review_loop", "round-2", "cross_review", "workflow-loop", "dual_review", "semantic.json"))).resolves.toBeTruthy();
    expect(fake.runtime.requests.map((request) => request.sessionKey)).toEqual(expect.arrayContaining([
      "role:static_reviewer:loop:review_loop:round:1:stage:cross_review:item:workflow-loop:group:dual_review:lane:static",
      "role:semantic_reviewer:loop:review_loop:round:1:stage:cross_review:item:workflow-loop:group:dual_review:lane:semantic",
      "role:static_reviewer:loop:review_loop:round:2:stage:cross_review:item:workflow-loop:group:dual_review:lane:static",
      "role:semantic_reviewer:loop:review_loop:round:2:stage:cross_review:item:workflow-loop:group:dual_review:lane:semantic"
    ]));
    expect(fake.runtime.requests.map((request) => request.roleName)).toContain("final_summarizer");
  });

  it("runs loop body fanout lane work units for multiple items and lanes", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-loop-body-fanout-"));
    const fake = fakeRuntimeFactory([
      { text: plainJsonOutput(baseOutput({ summary: "lane completed" })) },
      { text: plainJsonOutput(baseOutput({ summary: "lane completed" })) },
      { text: plainJsonOutput(baseOutput({ summary: "lane completed" })) },
      { text: plainJsonOutput(baseOutput({ summary: "lane completed" })) }
    ]);
    setAgentRuntimeFactoryForTests(fake.factory);
    const prepared = await prepareRun(loopBodyFanoutSpec(cwd), {
      cwd,
      input: { cwd, reviewItems: [{ id: "item-1" }, { id: "item-2" }] }
    });

    const index = await runToTerminal(cwd, prepared.logicalRunId);
    const output = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "review_loop", "round-1", "review_items.json"), "utf8")) as { laneOutputs: unknown[] };

    expect(index.status).toBe("completed");
    expect(output.laneOutputs).toHaveLength(4);
    expect(index.stages.review_loop?.loop?.rounds[0]?.stages.review_items.fanout).toMatchObject({
      totalItems: 2,
      completedItems: 2,
      workUnits: 4
    });
    expect(fake.runtime.requests.map((request) => request.sessionKey)).toHaveLength(4);
    expect(fake.runtime.requests.map((request) => request.sessionKey)).toEqual(expect.arrayContaining([
      "role:worker:loop:review_loop:round:1:stage:review_items:item:item-1:group:dual:lane:static",
      "role:worker:loop:review_loop:round:1:stage:review_items:item:item-1:group:dual:lane:semantic",
      "role:worker:loop:review_loop:round:1:stage:review_items:item:item-2:group:dual:lane:static",
      "role:worker:loop:review_loop:round:1:stage:review_items:item:item-2:group:dual:lane:semantic"
    ]));
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
    limits: { stageTimeoutMinutes: 1 },
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
    limits: { stageTimeoutMinutes: 1 },
    stages: [
      { id: "decide", kind: "decisionGate", mode: "agent", role: "decider", prompt: "Pick a route", rules: [{ when: { source: "input.cwd", op: "exists" }, to: "left" }], default: "right", routes: ["left", "right"] },
      { id: "left", kind: "agentTask", role: "worker", dependsOn: ["decide"], prompt: "Left" },
      { id: "right", kind: "agentTask", role: "worker", dependsOn: ["decide"], prompt: "Right" },
      { id: "gate", kind: "gate", dependsOn: ["left", "right"], condition: { any: [{ source: "outputs.left", op: "exists" }, { source: "outputs.right", op: "exists" }] } }
    ]
  });
}

function loopSpec(cwd: string): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpx-workflow-orchestrator.workflow/v1",
    name: "loop",
    root: "quality_loop",
    inputs: { cwd: { type: "path", default: cwd } },
    roles: {
      reviewer: { category: "coordination", agent: "fake", mode: "readOnly" }
    },
    limits: { stageTimeoutMinutes: 1 },
    stages: [
      {
        id: "quality_loop",
        kind: "loop",
        maxRounds: 2,
        body: {
          root: "review",
          output: "review",
          stages: [{ id: "review", kind: "agentTask", role: "reviewer", prompt: "Review" }]
        },
        continueWhen: { source: "loop.current.output.data.needsAnotherRound", op: "eq", value: true },
        onExhausted: "blocked"
      },
      { id: "gate", kind: "gate", dependsOn: ["quality_loop"] }
    ]
  });
}

function loopBodyFanoutSpec(cwd: string): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpx-workflow-orchestrator.workflow/v1",
    name: "loop-body-fanout",
    root: "review_loop",
    inputs: {
      cwd: { type: "path", default: cwd },
      reviewItems: { type: "array<json>" }
    },
    roles: {
      worker: { category: "coordination", agent: "fake", mode: "readOnly" }
    },
    limits: { stageTimeoutMinutes: 1 },
    stages: [
      {
        id: "review_loop",
        kind: "loop",
        maxRounds: 1,
        body: {
          root: "review_items",
          output: "review_items",
          stages: [{
            id: "review_items",
            kind: "fanout",
            items: { source: "input.reviewItems" },
            limits: { maxConcurrency: 2, maxFanoutItems: 2 },
            prompt: "Review item",
            laneGroups: [{
              id: "dual",
              mode: "all",
              lanes: [
                { id: "static", role: "worker" },
                { id: "semantic", role: "worker" }
              ]
            }],
            fanoutPolicy: { allowPartial: false }
          }]
        },
        continueWhen: { source: "loop.current.output.status", op: "eq", value: "again" },
        onExhausted: "blocked"
      },
      { id: "gate", kind: "gate", dependsOn: ["review_loop"] }
    ]
  });
}
