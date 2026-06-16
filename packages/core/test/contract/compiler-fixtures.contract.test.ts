import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileWorkflow } from "../../src/index.js";

const fixtures = join(import.meta.dirname, "..", "fixtures");

function fixture(name: string): string {
  return readFileSync(join(fixtures, name), "utf8");
}

describe("@acpus/core compiler: canonical fixtures", () => {
  it("compiles Case A: plan-review-impl (sequential + signal + agents)", () => {
    const result = compileWorkflow(fixture("case-a-plan-review-impl.yaml"), {
      sourcePath: join(fixtures, "case-a-plan-review-impl.yaml")
    });

    expect(result.ok).toBe(true);
    expect(result.ir?.name).toBe("plan-review-impl");
    expect(result.ir?.root.children?.map((n) => n.kind)).toEqual([
      "run.agent",
      "run.signal",
      "run.agent",
      "run.program"
    ]);
    expect(result.schedule?.nodes).toHaveLength(4);
  });

  it("compiles Case B: multi-agent-review (fanout + quorum + switch)", () => {
    const result = compileWorkflow(fixture("case-b-multi-agent-review.yaml"), {
      sourcePath: join(fixtures, "case-b-multi-agent-review.yaml")
    });

    expect(result.ok).toBe(true);
    expect(result.ir?.name).toBe("multi-agent-review");
    expect(result.ir?.root.children?.map((n) => n.kind)).toEqual([
      "run.program",
      "fanout",
      "run.program",
      "run.signal",
      "switch"
    ]);
    expect(result.schedule?.nodes).toHaveLength(5);
    const fanoutNode = result.ir?.root.children?.[1];
    expect(fanoutNode?.kind).toBe("fanout");
    expect(fanoutNode?.children?.length).toBe(1);
    const innerParallel = fanoutNode?.children?.[0];
    expect(innerParallel?.kind).toBe("parallel");
    expect(innerParallel?.children?.length).toBe(3);
  });

  it("compiles Case C: refactor-and-fix (fanout + subworkflow + loop + switch)", () => {
    const result = compileWorkflow(fixture("case-c-refactor-and-fix.yaml"), {
      sourcePath: join(fixtures, "case-c-refactor-and-fix.yaml")
    });

    expect(result.ok).toBe(true);
    expect(result.ir?.name).toBe("refactor-and-fix");
    expect(result.ir?.root.children?.map((n) => n.kind)).toEqual([
      "run.program",
      "guard",
      "fanout",
      "loop",
      "run.signal"
    ]);
    expect(result.schedule?.nodes).toHaveLength(5);
    const loopNode = result.ir?.root.children?.[3];
    expect(loopNode?.kind).toBe("loop");
    expect(loopNode?.children?.length).toBe(3);
  });

  it("compiles Case D: deep-research (agent + dynamic fanout + loop)", () => {
    const result = compileWorkflow(fixture("case-d-deep-research.yaml"), {
      sourcePath: join(fixtures, "case-d-deep-research.yaml")
    });

    expect(result.ok).toBe(true);
    expect(result.ir?.name).toBe("deep-research");
    expect(result.ir?.root.children?.map((n) => n.kind)).toEqual([
      "run.agent",
      "fanout",
      "loop",
      "run.signal",
      "run.agent"
    ]);
    expect(result.schedule?.nodes).toHaveLength(5);
  });

  it("compiles a workflow with all M1 primitives", () => {
    const result = compileWorkflow(fixture("all-primitives.yaml"), {
      sourcePath: join(fixtures, "all-primitives.yaml")
    });

    expect(result.ok).toBe(true);
    expect(result.ir?.name).toBe("all-primitives");
    expect(result.ir?.root.children?.map((node) => node.kind)).toEqual([
      "run.program",
      "run.agent",
      "parallel",
      "fanout",
      "guard",
      "switch",
      "loop",
      "run.signal",
      "subworkflow"
    ]);
    expect(result.schedule?.nodes).toHaveLength(9);
    expect(result.ir?.expressions.some((expression) => expression.source.includes("steps.discover.output.files"))).toBe(true);

    const parallelNode = result.ir?.root.children?.[2];
    expect(parallelNode?.kind).toBe("parallel");
    expect(parallelNode?.outputMerge).toBe("map");

    const fanoutNode = result.ir?.root.children?.[3];
    expect(fanoutNode?.kind).toBe("fanout");
    expect(fanoutNode?.outputMerge).toBe("array");

    const switchNode = result.ir?.root.children?.[5];
    expect(switchNode?.kind).toBe("switch");
    expect(switchNode?.outputMerge).toBe("selected");

    const loopNode = result.ir?.root.children?.[6];
    expect(loopNode?.kind).toBe("loop");
    expect(loopNode?.outputMerge).toBe("last");
  });

  it("compiles fanout-nested-parallel fixture", () => {
    const result = compileWorkflow(fixture("fanout-nested-parallel.yaml"), {
      sourcePath: join(fixtures, "fanout-nested-parallel.yaml")
    });

    expect(result.ok).toBe(true);
    expect(result.ir?.name).toBe("fanout-nested-parallel");
    const fanoutNode = result.ir?.root.children?.[1];
    expect(fanoutNode?.kind).toBe("fanout");
    expect(fanoutNode?.outputMerge).toBe("array");
    const innerParallel = fanoutNode?.children?.[0];
    expect(innerParallel?.kind).toBe("parallel");
    expect(innerParallel?.outputMerge).toBe("map");
    expect(innerParallel?.children?.length).toBe(2);
    const reviewBranch = innerParallel?.children?.[0];
    expect(reviewBranch?.id).toBe("review");
    expect(reviewBranch?.kind).toBe("run.agent");
    expect(reviewBranch?.metadata.output).toEqual({
      type: "object",
      properties: {
        verdict: { type: "string" },
        issues: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
            },
            additionalProperties: false,
            required: ["description"],
          },
        },
      },
      additionalProperties: false,
      required: ["verdict", "issues"]
    });
    const testBranch = innerParallel?.children?.[1];
    expect(testBranch?.id).toBe("test");
    expect(testBranch?.kind).toBe("run.program");
  });

  it("compiles fanout-parallel-loop-switch fixture", () => {
    const result = compileWorkflow(fixture("fanout-parallel-loop-switch/workflow.yaml"), {
      sourcePath: join(fixtures, "fanout-parallel-loop-switch/workflow.yaml")
    });

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.ir?.name).toBe("fanout-parallel-loop-switch");
    expect(result.ir?.input).toMatchObject({
      type: "object",
      properties: {
        lanes: { type: "array", default: ["alpha", "beta", "gamma"] },
        max_rounds: { type: "integer", default: 3 },
        route_mode: { type: "string", default: "default" }
      }
    });

    const fanoutNode = result.ir?.root.children?.[0];
    expect(fanoutNode?.kind).toBe("fanout");
    expect(fanoutNode?.metadata).toMatchObject({ over: "input.lanes", join: "all", max_concurrency: 1 });

    const parallelNode = fanoutNode?.children?.[0];
    expect(parallelNode?.kind).toBe("parallel");
    expect(parallelNode?.children?.map((n) => [n.id, n.kind])).toEqual([
      ["review_lane", "run.agent"],
      ["loop_lane", "loop"],
      ["switch_lane", "switch"]
    ]);

    const loopNode = parallelNode?.children?.[1];
    expect(loopNode?.outputMerge).toBe("last");
    expect(loopNode?.metadata.until).toBe("loop.iter >= input.max_rounds");

    const switchNode = parallelNode?.children?.[2];
    expect(switchNode?.outputMerge).toBe("selected");
    expect(switchNode?.branches?.map((b) => b.id)).toEqual(["case_1", "case_2", "default"]);
  });

  it("compiles composite-e2e fixture (fanout→loop, lightweight)", () => {
    const result = compileWorkflow(fixture("composite-e2e/workflow.yaml"), {
      sourcePath: join(fixtures, "composite-e2e/workflow.yaml")
    });

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.ir?.name).toBe("composite-e2e");
    expect(result.ir?.input).toMatchObject({
      type: "object",
      properties: {
        items: { type: "array", default: ["alpha", "beta", "skip"] },
        max_rounds: { type: "integer", default: 2 }
      }
    });

    const fanoutNode = result.ir?.root.children?.[0];
    expect(fanoutNode?.kind).toBe("fanout");
    expect(fanoutNode?.outputMerge).toBe("array");
    expect(fanoutNode?.metadata).toMatchObject({ over: "input.items", max_concurrency: 1 });

    const guardNode = fanoutNode?.children?.[0];
    expect(guardNode?.kind).toBe("guard");
    expect(guardNode?.metadata).toMatchObject({ when: 'item == "skip"', then: "complete", else: "continue" });

    const loopNode = fanoutNode?.children?.[1];
    expect(loopNode?.kind).toBe("loop");
    expect(loopNode?.outputMerge).toBe("last");
    expect(loopNode?.metadata.until).toBe("loop.iter >= input.max_rounds");

    const workNode = loopNode?.children?.[0];
    expect(workNode?.kind).toBe("run.agent");
    expect(workNode?.id).toBe("work");
    expect(workNode?.metadata.output).toEqual({
      type: "object",
      properties: {
        item: { type: "string" },
        round: { type: "integer" },
        ok: { type: "boolean" }
      },
      additionalProperties: false,
      required: ["item", "round", "ok"]
    });
  });

  it("IR survives JSON round-trip serialization", () => {
    const result = compileWorkflow(fixture("all-primitives.yaml"), {
      sourcePath: join(fixtures, "all-primitives.yaml")
    });
    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(result.ir);
    const deserialized = JSON.parse(serialized) as typeof result.ir;
    expect(deserialized).toEqual(result.ir);
  });
});
