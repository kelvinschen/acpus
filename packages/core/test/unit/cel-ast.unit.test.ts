import { describe, expect, it } from "vitest";
import { extractReferences, referenceToString, isStaticReference } from "../../src/cel-ast.js";
import { toCelParseSource } from "../../src/expressions-shared.js";

describe("toCelParseSource", () => {
  it("rewrites a bare loop. root to loop_ctx.", () => {
    expect(toCelParseSource("loop.iter > 0")).toBe("loop_ctx.iter > 0");
  });

  it("does not rewrite loop as a dotted field (step named loop)", () => {
    expect(toCelParseSource("steps.loop.output.z")).toBe("steps.loop.output.z");
  });
});

describe("extractReferences", () => {
  it("extracts a simple field chain", () => {
    const { references } = extractReferences("steps.collect.output.report_path");
    expect(references).toHaveLength(1);
    expect(referenceToString(references[0]!)).toBe("steps.collect.output.report_path");
    expect(isStaticReference(references[0]!)).toBe(true);
  });

  it("normalizes loop_ctx back to loop", () => {
    const { references } = extractReferences("loop.last.output.ok");
    expect(references[0]!.root).toBe("loop");
  });

  it("marks index access as a non-static segment", () => {
    const { references } = extractReferences("steps.research.output[0].output.filepath");
    const ref = references[0]!;
    expect(ref.root).toBe("steps");
    expect(isStaticReference(ref)).toBe(false);
    expect(referenceToString(ref)).toBe("steps.research.output[].output.filepath");
  });

  it("collects standalone function names but not method calls", () => {
    const fromCall = extractReferences("len(steps.x.output)");
    expect(fromCall.functions).toContain("len");
    const fromMethod = extractReferences('input.name.startsWith("a")');
    expect(fromMethod.functions).not.toContain("startsWith");
    // the receiver chain is still extracted
    expect(fromMethod.references.some((r) => r.root === "input")).toBe(true);
  });

  it("does not collect CEL macro locals as workflow references", () => {
    const { references } = extractReferences("input.items.filter(x, x > steps.s.output.threshold)");
    expect(references.map(referenceToString)).toEqual([
      "input.items",
      "steps.s.output.threshold"
    ]);
  });

  it("collects receiver method argument references", () => {
    const { references } = extractReferences("input.name.startsWith(prefix)");
    expect(references.map(referenceToString)).toEqual(["input.name", "prefix"]);
  });

  it("walks references inside function arguments and operators", () => {
    const { references } = extractReferences("coalesce(steps.a.output.x, input.y) > 0");
    const roots = references.map((r) => r.root).sort();
    expect(roots).toEqual(["input", "steps"]);
  });

  it("walks the index sub-expression for scope references", () => {
    const { references } = extractReferences("input.items[item_index].field");
    expect(references.some((r) => r.root === "item_index")).toBe(true);
  });

  it("reports a parse error without throwing", () => {
    const { parseError, references } = extractReferences("+");
    expect(parseError).toBeDefined();
    expect(references).toEqual([]);
  });
});
