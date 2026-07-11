import { describe, expect, it } from "vitest";
import {
  type WorkflowCheck,
  runCheck,
  withCheckWorkspace,
} from "./support/check-workspace.js";

describe("workflow check authoring diagnostics", () => {
  it("aggregates TypeScript and Acpus authoring diagnostics", async () => {
    await withCheckWorkspace("workflow-mixed-check", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow, z } from "acpus/core";

        export default defineWorkflow({
          name: "mixed_check",
          inputSchema: z.object({
            ready: z.boolean(),
          }),
        }).build(({ input, step }) => {
          const wrong: string = 1;
          if (input.ready) step("ready").assert({ condition: true });
          return { wrong };
        });
      `);

      expect(codes(result.diagnostics)).toEqual(expect.arrayContaining([
        "TS2322",
        "AL001",
      ]));
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "AL001", hint: expect.any(String) }),
      ]));
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
