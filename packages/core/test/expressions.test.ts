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
});
