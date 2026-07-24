import { describe, expect, it } from "vitest";
import { runCheck, withCheckWorkspace } from "./support/check-workspace.js";

describe("workflow valid authoring checks", () => {
  it("allows representative valid authoring and output patterns", async () => {
    await withCheckWorkspace("workflow-valid-patterns", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow, task, type JsonObject, type JsonValue, z } from "acpus/core";

        const ReviewOut = z.object({ ok: z.boolean() });
        const focuses = ["security", "docs"] as const;
        type Output = { ok: boolean };
        function helper(): Output {
          return { ok: true };
        }
        const inlineHidden = task.define({
          inputSchema: z.object({}),
          exec: async (): Promise<Output> => helper(),
        });

        export default defineWorkflow({
          name: "valid_lint_patterns",
          agents: { reviewer: { use: "codex" } },
        }).build(({ agents, step }) => {
          const reviews = focuses.map(id => step(\`review_\${id}\`).agent({
            outputSchema: ReviewOut,
            agent: agents.reviewer,
            prompt: "review",
          }));
          const client = {
            task: (_spec: object) => ({ ok: true }),
            loop: (_spec: object) => ({ ok: true }),
          };
          client.task({ exec: async () => ({ when: new Date() }) });
          client.loop({ do() { return { ok: true }; } });
          const thirdPartyTask = {
            define: (_spec: object) => ({ ok: true }),
          };
          thirdPartyTask.define({ exec: async () => ({ when: new Date() }) });
          step("inline_hidden").task({
            input: {},
            exec: async (): Promise<Output> => helper(),
          });
          step("same_file_hidden").task({ input: {}, task: inlineHidden });
          step("loop").loop({
            state: { ok: true, count: 0, summary: "" },
            do({ round, state }) {
              return {
                state: {
                  ok: state.ok,
                  count: round,
                  summary: state.summary,
                },
                stop: true,
              };
            },
          });
          const value = JSON.parse("{}") as JsonValue;
          const object = { ok: true } as JsonObject;
          return { first: reviews[0].output.ok, value, object };
        });
      `);

      expect(result.diagnostics.filter(diagnostic =>
        diagnostic.code.startsWith("AL")
        || diagnostic.code === "TB004",
      )).toEqual([]);
    });
  });

  it("accepts optional concurrency expressions without casts or fixed fallbacks", async () => {
    await withCheckWorkspace("workflow-optional-concurrency", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow, z } from "acpus/core";
        import { lift } from "acpus/expression";

        export default defineWorkflow({
          name: "optional_concurrency",
          inputSchema: z.object({
            items: z.array(z.string()),
            parallelism: z.number().optional(),
          }),
        }).build(({ input, step }) => {
          step("parallel").parallel({
            maxConcurrency: input.parallelism,
            branches: { only() { return {}; } },
          });
          step("fanout").fanout({
            over: input.items,
            maxConcurrency: lift(input.parallelism, value => value ?? 0),
            do({ item }) { return { item }; },
          });
          return {};
        });
      `);

      expect(result.diagnostics).toEqual([]);
    });
  });

  it("reports durable output and loop contract violations as TypeScript diagnostics only", async () => {
    await withCheckWorkspace("workflow-output-types", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow } from "acpus/core";

        export default defineWorkflow({ name: "output_types" }).build(({ step }) => {
          step("date").task({ input: {}, exec: async () => ({ when: new Date() }) });
          step("if_date").if({
            condition: true,
            then() { return { when: new Date() }; },
            else() { return { ok: true }; },
          });
          step("switch_date").switch({
            cases: [{ when: true, then() { return { when: new Date() }; } }],
            default() { return { ok: true }; },
          });
          step("parallel_date").parallel({
            branches: {
              invalid() { return { when: new Date() }; },
              valid() { return { ok: true }; },
            },
          });
          step("fanout_date").fanout({
            over: ["item"],
            do() { return { when: new Date() }; },
          });
          step("missing_stop").loop({
            state: { ok: true },
            do() { return { state: { ok: true } }; },
          });
          step("bad_stop").loop({
            state: { ok: true },
            do() { return { state: { ok: true }, stop: "yes" }; },
          });
          return { ok: true };
        });
      `);

      expect(result.diagnostics.filter(diagnostic => diagnostic.code.startsWith("TS")).length).toBeGreaterThanOrEqual(7);
      expect(result.diagnostics.filter(diagnostic => diagnostic.code.startsWith("OA"))).toEqual([]);
    });
  });
});
