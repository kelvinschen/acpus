import { describe, expect, it } from "vitest";
import { DiagnosticBag } from "../../src/diagnostics.js";
import { createExpressionCollector } from "../../src/expressions.js";

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

  it("errors on unknown root names in expressions", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set());
    collector.visit("${{ unknown_var.x }}", "$.test");
    expect(diagnostics.diagnostics).toEqual([
      expect.objectContaining({ code: "EXPR_UNKNOWN_ROOT", severity: "error" })
    ]);
  });

  it("accepts registered context roots", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set());
    collector.visit("${{ input.x }}", "$.test");
    collector.visit("${{ workflow.source_dir }}", "$.test-workflow");
    collector.visit("${{ item.y }}", "$.test2");
    collector.visit("${{ loop.z }}", "$.test3");
    expect(diagnostics.diagnostics).toEqual([]);
  });

  it("accepts Acpus custom functions", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set(["s"]));
    collector.visit("${{ json(steps.s.output) }}", "$.test");
    expect(diagnostics.diagnostics).toEqual([]);
  });

  it("accepts cel-js built-in standalone functions", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set());
    collector.visit("${{ size(input.items) }}", "$.test1");
    collector.visit("${{ string(input.count) }}", "$.test2");
    collector.visit("${{ int(input.count) }}", "$.test3");
    collector.visit("${{ bool(input.flag) }}", "$.test4");
    expect(diagnostics.diagnostics).toEqual([]);
  });

  it("errors on unregistered functions", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set(["s"]));
    collector.visit("${{ hash(steps.s.output) }}", "$.test");
    expect(diagnostics.diagnostics).toEqual([
      expect.objectContaining({ code: "EXPR_CEL", severity: "error" })
    ]);
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
    collector.visit("${{ steps.gate.output.approved }}", "$.workflow.steps[2].switch.cases[0].when");

    expect(diagnostics.diagnostics).toEqual([
      expect.objectContaining({ code: "EXPR_TEMPLATE_IN_CEL", path: expect.stringContaining("over") }),
      expect.objectContaining({ code: "EXPR_TEMPLATE_IN_CEL", path: expect.stringContaining("until") }),
      expect.objectContaining({ code: "EXPR_TEMPLATE_IN_CEL", path: expect.stringContaining("when") })
    ]);
  });

  it("does not warn when raw-CEL fields lack ${{ }}", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set(["discover", "gate"]));

    collector.visit("steps.discover.output.files", "$.workflow.steps[0].fanout.over");
    collector.visit("loop.iter >= 2", "$.workflow.steps[1].loop.until");
    collector.visit("steps.gate.output.approved", "$.workflow.steps[2].switch.cases[0].when");

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

  it("allows known step references without shape validation", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set(["mystery"]));
    collector.visit("${{ steps.mystery.output.x }}", "$.test");
    expect(diagnostics.diagnostics).toEqual([]);
  });

  it("accepts filter macro binding variables", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set());
    collector.visit("${{ input.items.filter(x, x > 0) }}", "$.test");
    expect(diagnostics.diagnostics).toEqual([]);
  });

  it("accepts map macro binding variables", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set());
    collector.visit("${{ input.numbers.map(n, n * 2) }}", "$.test");
    expect(diagnostics.diagnostics).toEqual([]);
  });

  it("does not warn on 3-arg map macro binding variable", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set());
    collector.visit("${{ input.items.map(x, x > 0, x * 2) }}", "$.test");
    expect(diagnostics.diagnostics).toEqual([]);
  });

  it("accepts cel.bind macro binding variables", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set());
    collector.visit("${{ cel.bind(y, 5, y + 1) }}", "$.test");
    expect(diagnostics.diagnostics).toEqual([]);
  });

  it("rejects invalid macro arguments through cel-js", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set());
    collector.visit("${{ input.items.filter(1, true) }}", "$.test");
    expect(diagnostics.diagnostics).toEqual([
      expect.objectContaining({ code: "EXPR_PARSE", severity: "error" })
    ]);
  });

  it("collects workflow references inside nested macros", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set(["s"]));
    collector.visit("${{ input.groups.exists(g, g.items.exists(x, x > steps.s.output.threshold)) }}", "$.test");
    expect(diagnostics.diagnostics).toEqual([]);
    expect(collector.expressions[0].references).toEqual(["s"]);
  });

  it("still collects receiver reference from macro calls", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set(["s"]));
    collector.visit("${{ steps.s.output.items.filter(x, x > 0) }}", "$.test");
    expect(diagnostics.diagnostics).toEqual([]);
    // The receiver `steps.s.output.items` is still collected; `s` resolves as
    // a step reference while the binding var `x` is filtered out.
    expect(collector.expressions[0].references).toEqual(["s"]);
  });

  it("collects other roots alongside binding var in macro body", () => {
    const diagnostics = new DiagnosticBag();
    const collector = createExpressionCollector(diagnostics, new Set(["s"]));
    collector.visit("${{ input.items.filter(x, x > steps.s.output.threshold) }}", "$.test");
    // `x` is filtered out, but `steps.s` is still collected
    expect(diagnostics.diagnostics).toEqual([]);
    expect(collector.expressions[0].references).toEqual(["s"]);
  });
});
