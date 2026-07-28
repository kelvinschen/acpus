import { describe, expect, it } from "vitest";
import {
  type WorkflowCheck,
  runCheck,
  withCheckWorkspace,
} from "./support/check-workspace.js";

describe("workflow check expression diagnostics", () => {
  it("covers Expr ownership, replacements, and native hints in one checked program", async () => {
    await withCheckWorkspace("workflow-native-expr-errors", async cwd => {
      const source = `
        import { defineWorkflow, z } from "acpus/core";
        import { eq, gt, gte, lift, lift as map, lt, lte } from "acpus/expression";
        import * as expression from "acpus/expression";

        export default defineWorkflow({
          name: "native_expr_errors",
          agents: { worker: { use: "codex" } },
          inputSchema: z.object({
            count: z.number(),
            limit: z.number(),
            items: z.array(z.string()),
            note: z.string().optional(),
            record: z.object({ present: z.string() }),
          }),
        }).build(({ agents, input, step }) => {
          const incremented = input.count + 1;
          const itemCount = input.items.length;
          void (input.note ?? "fallback");
          void (input.count === input.count);
          void (input.count < input.limit);
          void (input.count <= input.limit);
          void (input.count > input.limit);
          void (input.count >= input.limit);
          switch (input.count) { case input.count: break; }
          void lift(input.note, value => value ?? null);
          void eq(input.count, input.count);
          void lt(input.count, input.limit);
          void lte(input.count, input.limit);
          void gt(input.count, input.limit);
          void gte(input.count, input.limit);
          step("route").switch({ cases: [{ when: eq(input.count, input.limit), then() { return { value: 1 }; } }], default() { return { value: 0 }; } });
          void (input.count === 1);
          void (input.count < 1);
          void (input.count <= 1);
          void (input.count > 1);
          void (input.count >= 1);
          switch (input.count) { case 1: break; }
          const missing = map(input.note, note => note || undefined);
          const dated = expression.lift(input.note, note => new Date(note ?? ""));
          const unknownOutput = step("unknown").agent({ agent: agents.worker, prompt: "respond", outputSchema: z.unknown() });
          void unknownOutput.output.value;
          void input.note.missing;
          void input.record.missing;
          return { incremented, itemCount, missing, dated };
        });
        const ordinary = 1;
        ordinary.missing;
        void ({} + 1);
        function takesNumber(value: number): void { void value; }
        takesNumber("wrong");
        new Date(true);
      `;
      const result = await runCheck(cwd, source);
      const at = (needle: string) => result.diagnostics.filter(diagnostic => diagnostic.source?.line === sourceLine(source, needle));

      for (const [needle, code, hint] of [
        ["void (input.note ??", "AL002", "lift"],
        ["void (input.count === input.count)", "AL003", "eq"],
        ["void (input.count < input.limit)", "AL003", "lt"],
        ["void (input.count <= input.limit)", "AL003", "lte"],
        ["void (input.count > input.limit)", "AL003", "gt"],
        ["void (input.count >= input.limit)", "AL003", "gte"],
        ["switch (input.count) { case input.count", "AL001", 'step("id").switch'],
        ["void (input.count === 1)", "TS2367", "eq"],
        ["void (input.count < 1)", "TS2365", "lt"],
        ["void (input.count <= 1)", "TS2365", "lte"],
        ["void (input.count > 1)", "TS2365", "gt"],
        ["void (input.count >= 1)", "TS2365", "gte"],
        ["switch (input.count) { case 1", "TS2678", 'step("id").switch'],
      ] as const) {
        expect(at(needle)).toEqual([
          expect.objectContaining({ code, hint: expect.stringContaining(hint) }),
        ]);
      }

      for (const needle of [
        "void lift(input.note",
        "void eq(input.count",
        "void lt(input.count",
        "void lte(input.count",
        "void gt(input.count",
        "void gte(input.count",
        'step("route").switch',
      ]) {
        expect(at(needle)).toEqual([]);
      }

      expect(at("const incremented")).toEqual([
        expect.objectContaining({ code: "TS2365", hint: expect.stringContaining("lift") }),
      ]);
      expect(at("const itemCount")).toEqual([
        expect.objectContaining({ code: "TS2339", hint: expect.stringContaining("Expr arrays") }),
      ]);
      expect(at("const missing = map")).toEqual([
        expect.objectContaining({ code: "TS2769", hint: expect.stringContaining("null") }),
      ]);
      expect(at("const dated = expression.lift")).toEqual([
        expect.objectContaining({ code: "TS2769", hint: expect.stringContaining("convert Date") }),
      ]);
      expect(at("void unknownOutput.output.value").map(diagnostic => diagnostic.code)).toEqual(["TS2339"]);
      expect(at("void unknownOutput.output.value")[0]?.hint).toBeUndefined();
      expect(at("void input.note.missing").map(diagnostic => diagnostic.code)).toEqual(["TS2339"]);
      expect(at("void input.note.missing")[0]?.hint).toBeUndefined();
      expect(at("void input.record.missing").map(diagnostic => diagnostic.code)).toEqual(["TS2339"]);
      expect(at("void input.record.missing")[0]?.hint).toBeUndefined();

      for (const [needle, code] of [
        ["ordinary.missing", "TS2339"],
        ["void ({} + 1)", "TS2365"],
        ['takesNumber("wrong")', "TS2345"],
        ["new Date(true)", "TS2769"],
      ] as const) {
        const diagnostics = at(needle);
        expect(diagnostics).toEqual([expect.objectContaining({ code })]);
        expect(diagnostics[0]?.hint).toBeUndefined();
      }
    });
  });

  it("reports only AL005 for Expr-derived ids inside a loop body", async () => {
    await withCheckWorkspace("workflow-loop-dynamic-id", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow } from "acpus/core";
        import { gte } from "acpus/expression";

        export default defineWorkflow({
          name: "loop_dynamic_id",
          agents: { worker: { use: "codex" } },
        }).build(({ agents, step }) => {
          const rounds = step("rounds").loop({
            state: { count: 0 },
            do({ round }) {
              step(\`review_\${round}\`).agent({ agent: agents.worker, prompt: "review" });
              const current = step(\`record_\${round}\`).task({
                input: round,
                exec: async ({ input }) => ({ count: input }),
              });
              return { state: { count: current.output.count }, stop: gte(round, 2) };
            },
          });
          return { count: rounds.output.count };
        });
      `);

      expect(codes(result.diagnostics)).toEqual(["AL005", "AL005"]);
      expect(result.diagnostics.every(diagnostic => diagnostic.hint?.includes("distinct nodeKey"))).toBe(true);
    });
  });

  it("accepts aliases, spreads, computed keys, callback variables, and heterogeneous branches", async () => {
    await withCheckWorkspace("workflow-output-source-shapes", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow } from "acpus/core";

        export default defineWorkflow({ name: "output_source_shapes" }).build(({ step }) => {
          const hidden = { ok: true };
          const fanoutSpec = { over: ["a"], do() { return { ok: true }; } };
          step("items").fanout(fanoutSpec);
          function branch() { return { ok: true }; }
          step("parallel").parallel({ branches: { branch } });
          step("spread").if({
            condition: true,
            then() { return { ...hidden }; },
            else() { return { missing: true }; },
          });
          const key = "computed";
          step("computed").if({
            condition: true,
            then() { return { [key]: true }; },
            else() { return { fallback: true }; },
          });
          step("loop").loop({
            state: hidden,
            do() {
              const state = { ok: true };
              const stop = true;
              return { state, stop };
            },
          });
          step("switch").switch({
            cases: [{ when: true, then() { return { selected: true }; } }],
            default() { return { fallback: true }; },
          });
          return { ok: true };
        });
      `);

      expect(result.diagnostics).toEqual([]);
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
