import { describe, expect, it } from "vitest";
import { DiagnosticBag } from "../src/diagnostics.js";
import { createExpressionCollector } from "../src/expressions.js";

describe("createExpressionCollector", () => {
  it("rejects expressions referencing unknown steps", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set(["known_step"]), new Map());
    collector.visit("${{ steps.ghost.output.x }}", "$.test");
    expect(diagnostics.diagnostics).toEqual([
      expect.objectContaining({ code: "EXPR_UNKNOWN_STEP", message: expect.stringContaining("ghost") })
    ]);
  });

  it("rejects invalid CEL expressions", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set(), new Map());
    collector.visit("${{ + }}", "$.test");
    expect(diagnostics.diagnostics).toEqual([
      expect.objectContaining({ code: "EXPR_PARSE" })
    ]);
  });

  it("accepts valid expressions referencing known steps", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set(["discover"]), new Map([["discover", "run.agent"]]));
    collector.visit("${{ steps.discover.output.files }}", "$.test");
    expect(diagnostics.diagnostics).toEqual([]);
    expect(collector.expressions).toHaveLength(1);
    expect(collector.expressions[0].references).toEqual(["discover"]);
  });

  it("warns on unknown root names in expressions", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set(), new Map());
    collector.visit("${{ unknown_var.x }}", "$.test");
    expect(diagnostics.diagnostics).toEqual([
      expect.objectContaining({ code: "EXPR_UNKNOWN_ROOT" })
    ]);
  });

  it("accepts allowed root names without warning", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set(), new Map());
    collector.visit("${{ input.x }}", "$.test");
    collector.visit("${{ item.y }}", "$.test2");
    collector.visit("${{ loop.z }}", "$.test3");
    expect(diagnostics.diagnostics).toEqual([]);
  });

  it("rejects empty expressions", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set(), new Map());
    collector.visit("${{   }}", "$.test");
    expect(diagnostics.diagnostics).toEqual([
      expect.objectContaining({ code: "EXPR_EMPTY" })
    ]);
  });

  it("collects multiple expressions from a nested object", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set(["step_a", "step_b"]), new Map([["step_a", "run.agent"], ["step_b", "run.program"]]));
    collector.visit({ key1: "${{ steps.step_a.output.x }}", nested: { key2: "${{ steps.step_b.output.y }}" } }, "$.test");
    expect(collector.expressions).toHaveLength(2);
    expect(collector.expressions[0].references).toEqual(["step_a"]);
    expect(collector.expressions[1].references).toEqual(["step_b"]);
  });

  it("warns when ${{ }} appears in raw-CEL fields (over, until, when)", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set(["discover", "gate"]), new Map([["discover", "run.agent"], ["gate", "approval"]]));

    collector.visit("${{ steps.discover.output.files }}", "$.workflow.steps[0].fanout.over");
    collector.visit("${{ loop.iter >= 2 }}", "$.workflow.steps[1].loop.until");
    collector.visit("${{ steps.gate.approved }}", "$.workflow.steps[2].switch.cases[0].when");

    expect(diagnostics.diagnostics).toEqual([
      expect.objectContaining({ code: "EXPR_TEMPLATE_IN_CEL", path: expect.stringContaining("over") }),
      expect.objectContaining({ code: "EXPR_TEMPLATE_IN_CEL", path: expect.stringContaining("until") }),
      expect.objectContaining({ code: "EXPR_TEMPLATE_IN_CEL", path: expect.stringContaining("when") })
    ]);
  });

  it("does not warn when raw-CEL fields lack ${{ }}", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set(), new Map());

    collector.visit("steps.discover.output.files", "$.workflow.steps[0].fanout.over");
    collector.visit("loop.iter >= 2", "$.workflow.steps[1].loop.until");
    collector.visit("steps.gate.approved", "$.workflow.steps[2].switch.cases[0].when");

    expect(diagnostics.diagnostics).toEqual([]);
  });

  it("does not warn when key uses ${{ }} template syntax", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set(), new Map());

    collector.visit("${{ item.path }}", "$.workflow.steps[0].fanout.key");

    // key is now a template field — ${{ }} is valid syntax, no warning expected
    const warnings = diagnostics.diagnostics.filter((d) => d.code === "EXPR_TEMPLATE_IN_PROPERTY");
    expect(warnings).toEqual([]);
  });

  it("errors when .output is accessed on a composite step (fanout)", () => {
    const diagnostics = new DiagnosticBag();
    const kinds = new Map([["research", "fanout"]]);
    const collector = createExpressionCollector(diagnostics, new Set(["research"]), kinds);
    collector.visit("${{ steps.research.output.architecture.filepath }}", "$.test");
    expect(diagnostics.diagnostics).toEqual([
      expect.objectContaining({ code: "EXPR_COMPOSITE_OUTPUT", message: expect.stringContaining("fanout") })
    ]);
  });

  it("errors when .output is accessed on a composite step (parallel)", () => {
    const diagnostics = new DiagnosticBag();
    const kinds = new Map([["analyze", "parallel"]]);
    const collector = createExpressionCollector(diagnostics, new Set(["analyze"]), kinds);
    collector.visit("${{ steps.analyze.output }}", "$.test");
    expect(diagnostics.diagnostics).toEqual([
      expect.objectContaining({ code: "EXPR_COMPOSITE_OUTPUT", message: expect.stringContaining("parallel") })
    ]);
  });

  it("errors when .output is accessed on a composite step (loop/switch)", () => {
    const diagnostics = new DiagnosticBag();
    const kinds = new Map([["refine", "loop"], ["route", "switch"]]);
    const collector = createExpressionCollector(diagnostics, new Set(["refine", "route"]), kinds);
    collector.visit("${{ steps.refine.output.result }}", "$.test1");
    collector.visit("${{ steps.route.output.chosen }}", "$.test2");
    const errs = diagnostics.diagnostics.filter((d) => d.code === "EXPR_COMPOSITE_OUTPUT");
    expect(errs).toHaveLength(2);
    expect(errs[0].message).toContain("loop");
    expect(errs[1].message).toContain("switch");
  });

  it("allows .output on leaf steps (run.agent, run.program)", () => {
    const diagnostics = new DiagnosticBag();
    const kinds = new Map([["discover", "run.agent"], ["build", "run.program"]]);
    const collector = createExpressionCollector(diagnostics, new Set(["discover", "build"]), kinds);
    collector.visit("${{ steps.discover.output.files }}", "$.test1");
    collector.visit("${{ steps.build.output.artifact }}", "$.test2");
    expect(diagnostics.diagnostics).toEqual([]);
  });

  it("does not error when composite step is accessed without .output", () => {
    const diagnostics = new DiagnosticBag();
    const kinds = new Map([["research", "fanout"]]);
    const collector = createExpressionCollector(diagnostics, new Set(["research"]), kinds);
    collector.visit("${{ steps.research }}", "$.test");
    expect(diagnostics.diagnostics).toEqual([]);
  });

  it("errors when .output is accessed on a subworkflow step", () => {
    const diagnostics = new DiagnosticBag();
    const kinds = new Map([["sub", "subworkflow"]]);
    const collector = createExpressionCollector(diagnostics, new Set(["sub"]), kinds);
    collector.visit("${{ steps.sub.output.result }}", "$.test");
    expect(diagnostics.diagnostics).toEqual([
      expect.objectContaining({ code: "EXPR_COMPOSITE_OUTPUT", message: expect.stringContaining("subworkflow") })
    ]);
  });

  it("does not error when fanout uses bracket-index path", () => {
    const diagnostics = new DiagnosticBag();
    const kinds = new Map([["research", "fanout"]]);
    const collector = createExpressionCollector(diagnostics, new Set(["research"]), kinds);
    collector.visit("${{ steps.research[0].output.filepath }}", "$.test");
    expect(diagnostics.diagnostics).toEqual([]);
  });

  it("does not error when step kind is unknown (not in stepKinds)", () => {
    const diagnostics = new DiagnosticBag();
    const kinds = new Map(); // no kind for "mystery"
    const collector = createExpressionCollector(diagnostics, new Set(["mystery"]), kinds);
    collector.visit("${{ steps.mystery.output.x }}", "$.test");
    const compositeErrors = diagnostics.diagnostics.filter((d) => d.code === "EXPR_COMPOSITE_OUTPUT");
    expect(compositeErrors).toEqual([]);
  });
});
