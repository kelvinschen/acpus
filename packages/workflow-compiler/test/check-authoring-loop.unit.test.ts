import { describe, expect, it } from "vitest";
import {
  runCheck,
  withCheckWorkspace,
} from "./support/check-workspace.js";

describe("workflow check loop diagnostics", () => {
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
                input: round,
                exec: async ({ input }) => ({ count: input }),
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

  it("hints when a narrow initial loop state rejects later transition values", async () => {
    await withCheckWorkspace("workflow-loop-state-widening", async cwd => {
      const source = `
        import { defineWorkflow, z } from "acpus/core";

        type Grow<T> = { value: T; next: Grow<[T]> };
        const recursiveInitial = null as unknown as Grow<string>;
        const recursiveTransition = null as unknown as Grow<number>;

        export default defineWorkflow({
          name: "loop_state_widening",
          inputSchema: z.object({ items: z.array(z.string()) }),
        }).build(({ input, step }) => {
          step("literal").loop({
            state: { phase: "draft" as const },
            do() {
              const unrelated: string = 1;
              void unrelated;
              return { state: { phase: "done" }, stop: true };
            },
          });
          step("nullable").loop({
            state: { result: null },
            do() { return { state: { result: "done" }, stop: true }; },
          });
          step("empty").loop({
            state: { items: [] },
            do() { return { state: { items: ["done"] }, stop: true }; },
          });
          step("expr_root").loop({
            state: [],
            do() { return { state: input.items, stop: true }; },
          });
          step("expr_nested").loop({
            state: { items: [] },
            do() { return { state: { items: input.items }, stop: true }; },
          });
          step("recursive").loop({
            state: recursiveInitial,
            do() { return { state: recursiveTransition, stop: true }; },
          });
          return { ok: true };
        });
      `;
      const result = await runCheck(cwd, source);

      for (const needle of [
        "do() {",
        'do() { return { state: { result: "done" }',
        'do() { return { state: { items: ["done"] }',
        "do() { return { state: input.items",
        "do() { return { state: { items: input.items }",
      ]) {
        expect(result.diagnostics.filter(diagnostic => diagnostic.source?.line === sourceLine(source, needle))).toEqual([
          expect.objectContaining({ code: "TS2322", hint: expect.stringContaining("State type") }),
        ]);
      }
      const unrelated = result.diagnostics.filter(diagnostic => diagnostic.source?.line === sourceLine(source, "const unrelated"));
      expect(unrelated.map(diagnostic => diagnostic.code)).toEqual(["TS2322"]);
      expect(unrelated[0]?.hint).toBeUndefined();
      const recursive = result.diagnostics.filter(diagnostic => diagnostic.source?.line === sourceLine(source, "do() { return { state: recursiveTransition"));
      expect(recursive.map(diagnostic => diagnostic.code)).toEqual(["TS2322"]);
      expect(recursive[0]?.hint).toBeUndefined();
    });
  }, 5_000);

});

function sourceLine(source: string, needle: string): number {
  const offset = source.indexOf(needle);
  if (offset < 0) throw new Error(`Missing source marker: ${needle}`);
  return source.slice(0, offset).split("\n").length;
}
