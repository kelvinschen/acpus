import { describe, expect, it } from "vitest";
import {
  type WorkflowCheck,
  runCheck,
  withCheckWorkspace,
} from "./support/check-workspace.js";

describe("workflow check authoring boundaries", () => {
  it("aggregates native and Acpus diagnostics across authoring boundaries", async () => {
    await withCheckWorkspace("workflow-mixed-check", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow, z } from "acpus/core";
        import { helper } from "./helper.js";

        export default defineWorkflow({
          name: "mixed_check",
          inputSchema: z.object({
            ready: z.boolean(),
          }),
        }).build(({ input, step }) => {
          const inherited = step("inherited").task({ input: {}, exec: async () => helper() });
          step("inherited_branch").parallel({ branches: { only() { return helper(); } } });
          const leaf = step("leaf").task({ input: {}, exec: async () => ({ value: "ok" }) });
          step("leaf").task({ input: {}, exec: async () => ({ value: "duplicate" }) });
          step("date").task({ input: {}, exec: async () => new Date() });
          step("bad_expr").parallel({ branches: { only() { return leaf.output.value; } } });
          const branch = step("branch").if({
            condition: true,
            then: () => ({ common: "a", left: true }),
            else: () => ({ common: "b", right: true }),
          });
          const wrong: string = 1;
          const explicit = helper() as any;
          if (input.ready) step("ready").assert({ condition: true });
          void explicit;
          return {
            wrong,
            leaf,
            inherited: inherited.output.value,
            missing: leaf.value,
            unsafe: branch.output.left,
          };
        });
      `, {
        "helper.ts": `export function helper(): any { return {}; }`,
      });

      expect(codes(result.diagnostics)).toEqual([
        "TS2345",
        "TB003",
        "TS2769",
        "TB004",
        "TS2769",
        "TS2322",
        "AL007",
        "AL001",
        "TS2339",
        "TS2339",
        "TS2339",
      ]);
      expect(result.diagnostics.map(diagnostic => ({
        code: diagnostic.code,
        line: diagnostic.source?.line,
      }))).toEqual([
        { code: "TS2345", line: 10 },
        { code: "TB003", line: 11 },
        { code: "TS2769", line: 12 },
        { code: "TB004", line: 14 },
        { code: "TS2769", line: 15 },
        { code: "TS2322", line: 22 },
        { code: "AL007", line: 23 },
        { code: "AL001", line: 24 },
        { code: "TS2339", line: 29 },
        { code: "TS2339", line: 30 },
        { code: "TS2339", line: 31 },
      ]);
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "TS2345", hint: expect.stringContaining("Return node.output") }),
        expect.objectContaining({ code: "TB004", source: expect.objectContaining({ line: 14 }), hint: expect.stringContaining("13:") }),
        expect.objectContaining({ code: "TS2769", source: expect.objectContaining({ line: 15 }), hint: expect.stringContaining("convert Date") }),
        expect.objectContaining({ code: "AL001", hint: expect.any(String) }),
        expect.objectContaining({
          code: "AL007",
          severity: "error",
          message: "Explicit 'any' is not allowed in Acpus workflow authoring.",
          hint: "Use a precise type, or use unknown and narrow it before crossing an Acpus boundary.",
          source: expect.objectContaining({ file: expect.stringContaining("workflow.ts") }),
        }),
        expect.objectContaining({
          code: "TS2339",
          message: expect.stringContaining("Property 'value' does not exist on type 'NodeRef"),
          hint: expect.stringContaining(".output"),
        }),
        expect.objectContaining({
          code: "TS2339",
          message: expect.stringContaining("Property 'left' does not exist"),
          hint: expect.stringContaining("narrow"),
        }),
        expect.objectContaining({
          code: "TS2339",
          message: expect.stringContaining("Property 'value' does not exist on type 'Expr<unknown>"),
          hint: expect.stringContaining("fix the producer"),
        }),
      ]));
      expect(result.diagnostics.filter(diagnostic => diagnostic.code === "AL007")).toHaveLength(1);
      expect(result.diagnostics.every(diagnostic => diagnostic.source?.file?.endsWith("workflow.ts"))).toBe(true);
      expect(codes(result.diagnostics)).not.toContain("W001");
      expect(codes(result.diagnostics)).not.toContain("B001");
    });
  });

  it("hints a missing lift import and suppresses only its direct callback TS7006", async () => {
    await withCheckWorkspace("workflow-missing-lift", async cwd => {
      const source = `
        import { defineWorkflow, z } from "acpus/core";

        export default defineWorkflow({
          name: "missing_lift",
          inputSchema: z.object({ count: z.number() }),
        }).build(({ input }) => {
          void lift(input.count, value => value + 1);
          void lift(input.count, input.count, (left, right) => left + right);
          void lift(input.count, input.count, input.count, (first, second, third) => first + second + third);
          void lift(value => value);
          void lift(input.count, (value, extra) => value);
          void lift(input.count, input.count, input.count, input.count, (one, two, three, four) => one + two + three + four);
          void lift(...[input.count], value => value);
          void lift(input.count, function (value) { return value; });
          void transform(input.count, value => value + 1);
          return { ok: true };
        });
      `;
      const result = await runCheck(cwd, source);

      for (const needle of [
        "void lift(input.count, value",
        "void lift(input.count, input.count, (left",
        "void lift(input.count, input.count, input.count, (first",
      ]) {
        expect(result.diagnostics.filter(diagnostic => diagnostic.source?.line === sourceLine(source, needle))).toEqual([
          expect.objectContaining({
            code: "TS2304",
            hint: 'Import the helper with import { lift } from "acpus/expression".',
          }),
        ]);
      }
      for (const [needle, expected] of [
        ["void lift(value", ["TS2304", "TS7006"]],
        ["void lift(input.count, (value", ["TS2304", "TS7006", "TS7006"]],
        ["void lift(input.count, input.count, input.count, input.count", ["TS2304", "TS7006", "TS7006", "TS7006", "TS7006"]],
        ["void lift(...", ["TS2304", "TS7006"]],
        ["void lift(input.count, function", ["TS2304", "TS7006"]],
      ] as const) {
        expect(result.diagnostics
          .filter(diagnostic => diagnostic.source?.line === sourceLine(source, needle))
          .map(diagnostic => diagnostic.code)).toEqual(expected);
      }
      const other = result.diagnostics.filter(diagnostic => diagnostic.source?.line === sourceLine(source, "void transform"));
      expect(other.map(diagnostic => diagnostic.code)).toEqual(["TS2304", "TS7006"]);
      expect(other.every(diagnostic => diagnostic.hint === undefined)).toBe(true);
    });
  });

});

function codes(diagnostics: WorkflowCheck["diagnostics"]): string[] {
  return diagnostics.map(diagnostic => diagnostic.code);
}

function sourceLine(source: string, needle: string): number {
  const offset = source.indexOf(needle);
  if (offset < 0) throw new Error(`Missing source marker: ${needle}`);
  return source.slice(0, offset).split("\n").length;
}
