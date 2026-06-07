import { describe, expect, it } from "vitest";
import { DiagnosticBag } from "../src/diagnostics.js";
import { createExpressionCollector } from "../src/expressions.js";

describe("createExpressionCollector", () => {
  it("rejects expressions referencing unknown steps", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set(["known_step"]));
    collector.visit("${{ steps.ghost.output.x }}", "$.test");
    expect(diagnostics.diagnostics).toEqual([
      expect.objectContaining({ code: "EXPR_UNKNOWN_STEP", message: expect.stringContaining("ghost") })
    ]);
  });

  it("rejects invalid CEL expressions", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set());
    collector.visit("${{ + }}", "$.test");
    expect(diagnostics.diagnostics).toEqual([
      expect.objectContaining({ code: "EXPR_PARSE" })
    ]);
  });

  it("accepts valid expressions referencing known steps", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set(["discover"]));
    collector.visit("${{ steps.discover.output.files }}", "$.test");
    expect(diagnostics.diagnostics).toEqual([]);
    expect(collector.expressions).toHaveLength(1);
    expect(collector.expressions[0].references).toEqual(["discover"]);
  });

  it("warns on unknown root names in expressions", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set());
    collector.visit("${{ unknown_var.x }}", "$.test");
    expect(diagnostics.diagnostics).toEqual([
      expect.objectContaining({ code: "EXPR_UNKNOWN_ROOT" })
    ]);
  });

  it("accepts allowed root names without warning", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set());
    collector.visit("${{ input.x }}", "$.test");
    collector.visit("${{ item.y }}", "$.test2");
    collector.visit("${{ loop.z }}", "$.test3");
    expect(diagnostics.diagnostics).toEqual([]);
  });

  it("rejects empty expressions", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set());
    collector.visit("${{   }}", "$.test");
    expect(diagnostics.diagnostics).toEqual([
      expect.objectContaining({ code: "EXPR_EMPTY" })
    ]);
  });

  it("collects multiple expressions from a nested object", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set(["step_a", "step_b"]));
    collector.visit({ key1: "${{ steps.step_a.output.x }}", nested: { key2: "${{ steps.step_b.output.y }}" } }, "$.test");
    expect(collector.expressions).toHaveLength(2);
    expect(collector.expressions[0].references).toEqual(["step_a"]);
    expect(collector.expressions[1].references).toEqual(["step_b"]);
  });

  it("warns when ${{ }} appears in raw-CEL fields (over, until, when)", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set(["discover", "gate"]));

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
    const collector = createExpressionCollector(diagnostics, new Set());

    collector.visit("steps.discover.output.files", "$.workflow.steps[0].fanout.over");
    collector.visit("loop.iter >= 2", "$.workflow.steps[1].loop.until");
    collector.visit("steps.gate.approved", "$.workflow.steps[2].switch.cases[0].when");

    expect(diagnostics.diagnostics).toEqual([]);
  });

  it("does not warn when key uses ${{ }} template syntax", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set());

    collector.visit("${{ item.path }}", "$.workflow.steps[0].fanout.key");

    // key is now a template field — ${{ }} is valid syntax, no warning expected
    const warnings = diagnostics.diagnostics.filter((d) => d.code === "EXPR_TEMPLATE_IN_PROPERTY");
    expect(warnings).toEqual([]);
  });
});
