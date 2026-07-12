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
        "TS2769",
        "TS2769",
        "TS2322",
        "TS2339",
        "TS2339",
        "TS2339",
        "AL007",
        "AL001",
        "TB003",
      ]);
      expect(result.diagnostics.map(diagnostic => ({
        code: diagnostic.code,
        line: diagnostic.source?.line,
      }))).toEqual([
        { code: "TS2345", line: 10 },
        { code: "TS2769", line: 12 },
        { code: "TS2769", line: 14 },
        { code: "TS2322", line: 20 },
        { code: "TS2339", line: 27 },
        { code: "TS2339", line: 28 },
        { code: "TS2339", line: 29 },
        { code: "AL007", line: 21 },
        { code: "AL001", line: 22 },
        { code: "TB003", line: 11 },
      ]);
      expect(result.diagnostics).toEqual(expect.arrayContaining([
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
        }),
        expect.objectContaining({
          code: "TS2339",
          message: expect.stringContaining("Property 'left' does not exist"),
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

  it("leaves type-expressible Expr operations and durable undefined to TypeScript", async () => {
    await withCheckWorkspace("workflow-native-expr-errors", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow, z } from "acpus/core";
        import { lift } from "acpus/expression";

        export default defineWorkflow({
          name: "native_expr_errors",
          inputSchema: z.object({
            count: z.number(),
            limit: z.number(),
            items: z.array(z.string()),
            note: z.string().optional(),
          }),
        }).build(({ input }) => {
          const incremented = input.count + 1;
          const overLimit = input.count > input.limit;
          const itemCount = input.items.length;
          const missing = lift(input.note, note => note || undefined);
          return { incremented, overLimit, itemCount, missing };
        });
      `);

      expect(codes(result.diagnostics)).toEqual(["TS2345", "TS2365", "TS2339", "TS2769"]);
      expect(result.diagnostics.filter(diagnostic => diagnostic.code.startsWith("AL"))).toEqual([]);
    });
  });

  it("accepts predicates, lift transforms, null absence, and static loop ids", async () => {
    await withCheckWorkspace("workflow-expr-replacements", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow, z } from "acpus/core";
        import { gte, lift } from "acpus/expression";

        export default defineWorkflow({
          name: "expr_replacements",
          inputSchema: z.object({
            count: z.number(),
            limit: z.number(),
            items: z.array(z.string()),
            note: z.string().optional(),
          }),
        }).build(({ input, step }) => {
          const incremented = lift(input.count, count => count + 1);
          const overLimit = gte(input.count, input.limit);
          const itemCount = lift(input.items, items => items.length);
          const note = lift(input.note, value => value ?? null);
          const rounds = step("rounds").loop({
            state: { count: 0 },
            do({ round }) {
              const current = step("current_round").task({
                input: { round },
                exec: async ({ input }) => ({ count: input.round }),
              });
              return { state: { count: current.output.count }, stop: gte(round, 2) };
            },
          });
          return { incremented, overLimit, itemCount, note, rounds: rounds.output.count };
        });
      `);

      expect(result.diagnostics).toEqual([]);
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

  it("accepts loop transition shorthand properties and still checks their types and keys", async () => {
    await withCheckWorkspace("workflow-loop-shorthand", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow, z } from "acpus/core";
        import { lift } from "acpus/expression";

        export default defineWorkflow({
          name: "loop_shorthand",
          inputSchema: z.object({ shouldContinue: z.boolean() }),
        }).build(({ input, step }) => {
          const shorthand = step("shorthand").loop({
            state: { round: 0, shouldContinue: true },
            do({ round }) {
              const state = { round, shouldContinue: input.shouldContinue };
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
          return { shorthand: shorthand.output, explicit: explicit.output };
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
