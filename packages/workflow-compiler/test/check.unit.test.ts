import { rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../src/check/runner.js";
import { createScratchDir } from "../src/preflight/temp.js";
import { runCheck, withCheckWorkspace } from "./support/check-workspace.js";

describe("workflow check pipeline", () => {
  it("converts TypeScript compiler diagnostics to DiagnosticIR", async () => {
    await withCheckWorkspace("workflow-ts-check", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow } from "acpus/core";

        const wrong: string = 1;

        export default defineWorkflow({ name: "ts_check" }).build(() => ({ wrong }));
      `, {
        "tsconfig.json": `${JSON.stringify({
          compilerOptions: {
            strict: true,
          },
          include: ["unrelated.ts"],
        }, null, 2)}\n`,
        "unrelated.ts": "const value: string = 1;\n",
      });

      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "TS2322",
          message: expect.stringContaining("Type 'number' is not assignable to type 'string'"),
          source: expect.objectContaining({
            file: expect.stringContaining("workflow.ts"),
            line: expect.any(Number),
            column: expect.any(Number),
          }),
        }),
      ]));
      expect(result.diagnostics.filter(diagnostic => diagnostic.source?.file?.includes("unrelated.ts"))).toEqual([]);
    });
  });

  it("reports implicit any from TypeScript semantic diagnostics", async () => {
    await withCheckWorkspace("workflow-implicit-any-check", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow } from "acpus/core";

        function id(value) {
          return value;
        }

        export default defineWorkflow({ name: "implicit_any_check" }).build(() => ({ value: id("ok") }));
      `);

      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "TS7006",
          message: expect.stringContaining("implicitly has an 'any' type"),
        }),
      ]));
    });
  });

  it("reports missing workflow source as a check diagnostic", async () => {
    await withCheckWorkspace("workflow-missing-check", async cwd => {
      const scratchDir = await createScratchDir();
      try {
        const result = await checkWorkflow(join(cwd, "missing.workflow.ts"), cwd, scratchDir);

        expect(result.diagnostics).toContainEqual(expect.objectContaining({
          code: "WF001",
          path: "workflow",
          source: expect.objectContaining({ file: expect.stringContaining("missing.workflow.ts") }),
        }));
      } finally {
        await rm(scratchDir, { recursive: true, force: true });
      }
    });
  });

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
            run: {
              agent: agents.reviewer,
              prompt: "review",
            },
          }));
          const client = {
            task: (_spec: object) => ({ ok: true }),
            loop: (_spec: object) => ({ ok: true }),
          };
          client.task({ run: { exec: async () => ({ when: new Date() }) } });
          client.loop({ do() { return { ok: true }; } });
          const thirdPartyTask = {
            define: (_spec: object) => ({ ok: true }),
          };
          thirdPartyTask.define({ exec: async () => ({ when: new Date() }) });
          step("inline_hidden").task({
            run: {
              input: {},
              exec: async (): Promise<Output> => helper(),
            },
          });
          step("same_file_hidden").task({ run: { input: {}, task: inlineHidden } });
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

  it("reports durable output and loop contract violations as TypeScript diagnostics only", async () => {
    await withCheckWorkspace("workflow-output-types", async cwd => {
      const result = await runCheck(cwd, `
        import { defineWorkflow } from "acpus/core";

        export default defineWorkflow({ name: "output_types" }).build(({ step }) => {
          step("date").task({ run: { input: {}, exec: async () => ({ when: new Date() }) } });
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
