import { describe, expect, it } from "vitest";
import {
  type WorkflowCheck,
  runCheck,
  withCheckWorkspace,
} from "./support/check-workspace.js";

describe("workflow check authoring diagnostics", () => {
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
        { code: "TS2769", line: 16 },
        { code: "TS2322", line: 22 },
        { code: "AL007", line: 23 },
        { code: "AL001", line: 24 },
        { code: "TS2339", line: 29 },
        { code: "TS2339", line: 30 },
        { code: "TS2339", line: 31 },
      ]);
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "TS2345", hint: expect.stringContaining("NodeRef") }),
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
        }),
      ]));
      expect(result.diagnostics.filter(diagnostic => diagnostic.code === "AL007")).toHaveLength(1);
      expect(result.diagnostics.every(diagnostic => diagnostic.source?.file?.endsWith("workflow.ts"))).toBe(true);
      expect(codes(result.diagnostics)).not.toContain("W001");
      expect(codes(result.diagnostics)).not.toContain("B001");
    });
  });

  it("reports invalid expression lift callbacks during check", async () => {
    await withCheckWorkspace("workflow-lift-checks", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow, z } from "acpus/core";
        import { lift } from "acpus/expression";

        const suffix = "!";

        export default defineWorkflow({
          name: "lift_check",
          inputSchema: z.object({
            issue: z.object({
              title: z.string(),
            }),
          }),
        }).build(({ input }) => {
          const title = lift(input.issue, issue => {
            return issue.title + suffix;
          });
          return { title };
        });
      `);

      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "AL006",
          message: expect.stringContaining("external binding 'suffix'"),
          source: expect.objectContaining({
            file: expect.stringContaining("workflow.ts"),
            line: expect.any(Number),
            column: expect.any(Number),
          }),
        }),
      ]));
    });
  });

  it("covers Expr ownership, replacements, and native hints in one checked program", async () => {
    await withCheckWorkspace("workflow-native-expr-errors", async cwd => {
      const source = `
        import { defineWorkflow, z } from "acpus/core";
        import { eq, gt, gte, lift, lift as map, lt, lte } from "acpus/expression";
        import * as expression from "acpus/expression";

        export default defineWorkflow({
          name: "native_expr_errors",
          inputSchema: z.object({
            count: z.number(),
            limit: z.number(),
            items: z.array(z.string()),
            note: z.string().optional(),
          }),
        }).build(({ input, step }) => {
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
                input: { round },
                exec: async ({ input }) => ({ count: input.round }),
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

  it("accepts replacements, static loop ids, and shorthand transition properties", async () => {
    await withCheckWorkspace("workflow-loop-shorthand", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow, z } from "acpus/core";
        import { gte, lift } from "acpus/expression";

        export default defineWorkflow({
          name: "loop_shorthand",
          inputSchema: z.object({
            count: z.number(),
            limit: z.number(),
            items: z.array(z.string()),
            note: z.string().optional(),
            shouldContinue: z.boolean(),
          }),
        }).build(({ input, step }) => {
          const incremented = lift(input.count, count => count + 1);
          const overLimit = gte(input.count, input.limit);
          const itemCount = lift(input.items, items => items.length);
          const note = lift(input.note, value => value ?? null);
          const shorthand = step("shorthand").loop({
            state: { round: 0, shouldContinue: true },
            do({ round }) {
              const current = step("current_round").task({
                input: { round },
                exec: async ({ input }) => ({ count: input.round }),
              });
              const state = { round: current.output.count, shouldContinue: input.shouldContinue };
              const stop = lift(input.shouldContinue, round, (shouldContinue, currentRound) => !shouldContinue || currentRound >= 2);
              return { state, stop };
            },
          });
          const explicit = step("explicit").loop({
            state: { round: 0, shouldContinue: true },
            do({ round }) {
              const state = { round, shouldContinue: input.shouldContinue };
              const stop = lift(input.shouldContinue, round, (shouldContinue, currentRound) => !shouldContinue || currentRound >= 2);
              return { state: state, stop: stop };
            },
          });
          return { incremented, overLimit, itemCount, note, shorthand: shorthand.output, explicit: explicit.output };
        });
      `);

      expect(result.diagnostics).toEqual([]);
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
