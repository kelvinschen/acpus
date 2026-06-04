import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRunMonitorView } from "../../../src/projections/run-monitor.js";
import { setAgentRuntimeFactoryForTests } from "../../../src/runtime/agent-runtime.js";
import { prepareRun } from "../../../src/runtime/run-workflow.js";
import { syncRun } from "../../../src/runtime/sync.js";
import { WorkflowSpecSchema, type Actor, type WorkflowSpec } from "../../../src/schema/workflow-spec.js";
import { baseOutput, fakeRuntimeFactory, gateOutput, plainJsonOutput } from "../../helpers/fake-runtime.js";

describe("stage kind fake runtime e2e", () => {
  afterEach(() => setAgentRuntimeFactoryForTests(undefined));

  it("runs fanout lanes into program mergeArrays fanin", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-stage-program-fanin-"));
    const fake = fakeRuntimeFactory([
      { match: (request) => request.sessionKey.includes("item:one:"), text: plainJsonOutput(baseOutput({ data: [{ severity: "P1", summary: "one" }] })) },
      { match: (request) => request.sessionKey.includes("item:two:"), text: plainJsonOutput(baseOutput({ data: [{ severity: "P3", summary: "two" }] })) },
      { text: plainJsonOutput(gateOutput({ summary: "done" })) }
    ]);
    setAgentRuntimeFactoryForTests(fake.factory);
    const spec = programFaninSpec(cwd);
    const prepared = await prepareRun(spec, { cwd, input: { cwd, reviewItems: [{ id: "one" }, { id: "two" }] } });

    const index = await runToTerminal(cwd, prepared.logicalRunId);
    const merged = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "collect.json"), "utf8")) as { data: Array<{ severity: string }> };
    const gate = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "gate.json"), "utf8")) as { data?: unknown; verdict?: string };
    const monitor = await buildRunMonitorView(cwd, spec, index);

    expect(index.status).toBe("completed");
    expect(merged.data.map((item) => item.severity)).toEqual(["P1", "P3"]);
    expect(gate).toMatchObject({ status: "completed", verdict: "pass", data: merged });
    expect(monitor.finalOutput).toMatchObject({ status: "completed", verdict: "pass", data: merged });
  });

  it("skips unselected downstream routes for agent routes", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-stage-agent-route-"));
    const fake = fakeRuntimeFactory([
      { text: plainJsonOutput({ ...baseOutput(), route: "left" }) },
      { text: plainJsonOutput(baseOutput({ summary: "left ran" })) },
      { text: plainJsonOutput(baseOutput({ summary: "left ran" })) },
      { text: plainJsonOutput(gateOutput({ summary: "done" })) }
    ]);
    setAgentRuntimeFactoryForTests(fake.factory);
    const prepared = await prepareRun(agentRouteSpec(cwd), { cwd, input: { cwd } });

    const index = await runToTerminal(cwd, prepared.logicalRunId);

    expect(index.status).toBe("completed");
    expect(index.stages.left?.status).toBe("completed");
    expect(index.stages.right?.status).toBe("skipped");
    expect(fake.runtime.requests.map((request) => request.prompt)).not.toEqual(expect.arrayContaining([
      expect.stringContaining("Right")
    ]));
  });

  it("wraps the effective upstream output for route-style program gates", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-stage-program-gate-route-"));
    const fake = fakeRuntimeFactory([
      { text: plainJsonOutput({ ...baseOutput(), route: "left" }) },
      { text: plainJsonOutput(baseOutput({ summary: "left ran", data: [{ branch: "left" }] })) }
    ]);
    setAgentRuntimeFactoryForTests(fake.factory);
    const spec = agentRouteSpec(cwd);
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });

    const index = await runToTerminal(cwd, prepared.logicalRunId);
    const gate = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "gate.json"), "utf8")) as { data?: unknown; verdict?: string };

    expect(index.status).toBe("completed");
    expect(gate).toMatchObject({
      status: "completed",
      verdict: "pass",
      data: { summary: "left ran", data: [{ branch: "left" }] }
    });
  });

  it("wraps multiple effective upstream outputs by stage id", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-stage-program-gate-multi-"));
    const fake = fakeRuntimeFactory([
      { text: plainJsonOutput(baseOutput({ summary: "one" })) },
      { text: plainJsonOutput(baseOutput({ summary: "two" })) }
    ]);
    setAgentRuntimeFactoryForTests(fake.factory);
    const spec = multiOutputGateSpec(cwd);
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });

    const index = await runToTerminal(cwd, prepared.logicalRunId);
    const gate = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "gate.json"), "utf8")) as { data?: unknown; verdict?: string };

    expect(index.status).toBe("completed");
    expect(gate).toMatchObject({
      status: "completed",
      verdict: "pass",
      data: {
        one: { summary: "one" },
        two: { summary: "two" }
      }
    });
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
    const spec = loopReviewConvergenceSpec(cwd);
    const fake = fakeRuntimeFactory([
      { match: (request) => request.sessionKey.includes("round:1") && request.sessionKey.includes(":lane:"), text: plainJsonOutput(baseOutput({ data: [{ severity: "P1", summary: "review blocker" }] })) },
      { match: (request) => request.sessionKey.includes("round:1") && request.sessionKey.includes(":lane:"), text: plainJsonOutput(baseOutput({ data: [{ severity: "P1", summary: "review blocker" }] })) },
      { match: (request) => request.sessionKey.includes("round:1:stage:converge_review"), text: plainJsonOutput(baseOutput({ summary: "review needs another round", data: { needsAnotherRound: true, consensus: "blocking review findings remain", blockingFindings: ["static blocker", "semantic blocker"] } })) },
      { match: (request) => request.sessionKey.includes("round:2") && request.sessionKey.includes(":lane:"), text: plainJsonOutput(baseOutput({ summary: "review lane passed", data: [] })) },
      { match: (request) => request.sessionKey.includes("round:2") && request.sessionKey.includes(":lane:"), text: plainJsonOutput(baseOutput({ summary: "review lane passed", data: [] })) },
      { match: (request) => request.sessionKey.includes("round:2:stage:converge_review"), text: plainJsonOutput(baseOutput({ summary: "review converged", data: { needsAnotherRound: false, consensus: "review conclusions converged", blockingFindings: [] } })) },
      { match: (request) => request.sessionKey === "agent:final_summarizer", text: plainJsonOutput(baseOutput({ summary: "final review summary" })) },
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
    await expect(fs.stat(path.join(prepared.dir, "outputs", "review_loop", "round-1", "cross_review", "workflow-loop", "static.json"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(prepared.dir, "outputs", "review_loop", "round-2", "cross_review", "workflow-loop", "semantic.json"))).resolves.toBeTruthy();
    expect(fake.runtime.requests.map((request) => request.sessionKey)).toEqual(expect.arrayContaining([
      "loop:review_loop:round:1:stage:cross_review:item:workflow-loop:lane:static:agent:static_reviewer",
      "loop:review_loop:round:1:stage:cross_review:item:workflow-loop:lane:semantic:agent:semantic_reviewer",
      "loop:review_loop:round:2:stage:cross_review:item:workflow-loop:lane:static:agent:static_reviewer",
      "loop:review_loop:round:2:stage:cross_review:item:workflow-loop:lane:semantic:agent:semantic_reviewer"
    ]));
    expect(fake.runtime.requests.map((request) => request.actorLabel)).toContain("final_summarizer");
  });

  it("runs loop body fanout lane work units for multiple items and lanes", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-loop-body-fanout-"));
    const fake = fakeRuntimeFactory([
      { text: plainJsonOutput(baseOutput({ summary: "lane completed", data: [] })) },
      { text: plainJsonOutput(baseOutput({ summary: "lane completed", data: [] })) },
      { text: plainJsonOutput(baseOutput({ summary: "lane completed", data: [] })) },
      { text: plainJsonOutput(baseOutput({ summary: "lane completed", data: [] })) }
    ]);
    setAgentRuntimeFactoryForTests(fake.factory);
    const prepared = await prepareRun(loopBodyFanoutSpec(cwd), {
      cwd,
      input: { cwd, reviewItems: [{ id: "item-1" }, { id: "item-2" }] }
    });

    const index = await runToTerminal(cwd, prepared.logicalRunId);
    const output = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "review_loop", "round-1", "review_items.json"), "utf8")) as { data: unknown[] };

    expect(index.status).toBe("completed");
    expect(output.data).toHaveLength(0);
    expect(index.stages.review_loop?.loop?.rounds[0]?.stages.review_items.fanout).toMatchObject({
      totalItems: 2,
      completedItems: 2,
      workUnits: 4
    });
    expect(fake.runtime.requests.map((request) => request.sessionKey)).toHaveLength(4);
    expect(fake.runtime.requests.map((request) => request.sessionKey)).toEqual(expect.arrayContaining([
      "loop:review_loop:round:1:stage:review_items:item:item-1:lane:static:agent:worker",
      "loop:review_loop:round:1:stage:review_items:item:item-1:lane:semantic:agent:worker",
      "loop:review_loop:round:1:stage:review_items:item:item-2:lane:static:agent:worker",
      "loop:review_loop:round:1:stage:review_items:item:item-2:lane:semantic:agent:worker"
    ]));
  });
});

async function runToTerminal(cwd: string, runId: string) {
  let index = await syncRun(cwd, runId);
  while (index.status === "pending" || index.status === "running") index = await syncRun(cwd, runId);
  return index;
}

function actor(label: string): Actor {
  return { agent: "fake", mode: "readOnly", label };
}

function programFaninSpec(cwd: string): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "program-fanin",
    root: "collect",
    input: { schema: "{cwd:string,reviewItems:[{id:string,path?:string}]}", default: { cwd } },
    limits: { stageTimeoutMinutes: 1 },
    stages: [
      {
        id: "collect",
        kind: "fanout",
        items: { source: "input.reviewItems" },
        limits: { maxConcurrency: 2, maxFanoutItems: 2 },
        prompt: "Collect item data",
        lanes: [{ id: "worker", actor: actor("worker") }],
        fanin: { mode: "program", operation: "mergeArrays" },
        fanoutPolicy: { allowPartial: false }
      },
      { id: "gate", kind: "gate", mode: "program", dependsOn: ["collect"] }
    ]
  });
}

function agentRouteSpec(cwd: string): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "agent-route",
    root: "decide",
    input: { schema: "{cwd:string}", default: { cwd } },
    limits: { stageTimeoutMinutes: 1 },
    stages: [
      { id: "decide", kind: "route", mode: "agent", actor: actor("decider"), prompt: "Pick a route", rules: [{ when: { source: "input.cwd", op: "exists" }, to: "left" }], routes: ["left", "right"] },
      { id: "left", kind: "task", mode: "agent", actor: actor("worker"), dependsOn: ["decide"], prompt: "Left" },
      { id: "right", kind: "task", mode: "agent", actor: actor("worker"), dependsOn: ["decide"], prompt: "Right" },
      { id: "gate", kind: "gate", dependsOn: ["left", "right"], condition: { any: [{ source: "outputs.left", op: "exists" }, { source: "outputs.right", op: "exists" }] } }
    ]
  });
}

function multiOutputGateSpec(cwd: string): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "multi-output-gate",
    root: "one",
    input: { schema: "{cwd:string}", default: { cwd } },
    limits: { stageTimeoutMinutes: 1 },
    stages: [
      { id: "one", kind: "task", mode: "agent", actor: actor("one"), prompt: "One" },
      { id: "two", kind: "task", mode: "agent", actor: actor("two"), dependsOn: ["one"], prompt: "Two" },
      { id: "gate", kind: "gate", dependsOn: ["one", "two"] }
    ]
  });
}

function loopSpec(cwd: string): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "loop",
    root: "quality_loop",
    input: { schema: "{cwd:string}", default: { cwd } },
    limits: { stageTimeoutMinutes: 1 },
    stages: [
      {
        id: "quality_loop",
        kind: "loop",
        maxRounds: 2,
        body: {
          root: "review",
          output: "review",
          stages: [{ id: "review", kind: "task", mode: "agent", actor: actor("reviewer"), prompt: "Review" }]
        },
        continueWhen: { source: "loop.current.output.data.needsAnotherRound", op: "eq", value: true },
        onExhausted: "blocked"
      },
      { id: "gate", kind: "gate", mode: "program", dependsOn: ["quality_loop"] }
    ]
  });
}

function loopReviewConvergenceSpec(cwd: string): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "loop-review-convergence",
    root: "review_loop",
    input: { schema: "{cwd:string,reviewItems:[{id:string,path?:string}]}", default: { cwd } },
    limits: { stageTimeoutMinutes: 1 },
    stages: [
      {
        id: "review_loop",
        kind: "loop",
        maxRounds: 2,
        body: {
          root: "cross_review",
          output: "converge_review",
          stages: [
            {
              id: "cross_review",
              kind: "fanout",
              items: { source: "input.reviewItems" },
              limits: { maxConcurrency: 2, maxFanoutItems: 4 },
              prompt: "Review item",
              lanes: [
                { id: "static", actor: actor("static_reviewer") },
                { id: "semantic", actor: actor("semantic_reviewer") }
              ],
              fanin: { mode: "program", operation: "mergeArrays" },
              fanoutPolicy: { allowPartial: false }
            },
            {
              id: "converge_review",
              kind: "task",
              mode: "agent",
              actor: actor("review_converger"),
              dependsOn: ["cross_review"],
              prompt: "Converge review results"
            }
          ]
        },
        continueWhen: { source: "loop.current.output.data.needsAnotherRound", op: "eq", value: true },
        onExhausted: "blocked"
      },
      {
        id: "final_summary",
        kind: "task",
        mode: "agent",
        actor: actor("final_summarizer"),
        dependsOn: ["review_loop"],
        prompt: "Summarize final review"
      },
      { id: "gate", kind: "gate", mode: "program", dependsOn: ["final_summary"] }
    ]
  });
}

function loopBodyFanoutSpec(cwd: string): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "loop-body-fanout",
    root: "review_loop",
    input: { schema: "{cwd:string,reviewItems:[{id:string,path?:string}]}", default: { cwd } },
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
            lanes: [
              { id: "static", actor: actor("worker") },
              { id: "semantic", actor: actor("worker") }
            ],
            fanin: { mode: "program", operation: "mergeArrays" },
            fanoutPolicy: { allowPartial: false }
          }]
        },
        continueWhen: { source: "loop.round", op: "eq", value: 0 },
        onExhausted: "blocked"
      },
      { id: "gate", kind: "gate", mode: "program", dependsOn: ["review_loop"] }
    ]
  });
}
