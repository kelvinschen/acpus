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
          inputSchema: z.string(),
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
            input: null,
            exec: async (): Promise<Output> => helper(),
          });
          step("same_file_hidden").task({ input: "value", task: inlineHidden });
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

  it("accepts the original schema-less Agent RPS workflow with a direct Expr Task input", async () => {
    await withCheckWorkspace("workflow-direct-task-expression", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow } from "acpus/core";
        import { lift, md } from "acpus/expression";

        export default defineWorkflow({
          name: "claude-vs-pi-rps",
          description: "Let Claude and Pi play one round of rock paper scissors.",
          agents: {
            claude: { use: "claude" },
            pi: { use: "pi" },
          },
        }).build(({ agents, step }) => {
          const moves = step("choose_moves").parallel({
            branches: {
              claude: () => step("claude_move").agent({
                agent: agents.claude,
                prompt: md\`Play one round of rock paper scissors against Pi.

        Choose exactly one move. Reply with only one lowercase word: rock, paper, or scissors.\`,
              }).output,
              pi: () => step("pi_move").agent({
                agent: agents.pi,
                prompt: md\`Play one round of rock paper scissors against Claude.

        Choose exactly one move. Reply with only one lowercase word: rock, paper, or scissors.\`,
              }).output,
            },
          });

          const normalized = lift(moves.output, raw => {
            const normalize = (value: string) => {
              const text = value.toLowerCase();
              if (text.includes("rock")) return "rock";
              if (text.includes("paper")) return "paper";
              if (text.includes("scissors")) return "scissors";
              return "invalid";
            };
            const claude = normalize(raw.claude);
            const pi = normalize(raw.pi);
            let winner = "draw";
            if (claude === "invalid" || pi === "invalid") {
              winner = "invalid";
            } else if (claude !== pi) {
              const claudeWins =
                (claude === "rock" && pi === "scissors") ||
                (claude === "paper" && pi === "rock") ||
                (claude === "scissors" && pi === "paper");
              winner = claudeWins ? "claude" : "pi";
            }

            return {
              raw,
              moves: { claude, pi },
              winner,
            };
          });

          const verdict = step("judge").task({
            input: normalized,
            exec: async ({ input }) => input,
          });

          return verdict.output;
        });
      `);

      expect(result.diagnostics).toEqual([]);
    });
  });

  it("keeps invalid inline and reusable Task input diagnostics local without cascade fallout", async () => {
    await withCheckWorkspace("workflow-invalid-task-input", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow, task, z } from "acpus/core";

        export const StringTask = task.define({
          inputSchema: z.string(),
          exec: async ({ input }) => input.length,
        });

        export default defineWorkflow({ name: "invalid_task_input" }).build(({ step }) => {
          const invalidInline = step("invalid_inline").task({
            input: undefined,
            exec: async ({ input }) => String(input),
          });
          const invalidReusable = step("invalid_reusable").task({
            task: StringTask,
            input: 1,
          });
          return { inline: invalidInline.output, reusable: invalidReusable.output };
        });
      `);

      const typescript = result.diagnostics.filter(diagnostic => diagnostic.code.startsWith("TS"));
      expect(result.diagnostics).toHaveLength(2);
      expect(typescript).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "TS2769",
          source: expect.objectContaining({ line: 11 }),
        }),
        expect.objectContaining({
          code: "TS2769",
          source: expect.objectContaining({ line: 16 }),
        }),
      ]));
      expect(typescript.map(diagnostic => diagnostic.code)).not.toContain("TS7031");
      expect(typescript.map(diagnostic => diagnostic.code)).not.toContain("TS2345");
    });
  });

  it("reports durable output and loop contract violations as TypeScript diagnostics only", async () => {
    await withCheckWorkspace("workflow-output-types", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow } from "acpus/core";

        export default defineWorkflow({ name: "output_types" }).build(({ step }) => {
          step("date").task({ input: null, exec: async () => ({ when: new Date() }) });
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
